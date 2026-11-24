import { friendsFixture } from "./friends-fixture";
import type { FriendsRequest } from "@aerift/app-contract/friends";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { AppSnapshot, FileSelection, TransferRequest } from "@aerift/app-contract";
import { installMotionFixture, respondToMotionReceipt } from "./motion-fixture";
import { DesktopApp } from "../../apps/aerift/src/windows/DesktopApp";
import "@aerift/ui/styles.css";
import "../../apps/aerift/public/appearance-bootstrap.css";
import "../../apps/aerift/src/layout.css";

const query = new URLSearchParams(location.search);
const scheme = query.get("scheme") === "light" ? "light" : "dark";
const route = query.get("route") ?? "home";
const state = query.get("state") ?? "populated";
const settings = { version: 1, theme: "glass", scheme, windowMode: "full",
  motion: query.get("motion") === "reduce" ? "reduce" : "system",
  transparency: query.get("transparency") === "reduce" ? "reduce" : "system" };
localStorage.setItem("aerift.settings.v1", JSON.stringify({ route, experience: settings, appearance: settings }));

const first = { id: "iphone", name: "Mira’s iPhone", paired: true, online: true, platform: "ios" } as const;
const second = { id: "laptop", name: "Travel laptop", paired: true, online: false, platform: "windows" } as const;
const file: FileSelection = { selectionId: "visual-fixture", name: "Harbor survey.pdf", sizeBytes: 36812 };
const motionFixture = query.get("motionFixture") === "1";
let snapshot: AppSnapshot = { version: 1, devices: state === "empty" ? [] : [first, second], pendingPairing: [],
  transfers: state === "empty" || motionFixture ? [] : [
    { id: "current", deviceId: first.id, direction: "outgoing", state: "transferring", bytesTransferred: 15273, file },
    { id: "received", deviceId: first.id, direction: "incoming", state: "completed", bytesTransferred: 211400,
      file: { name: "Harbor aerial.heic", sizeBytes: 211400 } },
    { id: "stopped", deviceId: second.id, direction: "outgoing", state: "cancelled", bytesTransferred: 0,
      file: { name: "North coast notes.txt", sizeBytes: 4722 } },
  ] };
const subscribers = new Map<number, number>();
function emit(id: number, value: AppSnapshot) {
  const index = subscribers.get(id);
  if (index === undefined) return;
  (window as Window & { __TAURI_INTERNALS__?: { runCallback(id: number, value: unknown): void } }).__TAURI_INTERNALS__?.runCallback(id, { index, message: value });
  subscribers.set(id, index + 1);
}
function broadcast(value: AppSnapshot) {
  snapshot = value;
  for (const id of subscribers.keys()) emit(id, value);
}
if (motionFixture) installMotionFixture(first.id, () => snapshot, broadcast);
const friends = query.get("friendsFixture") === "1" ? friendsFixture(() => snapshot, broadcast) : undefined;
mockIPC((cmd, args) => {
  if (friends && cmd === "friends_create_contact_card") return friends.createContactCard().then(result => {
    if (!result.ok) throw result.error;
    return result.value;
  });
  if (friends && cmd === "friends_create_invitation") return friends.createInvitation((args as { recipientCard: string }).recipientCard).then(result => {
    if (!result.ok) throw result.error;
    return result.value;
  });
  if (friends && cmd === "friends_pick_object") return friends.pickObject("file").then(result => result.ok ? result.value : null);
  if (friends && cmd === "friends_apply") return friends.apply((args as { request: FriendsRequest }).request).then(result => {
    if (!result.ok) throw result.error;
  });
  if (cmd === "watch_app") {
    if (state === "offline") throw { code: "connection_failed" };
    const channel = (args as { updates: { id: number } }).updates;
    subscribers.set(channel.id, 0);
    emit(channel.id, snapshot);
    return String(channel.id);
  }
  if (cmd === "unwatch_app") subscribers.delete(Number((args as { subscriptionId: string }).subscriptionId));
  if (cmd === "transfer_app_file" && motionFixture) {
    const receipt = respondToMotionReceipt((args as { request: TransferRequest }).request, snapshot);
    if (!receipt) throw { code: "invalid_request" };
    broadcast({ ...snapshot, transfers: [receipt, ...snapshot.transfers.filter(item => item.id !== receipt.id)] });
    return receipt;
  }
  if (cmd === "get_receive_folder") return { active: "Downloads", next: null };
  if (cmd === "watch_desktop_ambient") return true;
  if (cmd === "select_app_file") return file;
  return undefined;
}, { shouldMockEvents: true });

createRoot(document.getElementById("root")!).render(<DesktopApp />);
