import { useState } from "react";
import { Button } from "@aerift/ui";
import { command } from "../nativeAppPort";
import type { Result } from "@aerift/app-contract";
import type { FriendContact, FriendsPort } from "@aerift/app-contract/friends";

type Review = { id: string; verification: string; expiresAt: number };
export type SetupView = { profile: string; contacts: FriendContact[]; pendingRecipient?: Review | null };

export const setupPort: Pick<FriendsPort, "apply"> = {
  apply: request => command("friends_setup_contact", { request }),
};

export function WindowsFriendsSetup({ view, refresh }: { view: SetupView; refresh(): void }) {
  const [card, setCard] = useState("");
  const [recipientCard, setRecipientCard] = useState("");
  const [ip, setIp] = useState("");
  const [issued, setIssued] = useState("");
  const [invitation, setInvitation] = useState("");
  const [review, setReview] = useState<Review>();
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function run<T>(name: string, args: Record<string, unknown> | undefined, next?: (value: T) => void) {
    setBusy(true);
    setMessage("");
    try {
      const result: Result<T> = await command<T>(`friends_setup_${name}`, args);
      if (result.ok) { next?.(result.value); refresh(); }
      else setMessage(result.error.code === "conflict" ? "An invitation is already active. Wait for it to expire before creating another." :
        "Couldn't complete this action. Check the invitation, private address, and expiration, then try again.");
    } catch {
      setMessage("Friends is temporarily unavailable. Try again.");
    } finally { setBusy(false); }
  }
  return <div aria-label="Private friendship invitation">
    <p>Exchange invitations privately. Both friends need AeRift for Windows and a reachable private network or VPN.</p>
    <div className="ae-friends-actions">
      <Button disabled={busy} onClick={() => void run<string>("card", undefined, setCard)}>Show my private contact card</Button>
    </div>
    {card && <label>Share this card privately with your friend<textarea readOnly value={card} spellCheck={false} /></label>}
    <details><summary>My verification fingerprint</summary><code>{view.profile}</code></details>
    <details><summary>Create an invitation</summary>
    <form onSubmit={event => {
      event.preventDefault();
      void run<string>("issue", { bindAddress: ip.trim(), recipientCard: recipientCard.trim() }, value => {
        setIssued(value);
        setMessage("Share the invitation privately. Keep AeRift open while your friend approves it. It expires in five minutes.");
      });
    }}>
      <label>Recipient’s private contact card<textarea autoComplete="off" spellCheck={false} value={recipientCard} maxLength={1024}
        onChange={event => setRecipientCard(event.target.value)} /></label>
      <label>Your private IPv4 address reachable by your friend<input autoComplete="off" value={ip} maxLength={15}
        onChange={event => setIp(event.target.value)} placeholder="Your LAN or VPN IPv4 address" /></label>
      <Button type="submit" disabled={busy || !ip.trim() || !recipientCard.trim()}>Create targeted invitation</Button>
    </form>
    {issued && <label>Your expiring invitation<textarea readOnly value={issued} spellCheck={false} /></label>}
    </details>
    {view.pendingRecipient && <section aria-label="Friendship invitation awaiting approval">
      <h4>Friendship awaiting approval</h4>
      <p>Compare the recipient’s full fingerprint privately.</p>
      <code>{view.pendingRecipient.verification}</code>
      <Button disabled={busy} onClick={() => void run("answer", { id: view.pendingRecipient?.id, accept: true })}>Verify and approve friendship</Button>
      <Button variant="quiet" disabled={busy} onClick={() => void run("answer", { id: view.pendingRecipient?.id, accept: false }, () => setIssued(""))}>Decline</Button>
    </section>}
    <details><summary>Review an invitation</summary>
    <form onSubmit={event => {
      event.preventDefault();
      void run<Review>("review", { invitation: invitation.trim() }, setReview);
    }}>
      <label>Received private invitation<textarea disabled={busy} autoComplete="off" spellCheck={false} maxLength={4096}
        value={invitation} onChange={event => { setInvitation(event.target.value); setReview(undefined); setSubmitted(false); }} /></label>
      <Button type="submit" disabled={busy || !invitation.trim()}>Review received invitation</Button>
    </form>
    {review && <section>
      <p>Compare the inviter’s full fingerprint privately before approving:</p><code>{review.verification}</code>
      <p>Expires {new Date(review.expiresAt * 1000).toLocaleTimeString()}</p>
      {!submitted ? <Button disabled={busy} onClick={() => void run("consent", { invitation: invitation.trim() }, () => setSubmitted(true))}>
        Verify and send my approval
      </Button> : <Button disabled={busy} onClick={() => void run<boolean>("finish", { invitation: invitation.trim() }, done => {
        if (done) { setReview(undefined); setInvitation(""); setSubmitted(false); setMessage("Friendship verified and saved."); }
        else setMessage("Waiting for the inviter to approve. Check again before the invitation expires.");
      })}>Check inviter approval and finish</Button>}
    </section>}
    </details>
    {message && <p role="status">{message}</p>}
  </div>;
}
