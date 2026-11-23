import { useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import {
  AppBrand, AppShell, Button, GestureCameraIndicator, GestureControl, Popover, SettingsPanel, SpatialIcon,
  Sheet, ThemeProvider, TransferWorkspace, createThemeRegistry, glassTheme,
  type AppearanceSettings, type GestureCameraStatus, type TransferControls,
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
  const deliveryTimers = new Map<string, number[]>();
  let sequence = 0;
  const publish = () => {
    for (const listener of listeners) listener({ version: 1, devices: visibleDevices, transfers, pendingPairing });
  };

  function change(transfer: Transfer) {
    transfers = transfers.map(item => item.id === transfer.id ? transfer : item);
    publish();
  }

  function stopDelivery(id: string) {
    deliveryTimers.get(id)?.forEach(timer => window.clearTimeout(timer));
    deliveryTimers.delete(id);
  }

  function startDelivery(transfer: Transfer) {
    if (!listeners.size || transfers.find(item => item.id === transfer.id)?.state !== transfer.state) return;
    const stages: Array<[number, "accepted" | "transferring" | "completed", number]> = [
      [1100, "accepted", 0],
      [2000, "transferring", .22],
      [3400, "transferring", .63],
      [4900, "transferring", 1],
      [6100, "completed", 1],
    ];
    const timers = stages.filter(([, state]) => transfer.state !== "accepted" || state !== "accepted")
      .map(([delay, state, proportion]) => window.setTimeout(() => {
        change({ ...transfer, state, bytesTransferred: Math.round(transfer.file.sizeBytes * proportion) });
        if (state === "completed") deliveryTimers.delete(transfer.id);
      }, delay));
    deliveryTimers.set(transfer.id, timers);
  }

  return {
    releaseOffer() { releaseOffer?.(); },
    async watch(listener) {
      if (scene === "disconnected") return { ok: false, error: { code: "network_error" } };
      listeners.add(listener);
      if (scene !== "searching") publish();
      return { ok: true, value: () => {
        listeners.delete(listener);
        if (listeners.size) return;
        for (const id of deliveryTimers.keys()) stopDelivery(id);
        releaseOffer?.();
      } };
    },
    async selectFile() {
      return { ok: true, value: file };
    },
    async setReceiverReady(ready) { return { ok: true, value: ready ? 60_000 : 0 }; },
    async checkReceiver(deviceId) {
      return { ok: true, value: scene === "normal" && devices.some(device => device.id === deviceId && device.online) };
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
        publish();
      } else {
        const existing = transfers.find(item => item.id === request.transferId);
        if (!existing) return { ok: false, error: { code: "invalid_request" } };
        stopDelivery(existing.id);
        transfer = { ...existing, state: request.action === "cancel" ? "cancelled" : request.accept ? "accepted" : "rejected" };
        change(transfer);
      }
      if (request.action === "offer" && scene === "offer-pending") {
        await new Promise<void>(resolve => { releaseOffer = resolve; });
        releaseOffer = undefined;
      }
      if (transfer.state === "pending" || transfer.state === "accepted") startDelivery(transfer);
      return { ok: true, value: transfer };
    },
  };
}

const registry = createThemeRegistry([glassTheme, { id: "paper-preview", label: "Paper preview" }]);
const initialAppearance: AppearanceSettings = {
  theme: "glass", scheme: "dark", contrast: "system", transparency: "system", motion: "system",
};
const showcaseAppearanceKey = "aerift.showcase.appearance.v1";

function readShowcaseAppearance(): AppearanceSettings {
  try {
    const source = JSON.parse(localStorage.getItem(showcaseAppearanceKey) ?? "{}");
    return {
      theme: source.theme === "paper-preview" ? source.theme : initialAppearance.theme,
      scheme: ["light", "dark", "system"].includes(source.scheme) ? source.scheme : initialAppearance.scheme,
      contrast: source.contrast === "increase" ? "increase" : "system",
      transparency: source.transparency === "reduce" ? "reduce" : "system",
      motion: source.motion === "reduce" ? "reduce" : "system",
    };
  } catch {
    return initialAppearance;
  }
}

