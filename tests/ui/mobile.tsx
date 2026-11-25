import { friendsFixture } from "./friends-fixture";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { AppPort, AppSnapshot, Transfer } from "@aerift/app-contract";
import { installMotionFixture, installTransferIslandFixture, respondToMotionReceipt } from "./motion-fixture";
import "../../apps/aerift/public/appearance-bootstrap.css";
import type { ImportedMedia, MobileMediaPort } from "../../apps/aerift/src/ios/mobile-media";
import { AndroidApp, IosApp } from "../../apps/aerift/src/ios/IosApp";
import "@aerift/ui/styles.css";
import "../../apps/aerift/src/layout.css";

const device = { id: "desk", name: "Studio PC", paired: true, online: true, platform: "windows" } as const;
const file = { name: "Harbor survey.pdf", sizeBytes: 36812 };
const photo = { name: "Coastline.heic", sizeBytes: 91224 };
const incoming: Transfer = {
  id: "offer", direction: "incoming", deviceId: device.id,
  state: "pending", bytesTransferred: 0, file: photo,
};
const receivedTextFixture = new URLSearchParams(location.search).get("receivedTextFixture") === "1";
const receiptPrefix = "a".repeat(64) + ":c6991e6c-ecd2-4f10-905c-0f254040dda";
const islandFixture = new URLSearchParams(location.search).get("islandFixture") === "1";
const motionFixture = new URLSearchParams(location.search).get("motionFixture") === "1";
let snapshot: AppSnapshot = { version: 1, devices: [device], pendingPairing: [], transfers: [
  ...(!motionFixture && !islandFixture ? [incoming] : []),
  ...(receivedTextFixture ? ([
    { ...incoming, id: receiptPrefix + "7", state: "completed", file: { name: "Verified notes.txt", sizeBytes: 89 }, bytesTransferred: 89 },
    { ...incoming, id: receiptPrefix + "8", state: "completed", file: { name: "Other receipt.txt", sizeBytes: 89 }, bytesTransferred: 89 },
  ] satisfies Transfer[]) : []),
  { ...incoming, id: "earlier", state: "completed", file, bytesTransferred: file.sizeBytes },
] };
const watchers = new Set<(snapshot: AppSnapshot) => void>();
let selection = { ...file, selectionId: "fixture" };

function broadcast(value: AppSnapshot) {
  snapshot = value;
  for (const watch of watchers) watch(snapshot);
}
if (motionFixture) installMotionFixture(device.id, () => snapshot, broadcast);
if (islandFixture) installTransferIslandFixture(device.id, () => snapshot, broadcast);

function publish(transfer: Transfer) {
  broadcast({ ...snapshot, transfers: [transfer, ...snapshot.transfers.filter(item => item.id !== transfer.id)] });
  return { ok: true, value: transfer } as const;
}

const friends = new URLSearchParams(location.search).get("friendsFixture") === "1"
  ? friendsFixture(() => snapshot, broadcast) : undefined;
const port: AppPort = {
  ...(friends ? { friends } : {}),
  async watch(listener) {
    watchers.add(listener);
    listener(snapshot);
    return { ok: true, value: () => { watchers.delete(listener); } };
  },
  async selectFile() { return { ok: true, value: selection }; },
  async pair() { return { ok: false, error: { code: "invalid_request" } }; },
  async transfer(request) {
    if (request.action === "offer" && request.selectionId === selection.selectionId && request.deviceId === device.id) {
      return publish({ id: "sent", direction: "outgoing", deviceId: device.id,
        file: selection, state: "pending", bytesTransferred: 0 });
    }
    if (request.action === "offer") return { ok: false, error: { code: "invalid_request" } };
    if (motionFixture) {
      const fixture = respondToMotionReceipt(request, snapshot);
      if (fixture) return publish(fixture);
      if (request.transferId.startsWith("motion-")) return { ok: false, error: { code: "invalid_request" } };
    }
    const item = snapshot.transfers.find(transfer => transfer.id === request.transferId);
    if (!item) return { ok: false, error: { code: "invalid_request" } };
    return publish({ ...item, state: request.action === "cancel" ? "cancelled" : request.accept ? "accepted" : "rejected" });
  },
};

const fixtureMedia = {
  files: [
    { id: "import-map", name: "Navigation chart.pdf", kind: "file", sizeBytes: 14890 },
    { id: "import-log", name: "Harbor log.txt", kind: "file", sizeBytes: 2741 },
  ],
  photos: [
    { id: "ff1a587e-224a-41f0-a368-5ab457e719a3", name: "Harbor aerial.heic", kind: "photo", sizeBytes: 221402 },
    { id: "import-video", name: "Harbor approach.mov", kind: "video", sizeBytes: 948962 },
  ],
} as const;

const fixtureLibraryKey = "aerift.fixture.media";
let imports: ImportedMedia[] = JSON.parse(localStorage.getItem(fixtureLibraryKey) ?? "[]");

function saveImports(items: ImportedMedia[]) {
  imports = items;
  localStorage.setItem(fixtureLibraryKey, JSON.stringify(items));
  return { ok: true, value: imports } as const;
}
// Expose only action names and synthetic fixture IDs in this fixture, never the app.
const mediaTrace: string[] | undefined = new URLSearchParams(location.search).get("photoGalleryFixture") === "1"
  ? ((window as Window & { aePhotoGalleryFixture?: string[] }).aePhotoGalleryFixture = []) : undefined;
const media: MobileMediaPort = {
  async list() { return { ok: true, value: imports }; },
  async import(source) {
    mediaTrace?.push(`import:${source}`);
    return saveImports([...imports, ...fixtureMedia[source].filter(item => !imports.some(value => value.id === item.id))
      .map(item => ({ ...item, assetId: item.id, schemaVersion: 1, ownership: "local" } as const))]);
  },
  async remove(id) {
    mediaTrace?.push(`remove:${id}`);
    return saveImports(imports.filter(item => item.id !== id));
  },
  async select(id) {
    mediaTrace?.push(`select:${id}`);
    const item = imports.find(asset => asset.id === id);
    if (!item) return { ok: false, error: { code: "invalid_request" } };
    selection = { selectionId: id, sizeBytes: item.sizeBytes, name: item.name };
    return { ok: true, value: selection };
  },
  ...(mediaTrace ? { async thumbnail(id: string) {
    mediaTrace.push(`thumbnail:${id}`);
    return id === "ff1a587e-224a-41f0-a368-5ab457e719a3"
      ? { ok: true, value: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAKABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCrRRRX1J86f//Z" } as const
      : { ok: false, error: { code: "invalid_request" } } as const;
  } } : {}),
  async present(id, action) { mediaTrace?.push(`${action}:${id}`); return { ok: true, value: undefined }; },
};

if (new URLSearchParams(location.search).get("receivedFixture") === "1") {
  const id = "received-" + "a".repeat(64);
  mockIPC((cmd, args) => {
    if (cmd === "list_android_received") return [{id, name: "Received chart.pdf", sizeBytes: 38413}];
    if (cmd === "present_android_received") {
      const { transferId, action } = args as { transferId: string; action: string };
      if (transferId !== id || action !== "preview") throw { code: "invalid_request" };
      return undefined;
    }
    return undefined;
  }, { shouldMockEvents: true });
}

const App = new URLSearchParams(location.search).get("platform") === "android" ? AndroidApp : IosApp;

createRoot(document.getElementById("root")!).render(
  <App port={port} media={media} pick={async source => {
    selection = { ...(source === "photos" ? photo : file), selectionId: "fixture" };
    return { ok: true, value: selection };
  }} />,
);

