import { useEffect, useId, useRef, useState } from "react";
import { useVisibleNativeRefresh } from "./useVisibleNativeRefresh";
import { Button } from "@aerift/ui";
import { FriendsIconButton } from "../FriendsWorkspace";
import type { FriendContact } from "@aerift/app-contract/friends";
import { command } from "../nativeAppPort";

type SendStatus = { state: string; bytesTransferred: number };
type FileOffer = { id: string; issuer: string; sender: string; label: string; sizeBytes: number; accepted: boolean };
type FileView = {
  personTransfersAvailable?: boolean;
  incoming: FileOffer[];
  outgoing: readonly [string, number, string | null] | null;
  canRelease: boolean;
  receipts: readonly [string, string, SendStatus][];
};
type Action =
  | { action: "offer_contact"; friendId: string }
  | { action: "accept_contact_offer" | "decline_contact_offer" | "reconcile_contact_offer"; id: string }
  | { action: "send" | "withdraw"; id: string };

export function WindowsFriendsFiles({ contacts, preferredContact }: { contacts: readonly FriendContact[]; preferredContact?: string }) {
  const friendField = useId();
  const [view, setView] = useState<FileView>();
  const [person, setPerson] = useState(preferredContact ?? "");
  const previousPreferred = useRef(preferredContact);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [unavailable, setUnavailable] = useState(false);
  const refresh = useVisibleNativeRefresh("friends_files_view", 1000,
    async () => {
      const result = await command<FileView>("friends_files_view");
      if (!result.ok) throw result.error;
      return result.value;
    },
    value => { setView(value); setUnavailable(false); },
    () => { setView(undefined); setUnavailable(false); },
    () => { setView(undefined); setUnavailable(true); },
  );
  const outgoing = view?.outgoing;
  useEffect(() => {
    if (busy || outgoing) return;
    if (preferredContact && previousPreferred.current !== preferredContact) setPerson(preferredContact);
    previousPreferred.current = preferredContact;
  }, [preferredContact, outgoing, busy]);

  async function apply(request: Action) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNote("");
    try {
      const result = await command<SendStatus | null>("friends_files_action", { request });
      if (!result.ok) {
        setNote(result.error.code === "cancelled" ? "Action canceled." : "Couldn’t complete this action. Try again.");
      } else if (request.action === "offer_contact") {
        setNote("Offer sent. Nothing is uploaded until your friend accepts.");
      } else if (request.action === "accept_contact_offer") {
        setNote("You accepted the file on this device.");
      } else if (request.action === "decline_contact_offer") {
        setNote("You declined the file on this device.");
      } else if (request.action === "send") {
        setNote(result.value?.state === "completed" ? "File received and verified." : "Transfer did not complete.");
      }
    } catch {
      setNote("Friends transfers are temporarily unavailable.");
    } finally {
      busyRef.current = false;
      setBusy(false);
      refresh();
    }
  }

  const selected = contacts.find(contact => contact.id === person);
  return <div aria-label="Private Friends file transfer">
    {!view ? unavailable ? <div className="ae-friends-actions"><p role="alert">Private transfers are unavailable.</p>
      <FriendsIconButton icon="retry" name="Retry private transfers" onClick={refresh} /></div>
      : <p role="status">Checking private transfers…</p> : <>
      {!view.personTransfersAvailable ? <p>Friends transfers aren’t available on this connection yet.</p> :
        !outgoing && <form onSubmit={event => {
          event.preventDefault();
          if (selected && view.personTransfersAvailable) void apply({ action: "offer_contact", friendId: person });
        }}>
          <div className="ae-friends-field">
            <label htmlFor={friendField}>Friend</label>
            <select id={friendField} value={person} onChange={event => setPerson(event.target.value)}>
              <option value="">Choose a verified friend</option>
              {contacts.map(contact => <option key={contact.id} value={contact.id}>{contact.label}</option>)}
            </select>
          </div>
          <p>Your friend chooses where to accept. Only the first acceptance can receive the file.</p>
          <Button type="submit" disabled={busy || !selected}>Choose file and send offer</Button>
        </form>}
      {outgoing && <section aria-label="Outgoing offer">
        <p>{view.canRelease ? "Accepted. You can send the file now." : "Waiting for acceptance. No file has been sent."}</p>
        <Button disabled={busy || !view.personTransfersAvailable || !view.canRelease}
          onClick={() => void apply({ action: "send", id: outgoing[0] })}>Send accepted file</Button>
        <FriendsIconButton icon="close" name="Withdraw offer" disabled={busy}
          onClick={() => void apply({ action: "withdraw", id: outgoing[0] })} />
      </section>}
      {view.personTransfersAvailable && view.incoming.map(offer => {
        const receipt = view.receipts.some(([deviceId, id]) => deviceId === offer.issuer && id === offer.id);
        return <section key={`${offer.issuer}:${offer.id}`} aria-label="Incoming file offer">
          <p><strong>{offer.label}</strong> · {offer.sizeBytes.toLocaleString()} bytes</p>
          <p>From {contacts.find(contact => contact.id === offer.sender)?.label ?? "a verified friend"}</p>
          {receipt ? <p>Received and verified.</p> : offer.accepted ? <p>Accepted here. Waiting for the file.</p> :
            <div className="ae-friends-actions">
              <Button disabled={busy} onClick={() => void apply({ action: "accept_contact_offer", id: offer.id })}>Accept on this device</Button>
              <Button variant="quiet" disabled={busy} onClick={() => void apply({ action: "decline_contact_offer", id: offer.id })}>Decline</Button>
            </div>}
        </section>;
      })}
    </>}
    {note && <p role="status">{note}</p>}
  </div>;
}
