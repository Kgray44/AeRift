import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Device = { id: string; name: string; platform: string };
type Offer = {
  peerId: string; id: string; name: string; sizeBytes: number;
  status: { state: string; bytesTransferred: number };
};
type Snapshot = {
  active: boolean; endpoint: string; identity: string | null;
  peers: Device[]; pairing: { id: string; peer: Device } | null; offers: Offer[];
};

export function PrivateRemoteDev() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [permission, setPermission] = useState(false);
  const [busy, setBusy] = useState(false);
  const [peerId, setPeerId] = useState("");
  const [invite, setInvite] = useState("");
  const [notice, setNotice] = useState("");
  const [revoke, setRevoke] = useState("");

  useEffect(() => {
    let mounted = true;
    const poll = () => {
      void invoke<Snapshot>("private_remote_snapshot")
        .then((change) => { if (mounted) setSnapshot(change); })
        .catch(() => { if (mounted) setNotice("Private Remote native capability is unavailable."); });
    };
    poll();
    const timer = window.setInterval(poll, 750);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);

  async function operation(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      await work();
      setSnapshot(await invoke<Snapshot>("private_remote_snapshot"));
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
      setNotice(code ? "Private Remote action failed (" + code + ")." : "Private Remote action failed.");
    } finally {
      setBusy(false);
    }
  }

  function action(request: Record<string, unknown>, onResult?: (invite: string | null) => void) {
    void operation(async () => {
      const result = await invoke<{ invite: string | null }>("private_remote_action", { request });
      onResult?.(result.invite);
    });
  }

  const active = snapshot?.active === true;
  return (
    <main className="ae-private-remote-dev">
      <h1>Private Remote Development</h1>
      <p>Receiver qualification only. Nearby, discovery, gestures and the normal workspace are not running.</p>
      {notice && <p role="status">{notice}</p>}
      {snapshot && <p>Selected private endpoint: <code>{snapshot.endpoint}</code></p>}
      {!active ? (
        <section aria-labelledby="remote-start-heading">
          <h2 id="remote-start-heading">Private receiver is off</h2>
          <label><input type="checkbox" checked={permission}
            onChange={(event) => setPermission(event.target.checked)} />
            This endpoint belongs to an already-authorized private test overlay. I will use synthetic files only.
          </label>
          <p><button type="button" disabled={!permission || !snapshot || busy}
            onClick={() => void operation(() => invoke("private_remote_start", { confirmed: permission }))}>
            Start private receiver
          </button></p>
        </section>
      ) : (
        <>
          <p>Device fingerprint: <code>{snapshot.identity}</code></p>
          <button type="button" disabled={busy}
            onClick={() => action({ action: "stop" }, () => { setInvite(""); setPermission(false); })}>
            Stop private receiver
          </button>
          <section aria-labelledby="remote-pair-heading">
            <h2 id="remote-pair-heading">Targeted Remote invitation</h2>
            <form onSubmit={(event) => {
              event.preventDefault();
              action({ action: "create_invite", peerId }, (created) => setInvite(created ?? ""));
            }}>
              <label>
                Expected recipient device fingerprint
                <input autoComplete="off" spellCheck={false} value={peerId} maxLength={64}
                  onChange={(event) => setPeerId(event.target.value.trim())} />
              </label>
              <button disabled={busy || !/^[0-9a-f]{64}$/.test(peerId)}>Create five-minute invitation</button>
            </form>
            {invite && (
              <>
                <label>Share privately with the intended device only
                  <textarea value={invite} readOnly rows={3} />
                </label>
                <button type="button" disabled={busy}
                  onClick={() => action({ action: "cancel_invite" }, () => setInvite(""))}>
                  Cancel invitation
                </button>
              </>
            )}
            {snapshot.pairing && (
              <div>
                <h3>Verify the expected device</h3>
                <p>{snapshot.pairing.peer.name} <code>{snapshot.pairing.peer.id}</code></p>
                <button type="button" disabled={busy}
                  onClick={() => action({ action: "confirm_pairing", id: snapshot.pairing?.id, accepted: true }, () => setInvite(""))}>Approve Remote pairing</button>
                <button type="button" disabled={busy}
                  onClick={() => action({ action: "confirm_pairing", id: snapshot.pairing?.id, accepted: false }, () => setInvite(""))}>Reject pairing</button>
              </div>
            )}
          </section>
          <section aria-labelledby="remote-peers-heading">
            <h2 id="remote-peers-heading">Authorized Remote devices</h2>
            <p>Saved authorization only. There is no discovery or online indicator.</p>
            {snapshot.peers.length === 0 && <p>No Remote devices authorized.</p>}
            <ul>{snapshot.peers.map((peer) => (
              <li key={peer.id}>
                {peer.name} <code>{peer.id}</code>
                {revoke === peer.id ? <>
                  <button type="button" disabled={busy} onClick={() => action({ action: "revoke", peerId: peer.id }, () => setRevoke(""))}>Confirm Remote revoke</button>
                  <button type="button" onClick={() => setRevoke("")}>Keep Remote access</button>
                </> : <button type="button" disabled={busy} onClick={() => setRevoke(peer.id)}>Revoke Remote access</button>}
              </li>
            ))}</ul>
          </section>
          <section aria-labelledby="remote-offers-heading">
            <h2 id="remote-offers-heading">Remote file decisions</h2>
            {snapshot.offers.length === 0 && <p>No incoming Remote offers.</p>}
            <ul>{snapshot.offers.map((offer) => (
              <li key={offer.peerId + ":" + offer.id}>
                <strong>{offer.name}</strong> • {offer.sizeBytes.toLocaleString()} bytes • {offer.status.state}
                <p>From <code>{offer.peerId}</code></p>
                {offer.status.state === "pending" && <>
                  <button type="button" disabled={busy} onClick={() => action({ action: "respond", peerId: offer.peerId, id: offer.id, accepted: true })}>Accept file</button>
                  <button type="button" disabled={busy} onClick={() => action({ action: "respond", peerId: offer.peerId, id: offer.id, accepted: false })}>Decline file</button>
                </>}
              </li>
            ))}</ul>
          </section>
        </>
      )}
    </main>
  );
}
