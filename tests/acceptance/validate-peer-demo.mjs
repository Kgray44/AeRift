import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readdir, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { hashFile } from "./hash-file.mjs";
import { prepareFixtures } from "./prepare-fixtures.mjs";

const largeBytes = 64 * 1024 * 1024;

async function loopbackAddress() {
  const listener = createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolveClose, reject) => listener.close(error =>
    error ? reject(error) : resolveClose()));
  return `127.0.0.1:${port}`;
}

function start(executable, args, maxOutput = 16384) {
  const child = spawn(executable, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  const state = { text: "", closed: false };
  child.stdout.setEncoding("utf8").on("data", part => {
    state.text += part;
    if (state.text.length > maxOutput) {
      state.error = "output limit exceeded";
      child.kill();
    }
  });
  child.stdin.on("error", () => { state.error ??= "input stream closed"; });
  child.once("error", () => { state.error ??= "could not start child"; });
  const closed = new Promise(resolveClose => child.once("close", code => {
    state.code = code;
    state.closed = true;
    resolveClose();
  }));
  return {
    pid: child.pid,
    output: () => state.text,
    terminate: () => !state.closed && child.kill(),
    write(text) { child.stdin.write(text + "\n"); },
    async waitFor(pattern, deadline, label) {
      while (performance.now() < deadline) {
        const match = pattern.exec(state.text);
        if (match) return match;
        if (state.error || state.closed) throw new Error(`${label}: peer process ended early`);
        await delay(10);
      }
      throw new Error(`${label}: timed out`);
    },
    async exit(deadline) {
      while (!state.closed && performance.now() < deadline) await delay(10);
      assert.ok(state.closed, "peer process did not shut down");
      return state.code;
    },
    async dispose() {
      if (!state.closed) child.kill();
      await closed;
    },
  };
}

async function windowsObservation(sender, receiver, destination, filename, deadline) {
  assert.ok(Number.isSafeInteger(sender.pid) && Number.isSafeInteger(receiver.pid));
  const powershell = join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const sampler = fileURLToPath(new URL("./measure-working-set.ps1", import.meta.url));
  const observer = start(powershell, [
    "-NoProfile", "-NonInteractive", "-File", sampler,
    "-SenderId", String(sender.pid), "-ReceiverId", String(receiver.pid),
  ], 262144);

  let watcher;
  let startAt;
  let publishedAt;
  let watchError;
  function dispose() {
    watcher?.close();
    return observer.dispose();
  }
  try {
    await observer.waitFor(/^[1-9][0-9]*,[1-9][0-9]*\r?$/m, deadline, "initial memory sample");
    watcher = watch(destination, { encoding: "utf8" }, (_event, name) => {
      if (name?.startsWith(".aerift-part-")) startAt ??= performance.now();
      if (name === filename) publishedAt ??= performance.now();
    });
    watcher.on("error", error => { watchError = error.code ?? "watch error"; });
  } catch (error) {
    await dispose();
    throw error;
  }

  return {
    dispose,
    async finish(bytesTransferred, approvedAt) {
      assert.equal(await observer.exit(deadline), 0, "working-set observer failed");
      assert.equal(watchError, undefined, "destination watcher failed");
      assert.ok(publishedAt > startAt && startAt >= approvedAt,
        "expected an ordered observation of a partial file and final publication");
      const writeAndPublishMs = publishedAt - startAt;
      const samples = [...observer.output().matchAll(/^([0-9]+),([0-9]+)\r?$/gm)];
      return {
        senderPeakWorkingSetBytes: Math.max(...samples.map(match => Number(match[1]))),
        receiverPeakWorkingSetBytes: Math.max(...samples.map(match => Number(match[2]))),
        workingSetSamples: samples.length,
        receiverWriteAndPublishMs: writeAndPublishMs,
        receiverEffectiveMiBPerSecond: bytesTransferred / 1048576 / (writeAndPublishMs / 1000),
      };
    },
  };
}

async function disconnectDuringUpload(sender, receiver, destination, previous, deadline) {
  let partialBytes = 0;
  while (performance.now() < deadline) {
    const partial = (await readdir(destination)).find(name => name.startsWith(".aerift-part-"));
    if (partial) {
      try {
        partialBytes = (await stat(join(destination, partial))).size;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (partialBytes > 0) break;
    }
    await delay(10);
  }
  assert.ok(partialBytes > 0 && partialBytes < largeBytes, "expected an incomplete upload");
  assert.ok(sender.terminate(), "sender exited before the disconnect could be exercised");
  const [, receiverBytes] = await receiver.waitFor(
    /Receiver result: Failed, ([0-9]+) bytes/, deadline, "receiver failure",
  );
  assert.notEqual(await sender.exit(deadline), 0, "sender unexpectedly completed");
  assert.equal(await receiver.exit(deadline), 0);
  assert.deepEqual((await readdir(destination)).sort(), previous, "partial data survived disconnect");
  return { outcome: "Failed", bytesTransferred: Number(receiverBytes), partialBytesAtDisconnect: partialBytes };
}

async function exchange(executable, source, destination, action) {
  const before = (await readdir(destination)).sort();
  const address = await loopbackAddress();
  const deadline = performance.now() + 150000;
  const receiver = start(executable, ["receive", address, destination]);
  let sender;
  let observation;
  try {
    // The ephemeral invitation moves through memory and child stdin only.
    const [, code] = await receiver.waitFor(
      /Enter this code at the sender prompt:\r?\n(aerift:v1:[a-f0-9]{64}:[A-Za-z0-9_-]{43})\r?\n/,
      deadline, "receiver invitation",
    );
    sender = start(executable, ["send", address, source]);
    await sender.waitFor(/Enter the receiver's pairing code: /, deadline, "sender prompt");
    const pairingStarted = performance.now();
    sender.write(code);
    await receiver.waitFor(/Pair with .*\? Type yes: /, deadline, "pairing consent");
    const pairingRequestMs = performance.now() - pairingStarted;
    receiver.write("yes");
    await receiver.waitFor(/Accept .*\? Type yes: /, deadline, "file consent");
    assert.deepEqual((await readdir(destination)).sort(), before, "files changed before consent");

    if (action === "observe") {
      observation = await windowsObservation(sender, receiver, destination, "large.bin", deadline);
    }
    const accept = action !== "reject";
    const expected = accept ? "Completed" : "Rejected";
    const approvedAt = performance.now();
    receiver.write(accept ? "yes" : "no");
    if (action === "disconnect") {
      return await disconnectDuringUpload(sender, receiver, destination, before, deadline);
    }
    const [sendResult, receiveResult] = await Promise.all([
      sender.waitFor(new RegExp(`Sender result: ${expected}, ([0-9]+) bytes`), deadline, "sender result"),
      receiver.waitFor(new RegExp(`Receiver result: ${expected}, ([0-9]+) bytes`), deadline, "receiver result"),
    ]);
    const approvalToResultMs = performance.now() - approvedAt;
    const [senderCode, receiverCode] = await Promise.all([sender.exit(deadline), receiver.exit(deadline)]);
    assert.equal(receiverCode, 0);
    if (accept) assert.equal(senderCode, 0);
    else assert.equal(senderCode, 1, "the demo reports rejection as a send error");
    assert.equal(sendResult[1], receiveResult[1], "peer byte counts differ");
    const bytesTransferred = Number(sendResult[1]);
    const metrics = await observation?.finish(bytesTransferred, approvedAt);
    return { outcome: expected, bytesTransferred, pairingRequestMs, approvalToResultMs, ...metrics };
  } finally {
    await Promise.all([receiver.dispose(), sender?.dispose(), observation?.dispose()]);
  }
}

const [, , executable, scratch, sourceSha, mode = "matrix"] = process.argv;
assert.ok(executable && scratch && sourceSha && process.argv.length <= 6,
  "usage: node validate-peer-demo.mjs <compiled loopback_node> <scratch directory> <source SHA> [matrix|disconnect|windows-benchmark]");
assert.ok(["matrix", "disconnect", "windows-benchmark"].includes(mode), "invalid mode");
if (mode === "windows-benchmark") assert.equal(process.platform, "win32", "the working-set probe requires Windows");
assert.match(sourceSha, /^[a-f0-9]{40}$/, "record the full source SHA used to build the example");
const root = await mkdtemp(join(resolve(scratch), "aerift-peer-demo-"));
const { directory, manifest } = await prepareFixtures(root, largeBytes);
const destination = join(root, "received");
await mkdir(destination);
const receipts = [];
let destinationEntries = [];
const matrix = [
  ["empty", "approve"], ["binary", "reject"], ["binary", "approve"],
  ["duplicate-a", "approve"], ["duplicate-b", "approve"], ["large", "approve"],
];
const cases = mode === "matrix" ? matrix
  : mode === "disconnect" ? [["large", "disconnect"], ["large", "approve"]]
  : [["large", "observe"]];
for (const [id, action] of cases) {
  const source = manifest.files.find(file => file.id === id);
  const receipt = await exchange(resolve(executable), join(directory, source.path), destination, action);
  const accept = receipt.outcome === "Completed";
  if (action !== "disconnect") assert.equal(receipt.bytesTransferred, accept ? source.sizeBytes : 0);
  const entries = await readdir(destination);
  const created = entries.filter(name => !destinationEntries.includes(name));
  assert.equal(entries.length, destinationEntries.length + Number(accept), "unexpected publication");
  let sha256;
  if (accept) {
    assert.equal(created.length, 1, "expected one newly published file");
    const saved = await hashFile(join(destination, created[0]));
    assert.equal(saved.sizeBytes, source.sizeBytes);
    assert.equal(saved.sha256, source.sha256);
    sha256 = saved.sha256;
  }
  destinationEntries = entries;
  receipts.push({ id, ...receipt, sha256 });
}
if (mode === "matrix") for (const id of ["duplicate-a", "duplicate-b"]) {
  const target = manifest.files.find(file => file.id === id);
  const sameNames = destinationEntries.filter(name => name.endsWith("same.bin"));
  const saved = await Promise.all(sameNames.map(name => hashFile(join(destination, name))));
  assert.ok(saved.some(file => file.sha256 === target.sha256), "a duplicate-name file was overwritten");
}
console.error(`Local fixtures and saved files: ${root}`);
console.log(JSON.stringify({ sourceSha, platform: process.platform, architecture: process.arch, receipts }, null, 2));
