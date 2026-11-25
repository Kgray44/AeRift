import { useEffect, useState } from "react";
import { Button } from "@aerift/ui";
import type { FriendContact } from "@aerift/app-contract/friends";
import { command } from "../nativeAppPort";

type Operation = "issue" | "approve" | "join";
type Review = { type: "review"; reviewId: string; owner: string; friend: string; device: string; friendDevice?: string; expiresAt: number; route?: string };
type View = { type: "view"; localDevice: string; memberContacts: number };
type Response = View | Review | { type: "handoff"; text: string } | { type: "joined" };
const labels: Record<Operation, string> = { issue: "Authorize from my original device", approve: "Approve a friend’s new device", join: "Enroll this new device" };

export function WindowsFriendsMember({ contacts }: { contacts: readonly FriendContact[] }) {
  const [operation, setOperation] = useState<Operation>("join");
  const [view, setView] = useState<View>();
  const [friend, setFriend] = useState("");
  const [device, setDevice] = useState("");
  const [capsule, setCapsule] = useState("");
  const [address, setAddress] = useState("");
  const [review, setReview] = useState<Review>();
  const [handoff, setHandoff] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [problem, setProblem] = useState(false);
  const submit = (request: Record<string, unknown>) => command<Response>("friends_member", { request });
  useEffect(() => {
    let active = true;
    void submit({ action: "view" }).then(result => {
      if (!active) return;
      if (result.ok && result.value.type === "view") setView(result.value);
      else setProblem(true);
    }).catch(() => { if (active) setProblem(true); });
    return () => { active = false; };
  }, []);
  const clear = () => { setReview(undefined); setHandoff(""); setMessage(""); };
  async function run(request: Record<string, unknown>) {
    setBusy(true);
    setMessage("");
    try {
      const result = await submit(request);
      if (!result.ok) {
        setMessage("Couldn’t complete enrollment. Recheck the fingerprints, private address, and expiration.");
        if (request.action === "confirm") setReview(undefined);
        return;
      }
      switch (result.value.type) {
        case "review": setReview(result.value); break;
        case "handoff": setReview(undefined); setHandoff(result.value.text); break;
        case "joined": {
          setReview(undefined);
          setCapsule("");
          const fresh = await submit({ action: "view" });
          if (fresh.ok && fresh.value.type === "view") setView(fresh.value);
          setMessage("This device is enrolled. Choose Delegated friendship when opening a private transfer.");
          break;
        }
      }
    } catch {
      setMessage("Device enrollment is temporarily unavailable. Try again.");
    } finally { setBusy(false); }
  }

  return <div aria-label="Friends device enrollment">
    {problem ? <p role="alert">Device enrollment is unavailable.</p> : !view ? <p role="status">Checking device enrollment…</p> : <>
      <details><summary>My device fingerprint</summary><code>{view.localDevice}</code></details>
      {view.memberContacts > 0 && <p>This device is enrolled. Choose Delegated friendship to use it in Private transfers.</p>}
      <p>Authorize another device for a verified friendship. This does not pair it in Nearby or Remote.</p>
      <label>Your role<select value={operation} disabled={busy} onChange={event => {
        setOperation(event.target.value as Operation); setDevice(""); setCapsule(""); setAddress(""); clear();
      }}>{Object.entries(labels).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <form onSubmit={event => {
        event.preventDefault(); clear();
        if (operation === "issue") void run({ action: "review_issue", friendId: friend, device: device.trim() });
        else if (operation === "approve") void run({ action: "review_approval", capsule: capsule.trim(), device: device.trim() });
        else void run({ action: "review_join", approval: capsule.trim() });
      }}>
        {operation === "issue" && <label>Verified friend<select disabled={busy} value={friend} onChange={event => { setFriend(event.target.value); clear(); }}>
          <option value="">Choose the existing friendship</option>
          {contacts.map(contact => <option value={contact.id} key={contact.id}>{contact.label}</option>)}
        </select></label>}
        {operation !== "join" && <label>New device fingerprint<input autoComplete="off" maxLength={64} spellCheck={false}
          disabled={busy} value={device} onChange={event => { setDevice(event.target.value); clear(); }} /></label>}
        {operation !== "issue" && <label>{operation === "approve" ? "Signed capsule from your friend" : "Signed approval from the original friend"}
          <textarea autoComplete="off" maxLength={4096} spellCheck={false} disabled={busy} value={capsule}
            onChange={event => { setCapsule(event.target.value); clear(); }} />
        </label>}
        <Button type="submit" disabled={busy || (operation === "issue" ? !friend || !device.trim() : !capsule.trim() ||
          (operation === "approve" && !device.trim())) || (operation === "join" && view.memberContacts > 0)}>Review exact enrollment</Button>
      </form>
      {review && <section aria-label="Verify enrollment">
        <p>Owner: <code>{review.owner}</code></p><p>Friend: <code>{review.friend}</code></p>
        <p>New device: <code>{review.device}</code></p>
        {review.friendDevice && <p>Pinned original friend device: <code>{review.friendDevice}</code></p>}
        {review.route && <p>Private connection address: <code>{review.route}</code></p>}
        <p>Review expires {new Date(review.expiresAt * 1000).toLocaleTimeString()}.</p>
        {operation === "approve" && <label>Your reachable private IPv4 address<input autoComplete="off" maxLength={15}
          disabled={busy} value={address} onChange={event => setAddress(event.target.value)} /></label>}
        <Button disabled={busy || (operation === "approve" && !address.trim())} onClick={() => void run({
          action: "confirm", reviewId: review.reviewId, operation, address: operation === "approve" ? address.trim() : null,
        })}>Confirm after comparing fingerprints</Button>
        <Button variant="quiet" disabled={busy} onClick={clear}>Cancel</Button>
      </section>}
      {handoff && <label>{operation === "approve" ?
        "Share this signed approval privately with the new device. Keep AeRift open until they join." :
        "Share this signed capsule privately with the named friend on their original device."}
        <textarea readOnly value={handoff} /></label>}
      {message && <p role="status">{message}</p>}
    </>}
  </div>;
}
