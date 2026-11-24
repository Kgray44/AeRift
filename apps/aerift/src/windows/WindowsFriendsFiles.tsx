import { useCallback, useEffect, useRef, useState } from "react";
import { Button, GlassSurface } from "@aerift/ui";
import type { FriendContact } from "@aerift/app-contract/friends";
import { command } from "../nativeAppPort";

type SendStatus = { state: string; bytesTransferred: number };
type FileOffer = { id: string; issuer: string; sender: string; label: string; sizeBytes: number; accepted: boolean };
type FileView = {
  endpoint: [string, string, number] | null;
  incoming: FileOffer[];
  outgoing: [string, string, boolean] | null;
  receipts: [string, string, SendStatus][];
};
type Action =
  | { action: "open"; address: string }
  | { action: "close" }
  | { action: "offer"; friendId: string; device: string; offerRoute: string; payloadRoute: string }
  | { action: "accept"; id: string; issuer: string; offerRoute: string }
  | { action: "decline"; id: string; issuer: string }
  | { action: "send" | "withdraw"; id: string };

export function WindowsFriendsFiles({ contacts }: { contacts: readonly FriendContact[] }) {
  const [view, setView] = useState<FileView>();
  const [local, setLocal] = useState("");
  const [person, setPerson] = useState("");
  const [device, setDevice] = useState("");
  const [offerRoute, setOfferRoute] = useState("");
  const [payloadRoute, setPayloadRoute] = useState("");
  const [acceptRoutes, setAcceptRoutes] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const refreshing = useRef(false);
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const result = await command<FileView>("friends_files_view");
      if (result.ok) setView(result.value);
    } finally { refreshing.current = false; }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const select = contacts.find(contact => contact.id === person);
  const recipient = select?.devices.find(item => item.id === device);
  const outgoing = view?.outgoing;
  async function apply(request: Action) {
    setBusy(true);
    setNote("");
    try {
      const result = await command<SendStatus | null>("friends_files_action", { request });
      if (!result.ok) {
        setNote(result.error.code === "cancelled" ? "Action canceled or the receive window expired." :
          "AeRift couldn't complete this action. Check the exact device, both private routes, and window expiration.");
      } else if (request.action === "send") {
        setNote(result.value?.state === "completed" ?
          `File received and verified: ${result.value.bytesTransferred.toLocaleString()} bytes.` : "Transfer did not complete.");
      } else if (request.action === "offer") {
        setNote("File offer sent. No file bytes will leave until your friend accepts and you select Send accepted file.");
      } else if (request.action === "accept") {
        setNote("Accepted on this device. The sender still needs to send the file.");
      }
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  return <GlassSurface className="ae-friends-detail" aria-label="Private Friends file transfer">
    <h3>Send a private file</h3>
    <p>For two current AeRift Windows users on a reachable private network or VPN. Transfers are limited to one file up to 64 MiB. No automatic retry or transfer after AeRift closes.</p>
    {!view ? <p>Checking the private file service…</p> : !view.endpoint ?
      <form onSubmit={event => { event.preventDefault(); void apply({ action: "open", address: local.trim() }); }}>
        <label>Your reachable private IPv4 address<input value={local} onChange={event => setLocal(event.target.value)}
          autoComplete="off" maxLength={15} /></label>
        <Button type="submit" disabled={busy || !local.trim() || contacts.length === 0}>Open five-minute transfer window</Button>
        {contacts.length === 0 && <p>Set up a verified friendship first.</p>}
      </form> : <>
        <p>Share these addresses privately with your intended friend before the window expires at {new Date(view.endpoint[2] * 1000).toLocaleTimeString()}.</p>
        <label>Offer address<input readOnly value={view.endpoint[0]} /></label>
        <label>Payload address<input readOnly value={view.endpoint[1]} /></label>
        <Button variant="quiet" onClick={() => void apply({ action: "close" })}>Close transfer window and cancel active sending</Button>
        {!outgoing && <form onSubmit={event => {
          event.preventDefault();
          if (recipient && select) void apply({ action: "offer", friendId: select.id, device: recipient.id, offerRoute: offerRoute.trim(), payloadRoute: payloadRoute.trim() });
        }}>
          <label>Friend<select value={person} onChange={event => { setPerson(event.target.value); setDevice(""); }}>
            <option value="">Choose a verified friend</option>
            {contacts.map(contact => <option key={contact.id} value={contact.id}>{contact.label}</option>)}
          </select></label>
          <label>Their authorized device<select disabled={!select} value={device} onChange={event => setDevice(event.target.value)}>
            <option value="">Choose an authorized device</option>
            {select?.devices.map(endpoint => <option key={endpoint.id} value={endpoint.id}>{endpoint.label}</option>)}
          </select></label>
          {recipient && <p>Compare the destination device fingerprint before sending the offer: <code>{recipient.id}</code></p>}
          <label>Their offer address<input value={offerRoute} autoComplete="off" maxLength={21} onChange={event => setOfferRoute(event.target.value)} /></label>
          <label>Their payload address<input value={payloadRoute} autoComplete="off" maxLength={21} onChange={event => setPayloadRoute(event.target.value)} /></label>
          <Button type="submit" disabled={busy || !recipient || !offerRoute.trim() || !payloadRoute.trim()}>Choose a file and send offer</Button>
        </form>}
        {outgoing && <section aria-label="Outgoing offer">
          <p>Recipient device: <code>{outgoing[1]}</code></p>
          <p>{outgoing[2] ? "Accepted by this exact device." : "Waiting for this device to accept."}</p>
          <Button disabled={busy || !outgoing[2]} onClick={() => void apply({ action: "send", id: outgoing[0] })}>Send accepted file</Button>
          <Button variant="quiet" disabled={busy} onClick={() => void apply({ action: "withdraw", id: outgoing[0] })}>Withdraw offer</Button>
        </section>}
        {view.incoming.map(offer => {
          const key = `${offer.issuer}:${offer.id}`;
          const received = view.receipts.find(([deviceId, id]) => deviceId === offer.issuer && id === offer.id);
          return <section key={key} aria-label="Incoming file offer">
            <p>{offer.label} ({offer.sizeBytes.toLocaleString()} bytes) from {contacts.find(contact => contact.id === offer.sender)?.label ?? "verified friend"}</p>
            <p>Sender device: <code>{offer.issuer}</code></p>
            {received ? <p>Received and verified. Saved in FriendsReceived in your AeRift local-data folder.</p> :
              offer.accepted ? <p>Accepted. Waiting for the sender to transfer the file.</p> : <>
                <label>Sender’s offer address<input value={acceptRoutes[key] ?? ""} autoComplete="off" maxLength={21}
                  onChange={event => setAcceptRoutes(routes => ({ ...routes, [key]: event.target.value }))} /></label>
                <Button disabled={busy || !acceptRoutes[key]?.trim()} onClick={() => void apply({
                  action: "accept", id: offer.id, issuer: offer.issuer, offerRoute: acceptRoutes[key].trim()
                })}>Accept file on this device</Button>
                <Button disabled={busy} variant="quiet" onClick={() => void apply({ action: "decline", id: offer.id, issuer: offer.issuer })}>Decline</Button>
              </>}
          </section>;
        })}
      </>}
    {note && <p role="status">{note}</p>}
  </GlassSurface>;
}
