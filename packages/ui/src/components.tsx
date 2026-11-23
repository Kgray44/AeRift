import { useId, type PointerEvent, type ComponentPropsWithRef, type HTMLAttributes, type ReactNode } from "react";
import type { Device, FileInfo, Transfer } from "@aerift/app-contract";
import { GlassOptics, type GlassAppearanceRecipe } from "./GlassOptics";
import { useTheme } from "./theme";

type SurfaceProps = HTMLAttributes<HTMLDivElement> & { material?: "content" | "raised" | "chrome" | "overlay" };

export function GlassSurface({ material = "content", className = "", ...props }: SurfaceProps) {
  return <div {...props} data-material={material} className={`ae-surface ${className}`} />;
}

export function AppBrand({ children = "AeRift" }: { children?: ReactNode }) {
  return <div className="ae-brand">
    <span className="ae-mark" aria-hidden="true"><span /></span>
    {typeof children === "string" ? <h1>{children}</h1> : children}
  </div>;
}

export function AppShell({ brand = "AeRift", toolbar, hideToolbar = false, glassRecipe, children }: {
  brand?: ReactNode; toolbar?: ReactNode; hideToolbar?: boolean; glassRecipe?: Partial<GlassAppearanceRecipe>; children: ReactNode;
}) {
  const mainId = useId();
  const theme = useTheme();
  return (
    <div className="ae-shell" data-experience={hideToolbar ? "spatial" : undefined}>
      {theme.id === "glass" && <GlassOptics appearanceRecipe={glassRecipe} />}
      <a className="ae-skip" href={`#${mainId}`}>Skip to content</a>
      {!hideToolbar && <header className="ae-header">
        <GlassSurface material="chrome" className="ae-toolbar">
          <AppBrand>{brand}</AppBrand>
          {toolbar && <div className="ae-actions">{toolbar}</div>}
        </GlassSurface>
      </header>}
      <main id={mainId} tabIndex={-1} className="ae-main">{children}</main>
    </div>
  );
}

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: "primary" | "secondary" | "quiet" | "danger";
  loading?: boolean;
  loadingLabel?: string;
}

function setPressOrigin(event: PointerEvent<HTMLButtonElement>) {
  if (event.currentTarget.closest("[data-ae-theme='glass']") === null) return;
  const { left, top, width, height } = event.currentTarget.getBoundingClientRect();
  if (!width || !height) return;
  const percent = (value: number) => `${Math.min(100, Math.max(0, value * 100))}%`;
  event.currentTarget.style.setProperty("--ae-press-x", percent((event.clientX - left) / width));
  event.currentTarget.style.setProperty("--ae-press-y", percent((event.clientY - top) / height));
}

export function Button({ variant = "secondary", loading = false, loadingLabel = "Please wait",
  disabled, type = "button", children, className = "", ...props }: ButtonProps) {
  return (
    <button {...props} type={type} disabled={disabled} aria-disabled={loading || props["aria-disabled"]}
      aria-busy={loading || props["aria-busy"]} data-variant={variant} className={`ae-button ${className}`}
      onPointerEnter={event => { setPressOrigin(event); props.onPointerEnter?.(event); }}
      onPointerDown={event => { setPressOrigin(event); props.onPointerDown?.(event); }}
      onClick={loading ? (event) => { event.preventDefault(); event.stopPropagation(); } : props.onClick}>
      {loading ? <><span className="ae-spinner" aria-hidden="true" />{loadingLabel}</> : children}
    </button>
  );
}

type NetworkState = "connected" | "searching" | "offline" | "error";
const connectionLabels: Record<NetworkState, string> = {
  connected: "Connected", searching: "Searching", offline: "Offline", error: "Connection error",
};

export function ConnectionStatus({ state, label, announce = false }: {
  state: NetworkState; label?: string; announce?: boolean;
}) {
  return <span className="ae-status" data-state={state} role={announce ? "status" : undefined}>
    <span className="ae-dot" aria-hidden="true" />{label ?? connectionLabels[state]}
  </span>;
}

const platforms = { windows: "Windows", ios: "iPhone", android: "Android", macos: "Mac", linux: "Linux" };

