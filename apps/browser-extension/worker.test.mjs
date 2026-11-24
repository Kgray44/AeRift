import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const tab = { id: 9, windowId: 2, active: true, incognito: false, url: "https://example.test/a" };
const makeEvent = () => ({ addListener(fn) { this.fn = fn; } });
const action = makeEvent(), menu = makeEvent();
let mode, statuses, calls, send, focus;
let finish;
globalThis.chrome = {
  runtime: { onInstalled: makeEvent(), async sendNativeMessage(host, packet) {
    send.push({ host, packet });
    if (mode === "unavailable") throw new Error("simulated missing host");
    return { version: 1, status: "captured" };
  } },
  action: { onClicked: action, async setTitle(info) { statuses.push(info.title); finish?.(); } },
  contextMenus: { onClicked: menu },
  windows: { async getLastFocused() { return { id: focus, incognito: false, focused: true }; } },
  tabs: { async get() { return mode === "stale-tab" ? { ...tab, url:"https://example.test/b" } : tab; } },
  scripting: { async executeScript(request) {
    calls.push(request.target);
    if (request.target.documentIds) {
      return [{ documentId: mode === "stale-document" ? "beta" : "alpha", frameId: 0, result: tab.url }];
    }
    return [{ documentId: "alpha", frameId: 0, result: { url:tab.url, selection:"fixture text" } }];
  } },
};
await import("./worker.mjs");

async function click(browserTab = tab) {
  await new Promise((resolve) => { finish = resolve; action.fn(browserTab); });
}
function reset(value) { mode=value; statuses=[]; calls=[]; send=[]; focus=2; }

test("minimal explicit permissions; no host access, persistent injection or private access", () => {
  const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url)));
  assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "contextMenus", "nativeMessaging"]);
  assert.equal(manifest.incognito, "not_allowed");
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
});

test("only qualified user activation releases snapshot to the bounded host; reconnect on next action", async () => {
  reset("unavailable");
  await click();
  assert.match(statuses.at(-1), /Unavailable/);
  mode = "ok";
  await click();
  assert.equal(send.length, 2);
  assert.deepEqual(send.at(-1).packet, { version:1, kind:"selection", value:"fixture text" });
  assert.deepEqual(calls.at(-1), { tabId:9, documentIds:["alpha"] });
  assert.match(statuses.at(-1), /nothing sent/);
});

test("same-URL replacement, same-origin URL change, wrong window and incognito produce no native calls", async () => {
  for (const mode of ["stale-tab", "stale-document"]) {
    reset(mode);
    await click();
    assert.equal(send.length, 0);
  }
  reset("ok"); focus=3;
  await click();
  assert.equal(calls.length, 0);
  reset("ok");
  await click({ ...tab, incognito:true });
  assert.equal(calls.length, 0);
});
