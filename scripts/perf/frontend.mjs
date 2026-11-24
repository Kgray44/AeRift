import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { SCHEMA, metric, unavailable, validateEvidence } from "./evidence.mjs";

export function initialAssets(manifest, entry) {
  const seen = new Set();
  const js = new Set();
  const css = new Set();
  function visit(key) {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    assert.ok(chunk && typeof chunk.file === "string", `missing Vite manifest node: ${key}`);
    if (/\.m?js$/.test(chunk.file)) js.add(chunk.file);
    if (/\.css$/.test(chunk.file)) css.add(chunk.file);
    for (const asset of chunk.css ?? []) css.add(asset);
    for (const dependency of chunk.imports ?? []) visit(dependency);
  }
  assert.equal(manifest[entry]?.isEntry, true, "expected selected HTML entry");
  visit(entry);
  return { js: [...js].sort(), css: [...css].sort() };
}

async function directoryAssets(root, dir = root) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const next = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await directoryAssets(root, next));
    else {
      assert.ok(entry.isFile(), "unexpected output entry");
      files.push(path.relative(root, next).split(path.sep).join("/"));
    }
  }
  return files;
}

async function inspectBundle(root) {
  const manifestFile = ".vite/manifest.json";
  const manifest = JSON.parse(await readFile(path.join(root, manifestFile), "utf8"));
  const initial = initialAssets(manifest, "index.html");
  const paths = (await directoryAssets(root)).filter((file) => file !== manifestFile).sort();
  const assets = new Map();
  const hash = createHash("sha256");
  for (const name of paths) {
    const content = await readFile(path.join(root, name));
    const digest = createHash("sha256").update(content).digest("hex");
    hash.update(JSON.stringify([name, digest]) + "\n");
    assets.set(name, {
      bytes: content.length,
      gzip: /\.(?:m?js|css)$/.test(name) ? gzipSync(content, { level: 6 }).length : 0,
    });
  }
  const sum = (files, field) => files.reduce((total, file) => {
    assert.ok(assets.has(file), `missing manifest file: ${file}`);
    return total + assets.get(file)[field];
  }, 0);
  const js = paths.filter((file) => /^assets\/.*\.m?js$/.test(file));
  const css = paths.filter((file) => /^assets\/.*\.css$/.test(file));
  return {
    outputSha256: hash.digest("hex"),
    "startup.js.raw": sum(initial.js, "bytes"),
    "startup.js.gzip": sum(initial.js, "gzip"),
    "startup.css.raw": sum(initial.css, "bytes"),
    "startup.css.gzip": sum(initial.css, "gzip"),
    "emitted.js.raw": sum(js, "bytes"),
    "emitted.js.gzip": sum(js, "gzip"),
    "emitted.css.raw": sum(css, "bytes"),
    "emitted.css.gzip": sum(css, "gzip"),
    "other-output.raw": sum(paths.filter((file) => !js.includes(file) && !css.includes(file)), "bytes"),
  };
}

