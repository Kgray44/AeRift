import { Button, ConnectionStatus, GlassSurface, IconAction, SpatialIcon } from "@aerift/ui";
import type { WorkspaceConnection } from "@aerift/ui";
import type { DestinationId } from "@aerift/app-contract/experience";

export function DesktopHome({ connection, gestures, onNavigate }: {
  connection: WorkspaceConnection;
  gestures: boolean;
  onNavigate(route: DestinationId): void;
}) {
  const snapshot = connection.state === "ready" ? connection.snapshot : undefined;
  const online = snapshot?.devices.filter(device => device.online) ?? [];
  const active = snapshot?.transfers.filter(transfer =>
    transfer.state === "pending" || transfer.state === "accepted" || transfer.state === "transferring") ?? [];
  const completed = snapshot?.transfers.filter(transfer => transfer.state === "completed") ?? [];
  const recent = [...new Map(completed.map(transfer => [transfer.file.name, transfer])).values()].slice(0, 3);

  return <>
    <section className="aerift-home-hero" aria-labelledby="home-rift-heading">
      <div className="aerift-home-introduction">
        <h3 id="home-rift-heading">Share between devices.</h3>
        <p>Send a file or receive one in the Rift.</p>
        <Button variant="primary" onClick={() => onNavigate("rift")}><SpatialIcon name="rift" />Open the Rift</Button>
        {gestures && <p className="aerift-home-gesture">Gestures available in the Rift</p>}
      </div>
      <GlassSurface className="aerift-home-lead" material="content">
        <div className="aerift-section-heading">
          <h3><SpatialIcon name="devices" />Nearby devices</h3>
          <IconAction label="Manage devices" icon="chevron" onClick={() => onNavigate("devices")} />
        </div>
        {online.length ? <ul className="aerift-summary">{online.slice(0, 4).map(device =>
          <li key={device.id}><strong>{device.name}</strong><ConnectionStatus state="connected"
            label={device.paired ? "Paired" : "Available to pair"} /></li>)}</ul> :
          <p>{connection.state === "connecting" ? "Connecting…" :
            connection.state === "disconnected" ? "Connection unavailable" : "No nearby devices yet."}</p>}
        {online.length > 4 && <p>{online.length - 4} more nearby</p>}
      </GlassSurface>
    </section>
    <section className="aerift-home-recent" aria-labelledby="home-recent-heading">
      <div className="aerift-section-heading">
        <h3 id="home-recent-heading"><SpatialIcon name="activity" />Recent transfers</h3>
        <div className="ae-actions">
          {active.length > 0 && <small>{active.length} active</small>}
          <IconAction label="View activity" icon="chevron" onClick={() => onNavigate("activity")} />
        </div>
      </div>
      {recent.length ? <ul className="aerift-summary aerift-recent-objects">{recent.map(transfer =>
        <li key={transfer.id}><span className="aerift-object-glyph"><SpatialIcon name="file" size={22} /></span>
          <div><strong>{transfer.file.name}</strong><span>{transfer.direction === "incoming" ? "Received from" : "Delivered to"}{" "}
            {snapshot?.devices.find(device => device.id === transfer.deviceId)?.name ?? "paired device"}</span></div></li>)}</ul> :
        <p>No completed transfers yet.</p>}
    </section>
  </>;
}
