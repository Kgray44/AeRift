import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relative) => readFileSync(new URL("../../" + relative, import.meta.url), "utf8").replaceAll("\r\n", "\n");

test("private Remote developer startup has a separate native dispatcher and fails closed", () => {
  const native = read("apps/aerift/src-tauri/src/lib.rs");
  const gated = native.slice(native.indexOf("pub fn run()"), native.indexOf("let builder = tauri::Builder"));
  assert.match(gated, /--private-remote-dev/);
  assert.match(gated, /not\(feature = "private-remote-app"\)/);
  assert.match(gated, /No listener was started/);
  assert.match(gated, /return;/);
  const module = read("apps/aerift/src-tauri/src/private_remote_app.rs");
  assert.match(module, /config_mut\(\)\.app\.windows\.clear/);
  assert.match(module, /app_local_data_dir/);
  assert.match(module, /PrivateRemoteProfile::open/);
  assert.match(module, /if !confirmed/);
  assert.match(module, /TcpListener::bind\(runtime\.endpoint\)/);
  assert.doesNotMatch(module, /windows::watch_app|AppRuntime|[dD]iscovery::|set_receiver_ready/);
  assert.doesNotMatch(native.slice(native.indexOf("let builder = tauri::Builder")), /private_remote_start|private_remote_action/);
});

test("private Remote view never equates Native authorization with discovery or file consent", () => {
  const entry = read("apps/aerift/src/main.tsx");
  assert.match(entry, /__AERIFT_PRIVATE_REMOTE_DEV__ === true/);
  const view = read("apps/aerift/src/windows/PrivateRemoteDev.tsx");
  assert.match(view, /disabled=\{!permission \|\| !snapshot \|\| busy\}/);
  assert.match(view, /Authorized Remote devices/);
  assert.match(view, /Saved authorization only/);
  assert.match(view, /action: "confirm_pairing"/);
  assert.match(view, /offer\.status\.state === "pending"/);
  assert.match(view, /action: "respond", peerId: offer\.peerId, id: offer\.id, accepted: true/);
});
