import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
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

function start(executable, args) {
  const child = spawn(executable, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  const state = { text: "", closed: false };
  child.stdout.setEncoding("utf8").on("data", part => {
    state.text += part;
    if (state.text.length > 16384) {
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

async function exchange(executable, source, destination, accept) {
  const before = (await readdir(destination)).sort();
  const address = await loopbackAddress();
  const deadline = performance.now() + 150000;
  const receiver = start(executable, ["receive", address, destination]);
  let sender;
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

    const expected = accept ? "Completed" : "Rejected";
    const approvedAt = performance.now();
    receiver.write(accept ? "yes" : "no");
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
    return { outcome: expected, bytesTransferred: Number(sendResult[1]), pairingRequestMs, approvalToResultMs };
  } finally {
    await Promise.all([receiver.dispose(), sender?.dispose()]);
  }
}

const [, , executable, scratch, sourceSha] = process.argv;
assert.ok(executable && scratch && sourceSha && process.argv.length === 5,
  "usage: node validate-peer-demo.mjs <compiled loopback_node> <scratch directory> <source SHA>");
assert.match(sourceSha, /^[a-f0-9]{40}$/, "record the full source SHA used to build the example");
const root = await mkdtemp(join(resolve(scratch), "aerift-peer-demo-"));
const { directory, manifest } = await prepareFixtures(root, largeBytes);
const destination = join(root, "received");
await mkdir(destination);
const receipts = [];
let destinationEntries = [];
for (const [id, accept] of [
  ["empty", true], ["binary", false], ["binary", true], ["duplicate-a", true],
  ["duplicate-b", true], ["large", true],
]) {
  const source = manifest.files.find(file => file.id === id);
  const receipt = await exchange(resolve(executable), join(directory, source.path), destination, accept);
  assert.equal(receipt.bytesTransferred, accept ? source.sizeBytes : 0);
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
for (const id of ["duplicate-a", "duplicate-b"]) {
  const target = manifest.files.find(file => file.id === id);
  const sameNames = destinationEntries.filter(name => name.endsWith("same.bin"));
  const saved = await Promise.all(sameNames.map(name => hashFile(join(destination, name))));
  assert.ok(saved.some(file => file.sha256 === target.sha256), "a duplicate-name file was overwritten");
}
console.error(`Local fixtures and saved files: ${root}`);
console.log(JSON.stringify({ sourceSha, platform: process.platform, architecture: process.arch, receipts }, null, 2));
