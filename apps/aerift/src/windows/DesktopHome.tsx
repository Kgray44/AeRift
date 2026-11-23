import { Button, ConnectionStatus, GlassSurface } from "@aerift/ui";
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
  const completed = snapshot?.transfers.filter(transfer => transfer.state === "completed").slice(0, 5) ?? [];
  const recent = [...new Map(completed.map(transfer => [transfer.file.name, transfer])).values()].slice(0, 3);

  return <>
    <GlassSurface className="aerift-home-lead">
      <p>{connection.state === "connecting" ? "Connecting to the local network…" :
        connection.state === "disconnected" ? "Connection unavailable" :
        online.length ? `${online.length} nearby ${online.length === 1 ? "device" : "devices"}` : "No nearby devices yet"}</p>
      <div className="ae-actions">
        <Button variant="primary" onClick={() => onNavigate("rift")}>Open the Rift</Button>
        <Button onClick={() => onNavigate("devices")}>Manage devices</Button>
      </div>
    </GlassSurface>
    <div className="aerift-home-grid">
      <section>
        <h3>Connected space</h3>
        {online.length ? <ul className="aerift-summary">{online.map(device =>
          <li key={device.id}><strong>{device.name}</strong><ConnectionStatus state="connected"
            label={device.paired ? "Paired and online" : "Available to pair"} /></li>)}</ul> :
          <p>Nearby devices appear here when AeRift can reach them.</p>}
        <p>{gestures ? "Gestures enabled · camera off" : "Gestures off"}</p>
      </section>
      <section>
        <h3>Recent objects</h3>
        {recent.length ? <ul className="aerift-summary">{recent.map(transfer =>
          <li key={transfer.id}><strong>{transfer.file.name}</strong>
            <span>{transfer.direction === "incoming" ? "Received" : "Sent"}</span></li>)}</ul> : <p>Transferred objects appear here.</p>}
      </section>
      <section>
        <h3>Transfer activity</h3>
        {active.length ? <p>{active.length} in progress or awaiting a response.</p> : <p>No active transfers.</p>}
        {completed.length > 0 && <p>{completed.length} recent completed {completed.length === 1 ? "transfer" : "transfers"}.</p>}
        <Button onClick={() => onNavigate("activity")}>View activity</Button>
      </section>
    </div>
  </>;
}
