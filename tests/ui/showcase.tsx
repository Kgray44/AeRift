import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AppShell, Button, ConnectionStatus, GestureIndicator, Popover, SettingsPanel,
  Sheet, ThemeProvider, TransferWorkspace, createThemeRegistry, glassTheme,
  type AppearanceSettings, type GestureState, type TransferControls, type TransferIntent,
} from "../../packages/ui/src";
import type { AppPort, AppSnapshot, Device, FileSelection, Transfer } from "@aerift/app-contract";
import "../../packages/ui/src/styles.css";
import "./showcase.css";

const devices: readonly Device[] = [
  { id: "phone", name: "Mira's iPhone", platform: "ios", online: true, paired: true },
  { id: "desktop", name: "Studio PC", platform: "windows", online: true, paired: true },
  { id: "laptop", name: "Travel laptop", platform: "windows", online: false, paired: true },
];
const file: FileSelection = { selectionId: "file", name: "North Shore selects.zip", sizeBytes: 32 * 1024 ** 2 };
const startingTransfers: readonly Transfer[] = [
  { id: "first", deviceId: "desktop", direction: "outgoing", file: { name: "Studio references.zip", sizeBytes: 32 * 1024 ** 2 },
    state: "transferring", bytesTransferred: 19 * 1024 ** 2 },
  { id: "second", deviceId: "phone", direction: "incoming", file: { name: "Field notes.pdf", sizeBytes: 2 * 1024 ** 2 },
    state: "completed", bytesTransferred: 2 * 1024 ** 2 },
];

type Scene = "normal" | "searching" | "disconnected" | "incoming" | "failure" | "offer-pending" | "pairing";

function demoPort(scene: Scene): AppPort & { releaseOffer: () => void } {
  let transfers = scene === "incoming" || scene === "offer-pending"
    ? [{ id: "incoming", deviceId: "phone", direction: "incoming", file, state: "pending", bytesTransferred: 0 } satisfies Transfer, ...startingTransfers]
    : [...startingTransfers];
  const expiresAt = new Date(Date.now() + 300000).toISOString();
  const unpaired: Device = { id: "nearby", name: "Nearby iPhone", platform: "ios", online: true, paired: false };
  const demoCode = `aerift:v1:${"a".repeat(64)}:${"b".repeat(43)}`;
  let visibleDevices = devices;
  let pendingPairing: AppSnapshot["pendingPairing"] = scene === "pairing"
    ? [{ requestId: "pair-demo", device: unpaired, expiresAt }] : [];
  let releaseOffer: (() => void) | undefined;
  const listeners = new Set<(snapshot: AppSnapshot) => void>();
  let sequence = 0;
  const publish = () => {
    for (const listener of listeners) listener({ version: 1, devices: visibleDevices, transfers, pendingPairing });
  };
  return {
    releaseOffer() { releaseOffer?.(); },
    async watch(listener) {
      if (scene === "disconnected") return { ok: false, error: { code: "network_error" } };
      listeners.add(listener);
      if (scene !== "searching") publish();
      return { ok: true, value: () => { listeners.delete(listener); } };
    },
    async selectFile() {
      await new Promise(resolve => window.setTimeout(resolve, 420));
      return { ok: true, value: file };
    },
    async pair(request) {
      if (scene !== "pairing") return { ok: false, error: { code: "invalid_request" } };
      if (request.action === "create") return { ok: true, value: { state: "invitation", invitation: { code: demoCode, expiresAt } } };
      if (request.action === "redeem" && request.code !== demoCode) return { ok: false, error: { code: "pairing_expired" } };
      if (request.action === "confirm" && !pendingPairing.some(item => item.requestId === request.requestId)) {
        return { ok: false, error: { code: "pairing_expired" } };
      }
      if (request.action === "revoke") return { ok: false, error: { code: "invalid_request" } };
      pendingPairing = [];
      if (request.action === "confirm" && !request.accept) {
        publish();
        return { ok: true, value: { state: "rejected" } };
      }
      const paired = { ...unpaired, paired: true };
      visibleDevices = [...devices, paired];
      publish();
      return { ok: true, value: { state: "paired", device: paired } };
    },
    async transfer(request) {
      if (scene === "failure") return { ok: false, error: { code: "network_error" } };
      let transfer: Transfer;
      if (request.action === "offer") {
        transfer = { id: `demo-${++sequence}`, deviceId: request.deviceId, direction: "outgoing", file,
          state: "pending", bytesTransferred: 0 };
        transfers = [transfer, ...transfers];
      } else {
        const existing = transfers.find(item => item.id === request.transferId);
        if (!existing) return { ok: false, error: { code: "invalid_request" } };
        transfer = { ...existing, state: request.action === "cancel" ? "cancelled" : request.accept ? "completed" : "rejected",
          bytesTransferred: request.action === "respond" && request.accept ? existing.file.sizeBytes : existing.bytesTransferred };
        transfers = transfers.map(item => item.id === transfer.id ? transfer : item);
      }
      publish();
      if (request.action === "offer" && scene === "offer-pending") {
        await new Promise<void>(resolve => { releaseOffer = resolve; });
        releaseOffer = undefined;
      }
      return { ok: true, value: transfer };
    },
  };
}

