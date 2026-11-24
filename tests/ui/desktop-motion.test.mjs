import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";

const source = file => readFile(new URL(`../../apps/aerift/src/windows/${file}`, import.meta.url), "utf8");

test("desktop routes reuse the live Orbit content and defer to an active Orbit morph", async () => {
  const app = await source("DesktopApp.tsx");
  assert.match(app, /useDesktopContentEnter\(route, surfaceRef, "orbit"\)/);
  assert.doesNotMatch(app, /<(?:OrbitSurface|TransferWorkspace|DesktopWorkspace)[^>]*\bkey=/);
});

test("desktop Workspace navigation preserves native disclosures and animates only the changed items view", async () => {
  const workspace = await source("DesktopWorkspace.tsx");
  assert.match(workspace, /useDesktopContentEnter\(current\?\.id, itemsRef\)/);
  assert.match(workspace, /<section ref=\{itemsRef\}[^>]*className="aerift-workspace-items"/);
  assert.match(workspace, /<details className="aerift-workspace-create" ref=\{noteEditor\}>/);
  assert.match(workspace, /noteEditor\.current\.open = true/);
});

async function entryPoint(windowsCheckout = false) {
  const ts = await import("typescript");
  const moduleSource = await source("desktopContentMotion.ts");
  const { outputText } = ts.transpileModule(windowsCheckout ? moduleSource.replace(/\r?\n/g, "\r\n") : moduleSource,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  runInThisContext(`(function (exports, require) { ${outputText}\n})`)(exports, createRequire(import.meta.url));
  return exports.beginDesktopContentEnter;
}

function fixture() {
  const attributes = new Map();
  const animations = [];
  const preference = Object.assign(new EventTarget(), { matches: false });
  const document = Object.assign(new EventTarget(), { hidden: false, defaultView: { matchMedia: () => preference } });
  const target = {
    ownerDocument: document,
    getClientRects: () => [1],
    closest: () => null,
    getAnimations: () => animations,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name),
  };
  const surface = { ownerDocument: document, dataset: {}, querySelector: () => target };
  return { attributes, animations, preference, document, target, surface };
}

test("an actual Orbit morph wins over direct feedback; reduced and hidden state never start an effect", async () => {
  const begin = await entryPoint();
  const { attributes, animations, preference, document, target, surface } = fixture();
  animations.push({ finished: new Promise(() => {}) });
  surface.dataset.morphing = "true";
  assert.equal(begin(surface, "orbit"), undefined);
  delete surface.dataset.morphing;
  preference.matches = true;
  assert.equal(begin(surface, "orbit"), undefined);
  preference.matches = false;
  document.hidden = true;
  assert.equal(begin(target, "workspace"), undefined);
  document.hidden = false;
  target.getClientRects = () => [];
  assert.equal(begin(target, "workspace"), undefined);
  assert.equal(attributes.size, 0);
});

test("a superseded route cannot remove a newer route's animation marker", async () => {
  const begin = await entryPoint();
  const { attributes, animations, surface, document } = fixture();
  let resolveFirst;
  animations.push({ finished: new Promise(resolve => { resolveFirst = resolve; }) });
  const cleanupFirst = begin(surface, "orbit");
  assert.equal(attributes.get("data-ae-route-enter"), "neutral");
  cleanupFirst();
  animations[0] = { finished: new Promise(() => {}) };
  begin(surface, "orbit");
  resolveFirst();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(attributes.get("data-ae-route-enter"), "neutral");
  document.hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(attributes.size, 0);
});

test("completion or a live OS reduced-motion change cleans up just the decorative marker", async () => {
  const begin = await entryPoint();
  const { attributes, animations, preference, target } = fixture();
  let finish;
  animations.push({ finished: new Promise(resolve => { finish = resolve; }) });
  begin(target, "workspace");
  finish();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(attributes.size, 0);
  animations[0] = { finished: new Promise(() => {}) };
  begin(target, "workspace");
  preference.matches = true;
  preference.dispatchEvent(new Event("change"));
  assert.equal(attributes.size, 0);
});


test("desktop motion test harness supports a Windows CRLF checkout", async () => {
  const begin = await entryPoint(true);
  const { attributes, target } = fixture();
  assert.equal(begin(target, "workspace"), undefined);
  assert.equal(attributes.size, 0);
});
