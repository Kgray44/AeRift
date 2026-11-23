import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type {
  AppPort, AppSnapshot, ErrorCode, FileSelection, Result, TransferRequest,
} from "@aerift/app-contract";
import { Button, DevicePicker, FileCard, GlassSurface, TransferProgress } from "./components";
import { Toast } from "./overlays";
import { offerTransfer, type TransferIntent } from "./send-action";

export type { TransferIntent } from "./send-action";

const errors: Partial<Record<ErrorCode, string>> = {
  permission_denied: "Permission was denied. Check the device settings and try again.",
  peer_unavailable: "The device is offline. Check its connection and try again.",
  peer_untrusted: "Pair with this device before sending.",
  integrity_failed: "The received file failed its integrity check.",
  storage_failed: "The destination could not save the file.",
  network_error: "The local network connection was interrupted.",
  conflict: "A file or transfer already exists at the destination.",
};

function messageFor(code: ErrorCode) {
  return errors[code] ?? "The operation could not be completed. Try again.";
}

type Operation = "file" | "send" | "accept" | "decline" | "cancel";
const composerKey = "composer";
const transferKey = (id: string) => `transfer:${id}`;

export interface TransferControls {
  intent: TransferIntent | null;
  busy: boolean;
  send: (intent: TransferIntent) => Promise<boolean>;
}