export function DeviceCard({ device, selected, name, onSelect, disabled }: {
  device: Device; selected: boolean; name: string; onSelect: () => void; disabled?: boolean;
}) {
  return <label className="ae-device">
    <input type="radio" name={name} checked={selected} disabled={disabled || !device.online || !device.paired}
      onChange={onSelect} />
    <span className="ae-device-body">
      <span className="ae-device-icon" data-phone={device.platform === "ios" || device.platform === "android"} aria-hidden="true" />
      <span className="ae-device-copy"><strong>{device.name}</strong><small>{platforms[device.platform]} · {device.paired ? "Paired" : "Unpaired"}</small></span>
      <ConnectionStatus state={device.online ? "connected" : "offline"} label={device.online ? "Online" : "Offline"} />
    </span>
  </label>;
}

export function DevicePicker({ devices, selectedId, onSelect, loading = false, error, disabled }: {
  devices: readonly Device[]; selectedId?: string; onSelect: (id: string) => void;
  loading?: boolean; error?: string; disabled?: boolean;
}) {
  const id = useId();
  return <fieldset className="ae-picker" disabled={disabled} aria-busy={loading}>
    <legend>Paired devices</legend>
    {loading ? <p role="status">Looking for devices…</p> :
      error ? <p role="alert">{error}</p> :
      devices.length ? <div className="ae-devices">{devices.map(device => (
        <DeviceCard key={device.id} name={id} device={device} selected={selectedId === device.id}
          onSelect={() => onSelect(device.id)} />
      ))}</div> : <p>No paired devices found.</p>}
  </fieldset>;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1024 ** unit)} ${["B", "KiB", "MiB", "GiB", "TiB"][unit]}`;
}

export function FileCard({ file, action }: { file: FileInfo; action?: ReactNode }) {
  return <GlassSurface className="ae-file">
    <span className="ae-file-icon" aria-hidden="true" />
    <div className="ae-file-copy"><strong>{file.name}</strong><small>{formatFileSize(file.sizeBytes)}</small></div>
    {action}
  </GlassSurface>;
}

const transferLabels: Record<Transfer["state"], string> = {
  pending: "Awaiting confirmation", accepted: "Accepted", transferring: "Transferring",
  rejected: "Declined", cancelled: "Cancelled", completed: "Delivered", failed: "Transfer failed",
};

export function TransferProgress({ transfer, deviceName, error, action }: {
  transfer: Transfer; deviceName?: string; error?: string; action?: ReactNode;
}) {
  const id = useId();
  const percent = transfer.state === "completed" ? 100 : transfer.file.sizeBytes > 0
    ? Math.min(100, Math.max(0, Math.round(transfer.bytesTransferred / transfer.file.sizeBytes * 100))) : 0;
  return <GlassSurface className="ae-transfer">
    <div className="ae-transfer-top">
      <span className="ae-transfer-glyph" aria-hidden="true">
        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
          strokeLinecap="round" strokeLinejoin="round" focusable="false">
          <path d={transfer.direction === "incoming" ? "M18 6 6 18m10 0H6V8" : "M6 18 18 6M8 6h10v10"} />
        </svg>
      </span>
      <div className="ae-transfer-file">
        <strong id={id}>{transfer.file.name}</strong>
        <small>{transfer.direction === "incoming" ? "Incoming" : "Outgoing"}{deviceName && ` · ${deviceName}`}</small>
      </div>
    </div>
    <span className="ae-transfer-status" data-state={transfer.state} role="status">{transferLabels[transfer.state]}</span>
    {["accepted", "transferring", "completed"].includes(transfer.state) && <>
      <div className="ae-progress" role="progressbar" aria-labelledby={id} aria-valuenow={percent}>
        <span style={{ transform: `scaleX(${percent / 100})` }} />
      </div>
      <small>{formatFileSize(Math.max(0, Math.min(transfer.file.sizeBytes, transfer.bytesTransferred)))} of {formatFileSize(transfer.file.sizeBytes)} · {percent}%</small>
    </>}
    {error && <small>{error}</small>}
    {action}
  </GlassSurface>;
}

export type GestureState = "idle" | "armed" | "confirmed" | "interrupted";
const gestureLabels: Record<GestureState, string> = {
  idle: "Ready to arm", armed: "Gesture armed", confirmed: "Gesture confirmed", interrupted: "Gesture interrupted",
};

export function GestureIndicator({ state }: { state: GestureState }) {
  return <div className="ae-gesture" data-state={state} role="status">
    <span className="ae-gesture-mark" aria-hidden="true"><span /></span>
    <strong>{gestureLabels[state]}</strong>
  </div>;
}
