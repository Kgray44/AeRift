import { useId, useRef, useState } from "react";
import type { AppSnapshot, Device, NearbyPairingVerification, PairingInvitation, PairingRequest } from "@aerift/app-contract";
import { Button } from "./components";

export type PairingAction = Exclude<PairingRequest, { action: "revoke" }>;

type Props = {
  invitation?: PairingInvitation;
  requests: AppSnapshot["pendingPairing"];
  busy?: "create" | "redeem" | "start_nearby";
  nearby?: { candidates: readonly Device[]; incoming?: NearbyPairingVerification | null; outgoing?: NearbyPairingVerification | null };
  requestBusy: (id: string) => "approve" | "deny" | undefined;
  disabled: boolean;
  status?: string;
  error?: string;
  onPair: (request: PairingAction) => Promise<boolean>;
};

function timeLabel(utc: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(utc));
}

export function PairingPanel({ invitation, requests, busy, requestBusy, disabled, status, error, onPair, nearby }: Props) {
  const codeId = useId();
  const invitationId = useId();
  const invitationInput = useRef<HTMLTextAreaElement>(null);
  const [code, setCode] = useState("");
  const [copiedExpiry, setCopiedExpiry] = useState<string>();
  const [copyError, setCopyError] = useState<string>();

  async function copyInvitation() {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation.code);
      setCopiedExpiry(invitation.expiresAt);
      setCopyError(undefined);
    } catch {
      invitationInput.current?.focus();
      invitationInput.current?.select();
      setCopyError("Copy the selected code to share it.");
    }
  }

  const challenges = [nearby?.incoming, nearby?.outgoing].filter((item): item is NearbyPairingVerification => !!item);
  const legacy = <>
    <section aria-label="Share an invitation" className="ae-pair-section">
      <p>Create a code to share with the device you want to pair.</p>
      <Button disabled={disabled || busy === "redeem"} loading={busy === "create"} loadingLabel="Creating code…"
        onClick={() => void onPair({ action: "create" })}>{invitation ? "Create a new code" : "Create code"}</Button>
      {invitation && <>
        <label htmlFor={invitationId}>Invitation code</label>
        <textarea id={invitationId} readOnly rows={3} ref={invitationInput} value={invitation.code} />
        <small>Expires at <time dateTime={invitation.expiresAt}>{timeLabel(invitation.expiresAt)}</time></small>
        <Button variant="quiet" onClick={() => void copyInvitation()}>Copy code</Button>
        <p role="status">{copyError ?? (copiedExpiry === invitation.expiresAt ? "Invitation copied" : "")}</p>
      </>}
    </section>
    <form className="ae-pair-section" onSubmit={async event => {
      event.preventDefault();
      const enteredCode = code.trim();
      if (!enteredCode || busy || disabled) return;
      if (await onPair({ action: "redeem", code: enteredCode })) setCode("");
    }}>
      <label htmlFor={codeId}>Code from the other device</label>
      <input id={codeId} value={code} onChange={event => setCode(event.target.value)}
        autoCapitalize="none" autoComplete="off" spellCheck={false} maxLength={256}
        disabled={disabled || busy === "redeem"} />
      <Button type="submit" disabled={disabled || busy === "create" || !code.trim()}
        loading={busy === "redeem"} loadingLabel="Waiting for approval…">Request pairing</Button>
    </form></>;
  return <div className="ae-pairing">
    <p role="status">{status}</p>
    <p role="alert">{error}</p>
    {requests.length > 0 && <section aria-label="Incoming pairing requests" className="ae-pair-section">
      {requests.map(({ requestId, device, expiresAt }) => {
        const pending = requestBusy(requestId);
        return <div key={requestId} className="ae-pair-request">
          <strong>{device.name} wants to pair</strong>
          <small>Expires at <time dateTime={expiresAt}>{timeLabel(expiresAt)}</time></small>
          <div className="ae-actions">
            <Button disabled={disabled || pending === "deny"} loading={pending === "approve"} loadingLabel="Approving…"
              onClick={() => void onPair({ action: "confirm", requestId, accept: true })}>Approve</Button>
            <Button variant="quiet" disabled={disabled || pending === "approve"} loading={pending === "deny"} loadingLabel="Denying…"
              onClick={() => void onPair({ action: "confirm", requestId, accept: false })}>Deny</Button>
          </div>
        </div>;
      })}
    </section>}
    {nearby && <section aria-label="Nearby pairing" className="ae-pair-section">
      {challenges.map(({ requestId, device, expiresAt, verification, outgoing, approved }) => {
        const pending = requestBusy(requestId);
        const validVerification = /^[0-9]{6}$/.test(verification);
        return <div key={requestId} className="ae-pair-request">
          <strong>{outgoing ? `Pair with ${device.name}` : `${device.name} wants to pair nearby`}</strong>
          {validVerification && <output className="ae-pair-verification" aria-label={`Verification code ${[...verification].join(" ")}`}>{verification}</output>}
          <p>{approved ? "You approved. Waiting for the other device." : "Compare these six digits on both screens. Confirm on both devices only if they match."}</p>
          <small>Expires at <time dateTime={expiresAt}>{timeLabel(expiresAt)}</time></small>
          <div className="ae-actions">
            <Button disabled={disabled || !validVerification || approved || pending === "deny"} loading={pending === "approve"}
              loadingLabel="Waiting for approval…" onClick={() => void onPair({ action: "confirm_nearby", requestId, accept: true, outgoing: outgoing === true })}>Codes match</Button>
            <Button variant="quiet" disabled={disabled || pending === "approve"} loading={pending === "deny"}
              loadingLabel="Declining…" onClick={() => void onPair({ action: "confirm_nearby", requestId, accept: false, outgoing: outgoing === true })}>{approved ? "Cancel request" : "Decline"}</Button>
          </div>
        </div>;
      })}
      {!challenges.length && (nearby.candidates.length ? nearby.candidates.map(device =>
        <div key={device.id} className="ae-pair-request"><strong>{device.name}</strong>
          <Button variant="quiet" disabled={disabled || !!busy} onClick={() => void onPair({ action: "start_nearby", deviceId: device.id })}>Pair nearby</Button></div>
      ) : <p>No unpaired devices found nearby. Open AeRift on both devices and connect them to the same local network.</p>)}
    </section>}
    {nearby ? <details className="ae-pair-section"><summary>Legacy local invitation</summary>
      <p>Only for older versions of AeRift. This does not use six-digit verification.</p>{legacy}
    </details> : legacy}
  </div>;
}
