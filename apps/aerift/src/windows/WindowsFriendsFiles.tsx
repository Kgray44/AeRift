import { useCallback, useEffect, useRef, useState } from "react";
import { Button, GlassSurface } from "@aerift/ui";
import type { FriendContact } from "@aerift/app-contract/friends";
import { command } from "../nativeAppPort";

type SendStatus = { state: string; bytesTransferred: number };
type FileOffer = { id: string; issuer: string; sender: string; label: string; sizeBytes: number; accepted: boolean };
type Profile = "primary" | "delegated";
type Route = { device: string; offerRoute: string; payloadRoute: string };
type FileView = {
  endpoint: [string, string, number] | null;
  incoming: FileOffer[];
  outgoing: [string, number, string | null] | null;
  profile: Profile | null;
  canRelease: boolean;
  memberRoster: Array<{ id: string; devices: string[] }>;
  receipts: [string, string, SendStatus][];
};
type Action =
  | { action: "open"; address: string; profile: Profile }
  | { action: "close" }
  | { action: "offer"; friendId: string; device: string; offerRoute: string; payloadRoute: string }
  | { action: "offer_person"; friendId: string; routes: Route[] }
  | { action: "reconcile"; id: string; issuer: string; offerRoute: string }
  | { action: "accept"; id: string; issuer: string; offerRoute: string }
  | { action: "decline"; id: string; issuer: string }
  | { action: "send" | "withdraw"; id: string };