const registry = createThemeRegistry([glassTheme, { id: "paper-preview", label: "Paper preview" }]);
const initialAppearance: AppearanceSettings = {
  theme: "glass", scheme: "dark", contrast: "system", transparency: "system", motion: "system",
};

function GestureDemo({ controls }: { controls: TransferControls }) {
  const [state, setState] = useState<GestureState>("idle");
  const armed = useRef<TransferIntent | null>(null);
  const valid = !!armed.current && armed.current.deviceId === controls.intent?.deviceId
    && armed.current.selectionId === controls.intent?.selectionId;
  const display = state === "armed" && !valid ? "interrupted" : state;

  return <div className="demo-gesture">
    <GestureIndicator state={display} />
    <Button variant="quiet" disabled={!controls.intent || controls.busy} onClick={async () => {
      if (valid && armed.current) {
        const captured = armed.current;
        armed.current = null;
        setState(await controls.send(captured) ? "confirmed" : "interrupted");
      } else if (controls.intent) {
        armed.current = controls.intent;
        setState("armed");
      }
    }}>{valid ? "Release demo gesture" : "Arm demo gesture"}</Button>
  </div>;
}

function Showcase() {
  const [appearance, setAppearance] = useState(initialAppearance);
  const [settings, setSettings] = useState(false);
  const [demo, setDemo] = useState(() => ({ scene: "normal" as Scene, port: demoPort("normal"), revision: 0 }));
  const showScene = (scene: Scene) => setDemo(previous => ({ scene, port: demoPort(scene), revision: previous.revision + 1 }));
  const scenes: readonly [Scene, string][] = [
    ["normal", "Connected devices"], ["searching", "Discovering devices"], ["disconnected", "Connection error"],
    ["incoming", "Incoming request"], ["failure", "Send failure"], ["offer-pending", "Delayed offer receipt"], ["pairing", "Pairing request"],
  ];

  return <ThemeProvider registry={registry} {...appearance}>
    <AppShell toolbar={<>
      <ConnectionStatus state={demo.scene === "searching" ? "searching" : demo.scene === "disconnected" ? "error" : "connected"}
            label={demo.scene === "searching" ? "Simulated discovery" : demo.scene === "disconnected" ? "Simulated connection error" : "Simulated local network"}
            announce />
      <Popover label="Scenarios" actions={scenes.map(([id, label]) => ({ id, label, onSelect: () => showScene(id) }))} />
      {demo.scene === "offer-pending" && <Button onClick={demo.port.releaseOffer}>Resolve demo offer</Button>}
      <Button variant="quiet" onClick={() => setSettings(true)}>Appearance</Button>
    </>}>
      <TransferWorkspace key={demo.revision} port={demo.port} gesture={controls => <GestureDemo controls={controls} />} />
      <Sheet open={settings} title="Appearance" onClose={() => setSettings(false)}>
        <SettingsPanel value={appearance} onChange={setAppearance} themes={[...registry.values()]} />
      </Sheet>
    </AppShell>
  </ThemeProvider>;
}

createRoot(document.getElementById("root")!).render(<Showcase />);
