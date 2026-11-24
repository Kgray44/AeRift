import { useId, useLayoutEffect, useRef, useState } from "react";
import { Button, GlassSurface, SpatialIcon } from "@aerift/ui";
import {
  friendTargets,
  type FriendContact, type FriendObjectKind, type FriendTarget, type FriendsPort, type FriendsRequest, type FriendsSnapshot,
} from "@aerift/app-contract/friends";
import "./friends.css";

const kinds: Record<FriendObjectKind, string> = {
  file: "File", folder: "Folder", photo: "Photo", video: "Video", link: "Link", clipboard: "Clipboard item", note: "Note",
};

export function FriendsWorkspace({ snapshot, port, mobile }: {
  snapshot: FriendsSnapshot; port: FriendsPort; mobile?: boolean;
}) {
  const headingId = useId();
  const inviteId = useId();
  const cardId = useId();
  const [selected, setSelected] = useState<string>();
  const [entry, setEntry] = useState<"forward" | "back">();
  const [invitation, setInvitation] = useState("");
  const [card, setCard] = useState("");
  const [recipientCard, setRecipientCard] = useState("");
  const [generated, setGenerated] = useState<{ invitation: string; expiresAt: string }>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const contact = snapshot.contacts.find(item => item.id === selected);
  const title = useRef<HTMLHeadingElement>(null);
  const previous = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (previous.current !== contact?.id) title.current?.focus();
    previous.current = contact?.id;
  }, [contact?.id]);

  async function run<T>(operation: () => Promise<import("@aerift/app-contract").Result<T>>, after?: (value: T) => void) {
    if (busyRef.current) return;
    busyRef.current = true;
    setError("");
    setBusy(true);
    try {
      const result = await operation();
      if (result.ok) after?.(result.value);
      else setError("AeRift couldn't complete that action. Review the request and try again.");
    } catch {
      setError("Friends is temporarily unavailable. Try again.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function apply(request: FriendsRequest, after?: () => void) {
    return run(() => port.apply(request), after);
  }

  return <div className="ae-friends" data-mobile={mobile ? "" : undefined} data-detail={contact ? "" : undefined}>
    <GlassSurface className="ae-friends-list" data-ae-route-enter={mobile && !contact ? entry : undefined} aria-labelledby={headingId}>
      <h3 id={headingId} tabIndex={-1} ref={!contact ? title : undefined}>Your friends</h3>
      <p>Friends are invited privately. Nearby devices aren't added here automatically.</p>
      {snapshot.contacts.length > 0 ? <ul>
        {snapshot.contacts.map(person => <li key={person.id}><Button className="ae-friends-row" variant="quiet"
          aria-pressed={person.id === contact?.id} onClick={() => { setEntry("forward"); setSelected(person.id); }}>
          <SpatialIcon name="friends" /><span>{person.label}</span><SpatialIcon name="chevron" size={16} />
        </Button></li>)}
      </ul> : <p>No friends yet.</p>}
      <details>
        <summary>Add a friend</summary>
        <p>First exchange contact cards privately. Then make an invitation from the recipient’s card. The invitation is bound to that identity. Compare the verification value before approving.</p>
        <Button disabled={busy} onClick={() => void run(() => port.createContactCard(), value => setCard(value.card))}>Show my private contact card</Button>
        {card && <div><label htmlFor={cardId}>Your private contact card</label>
          <textarea id={cardId} readOnly value={card} autoComplete="off" spellCheck={false} /></div>}
        <form onSubmit={event => {
          event.preventDefault();
          const value = recipientCard.trim();
          if (value) void run(() => port.createInvitation(value), result => { setGenerated(result); setRecipientCard(""); });
        }}>
          <label>Recipient’s private contact card<textarea autoComplete="off" spellCheck={false}
            value={recipientCard} onChange={event => { setGenerated(undefined); setRecipientCard(event.target.value); }} maxLength={8192} /></label>
          <Button type="submit" disabled={busy || !recipientCard.trim()}>Create targeted invitation</Button>
        </form>
        {generated && <div>
          <label htmlFor={inviteId}>Private invitation</label>
          <textarea id={inviteId} readOnly value={generated.invitation} autoComplete="off" spellCheck={false} />
          <small>Expires {new Date(generated.expiresAt).toLocaleString()}</small>
        </div>}
        <form onSubmit={event => {
          event.preventDefault();
          const value = invitation.trim();
          if (value) void apply({ action: "redeem_invitation", invitation: value }, () => setInvitation(""));
        }}>
          <label>Received invitation<input autoComplete="off" value={invitation}
            onChange={event => setInvitation(event.target.value)} spellCheck={false} maxLength={8192} /></label>
          <Button type="submit" disabled={busy || !invitation.trim()}>Review received invitation</Button>
        </form>
        {snapshot.invitations.map(item => <div className="ae-friends-invitation" key={item.id}>
          <strong>{item.label}</strong>
          <p>Compare this verification value with your friend: <b>{item.verification}</b></p>
          <Button disabled={busy} onClick={() => void apply({ action: "respond_invitation", invitationId: item.id, accept: true })}>Verify and approve</Button>
          <Button variant="quiet" disabled={busy} onClick={() => void apply({ action: "respond_invitation", invitationId: item.id, accept: false })}>Decline</Button>
        </div>)}
      </details>
    </GlassSurface>
    <GlassSurface className="ae-friends-detail" key={contact?.id ?? "none"} data-ae-route-enter={mobile && contact ? entry : undefined}>
      {contact ? <>
        {mobile && <Button variant="quiet" onClick={() => { setEntry("back"); setSelected(undefined); }}>Back to friends</Button>}
        <h3 tabIndex={-1} ref={title}>{contact.label}</h3>
        <FriendDetail key={contact.id} contact={contact} snapshot={snapshot} port={port} busy={busy} run={run} apply={apply} />
      </> : <p>Select a friend to see their authorized devices and transfer activity.</p>}
    </GlassSurface>
    {error && <p className="ae-friends-feedback" role="alert">{error}</p>}
  </div>;
}

type Runner = <T>(operation: () => Promise<import("@aerift/app-contract").Result<T>>, after?: (value: T) => void) => Promise<void>;
function FriendDetail({ contact, snapshot, port, busy, run, apply }: {
  contact: FriendContact; snapshot: FriendsSnapshot; port: FriendsPort; busy: boolean; run: Runner;
  apply: (request: FriendsRequest, after?: () => void) => Promise<void>;
}) {
  const [destination, setDestination] = useState("");
  const [choice, setChoice] = useState<{ selectionId: string; label: string; target: FriendTarget }>();
  const [confirm, setConfirm] = useState<{ kind: "remove" } | { kind: "device"; id: string }>();
  const [enrollment, setEnrollment] = useState("");
  const devices = friendTargets(snapshot, contact.id);
  const offers = snapshot.offers.filter(offer => offer.friendId === contact.id);
  const choiceAvailable = choice && (choice.target.deviceId
    ? devices.some(device => device.id === choice.target.deviceId) : devices.length > 0);
  return <>
    <p>Verified identity: <code>{contact.verification}</code></p>
    <section aria-label="Send to friend">
      <h4>Send an object</h4>
      {devices.length === 0 ? <p>No authorized devices.</p> : <>
        <label>Send to<select disabled={busy} value={destination} onChange={event => { setDestination(event.target.value); setChoice(undefined); }}>
          <option value="">Any authorized device</option>
          {devices.map(device => <option key={device.id} value={device.id}>{device.label} · {device.availability}</option>)}
        </select></label>
        <div className="ae-friends-actions">{snapshot.supportedObjects.map(kind => <Button variant="quiet" key={kind}
          disabled={busy || (destination !== "" && !devices.some(device => device.id === destination))} onClick={() => {
            const target = destination ? { friendId: contact.id, deviceId: destination } : { friendId: contact.id };
            void run(() => port.pickObject(kind), value => setChoice(value ? { ...value, target } : undefined));
          }}>{kinds[kind]}</Button>)}</div>
        {snapshot.supportedObjects.length === 0 && <p>Sending objects isn't available on this device.</p>}
        {choiceAvailable && <div className="ae-friends-actions">
          <span>{choice.label}</span>
          <Button disabled={busy} onClick={() => void apply({
            action: "offer", target: choice.target, selectionId: choice.selectionId,
          }, () => setChoice(undefined))}>Send offer</Button>
          <Button variant="quiet" disabled={busy} onClick={() => setChoice(undefined)}>Cancel</Button>
        </div>}
      </>}
    </section>
    <section aria-label="Authorized devices"><h4>Authorized devices</h4>
      <ul>{devices.map(device => <li key={device.id}>
        <span>{device.label} · {device.availability}</span>
        {confirm?.kind === "device" && confirm.id === device.id ? <Button variant="danger" disabled={busy}
          onClick={() => void apply({ action: "revoke_device", friendId: contact.id, deviceId: device.id }, () => setConfirm(undefined))}>Confirm revoke</Button>
          : <Button variant="quiet" disabled={busy} onClick={() => setConfirm({ kind: "device", id: device.id })}>Revoke</Button>}
      </li>)}</ul>
      <form onSubmit={event => {
        event.preventDefault();
        const invitation = enrollment.trim();
        if (invitation) void apply({ action: "authorize_device", friendId: contact.id, invitation }, () => setEnrollment(""));
      }}>
        <label>Private device authorization<input value={enrollment} autoComplete="off" spellCheck={false} maxLength={8192}
          onChange={event => setEnrollment(event.target.value)} /></label>
        <Button type="submit" disabled={busy || !enrollment.trim()}>Review device authorization</Button>
      </form>
    </section>
    <section aria-label="Pending transfers and history"><h4>Transfers</h4>
      {offers.length ? <ul>{offers.map(offer => <li key={offer.id}>
        <span>{offer.label} · {offer.state}</span>
        {offer.direction === "incoming" && offer.state === "pending" && <div className="ae-friends-actions">
          <Button disabled={busy || !contact.incomingAllowed}
            onClick={() => void apply({ action: "respond_offer", offerId: offer.id, accept: true })}>Accept</Button>
          <Button variant="quiet" disabled={busy}
            onClick={() => void apply({ action: "respond_offer", offerId: offer.id, accept: false })}>Decline</Button>
        </div>}
      </li>)}</ul> : <p>No transfer activity.</p>}
    </section>
    <details><summary>Friend permissions</summary>
      <label><input type="checkbox" checked={contact.incomingAllowed} disabled={busy} onChange={event =>
        void apply({ action: "set_permissions", friendId: contact.id, allowIncoming: event.target.checked })} /> Allow this friend to make offers</label>
      {confirm?.kind === "remove" ? <Button variant="danger" disabled={busy}
        onClick={() => void apply({ action: "remove_friend", friendId: contact.id })}>Confirm remove friend</Button>
        : <Button variant="quiet" disabled={busy} onClick={() => setConfirm({ kind: "remove" })}>Remove friend</Button>}
    </details>
  </>;
}
