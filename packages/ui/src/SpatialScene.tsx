import { memo, useId, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import type { Device, Platform } from "@aerift/app-contract";
import { Button, ConnectionStatus, GlassSurface } from "./components";
import { devicePresence } from "./spatial-device";
import { reconcilePeerSlots } from "./spatial-placement";
import "./spatial.css";

const icons = {
  home: <path d="m3.5 11 8.5-7 8.5 7v8a1 1 0 0 1-1 1h-5v-6h-5v6h-5a1 1 0 0 1-1-1z" />,
  rift: <><path d="M16.7 2.5C11 5 7.1 11 7.1 16.8c0 2.2.7 3.9 2.2 4.7M7.3 21.5c5.7-2.5 9.6-8.5 9.6-14.3 0-2.2-.7-3.9-2.2-4.7M4 12h16" /></>,
  devices: <><rect x="2.5" y="4.5" width="15" height="11.5" rx="1.6" /><rect x="14.5" y="9.5" width="7" height="11" rx="1.5" /><path d="M6.5 20h5m-2.5-4v4" /></>,
  desktop: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></>,
  laptop: <><path d="M5 17V6a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v11M3 17h18l1 3H2z" /></>,
  phone: <><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M10.5 5h3m-2.5 14h2" /></>,
  tablet: <><rect x="4" y="3" width="16" height="18" rx="2.5" /><path d="M11 18.25h2" /></>,
  settings: <><path d="m9.6 3-.5 2.1-1.8 1-2.1-.6-2.1 3.6 1.6 1.5v2.1l-1.6 1.5 2.1 3.6 2.1-.6 1.8 1 .5 2.1h4.2l.5-2.1 1.8-1 2.1.6 2.1-3.6-1.6-1.5v-2.1l1.6-1.5-2.1-3.6-2.1.6-1.8-1-.5-2.1z" /><circle cx="11.7" cy="11.65" r="2.65" /></>,
  pair: <><path d="m9 15 6-6m-7.4 2.1-2.4 2.4a3.8 3.8 0 0 0 5.3 5.3l2.4-2.4m3.5-3.5 2.4-2.4a3.8 3.8 0 0 0-5.3-5.3L11.1 7.6" /></>,
  activity: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M6 12h3l2-4 3 8 2-4h2" /></>,
  file: <><path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10Zm0 0v7h7m-12 5h8m-8 3h6" /></>,
  photo: <><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><circle cx="8.5" cy="9" r="1.35" /><path d="m4 17 4.8-4.2 3.1 2.6 3.8-4.5 4.3 4.9" /></>,
  url: <><circle cx="12" cy="12" r="8.5" /><path d="M4.5 12h15M12 3.5c4.3 4 4.3 13 0 17-4.3-4-4.3-13 0-17Z" /></>,
  note: <><rect x="5" y="3" width="14" height="18" rx="2.4" /><path d="M8.3 8h7.4M8.3 12h7.4M8.3 16h4.8" /></>,
  clipboard: <><path d="M9 5H6a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 6 21h12a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 18 5h-3" /><rect x="9" y="3" width="6" height="4" rx="1.2" /><path d="M8 12h8m-8 4h6" /></>,
  collection: <><path d="M4 6.7h6l2 2h7.5a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.2v-10A1.5 1.5 0 0 1 4.5 6.7Zm1-2.4h12.4" /></>,
  friends: <><circle cx="9" cy="8" r="3" /><path d="M2 20v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2m1-14a3 3 0 0 1 0 6m2 2a5 5 0 0 1 3 4v2" /></>,
  send: <><path d="m3 10 18-7-7 18-3-8Zm8 3L21 3" /></>,
  edit: <><path d="m4 16 11-11 4 4L8 20l-5 1 1-5Zm9-9 4 4" /><path d="m15 5 2-2c.6-.6 1.4-.6 2 0l2 2c.6.6.6 1.4 0 2l-2 2" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  workspace: <><circle cx="12" cy="12" r="2.5" /><circle cx="12" cy="12" r="8.5" /><path d="M12 1v2.5m0 17V23M1 12h2.5m17 0H23" /></>,
  drop: <><path d="M12 3v12m-4-4 4 4 4-4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></>,
  chevron: <path d="m9 6 6 6-6 6" />,
  minimize: <path d="M5 12h14" />,
  maximize: <><path d="M5 10V5h5m4 0h5v5m0 4v5h-5m-4 0H5v-5" /></>,
  back: <path d="m15 6-6 6 6 6" />,
  add: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="10.8" cy="10.8" r="5.8" /><path d="m15 15 4.5 4.5" /></>,
  folder: <path d="M3 6.8a1.8 1.8 0 0 1 1.8-1.8H9l2.4 2.5h7.8A1.8 1.8 0 0 1 21 9.3v8.9a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 18.2Z" />,
  check: <><circle cx="12" cy="12" r="8.8" /><path d="m8 12 2.6 2.6 5.5-5.5" /></>,
  unlink: <><path d="m7.6 11.1-2.4 2.4a3.8 3.8 0 0 0 5.3 5.3l2.4-2.4m3.5-3.5 2.4-2.4a3.8 3.8 0 0 0-5.3-5.3l-2.4 2.4M5.8 5.8l12.4 12.4" /></>,
  retry: <><path d="M21 4v5h-5M3 20v-5h5m12.4-6a8.5 8.5 0 0 0-14.6-3.3L3 9m18 6-2.8 3.3A8.5 8.5 0 0 1 3.6 15" /></>,
};

export function SpatialIcon({ name, size = 20, ...props }: Omit<ComponentPropsWithoutRef<"svg">, "name"> & {
  name: keyof typeof icons;
  size?: number;
}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
    {icons[name]}
  </svg>;
}

export type DiscoveryState = "connecting" | "searching" | "available" | "empty" | "disabled" | "interrupted";
const discoveryInfo = {
  connecting: { label: "Connecting to AeRift", state: "searching" },
  searching: { label: "Finding nearby devices", state: "searching" },
  available: { label: "Nearby devices available", state: "connected" },
  empty: { label: "No devices nearby", state: "offline" },
  disabled: { label: "Discovery is off", state: "offline" },
  interrupted: { label: "Discovery interrupted", state: "error" },
} as const;

type Position = { x: number; y: number };
export interface SpatialAnchors {
  width: number;
  height: number;
  local: Position;
  peers: ReadonlyMap<string, Position>;
  compact: boolean;
}

const platforms: Record<Platform, { label: string; icon: keyof typeof icons }> = {
  windows: { label: "Windows", icon: "desktop" },
  ios: { label: "iOS", icon: "phone" },
  android: { label: "Android", icon: "phone" },
  macos: { label: "macOS", icon: "desktop" },
  linux: { label: "Linux", icon: "desktop" },
};
const spatialCapacity = 6;

function midpoint(element: Element, stage: DOMRect): Position {
  const rect = element.getBoundingClientRect();
  return { x: rect.left - stage.left + rect.width / 2, y: rect.top - stage.top + rect.height / 2 };
}

function equalPosition(first: Position, second?: Position) {
  return first.x === second?.x && first.y === second.y;
}

function equalAnchors(first: SpatialAnchors | undefined, second: SpatialAnchors) {
  return first && first.width === second.width && first.height === second.height && first.compact === second.compact
    && equalPosition(first.local, second.local) && first.peers.size === second.peers.size
    && [...second.peers].every(([id, position]) => equalPosition(position, first.peers.get(id)));
}

// Progress snapshots can recreate every Device object. Pass just the values
// used by this peer so unrelated frame updates don't revisit its markup.
const Peer = memo(function Peer({ id, name, platformId, paired, online, slot, groupName, selected, busy, ready, offered, active, interrupted, onSelect }: {
  id: string; name: string; platformId: Platform; paired: boolean; online: boolean;
  slot: number; groupName: string; selected: boolean; busy?: boolean; ready: boolean;
  offered: boolean; active: boolean; interrupted: boolean; onSelect: (id: string) => void;
}) {
  const statusId = useId();
  const titleId = useId();
  const platform = platforms[platformId];
  const [state, presence] = devicePresence({ online, paired }, { selected, ready, offered, active, interrupted });
  const detail = `${platform.label}, ${paired ? "paired" : "unpaired"}, ${online ? "online" : "offline"}`;
  return <label className="ae-spatial-peer" data-slot={slot} data-peer-state={state} data-selected={selected}
    title={`${name} · ${detail}`}>
    <input className="ae-spatial-radio" type="radio" name={groupName} checked={selected}
      disabled={busy || !paired || !online} aria-labelledby={titleId} aria-describedby={statusId}
      onChange={() => onSelect(id)} />
    <span className="ae-surface ae-spatial-glyph" data-material="chrome" data-peer-anchor={id}>
      <SpatialIcon name={platform.icon} size={30} />
    </span>
    <span className="ae-spatial-caption">
      <strong id={titleId}>{name}</strong>
      <small className="ae-spatial-presence">{presence}</small>
      <span className="ae-spatial-detail" id={statusId}>{detail}
        {state !== "available" && state !== "offline" && state !== "unpaired" && `, ${presence.toLowerCase()}`}
      </span>
    </span>
  </label>;
});

export function SpatialScene({ devices, platform, discovery, selectedId, readinessPeerId, offeredPeerId, activePeerId, interruptedPeerId, receiverReady,
  busy, onSelect, onPair, pairingDisabled, pairingLabel = "Pair a device", onRetry, retryLabel = "Retry connection", children }: {
  devices: readonly Device[];
  platform?: Platform;
  discovery: DiscoveryState;
  selectedId?: string;
  readinessPeerId?: string;
  offeredPeerId?: string;
  activePeerId?: string;
  interruptedPeerId?: string;
  receiverReady?: boolean;
  busy?: boolean;
  onSelect: (id: string) => void;
  onPair: () => void;
  pairingDisabled?: boolean;
  pairingLabel?: string;
  onRetry?: () => void;
  retryLabel?: string;
  children?: ReactNode | ((anchors: SpatialAnchors) => ReactNode);
}) {
  const groupName = useId();
  const stageRef = useRef<HTMLDivElement>(null);
  const [anchors, setAnchors] = useState<SpatialAnchors>();
  const [previousSlots, setSlots] = useState<ReadonlyMap<string, number>>(() => new Map());
  const slots = reconcilePeerSlots(previousSlots, devices.map(device => device.id));
  if (slots !== previousSlots) setSlots(slots);
  const peers = [...devices].sort((first, second) => (slots.get(first.id) ?? 0) - (slots.get(second.id) ?? 0));
  const occupiedSlots = new Set(slots.values());
  const availableSlots = Array.from({ length: spatialCapacity }, (_, index) => index)
    .filter(index => !occupiedSlots.has(index));

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const local = stage?.querySelector("[data-local-anchor]");
    if (!stage || !local) return;
    const peerNodes = Array.from(stage.querySelectorAll<HTMLElement>("[data-peer-anchor]"));
    function measure() {
      if (!stage || !local) return;
      const rect = stage.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const compact = getComputedStyle(stage).getPropertyValue("--ae-stage-compact").trim() === "1";
      const next = { width: rect.width, height: rect.height, compact, local: midpoint(local, rect),
        peers: new Map(peerNodes.map(node => [node.dataset.peerAnchor!, midpoint(node, rect)])) };
      setAnchors(current => equalAnchors(current, next) ? current : next);
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    observer.observe(local);
    peerNodes.forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [slots]);

  const localState = activePeerId ? "active" : offeredPeerId ? "offered" : receiverReady || readinessPeerId ? "ready" : "idle";
  const localPresence = localState === "active" ? "Transfer active" : localState === "offered" ? "Offer pending"
    : localState === "ready" ? receiverReady ? "Ready to receive" : "Receiver ready" : undefined;
  const empty = !peers.some(device => device.paired);
  const info = discoveryInfo[discovery];
  return <div className="ae-spatial-scene" data-discovery={discovery}>
    <div className="ae-spatial-stage" ref={stageRef} data-crowded={peers.length > spatialCapacity}>
      <div className="ae-spatial-local" data-peer-state={localState} title={platform && platforms[platform].label}>
        <span className="ae-spatial-field" aria-hidden="true"><span /><span /><span /></span>
        <GlassSurface material="chrome" className="ae-spatial-glyph" data-local-anchor="">
          <SpatialIcon name={platform ? platforms[platform].icon : "desktop"} size={38} />
        </GlassSurface>
        <span className="ae-spatial-caption">
          <strong>This device</strong>
          {localPresence && <small className="ae-spatial-presence">{localPresence}</small>}
          {platform && <span className="ae-spatial-detail">{platforms[platform].label}</span>}
        </span>
      </div>
      {peers.length > 0 && <div className="ae-spatial-peer-group" role="radiogroup" aria-label="Destination device">
        {peers.map(device => {
          const current = slots.get(device.id) ?? 0;
          const slot = current >= spatialCapacity ? availableSlots.shift() ?? current : current;
          return <Peer key={device.id} slot={slot} groupName={groupName}
            id={device.id} name={device.name} platformId={device.platform} paired={device.paired} online={device.online}
            selected={device.id === selectedId} busy={busy} ready={device.id === readinessPeerId}
            offered={device.id === offeredPeerId} active={device.id === activePeerId}
            interrupted={device.id === interruptedPeerId} onSelect={onSelect} />;
        })}
      </div>}
      {children && <div className="ae-spatial-overlay">{typeof children === "function" ? anchors && children(anchors) : children}</div>}
    </div>
    <div className="ae-spatial-footer">
      <div className="ae-spatial-status">
        <ConnectionStatus {...info} announce />
        {empty && discovery !== "connecting" && <p>Pair a nearby device to send and receive files.</p>}
      </div>
      <div className="ae-actions">
        {onRetry && <Button variant="quiet" onClick={onRetry}><SpatialIcon name="retry" size={17} />{retryLabel}</Button>}
        <Button variant={empty ? "secondary" : "quiet"} disabled={pairingDisabled} onClick={onPair}>
          <SpatialIcon name="pair" size={17} />{pairingLabel}
        </Button>
      </div>
    </div>
  </div>;
}
