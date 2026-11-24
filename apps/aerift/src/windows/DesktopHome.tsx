import { Button, ConnectionStatus, GlassSurface, SpatialIcon } from "@aerift/ui";
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
        <span className="aerift-eyebrow">Your connected space</span>
        <h3 id="home-rift-heading">A little closer.<br />Across every device.</h3>
        <p>Bring an object into the Rift and send it to a paired device.</p>
        <div className="ae-actions">
          <Button variant="primary" onClick={() => onNavigate("rift")}><SpatialIcon name="rift" />Open the Rift</Button>
        </div>
        <p className="aerift-home-gesture">{gestures ? "Gestures enabled · camera off" : "Gestures off"}</p>
      </div>
      <GlassSurface className="aerift-home-lead" material="content">
        <span className="aerift-home-glyph"><SpatialIcon name="devices" size={36} /></span>
        <h3>Nearby devices</h3>
        <p>{connection.state === "connecting" ? "Connecting to the local network…" :
          connection.state === "disconnected" ? "Connection unavailable" :
          online.length ? `${online.length} nearby ${online.length === 1 ? "device" : "devices"}` : "No nearby devices yet"}</p>
        {online.length > 0 && <ul className="aerift-summary">{online.map(device =>
          <li key={device.id}><strong>{device.name}</strong><ConnectionStatus state="connected"
            label={device.paired ? "Paired and online" : "Available to pair"} /></li>)}</ul>}
        {!online.length && <p className="aerift-home-detail">Nearby devices appear here when AeRift can reach them.</p>}
        <Button variant="quiet" onClick={() => onNavigate("devices")}>Manage devices<SpatialIcon name="chevron" size={16} /></Button>
      </GlassSurface>
    </section>
    <div className="aerift-home-grid">
      <section className="aerift-home-recent" aria-labelledby="home-recent-heading">
        <div className="aerift-section-heading"><h3 id="home-recent-heading">Recent objects</h3><span>Across your devices</span></div>
        {recent.length ? <ul className="aerift-summary aerift-recent-objects">{recent.map(transfer =>
          <li key={transfer.id}><span className="aerift-object-glyph"><SpatialIcon name="file" size={24} /></span>
            <div><strong>{transfer.file.name}</strong><span>{transfer.direction === "incoming" ? "Received from" : "Delivered to"}{" "}
              {snapshot?.devices.find(device => device.id === transfer.deviceId)?.name ?? "paired device"}</span></div></li>)}</ul> :
          <p className="aerift-empty-state">Your transferred objects will appear here.</p>}
      </section>
      <section className="aerift-home-activity" aria-labelledby="home-activity-heading">
        <h3 id="home-activity-heading">Transfer activity</h3>
        <p>{active.length ? `${active.length} in progress or awaiting a response.` : "No active transfers."}</p>
        <Button variant="quiet" onClick={() => onNavigate("activity")}>View activity<SpatialIcon name="chevron" size={16} /></Button>
      </section>
    </div>
  </>;
}