export function WindowsFriendsFiles({ contacts }: { contacts: readonly FriendContact[] }) {
  const [view, setView] = useState<FileView>();
  const [local, setLocal] = useState("");
  const [person, setPerson] = useState("");
  const [profile, setProfile] = useState<Profile>("primary");
  const [target, setTarget] = useState<"device" | "person">("device");
  const [routes, setRoutes] = useState<Record<string, Partial<Route>>>({});
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
  const delegatedContacts = (view?.memberRoster ?? []).map(friend => ({
    id: friend.id, label: `Friend ${friend.id.slice(0, 12)}`,
    devices: friend.devices.map(id => ({ id, label: `Device ${id.slice(0, 12)}` })),
  }));
  const selectedRoster = (view?.profile ?? profile) === "delegated" ? delegatedContacts : contacts;
  const select = selectedRoster.find(contact => contact.id === person);
  const forPerson = target === "person" && view?.profile === "primary" && (select?.devices.length ?? 0) >= 2;
  const personRoutes = select?.devices.flatMap(endpoint => {
    const route = routes[endpoint.id];
    return route?.offerRoute?.trim() && route.payloadRoute?.trim()
      ? [{ device: endpoint.id, offerRoute: route.offerRoute.trim(), payloadRoute: route.payloadRoute.trim() }]
      : [];
  }) ?? [];
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
      } else if (request.action === "close") {
        setProfile("primary"); setTarget("device"); setPerson(""); setDevice(""); setRoutes({});
      } else if (request.action === "send") {
        setNote(result.value?.state === "completed" ?
          `File received and verified: ${result.value.bytesTransferred.toLocaleString()} bytes.` : "Transfer did not complete.");
      } else if (request.action === "offer" || request.action === "offer_person") {
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
      <form onSubmit={event => { event.preventDefault(); void apply({ action: "open", address: local.trim(), profile }); }}>
        {!!view.memberRoster.length && <label>Friends profile for this transfer window<select value={profile} disabled={busy}
          onChange={event => { setProfile(event.target.value as Profile); setPerson(""); setDevice(""); setTarget("device"); setRoutes({}); }}>
          <option value="primary">Primary Friends profile</option>
          <option value="delegated">Delegated friendship on this device</option>
        </select></label>}
        <label>Your reachable private IPv4 address<input value={local} onChange={event => setLocal(event.target.value)}
          autoComplete="off" maxLength={15} /></label>
        <Button type="submit" disabled={busy || !local.trim() || selectedRoster.length === 0}>Open five-minute transfer window</Button>
        {selectedRoster.length === 0 && <p>Set up a verified friendship first.</p>}
      </form> : <>
        <p>Active profile: {view.profile === "delegated" ? "delegated friendship only" : "primary Friends"}.</p>
        <p>Share these addresses privately with your intended friend before the window expires at {new Date(view.endpoint[2] * 1000).toLocaleTimeString()}.</p>
        <label>Offer address<input readOnly value={view.endpoint[0]} /></label>
        <label>Payload address<input readOnly value={view.endpoint[1]} /></label>
        <Button variant="quiet" onClick={() => void apply({ action: "close" })}>Close transfer window and cancel active sending</Button>
        {!outgoing && <form onSubmit={event => {
          event.preventDefault();
          if (forPerson && select && personRoutes.length >= 2) {
            void apply({ action: "offer_person", friendId: select.id, routes: personRoutes });
          } else if (!forPerson && recipient && select) void apply({ action: "offer", friendId: select.id, device: recipient.id, offerRoute: offerRoute.trim(), payloadRoute: payloadRoute.trim() });
        }}>
          <label>Friend<select value={person} onChange={event => { setPerson(event.target.value); setDevice(""); setTarget("device"); setRoutes({}); }}>
            <option value="">Choose a verified friend</option>
            {selectedRoster.map(contact => <option key={contact.id} value={contact.id}>{contact.label}</option>)}
          </select></label>
          {view.profile === "primary" && (select?.devices.length ?? 0) >= 2 &&
            <label>Target<select value={target} onChange={event => setTarget(event.target.value as "device" | "person")}>
              <option value="device">One specific device</option>
              <option value="person">This person, first device to accept</option>
            </select></label>}
          {forPerson ? <>
            <p>Enter privately verified addresses for at least two authorized devices. Only the first to accept can receive file contents.</p>
            {select?.devices.map(endpoint => <fieldset key={endpoint.id}>
              <legend>{endpoint.label} · {endpoint.id}</legend>
              <label>Offer address<input autoComplete="off" maxLength={21} value={routes[endpoint.id]?.offerRoute ?? ""}
                onChange={event => { const value = event.target.value; setRoutes(old => ({ ...old, [endpoint.id]: { ...old[endpoint.id], offerRoute: value } })); }} /></label>
              <label>Payload address<input autoComplete="off" maxLength={21} value={routes[endpoint.id]?.payloadRoute ?? ""}
                onChange={event => { const value = event.target.value; setRoutes(old => ({ ...old, [endpoint.id]: { ...old[endpoint.id], payloadRoute: value } })); }} /></label>
            </fieldset>)}
          </> : <>
            <label>Their authorized device<select disabled={!select} value={device} onChange={event => setDevice(event.target.value)}>
              <option value="">Choose an authorized device</option>
              {select?.devices.map(endpoint => <option key={endpoint.id} value={endpoint.id}>{endpoint.label}</option>)}
            </select></label>
            {recipient && <p>Compare the destination device fingerprint before sending the offer: <code>{recipient.id}</code></p>}
            <label>Their offer address<input value={offerRoute} autoComplete="off" maxLength={21} onChange={event => setOfferRoute(event.target.value)} /></label>
            <label>Their payload address<input value={payloadRoute} autoComplete="off" maxLength={21} onChange={event => setPayloadRoute(event.target.value)} /></label>
          </>}
          <Button type="submit" disabled={busy || (forPerson ? personRoutes.length < 2 : (!recipient || !offerRoute.trim() || !payloadRoute.trim()))}>Choose a file and send offer</Button>
        </form>}
        {outgoing && <section aria-label="Outgoing offer">
          <p>Offer acknowledged by {outgoing[1]} device(s).</p>
          {outgoing[2] && view.canRelease ? <p>Accepted on device <code>{outgoing[2]}</code>. Only this device can receive the file.</p> :
            <p>{outgoing[2] ? "This acceptance is no longer valid. Withdraw this offer and start again." : "Waiting for explicit acceptance. No file has been sent."}</p>}
          <Button disabled={busy || !view.canRelease} onClick={() => void apply({ action: "send", id: outgoing[0] })}>Send accepted file</Button>
          <Button variant="quiet" disabled={busy} onClick={() => void apply({ action: "withdraw", id: outgoing[0] })}>Withdraw offer</Button>
        </section>}
        {view.incoming.map(offer => {
          const key = `${offer.issuer}:${offer.id}`;
          const received = view.receipts.find(([deviceId, id]) => deviceId === offer.issuer && id === offer.id);
          return <section key={key} aria-label="Incoming file offer">
            <p>{offer.label} ({offer.sizeBytes.toLocaleString()} bytes) from {selectedRoster.find(contact => contact.id === offer.sender)?.label ?? "verified friend"}</p>
            <p>Sender device: <code>{offer.issuer}</code></p>
            {received ? <p>Received and verified. Saved in {view.profile === "delegated" ? "FriendsMemberReceived" : "FriendsReceived"} in your AeRift local-data folder.</p> :
              offer.accepted ? <p>Accepted. Waiting for the sender to transfer the file.</p> : <>
                <label>Sender’s offer address<input value={acceptRoutes[key] ?? ""} autoComplete="off" maxLength={21}
                  onChange={event => setAcceptRoutes(routes => ({ ...routes, [key]: event.target.value }))} /></label>
                <Button disabled={busy || !acceptRoutes[key]?.trim()} onClick={() => void apply({
                  action: "accept", id: offer.id, issuer: offer.issuer, offerRoute: acceptRoutes[key].trim()
                })}>Accept file on this device</Button>
                <Button disabled={busy} variant="quiet" onClick={() => void apply({ action: "decline", id: offer.id, issuer: offer.issuer })}>Decline</Button>
                <Button disabled={busy || !acceptRoutes[key]?.trim()} variant="quiet" onClick={() => void apply({
                  action: "reconcile", id: offer.id, issuer: offer.issuer, offerRoute: acceptRoutes[key].trim()
                })}>Check whether the offer is still available</Button>
              </>}
          </section>;
        })}
      </>}
    {note && <p role="status">{note}</p>}
  </GlassSurface>;
}
