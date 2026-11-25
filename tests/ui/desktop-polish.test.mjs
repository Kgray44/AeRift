import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL("../../" + path, import.meta.url), "utf8");

test("desktop Home and Devices offer labeled icons without turning unpair into a one-click action", () => {
  const home = read("apps/aerift/src/windows/DesktopHome.tsx");
  const devices = read("apps/aerift/src/DeviceTrust.tsx");
  assert.match(home, /<IconAction[^>]+label="Manage devices"/);
  assert.match(home, /<IconAction[^>]+label="View activity"/);
  assert.match(devices, /<IconAction[^>]+label=\{\x60Unpair \$\{device\.name\}\x60\}[\s\S]{1,144}onClick=\{\(\) => setSelected\(device\.id\)\}/s);
  assert.match(devices, /<Button variant="danger" onClick=\{\(\) => void revoke\(device\.id\)\}/);
});

test("desktop Workspace uses a named picker trigger instead of browser input chrome", () => {
  const workspace = read("apps/aerift/src/windows/DesktopWorkspace.tsx");
  assert.match(workspace, /<IconAction[^>]+label=\{importLabel\}[^>]+onClick=\{\(\) => importInput\.current\?\.click\(\)\}/s);
  assert.match(workspace, /<input ref=\{importInput\} hidden aria-label=\{importLabel\} type="file" multiple/);
});

test("desktop Inbox actions distinguish search, refresh, integrity and saving", () => {
  const inbox = read("apps/aerift/src/windows/DesktopInbox.tsx");
  const library = read("apps/aerift/src/ReceivedActivity.tsx");
  assert.match(inbox, /<ReceivedActivity title="Inbox"/);
  assert.match(library, /Find a file\s+<input type="search"/);
  assert.match(library, /<IconAction[^>]+type="submit"[^>]+label=\{title === "Inbox" \? "Search Inbox"/);
  assert.match(library, /<IconAction[^>]+label=\{title === "Inbox" \? "Refresh Inbox"/);
  assert.match(inbox, /<IconAction[^>]+label=\{\x60Check integrity for \$\{entry\.name\}\x60\}/s);
  assert.match(inbox, /<IconAction[^>]+label=\{\x60Save a copy of \$\{entry\.name\}\x60\}/s);
  assert.match(inbox, /<Button disabled=\{explorerBusy\} onClick=\{\(\) => void confirmExplorer\(explorerView\.id\)\}>Save to this folder/);
});

test("the hosted desktop Rift hides secondary file-button text without changing consent or mobile copy", () => {
  const transfer = read("packages/ui/src/TransferWorkspace.tsx");
  assert.match(transfer, /hosted && outgoingObject \? <IconAction[^>]+label="Change file"/);
  assert.match(transfer, /\}>\{allowInbox \? "Accept to receive folder" : "Accept"\}/);
  assert.match(transfer, />\s*Accept to Inbox/);
});

