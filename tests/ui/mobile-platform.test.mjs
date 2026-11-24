import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const read = name => readFileSync(new URL("../../apps/aerift/src/" + name, import.meta.url), "utf8");
const source = new URL("../../apps/aerift/src/ios/mobile-platform.ts", import.meta.url);
function load() {
  assert.ok(existsSync(source), "shared mobile platform adapter");
  const exports = {};
  runInNewContext(ts.transpileModule(readFileSync(source, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports });
  return exports;
}

test("Android routes mobile features through platform commands without changing iOS IPC", async () => {
  const { createMobileOperations } = load();
  const calls = [];
  const call = async (name, args) => { calls.push([name, args]); return { ok: true, value: name.startsWith("list_") ? [] : null }; };
  for (const platform of ["ios", "android"]) {
    const api = createMobileOperations(platform, call);
    await api.pick("photos");
    await api.retryDiscovery();
    await api.presentSelection("selection-1", "preview");
    await api.clipboardImageAvailable();
    await api.stageClipboardImage();
    await api.stageText({ name: "test.txt", text: "synthetic" });
    await api.openBrowser("https://example.org");
    await api.media.list();
    await api.media.select("asset-1");
  }
  assert.deepEqual(calls.map(([name]) => name), [
    "select_app_file", "retry_ios_discovery", "present_ios_selection", "ios_clipboard_image_available",
    "stage_ios_clipboard_image", "stage_ios_text", "open_ios_browser", "list_ios_media", "select_ios_media",
    "select_app_file", "retry_android_discovery", "present_android_selection", "android_clipboard_image_available",
    "stage_android_clipboard_image", "stage_android_text", "open_android_browser", "list_android_media", "select_android_media",
  ]);
  const expectedArgs = [
    { source: "photos" }, undefined, { selectionId: "selection-1", action: "preview" },
    undefined, undefined, { name: "test.txt", text: "synthetic" }, { url: "https://example.org" }, undefined, { assetId: "asset-1" },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(calls.slice(0, 9).map(([, args]) => args))),
    JSON.parse(JSON.stringify(expectedArgs)));
  assert.deepEqual(JSON.parse(JSON.stringify(calls.slice(9).map(([, args]) => args))),
    JSON.parse(JSON.stringify(expectedArgs)));
});

test("mobile settings and saved Notes keep existing iOS keys while Android is namespaced", () => {
  const { mobileStorageKeys } = load();
  const ios = Object.values(mobileStorageKeys("ios"));
  const android = Object.values(mobileStorageKeys("android"));
  assert.deepEqual(ios, [
    "aerift.ios.appearance.v1", "aerift.ios.workspace.v1", "aerift.ios.gestures.enabled",
    "aerift.ios.activity.v1", "aerift.ios.objects.v1", "aerift.ios.note-attachments.v1",
  ]);
  assert.deepEqual(android, ios.map(key => key.replace(".ios.", ".android.")));
});

test("native Android shares the mobile shell rather than using fallback or cloning it", () => {
  assert.match(read("App.tsx"), /Android.*<AndroidApp\s*\//);
  assert.match(read("ios/IosApp.tsx"), /function AndroidApp[^]*?<MobileApp/);
  assert.match(read("ios/IosApp.tsx"), /<TransferWorkspace\s+port=\{port\}\s+platform=\{platform\}/);
});

test("Android received handles address only transfer ID; iOS retains its original folder instructions", async () => {
  const { createMobileOperations, mobilePlatformCopy } = load();
  const calls = [];
  const failure = { ok: false, error: { code: "storage_failed" } };
  const call = async (name, args) => { calls.push([name, args]); return failure; };
  assert.equal(createMobileOperations("ios", call).presentReceived, undefined);
  const android = createMobileOperations("android", call);
  assert.equal(await android.presentReceived("receipt-id", "export"), failure);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["present_android_received", { transferId: "receipt-id", action: "export" }],
  ]);
  assert.match(mobilePlatformCopy.ios.receivedFolder, /On My iPhone/);
  assert.doesNotMatch(mobilePlatformCopy.android.receivedFolder, /iPhone/);
});

test("imported Android photos retain stable native asset IDs and durable object shape", async () => {
  const { createMobileOperations } = load();
  const calls = [];
  const picture = { id: "123", name: "Studio.png", kind: "photo", sizeBytes: 210 };
  const call = async (name, args) => { calls.push([name, args]); return { ok: true, value: [picture] }; };
  const media = createMobileOperations("android", call).media;
  const result = await media.import("photos");
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: true, value: [{ ...picture, assetId: "123", schemaVersion: 1, ownership: "local" }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["import_android_media", { source: "photos" }]]);
});

test("Android lists durable received copies through an opaque catalog; iOS does not call Android native IPC", async () => {
  const { createMobileOperations } = load();
  const received = { id: "received-123", name: "after-restart.pdf", sizeBytes: 17 };
  const calls = [];
  const call = async (name, args) => { calls.push([name, args]); return { ok: true, value: [received] }; };
  assert.equal(createMobileOperations("ios", call).listReceived, undefined);
  const android = createMobileOperations("android", call);
  assert.deepEqual(await android.listReceived(), { ok: true, value: [received] });
  await android.presentReceived(received.id, "preview");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["list_android_received", null],
    ["present_android_received", { transferId: received.id, action: "preview" }],
  ]);
});

test("Files renders either the persisted Android catalog or iOS live summary, never both", () => {
  const workspace = read("ios/MobileWorkspace.tsx");
  assert.match(workspace, /if \(current !== "files" \|\| !operations\.listReceived\) return;/);
  assert.match(workspace, /\[catalogRefresh, current, latestArrival, operations\]/);
  assert.match(workspace, /const visibleReceived = \(operations\.listReceived\s*\? catalog\s*: received\.map/);
  assert.match(workspace, /\.filter\(item => !documents \|\| isWorkspaceDocument/);
  assert.match(workspace, /presentReceived\(item\.id, "share"\)/);
});
