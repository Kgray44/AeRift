import { SpatialIcon, type GestureCameraStatus, type WorkspaceConnection } from "@aerift/ui";
import "./compact-header.css";

export function CompactHeaderMark() {
  return <h1 className="ae-compact-header-mark">
    <img src="/branding/aerift-mark-transparent.png" alt="AeRift" />
  </h1>;
}

export function CompactHeaderStatus({ camera, enabled, connections, service }: {
  camera?: GestureCameraStatus;
  enabled: boolean;
  connections: number | undefined;
  service: WorkspaceConnection["state"];
}) {
  const cameraState = enabled ? camera?.state ?? "standby" : "disabled";
  const cameraLabel = enabled ? camera?.label ?? "Camera standby" : "Camera off";
  const cameraDetail = enabled ? camera?.detail ?? "Gesture camera is not capturing." : "Gesture recognition is disabled.";
  const cameraColor = ["listening", "detected", "held"].includes(cameraState) ? "active" :
    ["starting", "permission", "unavailable", "paused"].includes(cameraState) ? "waiting" : "quiet";
  const connectionLabel = service === "disconnected" ? "Paired connections unavailable: transfer service disconnected" :
    service === "connecting" || connections === undefined ? "Checking available paired connections" :
    connections === 0 ? "No paired connections available" :
    connections === 1 ? "1 paired connection available" : `${connections} paired connections available`;
  const connectionColor = service === "disconnected" ? "waiting" :
    service === "connecting" || connections === undefined ? "waiting" :
      connections ? "active" : "quiet";
  return <div className="ae-compact-header-status" role="group" aria-label="App status">
    <span role="img" aria-label={cameraLabel} title={`${cameraLabel}: ${cameraDetail}`} data-tone={cameraColor}>
      <svg aria-hidden="true" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.7">
        <rect x="3.5" y="6" width="12.5" height="12" rx="2" />
        <path d="m16 10 4.5-2v8L16 14" />
      </svg>
    </span>
    <span role="img" aria-label={connectionLabel} title={connectionLabel} data-tone={connectionColor}>
      <SpatialIcon name="devices" size={19} aria-hidden="true" />
    </span>
  </div>;
}
