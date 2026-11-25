import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const module = "../../apps/aerift/src/windows/private-remote-upload.ts";
const read = path => readFileSync(new URL("../../" + path, import.meta.url), "utf8");
const frame = { kind: "file", name: "Survey.wav", sizeBytes: 1000, bytesTransferred: 200, state: "transferring" };

test("one operation exposes advancing native checkpoints, not consent, final delivery or path data", async () => {
  const { projectPrivateRemoteUpload } = await import(module);
  const first = projectPrivateRemoteUpload("file", undefined, frame);
  assert.deepEqual(first, { id: "private-remote-upload:file", kind: "file", direction: "outgoing", state: "transferring",
    file: { name: "Survey.wav", sizeBytes: 1000 }, bytesTransferred: 200 });
  for (const invalid of [
    null, [], { ...frame, kind: "folder" }, { ...frame, state: "accepted" }, { ...frame, state: "completed" },
    { ...frame, bytesTransferred: 0 }, { ...frame, bytesTransferred: 199 }, { ...frame, bytesTransferred: 1001 },
    { ...frame, bytesTransferred: 400, name: "Other.wav" }, { ...frame, bytesTransferred: 400, sizeBytes: 2000 },
  ]) assert.equal(projectPrivateRemoteUpload("file", first, invalid), first);
  assert.equal(projectPrivateRemoteUpload("file", undefined, { ...frame, name: "C:\\secret.txt" }), undefined);
  assert.equal(projectPrivateRemoteUpload("file", first, { ...frame, bytesTransferred: 800 }).bytesTransferred, 800);
});

test("progress attaches only to existing authorized picker transfer commands", () => {
  const app = read("apps/aerift/src-tauri/src/private_remote_app.rs");
  const file = app.split("fn windows_send_remote_file(")[1].split("#[cfg(test)]")[0];
  assert.match(file, /require_remote_origin\(&window\)\?[\s\S]+try_lock\(\)[\s\S]+blocking_pick_file\(\)[\s\S]+send_resumable_file_with_manifest_progress/);
  const folder = read("apps/aerift/src-tauri/src/private_remote_folder_mode.rs");
  const pick = folder.split("match action {")[1].split("FolderAction::Approve")[0];
  assert.match(pick, /FolderAction::PickSend[\s\S]+try_lock\(\)[\s\S]+trusted_devices\(\)[\s\S]+prepare_folder[\s\S]+node.send_folder/);
  assert.match(app, /status\.state != State::Transferring/);
  assert.doesNotMatch(file + pick, /\.emit\(|emit_to|send_legacy/);
  assert.match(read("crates/transfer/src/client/resume.rs"), /result = prepare\(id, path, name\) => result\?[\s\S]+progress\(&manifest, status\)/);
});

test("frontend closes file and folder channels with the invoked operation", () => {
  const file = read("apps/aerift/src/windows/PrivateRemoteDev.tsx");
  assert.match(file, /windows_send_remote_file[\s\S]+progress: transfer\.updates[\s\S]+finally\(\(\) => \{ transfer\.close\(\)/);
  const folder = read("apps/aerift/src/windows/PrivateRemoteFolders.tsx");
  assert.match(folder, /action\.action === "pick_send" \? upload\.begin\(\) : undefined/);
  assert.match(folder, /command\(action, transfer\?\.updates\)[\s\S]+finally\(\(\) => \{ transfer\?\.close\(\)/);
});
