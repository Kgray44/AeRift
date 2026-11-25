import { useId, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Button, GlassSurface, Sheet, SpatialIcon } from "@aerift/ui";
import {
  friendTargets,
  type FriendContact, type FriendObjectKind, type FriendTarget, type FriendsPort, type FriendsRequest, type FriendsSnapshot,
} from "@aerift/app-contract/friends";
import "./friends.css";
import { FriendProfileEditor, ProfileBadge, type ReceivedProfileImages } from "./FriendProfileEditor";
import { emptyFriendProfiles, emptyPresentation, friendDisplayName, readFriendProfiles, saveFriendPresentation } from "./friends-profile";

const kinds: Record<FriendObjectKind, string> = {
  file: "File", folder: "Folder", photo: "Photo", video: "Video", link: "Link", clipboard: "Clipboard item", note: "Note",
};

type WorkspacePanel = "overview" | "transfer" | "enrollment";
type FriendsDesktop = {
  pendingInvitation?: boolean;
  transfer: (preferredContact?: string) => ReactNode;
  enrollment: ReactNode;
};

export function FriendsIconButton({ name, icon, ...props }: Omit<ComponentProps<typeof Button>, "children" | "title" | "aria-label"> & {
  name: string; icon: ComponentProps<typeof SpatialIcon>["name"];
}) {
  return <Button variant="quiet" {...props} className={["ae-friends-icon-button", props.className].filter(Boolean).join(" ")}
    title={name} aria-label={name}><SpatialIcon name={icon} size={18} /></Button>;
}

const panelNames = { transfer: "Private transfers", enrollment: "Device enrollment" } as const;

