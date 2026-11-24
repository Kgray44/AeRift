import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { AppSnapshot, FileSelection } from "@aerift/app-contract";
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
const snapshot: AppSnapshot = { version: 1, devices: state === "empty" ? [] : [first, second], pendingPairing: [],
  transfers: state === "empty" ? [] : [
    { id: "current", deviceId: first.id, direction: "outgoing", state: "transferring", bytesTransferred: 15273, file },
    { id: "received", deviceId: first.id, direction: "incoming", state: "completed", bytesTransferred: 211400,
      file: { name: "Harbor aerial.heic", sizeBytes: 211400 } },
    { id: "stopped", deviceId: second.id, direction: "outgoing", state: "cancelled", bytesTransferred: 0,
      file: { name: "North coast notes.txt", sizeBytes: 4722 } },
  ] };
mockIPC((cmd, args) => {
  if (cmd === "watch_app") {
    if (state === "offline") throw { code: "connection_failed" };
    const channel = (args as { updates: { id: number } }).updates;
    (window as Window & { __TAURI_INTERNALS__?: { runCallback(id: number, value: unknown): void } }).__TAURI_INTERNALS__?.runCallback(channel.id, { index: 0, message: snapshot });
    return "visual-fixture-watch";
  }
  if (cmd === "get_receive_folder") return { active: "Downloads", next: null };
  if (cmd === "watch_desktop_ambient") return true;
  if (cmd === "select_app_file") return file;
  return undefined;
}, { shouldMockEvents: true });

createRoot(document.getElementById("root")!).render(<DesktopApp />);
