// Run: AERIFT_JSDOM_MODULE=/absolute/path/to/jsdom/lib/api.js node scripts/measure-spatial-peer-commits.mjs e8cab6ef
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import React from "react";

const entry = "packages/ui/src/SpatialScene.tsx";
const base = process.argv[2];
if (!base) throw new Error("Pass the baseline Git revision.");
const jsdom = process.env.AERIFT_JSDOM_MODULE;
const { JSDOM } = await import(jsdom ? pathToFileURL(jsdom).href : "jsdom");
const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const nodeRequire = createRequire(import.meta.url);

function component(ref, onCommit) {
  const cache = new Map();
  function load(path) {
    if (cache.has(path)) return cache.get(path);
    const result = {};
    cache.set(path, result);
    let source = ref && path === entry
      ? execFileSync("git", ["show", ref + ":" + path], { encoding: "utf8" })
      : readFileSync(path, "utf8");
    if (path === entry) {
      const marker = "const statusId = useId();";
      assert.equal(source.split(marker).length, 2);
      // Instrument only the test-transpiled source. Count a layout effect once
      // per committed Peer render, not speculative render calls or DOM writes.
      source = source.replace(marker, marker + "useLayoutEffect(() => recordPeerCommit());");
    }
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    });
    const lookup = name => {
      if (!name.startsWith(".")) return nodeRequire(name);
      if (name.endsWith(".css")) return {};
      const pathBase = join(dirname(path), name);
      const target = [pathBase + ".ts", pathBase + ".tsx"].find(existsSync);
      if (!target) throw new Error("Cannot resolve " + name);
      return load(target);
    };
    new Function("exports", "require", "recordPeerCommit", outputText)(result, lookup, onCommit);
    return result;
  }
  return load(entry).SpatialScene;
}

function scenario(ref) {
  const host = document.getElementById("root");
  let commits = 0;
  const Scene = component(ref, () => { commits++; });
  const root = createRoot(host);
  const devices = Array.from({ length: 6 }, (_, idx) => ({
    id: "peer-" + idx, name: "Device " + idx, platform: idx % 2 ? "ios" : "windows", paired: true, online: true,
  }));
  const picks = [];
  const onSelect = id => picks.push(id), onPair = () => {};
  const render = (frame, props) => React.act(() => root.render(React.createElement(Scene, {
    discovery: "available", devices: devices.map(device => ({ ...device })), onSelect, onPair, ...props,
  }, React.createElement("output", null, "Progress " + frame))));
  render(0);
  const mounted = commits;
  for (let i = 1; i <= 120; i++) render(i);
  const unchanged = commits - mounted;
  assert.equal(host.querySelector("output").textContent, "Progress 120");
  assert.equal(host.querySelectorAll("[data-peer-anchor]").length, 6);
  render(121, { selectedId: "peer-2", activePeerId: "peer-2" });
  const changed = commits - mounted - unchanged;
  const peer = id => host.querySelector(`[data-peer-anchor="${id}"]`).closest("label");
  assert.equal(peer("peer-2").dataset.peerState, "active");
  assert.ok(peer("peer-2").querySelector("input").checked);
  React.act(() => peer("peer-1").querySelector("input").click());
  assert.deepEqual(picks, ["peer-1"]);
  devices[1] = { ...devices[1], online: false, name: "Renamed" };
  render(122);
  assert.equal(peer("peer-1").dataset.peerState, "offline");
  assert.ok(peer("peer-1").querySelector("input").disabled);
  assert.equal(peer("peer-1").querySelector("strong").textContent, "Renamed");
  let otherPick;
  render(123, { onSelect: id => { otherPick = id; } });
  React.act(() => peer("peer-3").querySelector("input").click());
  assert.equal(otherPick, "peer-3", "a genuinely replaced handler is never retained");
  render(124, { busy: true });
  assert.ok(peer("peer-3").querySelector("input").disabled);
  React.act(() => root.unmount());
  return { mounted, unchanged, changed };
}

const before = scenario(base), after = scenario(undefined);
assert.equal(before.mounted, 6);
assert.equal(before.unchanged, 720);
assert.deepEqual(after, { mounted: 6, unchanged: 0, changed: 1 });
console.log(JSON.stringify({ baseline: before, candidate: after }));