function GestureDemo({ controls, enabled, actionsBlocked, onStatus }: {
  controls: TransferControls; enabled: boolean; actionsBlocked: boolean; onStatus: (status: GestureCameraStatus) => void;
}) {
  const createCamera: ComponentProps<typeof GestureControl>["createCamera"] = ({ intent, onFeedback }) => {
    let step = 0;
    let stopped = false;
    function observe(posture: "open" | "fist", times: number[]) {
      for (const captureMs of times) {
        onFeedback(intent.observe({ captureMs, posture, track: 1, confidence: .95 }, captureMs));
      }
    }
    const steps = [
      () => observe("open", [10]),
      () => observe("open", [80, 150, 220]),
      () => observe("fist", [290, 360, 430]),
      () => observe("open", [500, 570, 640]),
    ];
    function advance() {
      if (!stopped) steps[step++]?.();
    }
    function advanceOnKey(event: KeyboardEvent) {
      if (event.code !== "KeyH" || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey ||
        event.defaultPrevented || event.repeat || (event.target instanceof HTMLElement &&
          (event.target.isContentEditable || event.target.closest("input, select, textarea")))) return;
      advance();
    }
    return {
      async start() {
        intent.begin(0);
        onFeedback(intent.setCamera("ready"));
        window.addEventListener("aerift-showcase-gesture", advance);
        window.addEventListener("keydown", advanceOnKey);
      },
      stop() {
        stopped = true;
        window.removeEventListener("aerift-showcase-gesture", advance);
        window.removeEventListener("keydown", advanceOnKey);
      },
      updateContext(target) { onFeedback(intent.updateContext(target)); },
    };
  };

  return <GestureControl controls={controls} enabled={enabled} actionsBlocked={actionsBlocked}
    createCamera={createCamera} shortcut="c" onStatus={onStatus} />;
}

function Showcase() {
  const phone = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const [appearance, setAppearance] = useState(readShowcaseAppearance);
  const [settings, setSettings] = useState(false);
  const [gesturesEnabled, setGesturesEnabled] = useState(false);
  const [cameraStatus, setCameraStatus] = useState<GestureCameraStatus>();
  const [demo, setDemo] = useState(() => ({ scene: "normal" as Scene, port: demoPort("normal"), revision: 0 }));
  function updateAppearance(value: AppearanceSettings) {
    setAppearance(value);
    try {
      localStorage.setItem(showcaseAppearanceKey, JSON.stringify(value));
    } catch {
      // The current session can still preview this appearance.
    }
  }
  const showScene = (scene: Scene) => setDemo(previous => ({ scene, port: demoPort(scene), revision: previous.revision + 1 }));
  const scenes: readonly [Scene, string][] = [
    ["normal", "Connected devices"], ["searching", "Discovering devices"], ["disconnected", "Connection error"],
    ["incoming", "Incoming request"], ["failure", "Send failure"], ["offer-pending", "Delayed offer receipt"], ["pairing", "Pairing request"],
  ];

  return <ThemeProvider registry={registry} {...appearance}>
    <AppShell hideToolbar>
      <TransferWorkspace key={demo.revision} port={demo.port} platform={phone ? "ios" : "windows"} allowDrop={!phone}
        discovery={demo.scene === "searching" ? "searching" : undefined}
        navigationStart={<AppBrand />} navigationEnd={<>
          <GestureCameraIndicator status={cameraStatus} />
          <Popover label="Scenarios" actions={scenes.map(([id, label]) => ({ id, label, onSelect: () => showScene(id) }))} />
          {demo.scene === "offer-pending" && <Button onClick={demo.port.releaseOffer}>Resolve demo offer</Button>}
          <Button variant="quiet" aria-label="Control Center" title="Control Center" onClick={() => setSettings(true)}>
            <SpatialIcon name="settings" />
          </Button>
        </>} gesture={controls => <GestureDemo controls={controls} enabled={gesturesEnabled} actionsBlocked={settings}
          onStatus={setCameraStatus} />} />
      <Sheet open={settings} title="Control Center" onClose={() => setSettings(false)}>
        <SettingsPanel value={appearance} onChange={updateAppearance} themes={[...registry.values()]} />
        <section aria-label="Gestures and camera">
          <h3>Gestures and camera</h3>
          <label className="ae-camera-toggle">Enable camera gestures
            <input type="checkbox" checked={gesturesEnabled} onChange={event => setGesturesEnabled(event.currentTarget.checked)} />
          </label>
          <p>Showcase replay uses synthetic hand observations and never opens a camera.</p>
        </section>
      </Sheet>
    </AppShell>
  </ThemeProvider>;
}

createRoot(document.getElementById("root")!).render(<Showcase />);