export function TransferWorkspace({ port, gesture, activityFooter }: {
  port: AppPort;
  gesture?: (controls: TransferControls) => ReactNode;
  activityFooter?: ReactNode;
}) {
  const titleId = useId();
  const activityId = useId();
  const [snapshot, setSnapshot] = useState<AppSnapshot>();
  const [watchError, setWatchError] = useState<string>();
  const [watchAttempt, setWatchAttempt] = useState(0);
  const [selection, setSelection] = useState<FileSelection | null>(null);
  const [selectedId, setSelectedId] = useState<string>();
  const [operations, setOperations] = useState<ReadonlyMap<string, Operation>>(() => new Map());
  const [toast, setToast] = useState<{ message: string; kind: "success" | "error" }>();
  const active = useRef<{ port: AppPort; snapshot?: AppSnapshot; selection: FileSelection | null; selectedId?: string; operations: Map<string, Operation>; watchFailed: boolean } | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    let unwatch: (() => void) | undefined;
    const state = { port, selection: null, operations: new Map<string, Operation>(), watchFailed: false };
    const session: NonNullable<typeof active.current> = state;
    active.current = session;
    setSnapshot(undefined);
    setSelection(null);
    setSelectedId(undefined);
    setOperations(new Map());
    setWatchError(undefined);
    setToast(undefined);

    void (async () => {
      try {
        const result = await port.watch(next => {
          if (disposed) return;
          session.snapshot = next;
          setSnapshot(next);
        });
        if (result.ok) {
          if (disposed) result.value();
          else unwatch = result.value;
        } else if (!disposed) {
          session.watchFailed = true;
          setWatchError(messageFor(result.error.code));
        }
      } catch {
        if (!disposed) {
          session.watchFailed = true;
          setWatchError("Could not connect to the app. Try again.");
        }
      }
    })();
    return () => { disposed = true; active.current = undefined; unwatch?.(); };
  }, [port, watchAttempt]);

  async function run<T>(key: string, operation: Operation, action: (session: NonNullable<typeof active.current>) => Promise<Result<T> | null>,
    success: (value: T, session: NonNullable<typeof active.current>) => void) {
    const session = active.current;
    if (!session || session.port !== port || session.operations.has(key) || session.watchFailed) return false;
    session.operations.set(key, operation);
    setOperations(new Map(session.operations));
    try {
      const result = await action(session);
      if (session !== active.current) return false;
      if (!result) return false;
      if (!result.ok) {
        setToast({ kind: "error", message: messageFor(result.error.code) });
        return false;
      }
      success(result.value, session);
      return true;
    } catch {
      if (session === active.current) setToast({ kind: "error", message: "The app could not finish the operation." });
      return false;
    } finally {
      session.operations.delete(key);
      if (session === active.current) setOperations(new Map(session.operations));
    }
  }

  const pending = operations.get(composerKey);
  const pairs = snapshot?.devices.filter(device => device.paired) ?? [];
  const target = pairs.find(device => device.id === selectedId && device.online);
  const intent = target && selection ? { deviceId: target.id, selectionId: selection.selectionId } : null;

  function selectDevice(id: string) {
    if (!active.current || active.current.operations.has(composerKey)) return;
    active.current.selectedId = id;
    setSelectedId(id);
  }

  function chooseFile() {
    void run(composerKey, "file", () => port.selectFile(), (file, session) => {
      if (!file) return;
      session.selection = file;
      setSelection(file);
    });
  }

  function send(captured: TransferIntent) {
    return run(composerKey, "send", session => offerTransfer(port,
      session.snapshot?.devices.find(device => device.id === session.selectedId), session.selection, captured),
      (_, session) => {
        session.selection = null;
        setSelection(null);
        setToast({ kind: "success", message: "Transfer offered" });
      });
  }

  function updateTransfer(request: Exclude<TransferRequest, { action: "offer" }>) {
    const operation = request.action === "cancel" ? "cancel" : request.accept ? "accept" : "decline";
    void run(transferKey(request.transferId), operation, session => {
      const transfer = session.snapshot?.transfers.find(item => item.id === request.transferId);
      if (!transfer) return Promise.resolve(null);
      const awaitingConsent = transfer.state === "pending" && transfer.direction === "incoming";
      const allowed = request.action === "respond" ? awaitingConsent
        : !awaitingConsent && ["pending", "accepted", "transferring"].includes(transfer.state);
      return allowed ? port.transfer(request) : Promise.resolve(null);
    }, () => {});
  }

  return <>
    <div className="ae-workspace">
      <section aria-labelledby={titleId}>
        <GlassSurface material="raised" className="ae-panel">
          <h2 id={titleId}>New transfer</h2>
          <div className="ae-file-slot">{selection
            ? <FileCard file={selection} action={<Button variant="quiet" onClick={chooseFile}
              disabled={pending !== undefined && pending !== "file"} loading={pending === "file"} loadingLabel="Opening…">Change</Button>} />
            : <Button onClick={chooseFile} loading={pending === "file"} loadingLabel="Opening picker…"
              disabled={!snapshot || !!watchError || (pending !== undefined && pending !== "file")}>Choose a file</Button>}
          </div>
          <DevicePicker devices={pairs} selectedId={selectedId} onSelect={selectDevice}
            loading={!snapshot && !watchError} error={watchError} disabled={pending !== undefined} />
          {watchError && <Button onClick={() => setWatchAttempt(attempt => attempt + 1)}>Retry connection</Button>}
          <div className="ae-send">
            <Button variant="primary" disabled={pending !== "send" && (!intent || !!pending || !!watchError)}
              loading={pending === "send"} loadingLabel="Sending…" onClick={() => { if (intent) void send(intent); }}>
              Send file <span aria-hidden="true">↗</span>
            </Button>
            {gesture?.({ intent: watchError ? null : intent, busy: pending !== undefined, send })}
          </div>
        </GlassSurface>
      </section>
      <section aria-labelledby={activityId}>
        <GlassSurface material="raised" className="ae-panel">
          <h2 id={activityId}>Activity</h2>
          {snapshot?.transfers.length ? snapshot.transfers.map(transfer => {
            const active = ["pending", "accepted", "transferring"].includes(transfer.state);
            const incoming = transfer.state === "pending" && transfer.direction === "incoming";
            const operation = operations.get(transferKey(transfer.id));
            const disabled = !!watchError;
            return <TransferProgress key={transfer.id} transfer={transfer}
              error={transfer.state === "failed" ? messageFor(transfer.error.code) : undefined}
              action={active && <div className="ae-actions">
                {incoming ? <>
                  <Button disabled={disabled || (operation !== undefined && operation !== "accept")}
                    loading={operation === "accept"} loadingLabel="Accepting…"
                    onClick={() => updateTransfer({ action: "respond", transferId: transfer.id, accept: true })}>Accept</Button>
                  <Button variant="quiet" disabled={disabled || (operation !== undefined && operation !== "decline")}
                    loading={operation === "decline"} loadingLabel="Declining…"
                    onClick={() => updateTransfer({ action: "respond", transferId: transfer.id, accept: false })}>Decline</Button>
                </> : <Button variant="quiet" disabled={disabled || (operation !== undefined && operation !== "cancel")}
                  loading={operation === "cancel"} loadingLabel="Cancelling…"
                  onClick={() => updateTransfer({ action: "cancel", transferId: transfer.id })}>Cancel transfer</Button>}
              </div>} />;
          }) : <p>No transfers yet.</p>}
          {activityFooter}
        </GlassSurface>
      </section>
    </div>
    <Toast message={toast?.message} kind={toast?.kind} onDismiss={() => setToast(undefined)} />
  </>;
}
