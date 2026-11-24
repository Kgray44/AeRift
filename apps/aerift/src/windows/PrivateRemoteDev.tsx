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

export function PrivateRemoteDev({ product = false }: { product?: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [permission, setPermission] = useState(false);
  const [busy, setBusy] = useState(false);
  const [peerId, setPeerId] = useState("");
  const [invite, setInvite] = useState("");
  const [notice, setNotice] = useState("");
  const [targetEndpoint, setTargetEndpoint] = useState("");
  const [issuer, setIssuer] = useState("");
  const [receivedCode, setReceivedCode] = useState("");
  const [outgoingPeer, setOutgoingPeer] = useState("");
  const [outgoing, setOutgoing] = useState(false);
  const [outgoingMessage, setOutgoingMessage] = useState("");
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
      <h1>{product ? "Remote transfers" : "Private Remote Development"}</h1>
      <p>{product ? "Send and receive files with invited devices over your private VPN. Nearby is off in this mode."
        : "Receiver qualification only. Nearby, discovery, gestures and the normal workspace are not running."}</p>
      {notice && <p role="status">{notice}</p>}
      {snapshot && <p>Selected private endpoint: <code>{snapshot.endpoint}</code></p>}
      {!active ? (
        <section aria-labelledby="remote-start-heading">
          <h2 id="remote-start-heading">Private receiver is off</h2>
          <label><input type="checkbox" checked={permission}
            onChange={(event) => setPermission(event.target.checked)} />
            {product ? "Start listening at this exact address on my private VPN."
              : "This endpoint belongs to an already-authorized private test overlay. I will use synthetic files only."}
          </label>
          <p><button type="button" disabled={!permission || !snapshot || busy}
            onClick={() => void operation(() => invoke("private_remote_start", { confirmed: permission }))}>
            {product ? "Start Remote" : "Start private receiver"}
          </button></p>
        </section>
      ) : (
        <>
          <p>Device fingerprint: <code>{snapshot.identity}</code></p>
          <button type="button" disabled={busy}
            onClick={() => action({ action: "stop" }, () => { setInvite(""); setPermission(false); })}>
            {product ? "Stop Remote" : "Stop private receiver"}
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
          {product && <section aria-labelledby="remote-outgoing-heading">
            <h2 id="remote-outgoing-heading">Connect to an invited device</h2>
            <label>Other device’s VPN address and port
              <input value={targetEndpoint} maxLength={22} placeholder="100.x.y.z:48888" autoComplete="off"
                onChange={(event) => setTargetEndpoint(event.target.value)} />
            </label>
            <form onSubmit={(event) => {
              event.preventDefault();
              setOutgoing(true); setOutgoingMessage("Waiting for the other device to approve pairing…");
              void invoke("windows_redeem_remote", { endpoint: targetEndpoint.trim(), invite: receivedCode.trim(), expectedIssuer: issuer.trim() })
                .then(() => { setReceivedCode(""); setOutgoingMessage("Remote pairing approved."); })
                .catch(() => setOutgoingMessage("Pairing failed or was declined. Check the address, fingerprint and invitation expiry."))
                .finally(() => setOutgoing(false));
            }}>
              <label>Verified fingerprint of the device that sent the invitation
                <input value={issuer} maxLength={64} spellCheck={false} autoComplete="off"
                  onChange={(event) => setIssuer(event.target.value)} />
              </label>
              <label>Invitation code
                <input value={receivedCode} maxLength={192} spellCheck={false} autoComplete="off"
                  onChange={(event) => setReceivedCode(event.target.value)} />
              </label>
              <button disabled={outgoing || !targetEndpoint.trim() || !receivedCode.trim() || !/^[0-9a-f]{64}$/.test(issuer.trim())}>
                Request Remote pairing
              </button>
            </form>
            <h3>Send one file</h3>
            <label>Authorized recipient
              <select value={outgoingPeer} onChange={(event) => setOutgoingPeer(event.target.value)}>
                <option value="">Choose an authorized device</option>
                {snapshot.peers.map((peer) => <option key={peer.id} value={peer.id}>{peer.name} · {peer.id.slice(0, 12)}</option>)}
              </select>
            </label>
            <button disabled={outgoing || !targetEndpoint.trim() || !snapshot.peers.some((peer) => peer.id === outgoingPeer)}
              onClick={() => {
                setOutgoing(true); setOutgoingMessage("Choose a file. The other device must accept before upload starts.");
                void invoke<{ state: string; bytesTransferred: number }>("windows_send_remote_file", { endpoint: targetEndpoint.trim(), peerId: outgoingPeer })
                  .then((receipt) => setOutgoingMessage(receipt.state === "completed"
                    ? "Delivered. The recipient verified the file." : "Transfer ended: " + receipt.state + "."))
                  .catch(() => setOutgoingMessage("No verified delivery. The transfer was cancelled, declined or could not connect."))
                  .finally(() => setOutgoing(false));
              }}>Choose file to send</button>
            <p role="status">{outgoingMessage}</p>
          </section>}
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
            {product && <p>Verified incoming files are saved to <code>RemoteReceived</code> in AeRift’s Windows local data folder.</p>}
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
