import { useMemo, useState } from "react";
import { useVisibleNativeRefresh } from "./useVisibleNativeRefresh";
import { PrivateRemoteFolders } from "./PrivateRemoteFolders";
import { TransferIsland, type TransferIslandReceipt } from "@aerift/ui";
import { usePrivateRemoteUpload } from "./usePrivateRemoteUpload";
import { incomingRemoteIslandTransfers, type IncomingRemoteFile, type IncomingRemoteFolder } from "./private-remote-island";
import { invoke } from "@tauri-apps/api/core";

type Device = { id: string; name: string; platform: string };
type Snapshot = {
  foldersAvailable?: boolean; foldersActive?: boolean;
  active: boolean; endpoint: string; identity: string | null;
  peers: Device[]; pairing: { id: string; peer: Device } | null; offers: IncomingRemoteFile[];
};

export function PrivateRemoteDev({ product = false }: { product?: boolean }) {
  const [folderOffers, setFolderOffers] = useState<readonly IncomingRemoteFolder[]>([]);
  const [fileProgress, setFileProgress] = useState<TransferIslandReceipt>();
  const [folderProgress, setFolderProgress] = useState<TransferIslandReceipt>();
  const upload = usePrivateRemoteUpload("file", setFileProgress);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [permission, setPermission] = useState(false);
  const [enableFolders, setEnableFolders] = useState(false);
  const [busy, setBusy] = useState(false);
  const [peerId, setPeerId] = useState("");
  const [invite, setInvite] = useState("");
  const [notice, setNotice] = useState("");
  const [snapshotUnavailable, setSnapshotUnavailable] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [targetEndpoint, setTargetEndpoint] = useState("");
  const [issuer, setIssuer] = useState("");
  const [receivedCode, setReceivedCode] = useState("");
  const [outgoingPeer, setOutgoingPeer] = useState("");
  const [outgoing, setOutgoing] = useState(false);
  const [outgoingMessage, setOutgoingMessage] = useState("");
  const [revoke, setRevoke] = useState("");

  const refresh = useVisibleNativeRefresh("private_remote_snapshot", 750,
    () => invoke<Snapshot>("private_remote_snapshot"),
    (value) => { setSnapshot(value); setSnapshotUnavailable(false); setFresh(true); },
    () => setFresh(false),
    () => {
      setFresh(false);
      setSnapshotUnavailable(true);
    },
  );

  async function operation(work: () => Promise<unknown>, canStop = false) {
    if (busy || (!fresh && !canStop)) return;
    setBusy(true);
    setNotice("");
    try {
      await work();
      setFresh(false);
      refresh();
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
    }, request.action === "stop");
  }

  const active = snapshot?.active === true;
  const islandTransfers = useMemo(() => {
    const receiving = incomingRemoteIslandTransfers(snapshot?.offers ?? [], snapshot?.foldersActive ? folderOffers : []);
    return [...receiving, ...(fileProgress ? [fileProgress] : []), ...(snapshot?.foldersActive && folderProgress ? [folderProgress] : [])];
  }, [snapshot?.offers, snapshot?.foldersActive, folderOffers, fileProgress, folderProgress]);
  return (
    <main className="ae-private-remote-dev">
      <h1>{product ? "Remote transfers" : "Private Remote Development"}</h1>
      <p>{product ? "Send and receive files with invited devices over your private VPN. Nearby is off in this mode."
        : "Receiver qualification only. Nearby, discovery, gestures and the normal workspace are not running."}</p>
      {notice && <p role="status">{notice}</p>}
      {snapshotUnavailable && <p role="status">Private Remote native capability is unavailable.</p>}
      {snapshot && <p>Selected private endpoint: <code>{snapshot.endpoint}</code></p>}
      {active && (
      <button type="button" disabled={busy}
        onClick={() => action({ action: "stop" }, () => {
          upload.close();
          setFolderProgress(undefined);
          setInvite(""); setPermission(false); setEnableFolders(false);
        })}>
        {product ? "Stop Remote" : "Stop private receiver"}
      </button>
      )}
      {!fresh && !snapshotUnavailable && <p role="status">Refreshing private transfer state…</p>}
      {/* Keep mounted editors and folder selection UI across minimization,
          but never permit offer actions until fresh native data returns. */}
      <fieldset disabled={!fresh} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      {!active ? (
        <section aria-labelledby="remote-start-heading">
          <h2 id="remote-start-heading">Private receiver is off</h2>
          <label><input type="checkbox" checked={permission}
            onChange={(event) => setPermission(event.target.checked)} />
            {product ? "Start listening at this exact address on my private VPN."
              : "This endpoint belongs to an already-authorized private test overlay. I will use synthetic files only."}
          </label>
          {product && snapshot?.foldersAvailable && <label>
            <input type="checkbox" checked={enableFolders}
              onChange={(event) => setEnableFolders(event.target.checked)} />
            Enable private folder transfers on this VPN listener for this session.
          </label>}
          <p><button type="button" disabled={!permission || !snapshot || busy}
            onClick={() => void operation(async () => { await invoke("private_remote_start", { confirmed: permission, enableFolders: product && enableFolders }); setPermission(false); setEnableFolders(false); })}>
            {product ? "Start Remote" : "Start private receiver"}
          </button></p>
        </section>
      ) : (
        <>
          <p>Device fingerprint: <code>{snapshot.identity}</code></p>
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
                .then(() => { setReceivedCode(""); setOutgoingMessage("Remote pairing approved."); refresh(); })
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
                const transfer = upload.begin();
                void invoke<{ state: string; bytesTransferred: number }>("windows_send_remote_file",
                  { endpoint: targetEndpoint.trim(), peerId: outgoingPeer, progress: transfer.updates })
                  .then((receipt) => setOutgoingMessage(receipt.state === "completed"
                    ? "Delivered. The recipient verified the file." : "Transfer ended: " + receipt.state + "."))
                  .catch(() => setOutgoingMessage("No verified delivery. The transfer was cancelled, declined or could not connect."))
                  .finally(() => { transfer.close(); setOutgoing(false); });
              }}>Choose file to send</button>
            <p role="status">{outgoingMessage}</p>
          </section>}
          {product && snapshot.foldersActive && <PrivateRemoteFolders peers={snapshot.peers} endpoint={targetEndpoint}
            onIncomingChange={setFolderOffers} onOutgoingChange={setFolderProgress} />}
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
      </fieldset>
      {product && <TransferIsland transfers={islandTransfers} suppressed={!active || !fresh} />}
    </main>
  );
}