function command(executable, args, cwd) {
  return execFileSync(executable, args, { cwd, encoding: "utf8", timeout: 120_000,
    windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"] });
}

function processorQuota() {
  return readFile("/sys/fs/cgroup/cpu.max", "utf8").then(s => s.trim(), () => null);
}
function memoryLimit() {
  return readFile("/sys/fs/cgroup/memory.max", "utf8").then(s => s.trim(), () => null);
}

export async function benchmarkFrontend(repo, trials = 7, context = "local developer build") {
  assert.ok(Number.isInteger(trials) && trials >= 5 && trials <= 20, "use 5–20 measured trials");
  assert.ok(typeof context === "string" && context.trim(), "name the actual measurement environment");
  repo = path.resolve(repo);
  const git = (...args) => command("git", args, repo).trim();
  const commit = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  const clean = () => git("status", "--porcelain=v1", "--untracked-files=normal").length === 0;
  assert.ok(clean(), "benchmark requires a clean source checkout");
  const cwd = path.join(repo, "apps", "aerift");
  const require = createRequire(path.join(cwd, "package.json"));
  const packagePaths = Object.fromEntries(["typescript", "vite"].map(name => [name, require.resolve(name + "/package.json")]));
  const versions = Object.fromEntries(Object.entries(packagePaths).map(([key, file]) => [key, require(file).version]));
  const commands = {
    typescript: [path.join(path.dirname(packagePaths.typescript), "bin", "tsc"), "--noEmit"],
    vite: [path.join(path.dirname(packagePaths.vite), "bin", "vite.js"), "build", "--manifest"],
  };
  const temporary = await mkdtemp(path.join(os.tmpdir(), "aerift-perf-"));
  const samples = [];
  const beforeLoad = os.loadavg();
  try {
    for (let index = 0; index <= trials; index++) {
      const output = path.join(temporary, "trial-" + index);
      const t0 = performance.now();
      command(process.execPath, commands.typescript, cwd);
      const t1 = performance.now();
      command(process.execPath, [...commands.vite, "--outDir", output], cwd);
      const t2 = performance.now();
      const sizes = await inspectBundle(output);
      if (index > 0) samples.push({ ts: t1-t0, vite: t2-t1, total: t2-t0, ...sizes });
      await rm(output, { recursive: true, force: true });
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  assert.equal(git("rev-parse", "HEAD"), commit, "source revision changed during measurement");
  assert.ok(clean(), "source changed during measurement");
  const values = (key) => samples.map(s => Math.round(s[key] * 1000) / 1000);
  const hashes = [...new Set(samples.map(s => s.outputSha256))];
  const byteFields = ["startup.js.raw", "startup.js.gzip", "startup.css.raw", "startup.css.gzip",
    "emitted.js.raw", "emitted.js.gzip", "emitted.css.raw", "emitted.css.gzip", "other-output.raw"];
  return validateEvidence({
    schema: SCHEMA, capturedAt: new Date().toISOString(), source: { commit, tree, clean: true },
    environment: {
      platform: process.platform, arch: process.arch, context, node: process.version, ...versions,
      visibleParallelism: os.availableParallelism(), cpuQuota: await processorQuota(), memoryLimitBytes: await memoryLimit(),
      visibleHostLoadAverageAtStart: beforeLoad, visibleHostLoadAverageAtEnd: os.loadavg(),
    },
    scenario: {
      id: "frontend.production-build", profile: "vite-production-tooling-only",
      conditions: { measuredTrials: trials, warmups: 1, serialBuilds: true, warmOperatingSystemCaches: true,
        excludes: ["npm dependency install", "native model staging", "Tauri wrapper/installer", "platform device startup"],
        initialGraph: "index.html static Vite manifest import closure; dynamic imports excluded",
        gzip: "independent JS/CSS file compression (zlib level 6), not network traffic",
        timingAdmission: "descriptive only; shared host contention and no dedicated performance runner",
        outputSha256ExcludingManifest: hashes,
      },
    },
    metrics: [
      metric("build.typescript.wall", "ms", "lower", values("ts")),
      metric("build.vite.wall", "ms", "lower", values("vite")),
      metric("build.total.wall", "ms", "lower", values("total")),
      ...byteFields.map(key => metric("bundle." + key, "bytes", "lower", values(key))),
      unavailable("app.cold-start.ready", "ms", "lower", "No installed app or native renderer startup measured."),
      unavailable("app.idle.process-tree-rss", "bytes", "lower", "No native application process tree sampled."),
      unavailable("app.navigation.frame-p95", "ms/frame", "lower", "No installed UI or physical display trace."),
      unavailable("app.energy.idle", "mWh", "lower", "No battery or energy sensor measurement."),
    ],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [repo = ".", trials = "7", context] = process.argv.slice(2);
  try {
    const evidence = await benchmarkFrontend(repo, Number(trials), context);
    console.log(JSON.stringify(evidence, null, 2));
  } catch (error) {
    console.error("frontend benchmark failed: " + error.message.split("\n")[0]);
    process.exitCode = 1;
  }
}
