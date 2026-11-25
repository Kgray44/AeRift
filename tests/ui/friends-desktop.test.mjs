import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
test("desktop Friends keeps native workflows out of the default list and detail", () => {
  const desktop = read("../../apps/aerift/src/windows/DesktopApp.tsx");
  assert.match(desktop, /<FriendsWorkspace[\s\S]*desktop=\{\{/);
  assert.match(desktop, /transfer: preferredContact => <WindowsFriendsFiles/);
  assert.match(desktop, /enrollment: <WindowsFriendsMember/);
  assert.equal(desktop.match(/<WindowsFriends(?:Files|Member)\b/g)?.length, 2);
  const workspace = read("../../apps/aerift/src/FriendsWorkspace.tsx");
  assert.match(workspace, /visited\.has\("transfer"\)/);
  assert.match(workspace, /visited\.has\("enrollment"\)/);
  assert.match(workspace, /pendingInvitation.*Review friendship invitation/s);
});

test("Friends pairing is a shared modal reached by a glass plus button", () => {
  const workspace = read("../../apps/aerift/src/FriendsWorkspace.tsx");
  const sheets = read("../../packages/ui/src/overlays.tsx");
  assert.match(workspace, /<FriendsIconButton icon="plus"/);
  assert.match(workspace, /aria-haspopup="dialog"/);
  assert.match(workspace, /<Sheet[\s\S]*open=\{pairing\}[\s\S]*title="Friends"/);
  assert.doesNotMatch(workspace, /visited\.has\("invite"\)/);
  assert.match(sheets, /node\.showModal\(\)/);
  assert.match(sheets, /onCancel=\{/);
});
