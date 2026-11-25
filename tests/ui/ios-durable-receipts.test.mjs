import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mobileReceivedRows } from "../../apps/aerift/src/ios/mobile-received-activity.ts";
const key = "a".repeat(64) + ":f6ee6d8d-8d96-4972-8e0a-0eb538067fa6";
test("only canonical native iOS IDs regain preview authority, with no synthetic timestamp", () => {
  const rows = mobileReceivedRows([], [{ id: key, name: "Count.txt", sizeBytes: 12 },
    { id: "/Documents/Received/spoof.txt", name: "spoof", sizeBytes: 0 },
    { id: key, name: "dup", sizeBytes: 20 }], true);
  assert.deepEqual(rows, [{ id: key, name: "Count.txt", sizeBytes: 12 }]);
  assert.deepEqual(mobileReceivedRows([], [{ id: key, name: "Count.txt", sizeBytes: 12 }]), []);
});
test("bounded native history persists only authorized completed records and retains exact preview digest", () => {
  const read = name => readFileSync(new URL("../../apps/aerift/src-tauri/src/" + name, import.meta.url), "utf8");
  const native = read("runtime/ios.rs");
  assert.match(native, /receiver\.subscribe\(\)/);
  assert.match(native, /completion_receipts\.is_enabled\(\)/);
  assert.match(native, /verified_text\([\s\S]*receipt\.sha256/);
  const store = read("platform/ios/src/receipts.rs");
  assert.match(store, /State::Completed/);
  assert.match(store, /status\.bytes_transferred != incoming\.offer\.size_bytes/);
  assert.match(store, /const MAX_RECEIPTS: usize = 60/);
  assert.doesNotMatch(store, /read_dir|SystemTime|Date\.now/);
});
