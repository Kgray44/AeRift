import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendWorkspaceBrowserHistory, decodeWorkspaceBrowserHistory, workspaceBrowserDestination,
  workspaceBrowserSearch, workspaceBrowserHistoryLimit, readWorkspaceBrowserHistory,
  setWorkspaceBrowserHistory, recordWorkspaceBrowserLaunch, clearWorkspaceBrowserHistory,
} from "../../apps/aerift/src/workspace-browser-tools.ts";

test("address entry accepts bounded credential-free web URLs", () => {
  assert.equal(workspaceBrowserDestination(" example.org/docs?ref=1 "), "https://example.org/docs?ref=1");
  assert.equal(workspaceBrowserDestination("http://example.org:8080"), "http://example.org:8080/");
  for (const value of ["", "file:///C:/data", "javascript:alert(1)", "https://me:secret@example.org/", "https://exa\\mple.org", "//example.org", "two words", "example.org\t/path", "https://example.org/" + "é".repeat(4096)]) {
    assert.equal(workspaceBrowserDestination(value), undefined, value.slice(0, 80));
  }
});

test("explicit searches use a fixed https provider and do not re-send pasted URLs", () => {
  const url = new URL(workspaceBrowserSearch("glass & cameras"));
  assert.equal(url.origin, "https://www.google.com");
  assert.equal(url.searchParams.get("q"), "glass & cameras");
  assert.equal(workspaceBrowserSearch(""), undefined);
  assert.equal(workspaceBrowserSearch("https://u:secret@example.org/?token=x"), undefined);
  assert.equal(workspaceBrowserSearch("example.org/?token=x"), undefined);
});

test("history is disabled by default and strips query and fragment before persistence", () => {
  const address = "https://example.org/docs?token=abc#private";
  const none = decodeWorkspaceBrowserHistory(null);
  assert.deepEqual(none, { enabled: false, items: [] });
  assert.strictEqual(appendWorkspaceBrowserHistory(none, address, 1), none);
  const allowed = { enabled: true, items: [] };
  const next = appendWorkspaceBrowserHistory(allowed, address, 123);
  assert.deepEqual(next.items, [{ url: "https://example.org/docs", openedAt: 123 }]);
  assert.strictEqual(appendWorkspaceBrowserHistory(next, "https://u:password@example.org/", 124), next);
});

test("history revisits move to the top, are deduplicated, and never exceed the bound", () => {
  let history = { enabled: true, items: [] };
  for (let i = 0; i <= workspaceBrowserHistoryLimit; i++) {
    history = appendWorkspaceBrowserHistory(history, `https://example.org/${i}`, i + 1);
  }
  history = appendWorkspaceBrowserHistory(history, "https://example.org/1?changed=true", 1000);
  assert.equal(history.items.length, workspaceBrowserHistoryLimit);
  assert.deepEqual(history.items[0], { url: "https://example.org/1", openedAt: 1000 });
  assert.equal(history.items.filter(item => item.url.endsWith("/1")).length, 1);
  assert.equal(history.items.some(item => item.url.endsWith("/0")), false);
});

test("persisted invalid history is inert and private fields cannot reappear from storage", () => {
  assert.deepEqual(decodeWorkspaceBrowserHistory("garbage"), { enabled: false, items: [] });
  assert.deepEqual(decodeWorkspaceBrowserHistory(JSON.stringify({ enabled: false, items: [{ url: "https://example.org/", openedAt: 12 }] })), { enabled: false, items: [] });
  assert.deepEqual(decodeWorkspaceBrowserHistory(JSON.stringify({ enabled: true, items: [
    { url: "javascript:alert(1)", openedAt: 17 },
    { url: "https://example.org/path?secret=abc#token", openedAt: 19 },
    { url: "http://name:secret@example.org/", openedAt: 21 },
    { url: "https://example.org/", openedAt: -1 },
  ] })), { enabled: true, items: [{ url: "https://example.org/path", openedAt: 19 }] });
});

test("clear preserves consent and opt-out deletes history for the next launch", () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, item) => data.set(key, item), removeItem: key => data.delete(key) };
  const key = "browser-history-test";
  assert.equal(recordWorkspaceBrowserLaunch(key, "https://example.org/", storage), true);
  assert.equal(data.has(key), false);
  assert.equal(setWorkspaceBrowserHistory(key, true, storage), true);
  assert.equal(recordWorkspaceBrowserLaunch(key, "https://example.org/x?secret=hello", storage), true);
  assert.equal(data.get(key).includes("hello"), false);
  assert.equal(clearWorkspaceBrowserHistory(key, storage), true);
  assert.deepEqual(readWorkspaceBrowserHistory(key, storage), { enabled: true, items: [] });
  recordWorkspaceBrowserLaunch(key, "https://example.org/", storage);
  assert.equal(setWorkspaceBrowserHistory(key, false, storage), true);
  assert.equal(data.has(key), false);
});
