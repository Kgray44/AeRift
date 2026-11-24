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
  assert.match(module, /TcpListener::bind\(endpoint\)/);
  const developerDispatcher = module.slice(module.indexOf("pub(crate) fn run("), module.indexOf("#[derive(Default)]"));
  assert.doesNotMatch(developerDispatcher, /windows::watch_app|AppRuntime|[dD]iscovery::|set_receiver_ready|windows_send_remote_file/);
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

test("the installed Windows shell admits either Nearby or explicit Remote, not both", () => {
  const lib = read("apps/aerift/src-tauri/src/lib.rs");
  const runtime = read("apps/aerift/src-tauri/src/runtime.rs");
  const remote = read("apps/aerift/src-tauri/src/private_remote_app.rs");
  const settings = read("apps/aerift/src/windows/RemoteModeSettings.tsx");
  assert.match(lib, /let nearby = matches!\(&mode, Ok\(None\)\)/);
  assert.match(lib, /configure_nearby\(nearby\)/);
  assert.match(runtime, /nearby_enabled\.get\(\).copied\(\) == Some\(true\)/);
  assert.match(runtime, /if !self.nearby_enabled\(\) \{[\s\S]*?get_or_try_init/);
  assert.match(remote, /LaunchMode::Remote\(endpoint\) => Ok\(endpoint\)/);
  assert.match(remote, /invitation_peer\(&invite\)\? != expected_issuer/);
  assert.match(remote, /sender\(\s*&\[route\],\s*peer_id/);
  assert.match(remote, /send_resumable_file\(&selected, name, stop/);
  assert.match(settings, /type="submit" disabled=\{!mode \|\| !authorized/);
  assert.match(settings, /windows_exit_for_remote_mode/);
});