export function FriendsWorkspace({ snapshot, port, mobile, setup, desktop, receivedProfileImages, verifiedOwnProfileName }: {
  snapshot: FriendsSnapshot; port: Pick<FriendsPort, "apply"> & Partial<FriendsPort>; mobile?: boolean; setup?: ReactNode; desktop?: FriendsDesktop; receivedProfileImages?: ReceivedProfileImages;
  /** Read-only name from a host that has verified the user's shared profile. */
  verifiedOwnProfileName?: string;
}) {
  const [profiles, setProfiles] = useState(() => {
    try { return readFriendProfiles(localStorage); } catch { return emptyFriendProfiles(); }
  });
  const [edit, setEdit] = useState<{ kind: "own" } | { kind: "friend"; id: string }>();
  const [editOpen, setEditOpen] = useState(false);
  const editorRevision = useRef(0);
  const editOrigin = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const inviteId = useId();
  const cardId = useId();
  const pairingId = useId();
  const [pairing, setPairing] = useState(false);
  const [pairingMounted, setPairingMounted] = useState(false);
  const pairingOrigin = useRef<HTMLButtonElement>(null);
  const addFriendButton = useRef<HTMLButtonElement>(null);
  const pairingIsAvailable = !!setup || !!(port.createContactCard && port.createInvitation);
  const hasPendingInvitation = desktop?.pendingInvitation || snapshot.invitations.length !== 0;
  const [selected, setSelected] = useState<string>();
  const [panel, setPanel] = useState<WorkspacePanel>("overview");
  const [visited, setVisited] = useState<ReadonlySet<WorkspacePanel>>(() => new Set());
  const [preferredContact, setPreferredContact] = useState<string>();
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const panelOrigin = useRef<HTMLElement>(null);
  const [entry, setEntry] = useState<"forward" | "back">();
  const [invitation, setInvitation] = useState("");
  const [card, setCard] = useState("");
  const [recipientCard, setRecipientCard] = useState("");
  const [generated, setGenerated] = useState<{ invitation: string; expiresAt: string }>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const contact = snapshot.contacts.find(item => item.id === selected);
  const editFriend = edit?.kind === "friend" ? snapshot.contacts.find(item => item.id === edit.id) : undefined;
  const ownName = friendDisplayName(verifiedOwnProfileName ?? "My profile", profiles.self);
  const contactName = contact ? friendDisplayName(contact.label, profiles.people[contact.id]) : undefined;
  const title = useRef<HTMLHeadingElement>(null);
  const previous = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (panel === "overview" && previous.current !== contact?.id) title.current?.focus();
    previous.current = contact?.id;
  }, [contact?.id, panel]);

  useLayoutEffect(() => {
    if (panel !== "overview") panelHeading.current?.focus();
  }, [panel]);

  function editProfile(target: NonNullable<typeof edit>, origin: HTMLButtonElement) {
    editOrigin.current = origin;
    origin.focus({ preventScroll: true });
    editorRevision.current++;
    setEdit(target);
    setEditOpen(true);
  }

  function showPairing(origin: HTMLButtonElement) {
    // Native dialog focus restoration uses the element focused before showModal.
    // Focus explicitly because not all WebViews focus pointer-clicked buttons.
    pairingOrigin.current = origin;
    origin.focus({ preventScroll: true });
    setError("");
    setPairingMounted(true);
    setPairing(true);
  }

  function reveal(next: Exclude<WorkspacePanel, "overview">, origin: HTMLElement, contactId?: string) {
    if (next === panel) { backToOverview(); return; }
    panelOrigin.current = origin;
    if (next === "transfer" && contactId) setPreferredContact(contactId);
    setVisited(known => new Set([...known, next]));
    setPanel(next);
  }

  function backToOverview() {
    setPanel("overview");
    requestAnimationFrame(() => {
      const origin = panelOrigin.current;
      if (origin?.isConnected && !origin.matches(":disabled")) origin.focus();
      else title.current?.focus();
    });
  }

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

  return <div className="ae-friends" data-mobile={mobile ? "" : undefined} data-detail={contact ? "" : undefined} data-desktop={desktop ? "" : undefined}>
    <GlassSurface className="ae-friends-list" data-ae-route-enter={mobile && !contact ? entry : undefined} aria-labelledby={headingId}>
      <div className="ae-friends-header">
        <h3 id={headingId} tabIndex={-1} ref={!contact ? title : undefined}>{desktop ? "People" : "Your friends"}</h3>
        {pairingIsAvailable && <div className="ae-friends-pair-controls">
          {hasPendingInvitation && <FriendsIconButton icon="activity" className="ae-friends-attention"
            name="Review friendship invitation" aria-haspopup="dialog" aria-controls={pairingMounted ? pairingId : undefined}
            onClick={event => showPairing(event.currentTarget)} />}
          <FriendsIconButton icon="plus" ref={addFriendButton} variant="secondary" name="Add a friend" aria-haspopup="dialog"
            aria-controls={pairingMounted ? pairingId : undefined} onClick={event => showPairing(event.currentTarget)} />
        </div>}
      </div>
      <div className="ae-friends-own">
        <ProfileBadge name={ownName} avatar={profiles.self.avatar} />
        <span><strong>{ownName}</strong>{ownName !== "My profile" && <small>My profile</small>}</span>
        <FriendsIconButton icon="edit" name="Edit my profile" aria-haspopup="dialog"
          onClick={event => editProfile({ kind: "own" }, event.currentTarget)} />
      </div>
      {!desktop && <p>Friends are invited privately. Nearby devices aren't added here automatically.</p>}
      {snapshot.contacts.length > 0 ? <ul className="ae-friends-roster">
        {snapshot.contacts.map(person => <li key={person.id}><Button className="ae-friends-row" variant="quiet"
          aria-pressed={person.id === contact?.id} onClick={() => { setEntry("forward"); setSelected(person.id); setPanel("overview"); }}>
          <ProfileBadge name={friendDisplayName(person.label, profiles.people[person.id])} avatar={profiles.people[person.id]?.avatar} />
          <span>{friendDisplayName(person.label, profiles.people[person.id])}</span><SpatialIcon name="chevron" size={16} />
        </Button></li>)}
      </ul> : !desktop ? <p>No friends yet.</p> : null}
    </GlassSurface>
    <GlassSurface className="ae-friends-detail" key={mobile ? contact?.id ?? "list" : undefined} data-ae-route-enter={mobile && contact ? entry : undefined}>
      {desktop && <div className="ae-friends-toolbar" role="group" aria-label="Friends actions">
        <FriendsIconButton icon="send" name="Private transfers" aria-expanded={panel === "transfer"}
          onClick={event => reveal("transfer", event.currentTarget)} />
        <FriendsIconButton icon="devices" name="Enroll a device" aria-expanded={panel === "enrollment"}
          onClick={event => reveal("enrollment", event.currentTarget)} />
      </div>}
      {desktop && panel !== "overview" && <div className="ae-friends-panel-heading">
        <FriendsIconButton icon="chevron" className="ae-friends-back" name="Back to friend details" onClick={backToOverview} />
        <h3 tabIndex={-1} ref={panelHeading}>{panelNames[panel]}</h3>
      </div>}
      <div hidden={panel !== "overview"}>
        {contact ? <>
          {mobile && <Button variant="quiet" onClick={() => { setEntry("back"); setSelected(undefined); }}>Back to friends</Button>}
          <div className="ae-friends-contact-heading">
            <ProfileBadge name={contactName!} avatar={profiles.people[contact.id]?.avatar} size="detail" />
            <div><h3 tabIndex={-1} ref={title}>{contactName}</h3>
              {desktop && <p>{contactName === contact.label ? "Verified friend" : `Verified as ${contact.label}`}</p>}
            </div>
            <FriendsIconButton icon="edit" name="Edit friend appearance" aria-haspopup="dialog"
              onClick={event => editProfile({ kind: "friend", id: contact.id }, event.currentTarget)} />
            {desktop && <FriendsIconButton variant="primary" icon="send" name={`Send a file to ${contact.label}`}
              disabled={!friendTargets(snapshot, contact.id).length}
              onClick={event => reveal("transfer", event.currentTarget, contact.id)} />}
          </div>
          <FriendDetail key={contact.id} contact={contact} snapshot={snapshot} port={port} busy={busy} run={run} apply={apply}
            setupOnly={!!setup} compact={!!desktop} />
        </> : desktop ? <div className="ae-friends-empty">
          <SpatialIcon name="friends" size={30} />
          <h3 tabIndex={-1} ref={title}>{snapshot.contacts.length ? "Choose a friend" : "No friends yet"}</h3>
          <p>{snapshot.contacts.length ? "Pick someone from the list to see their devices and permissions." :
            "Add a friend with a private invitation."}</p>
        </div> : <p>Select a friend to see their authorized devices and transfer activity.</p>}
      </div>
      {desktop && <>
        {visited.has("transfer") && <div className="ae-friends-workflow" hidden={panel !== "transfer"}>{desktop.transfer(preferredContact)}</div>}
        {visited.has("enrollment") && <div className="ae-friends-workflow" hidden={panel !== "enrollment"}>{desktop.enrollment}</div>}
      </>}
    </GlassSurface>
    {pairingIsAvailable && pairingMounted && <Sheet id={pairingId} className="ae-friends-pair-sheet" open={pairing}
      title="Friends" closeIcon onClose={() => setPairing(false)} onAfterClose={() => {
        const origin = pairingOrigin.current;
        (origin?.isConnected ? origin : addFriendButton.current)?.focus({ preventScroll: true });
      }}>
      {setup ?? <div aria-label="Private friendship invitation">
        <p>First exchange contact cards privately. Then make an invitation from the recipient’s card. The invitation is bound to that identity. Compare the verification value before approving.</p>
        <Button disabled={busy} onClick={() => void run(() => port.createContactCard!(), value => setCard(value.card))}>Show my private contact card</Button>
        {card && <div><label htmlFor={cardId}>Your private contact card</label>
          <textarea id={cardId} readOnly value={card} autoComplete="off" spellCheck={false} /></div>}
        <form onSubmit={event => {
          event.preventDefault();
          const value = recipientCard.trim();
          if (value) void run(() => port.createInvitation!(value), result => { setGenerated(result); setRecipientCard(""); });
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
      </div>}
      {error && pairing && <p role="alert">{error}</p>}
    </Sheet>}
    {edit && (edit.kind === "own" || editFriend) && <FriendProfileEditor key={editorRevision.current}
      open={editOpen} received={receivedProfileImages}
      target={edit.kind === "own" ? { kind: "own", verifiedName: verifiedOwnProfileName ?? "My profile", local: profiles.self }
        : { kind: "friend", verifiedName: editFriend!.label, local: profiles.people[edit.id] ?? emptyPresentation() }}
      onClose={() => setEditOpen(false)}
      onAfterClose={() => (editOrigin.current?.isConnected ? editOrigin.current : title.current)?.focus({ preventScroll: true })}
      onSave={value => setProfiles(saveFriendPresentation(localStorage, edit.kind === "own" ? "self" : edit.id, value))} />}
    {error && !pairing && <p className="ae-friends-feedback" role="alert">{error}</p>}
  </div>;
}

type Runner = <T>(operation: () => Promise<import("@aerift/app-contract").Result<T>>, after?: (value: T) => void) => Promise<void>;
function FriendDetail({ contact, snapshot, port, busy, run, apply, setupOnly, compact }: {
  contact: FriendContact; snapshot: FriendsSnapshot; port: Pick<FriendsPort, "apply"> & Partial<FriendsPort>; busy: boolean; run: Runner; setupOnly: boolean; compact: boolean;
  apply: (request: FriendsRequest, after?: () => void) => Promise<void>;
}) {
  const [destination, setDestination] = useState("");
  const [choice, setChoice] = useState<{ selectionId: string; label: string; target: FriendTarget }>();
  const [confirm, setConfirm] = useState<{ kind: "remove" } | { kind: "device"; id: string }>();
  const [enrollment, setEnrollment] = useState("");
  const [permissions, setPermissions] = useState(false);
  const permissionsId = useId();
  const devices = friendTargets(snapshot, contact.id);
  const offers = snapshot.offers.filter(offer => offer.friendId === contact.id);
  const choiceAvailable = choice && (choice.target.deviceId
    ? devices.some(device => device.id === choice.target.deviceId) : devices.length > 0);
  const permissionControls = <>
    <label className="ae-friends-check"><input type="checkbox" checked={contact.incomingAllowed} disabled={busy} onChange={event =>
      void apply({ action: "set_permissions", friendId: contact.id, allowIncoming: event.target.checked })} /> Allow this friend to make offers</label>
    {confirm?.kind === "remove" ? <div className="ae-friends-actions">
      <Button variant="danger" disabled={busy} onClick={() => void apply({ action: "remove_friend", friendId: contact.id }, () => setConfirm(undefined))}>Confirm remove friend</Button>
      <Button variant="quiet" disabled={busy} onClick={() => setConfirm(undefined)}>Cancel</Button>
    </div> : <Button variant="quiet" disabled={busy} onClick={() => setConfirm({ kind: "remove" })}>Remove friend</Button>}
  </>;
  return <>
    {!compact && <p>Verified identity: <code>{contact.verification}</code></p>}
    {!setupOnly && <section aria-label="Send to friend">
      <h4>Send an object</h4>
      {devices.length === 0 ? <p>No authorized devices.</p> : <>
        <label>Send to<select disabled={busy} value={destination} onChange={event => { setDestination(event.target.value); setChoice(undefined); }}>
          <option value="">Any authorized device</option>
          {devices.map(device => <option key={device.id} value={device.id}>{device.label} · {device.availability}</option>)}
        </select></label>
        <div className="ae-friends-actions">{port.pickObject && snapshot.supportedObjects.map(kind => <Button variant="quiet" key={kind}
          disabled={busy || (destination !== "" && !devices.some(device => device.id === destination))} onClick={() => {
            const target = destination ? { friendId: contact.id, deviceId: destination } : { friendId: contact.id };
            void run(() => port.pickObject!(kind), value => setChoice(value ? { ...value, target } : undefined));
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
    </section>}
    <section aria-label="Authorized devices">
      <div className="ae-friends-header"><h4>Authorized devices</h4>
        {compact && <FriendsIconButton icon="settings" name="Friend permissions" aria-expanded={permissions} aria-controls={permissionsId}
          onClick={() => { setPermissions(!permissions); setConfirm(undefined); }} />}
      </div>
      {devices.length ? <ul className="ae-friends-devices">{devices.map(device => <li key={device.id}>
        {compact && <SpatialIcon name="devices" size={18} />}
        <span>{device.label} <small>· {device.availability === "unknown" ? "Status unavailable" : device.availability}</small></span>
        {(!compact || permissions) && (confirm?.kind === "device" && confirm.id === device.id ? <div className="ae-friends-actions">
          <Button variant="danger" disabled={busy}
            onClick={() => void apply({ action: "revoke_device", friendId: contact.id, deviceId: device.id }, () => setConfirm(undefined))}>Confirm revoke</Button>
          <Button variant="quiet" disabled={busy} onClick={() => setConfirm(undefined)}>Cancel</Button>
        </div> : compact ? <FriendsIconButton icon="close" name={`Revoke ${device.label}`} disabled={busy}
          onClick={() => setConfirm({ kind: "device", id: device.id })} /> :
          <Button variant="quiet" disabled={busy} onClick={() => setConfirm({ kind: "device", id: device.id })}>Revoke</Button>)}
      </li>)}</ul> : <p>No authorized devices.</p>}
      {!setupOnly && <form onSubmit={event => {
        event.preventDefault();
        const invitation = enrollment.trim();
        if (invitation) void apply({ action: "authorize_device", friendId: contact.id, invitation }, () => setEnrollment(""));
      }}>
        <label>Private device authorization<input value={enrollment} autoComplete="off" spellCheck={false} maxLength={8192}
          onChange={event => setEnrollment(event.target.value)} /></label>
        <Button type="submit" disabled={busy || !enrollment.trim()}>Review device authorization</Button>
      </form>}
    </section>
    {!setupOnly && <section aria-label="Pending transfers and history"><h4>Transfers</h4>
      {offers.length ? <ul>{offers.map(offer => <li key={offer.id}>
        <span>{offer.label} · {offer.state}</span>
        {offer.direction === "incoming" && offer.state === "pending" && <div className="ae-friends-actions">
          <Button disabled={busy || !contact.incomingAllowed}
            onClick={() => void apply({ action: "respond_offer", offerId: offer.id, accept: true })}>Accept</Button>
          <Button variant="quiet" disabled={busy}
            onClick={() => void apply({ action: "respond_offer", offerId: offer.id, accept: false })}>Decline</Button>
        </div>}
      </li>)}</ul> : <p>No transfer activity.</p>}
    </section>}
    {compact ? <section id={permissionsId} hidden={!permissions} aria-label="Friend permissions">
      <h4>Friend permissions</h4>
      {permissionControls}
      <details><summary>Verification fingerprint</summary><code>{contact.verification}</code></details>
    </section> : <details><summary>Friend permissions</summary>{permissionControls}</details>}
  </>;
}
