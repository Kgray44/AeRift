import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { runInThisContext } from "node:vm";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

// The UI package is built from TypeScript source by Vite. Load the same
// components and React runtime for server rendering without a second build.
const require = createRequire(import.meta.url);
const modules = new Map();
function loadModule(url) {
  if (modules.has(url.href)) return modules.get(url.href);
  const { outputText } = ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  modules.set(url.href, exports);
  runInThisContext(`(function (exports, require) { ${outputText}\n})`)(exports, name => {
    if (!name.startsWith(".")) return require(name);
    const jsx = new URL(`${name}.tsx`, url);
    return loadModule(existsSync(jsx) ? jsx : new URL(`${name}.ts`, url));
  });
  return exports;
}

const render = (name, props) => {
  const ui = loadModule(new URL("../../packages/ui/src/RiftExperience.tsx", import.meta.url));
  return renderToStaticMarkup(createElement(ui[name], props));
};
const file = { name: "Field notes.pdf", sizeBytes: 1024 };
const transfer = {
  id: "transfer-6", deviceId: "peer-3", direction: "outgoing", state: "transferring", bytesTransferred: 768, file,
};
const geometry = { width: 420, height: 320, source: { x: 120, y: 160 }, destination: { x: 350, y: 80 } };

test("Rift exposes byte progress while sending", () => {
  const markup = render("RiftExperience", { transfer, deviceName: "Phone" });
  assert.match(markup, /role="progressbar"[^>]*aria-valuenow="75"/);
  assert.match(markup, /768 B of 1 KiB/);
  assert.match(markup, /Phone/);
});

test("Rift waits for the authoritative delivery result after all bytes arrive", () => {
  const markup = render("RiftExperience", { transfer: { ...transfer, bytesTransferred: 1024 } });
  assert.match(markup, /class="ae-rift-status"[^>]*>Awaiting delivery confirmation/);
  assert.doesNotMatch(markup, /\bDelivered\b/);
});

test("Rift settles a completed zero-byte transfer", () => {
  const markup = render("RiftExperience", {
    transfer: { ...transfer, direction: "incoming", state: "completed", file: { ...file, sizeBytes: 0 }, bytesTransferred: 0 },
  });
  assert.match(markup, /data-object-state="settled"/);
  assert.match(markup, /class="ae-rift-status"[^>]*>Received and stored/);
});

test("an incoming Rift runs from the peer to the local anchor", () => {
  const markup = render("RiftLink", { geometry, transfer: { ...transfer, direction: "incoming" } });
  assert.match(markup, /d="M 350 80 Q [\d. ]+ 120 160"/);
  assert.match(markup, /stroke-dashoffset="0.25"/);
});

test("the sender launches from the dock without advancing byte progress", () => {
  const markup = render("RiftLink", {
    geometry, transfer: { ...transfer, state: "pending", bytesTransferred: 0 }, departureFrom: { x: 90, y: 365 },
  });
  assert.match(markup, /class="ae-rift-flight ae-rift-launch"/);
  assert.match(markup, /stroke-dashoffset="1"/);
  assert.doesNotMatch(markup, /class="ae-rift-payload"/);
});

test("the arrival glyph only appears on the receiver after confirmed delivery", () => {
  const incoming = { ...transfer, direction: "incoming", bytesTransferred: 1024 };
  assert.doesNotMatch(render("RiftLink", { geometry, transfer: incoming }), /ae-rift-arrival/);
  const completed = render("RiftLink", { geometry, transfer: { ...incoming, state: "completed" } });
  assert.match(completed, /class="ae-rift-flight ae-rift-arrival"/);
  assert.doesNotMatch(completed, /class="ae-rift-payload"/);
});

test("the compact Rift marks actual byte progress and confirms arrival separately", () => {
  const renderCompact = updates => render("RiftExperience", {
    transfer: { ...transfer, direction: "incoming", ...updates }, compactPath: true,
  });
  const receiving = renderCompact({});
  assert.match(receiving, /class="ae-rift-inline"[^>]*aria-hidden="true"/);
  assert.match(receiving, /inset-inline-start:75%/);
  assert.doesNotMatch(renderCompact({ bytesTransferred: 1024 }), /data-arrived="true"/);
  assert.match(renderCompact({ state: "completed" }), /data-arrived="true"/);
});

test("the held capsule preserves file identity and the selected file count", () => {
  const props = { files: [file, { name: "Sketch.png", sizeBytes: 64 }], objectId: "selection-8" };
  for (const state of ["resting", "anticipating", "held", "recovering"]) {
    const markup = render("TransferObject", { ...props, state });
    assert.match(markup, /data-object-id="selection-8"/);
    assert.match(markup, /Field notes\.pdf/);
    assert.match(markup, /2 files/);
  }
});
