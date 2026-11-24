import { friendsFixture } from "./friends-fixture";
import { createRoot } from "react-dom/client";
import type { AppPort, AppSnapshot, Transfer } from "@aerift/app-contract";
import { installMotionFixture, respondToMotionReceipt } from "./motion-fixture";
import "../../apps/aerift/public/appearance-bootstrap.css";
import type { ImportedMedia, MobileMediaPort } from "../../apps/aerift/src/ios/mobile-media";
import { IosApp } from "../../apps/aerift/src/ios/IosApp";
import "@aerift/ui/styles.css";
import "../../apps/aerift/src/layout.css";

const device = { id: "desk", name: "Studio PC", paired: true, online: true, platform: "windows" } as const;
const file = { name: "Harbor survey.pdf", sizeBytes: 36812 };
const photo = { name: "Coastline.heic", sizeBytes: 91224 };
const incoming: Transfer = {
  id: "offer", direction: "incoming", deviceId: device.id,
  state: "pending", bytesTransferred: 0, file: photo,
};
const motionFixture = new URLSearchParams(location.search).get("motionFixture") === "1";
let snapshot: AppSnapshot = { version: 1, devices: [device], pendingPairing: [], transfers: [
  ...(!motionFixture ? [incoming] : []),
  { ...incoming, id: "earlier", state: "completed", file, bytesTransferred: file.sizeBytes },
] };
const watchers = new Set<(snapshot: AppSnapshot) => void>();
let selection = { ...file, selectionId: "fixture" };

function broadcast(value: AppSnapshot) {
  snapshot = value;
  for (const watch of watchers) watch(snapshot);
}
if (motionFixture) installMotionFixture(device.id, () => snapshot, broadcast);

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
    { id: "import-photo", name: "Harbor aerial.heic", kind: "photo", sizeBytes: 221402 },
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
const media: MobileMediaPort = {
  async list() { return { ok: true, value: imports }; },
  async import(source) {
    return saveImports([...imports, ...fixtureMedia[source].filter(item => !imports.some(value => value.id === item.id))
      .map(item => ({ ...item, assetId: item.id, schemaVersion: 1, ownership: "local" } as const))]);
  },
  async remove(id) {
    return saveImports(imports.filter(item => item.id !== id));
  },
  async select(id) {
    const item = imports.find(asset => asset.id === id);
    if (!item) return { ok: false, error: { code: "invalid_request" } };
    selection = { selectionId: id, sizeBytes: item.sizeBytes, name: item.name };
    return { ok: true, value: selection };
  },
  async present() { return { ok: true, value: undefined }; },
};

createRoot(document.getElementById("root")!).render(
  <IosApp port={port} media={media} pick={async source => {
    selection = { ...(source === "photos" ? photo : file), selectionId: "fixture" };
    return { ok: true, value: selection };
  }} />,
);
