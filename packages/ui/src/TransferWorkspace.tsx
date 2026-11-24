import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type {
  AppPort, AppSnapshot, ErrorCode, FileSelection, PairingInvitation, Platform, Result, Transfer, TransferRequest,
} from "@aerift/app-contract";
import { automaticGestureTarget } from "@aerift/gestures";
import { Button, GlassSurface, TransferProgress } from "./components";
import { Sheet, Toast } from "./overlays";
import { PairingPanel, type PairingAction } from "./PairingPanel";
import { offerTransfer, type TransferIntent } from "./send-action";
import { SpatialIcon, SpatialScene, type DiscoveryState } from "./SpatialScene";
import { RiftExperience, RiftLink, TransferObject } from "./RiftExperience";
import { environmentPhase, incomingObjectPhase, isTransferActive, objectPhase, readinessMatches, reconcileTransfers, selectRift, terminalTransition,
  type ReceiverReadiness, type RiftAftermath, type WorkspaceGestureFeedback } from "./rift-coordinator";

export type { TransferIntent } from "./send-action";
export type { WorkspaceGestureFeedback } from "./rift-coordinator";

const errors: Partial<Record<ErrorCode, string>> = {
  permission_denied: "Permission was denied. Check the device settings and try again.",
  peer_unavailable: "The device is offline. Check its connection and try again.",
  peer_untrusted: "Pair with this device before sending.",
  pairing_expired: "The pairing code or request expired. Create a fresh code and try again.",
  pairing_rejected: "The other device declined the pairing request.",
  integrity_failed: "The received file failed its integrity check.",
  storage_failed: "The destination could not save the file.",
  network_error: "The local network connection was interrupted.",
  conflict: "A file or transfer already exists at the destination.",
};

function messageFor(code: ErrorCode) {
  return errors[code] ?? "The operation could not be completed. Try again.";
}

type Operation = "file" | "send" | "accept" | "decline" | "cancel" | "create" | "redeem" | "start_nearby" | "approve" | "deny" | "readiness";
const composerKey = "composer";
const transferKey = (id: string) => `transfer:${id}`;
const pairingKey = (id: string) => `pairing:${id}`;

export interface IncomingTransferIntent {
  readonly transferId: string;
  readonly deviceId: string;
  readonly label?: string;
}

export interface TransferControls {
  intent: TransferIntent | null;
  busy: boolean;
  foreground: boolean;
  send: (intent: TransferIntent) => Promise<boolean>;
  incoming: readonly IncomingTransferIntent[];
  accept: (intent: IncomingTransferIntent, chosenOffer?: string) => Promise<boolean>;
  reportGesture: (feedback: WorkspaceGestureFeedback) => void;
}

export type WorkspaceConnection =
  | { state: "connecting" | "disconnected" }
  | { state: "ready"; snapshot: AppSnapshot };

export interface TransferWorkspaceRegions {
  pairingAction: ReactNode;
  selection: FileSelection | null;
  selecting: boolean;
  canSelect: boolean;
  select: (picker: AppPort["selectFile"]) => Promise<boolean>;
}

export interface MobileTransferPresentation {
  view: "rift" | "activity" | "supplement";
  archivedTransfers?: readonly Transfer[];
  offerBlockedReason?: (selection: FileSelection) => string | undefined;
  openRift: () => void;
  openActivity: () => void;
  render: (regions: TransferWorkspaceRegions) => ReactNode;
}

export function TransferWorkspace({ port, gesture, activityFooter, watchSelection, connection,
  navigationStart = "AeRift", navigationEnd, pairRequest, onPairingOpenChange,
  platform, discovery, discoveryNotice, allowDrop, desktopView, onOpenRift, mobile }: {
  port: AppPort;
  gesture?: (controls: TransferControls) => ReactNode;
  activityFooter?: ReactNode;
  watchSelection?: (listener: (selection: FileSelection | null) => void) => () => void;
  connection?: { generation: number; retry: () => void; onChange: (value: WorkspaceConnection) => void };
  navigationStart?: ReactNode;
  navigationEnd?: ReactNode;
  pairRequest?: number;
  onPairingOpenChange?: (open: boolean) => void;
  platform?: Platform;
  discovery?: DiscoveryState;
  discoveryNotice?: ReactNode;
  allowDrop?: boolean;
  desktopView?: "rift" | "activity" | "hidden";
  onOpenRift?: () => void;
  mobile?: MobileTransferPresentation;
}) {
  const titleId = useId();
  const activityId = useId();
  const transferRegionId = useId();
  const transferRegion = useRef<HTMLElement>(null);
  const environment = useRef<HTMLDivElement>(null);
  const [localDestination, setDestination] = useState<"send" | "activity">("send");
  const [activityFilter, setActivityFilter] = useState<"all" | "active" | "finished">("all");
  const hosted = desktopView !== undefined;
  const destination = mobile
    ? mobile.view === "rift" ? "send" : mobile.view
    : desktopView === "activity" ? "activity" : hosted ? "send" : localDestination;
  const riftVisible = desktopView !== "hidden" && destination === "send";
  const [snapshot, setSnapshot] = useState<AppSnapshot>();
  const [watchError, setWatchError] = useState<string>();
  const [watchAttempt, setWatchAttempt] = useState(0);
  const retryGeneration = connection?.generation ?? watchAttempt;
  const notifyConnection = connection?.onChange;
  const [selection, setSelection] = useState<FileSelection | null>(null);
  const [selectedId, setSelectedId] = useState<string>();
  const [operations, setOperations] = useState<ReadonlyMap<string, Operation>>(() => new Map());
  const [pairingOpen, setPairingOpen] = useState(false);
  const [invitation, setInvitation] = useState<PairingInvitation>();
  const [pairStatus, setPairStatus] = useState<string>();
  const [pairError, setPairError] = useState<string>();
  const [toast, setToast] = useState<{ message: string; kind: "success" | "error" }>();
  const [gestureFeedback, setGestureFeedback] = useState<WorkspaceGestureFeedback>();
  const [aftermath, setAftermath] = useState<RiftAftermath>();
  const [departure, setDeparture] = useState<{ request: symbol; file: FileSelection; deviceId: string; receipt?: Transfer;
    from?: { x: number; y: number } }>();
  const dockGlyph = useRef<HTMLSpanElement>(null);
  const [readiness, setReadiness] = useState<ReceiverReadiness>();
  const [receiveUntil, setReceiveUntil] = useState(0);
  const ignoredSelection = useRef<string>(undefined);
  const lastPairRequest = useRef(pairRequest);
  const active = useRef<{ port: AppPort; snapshot?: AppSnapshot; selection: FileSelection | null; selectedId?: string; operations: Map<string, Operation>; watchFailed: boolean } | undefined>(undefined);

  useEffect(() => {
    if (pairRequest !== lastPairRequest.current) {
      lastPairRequest.current = pairRequest;
      setPairingOpen(true);
    }
  }, [pairRequest]);

  useEffect(() => { onPairingOpenChange?.(pairingOpen); }, [onPairingOpenChange, pairingOpen]);

  useEffect(() => {
    if (!aftermath) return;
    const timer = window.setTimeout(() => setAftermath(undefined), Math.max(0, aftermath.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [aftermath]);

  useEffect(() => {
    let disposed = false;
    let unwatch: (() => void) | undefined;
    const state = { port, selection: null, operations: new Map<string, Operation>(), watchFailed: false };
    const session: NonNullable<typeof active.current> = state;
    active.current = session;
    notifyConnection?.({ state: "connecting" });
    setSnapshot(undefined);
    setSelection(null);
    setSelectedId(undefined);
    setOperations(new Map());
    setWatchError(undefined);
    setPairingOpen(false);
    setInvitation(undefined);
    setPairStatus(undefined);
    setPairError(undefined);
    setToast(undefined);
    setGestureFeedback(undefined);
    setAftermath(undefined);
    setDeparture(undefined);
    setReadiness(undefined);
    setReceiveUntil(0);

    const unwatchSelection = watchSelection?.(file => {
      if (disposed) return;
      if (file?.selectionId === ignoredSelection.current) return;
      session.selection = file;
      setSelection(file);
    });

    function disconnect(message: string) {
      if (disposed) return;
      session.watchFailed = true;
      session.snapshot = undefined;
      setSnapshot(undefined);
      setDeparture(undefined);
      setAftermath(undefined);
      setWatchError(message);
      notifyConnection?.({ state: "disconnected" });
    }

    void (async () => {
      try {
        const result = await port.watch(next => {
          if (disposed || session.watchFailed) return;
          const previous = session.snapshot;
          const transfers = reconcileTransfers(previous?.transfers ?? [], next.transfers);
          const terminal = terminalTransition(previous?.transfers, transfers);
          if (terminal) setAftermath({ id: terminal.id, expiresAt: Date.now() + 2800 });
          const current = { ...next, transfers };
          session.snapshot = current;
          const pairedNearby = previous?.nearbyPairingIncoming;
          if (pairedNearby && !current.nearbyPairingIncoming
            && current.devices.some(device => device.id === pairedNearby.device.id && device.paired)) {
            setPairStatus(`Paired with ${pairedNearby.device.name}`);
          }
          setSnapshot(current);
          notifyConnection?.({ state: "ready", snapshot: current });
        });
        if (result.ok) {
          if (disposed) result.value();
          else unwatch = result.value;
        } else disconnect(messageFor(result.error.code));
      } catch {
        disconnect("Could not connect to the app. Try again.");
      }
    })();
    return () => {
      disposed = true;
      active.current = undefined;
      unwatchSelection?.();
      unwatch?.();
    };
  }, [port, retryGeneration, watchSelection, notifyConnection]);

  useEffect(() => {
    if (!invitation) return;
    const expiry = window.setTimeout(() => {
      setInvitation(undefined);
      setPairStatus("The invitation expired.");
    }, Math.max(0, Date.parse(invitation.expiresAt) - Date.now()));
    return () => window.clearTimeout(expiry);
  }, [invitation]);

  function showActionError(message: string) {
    setToast({ kind: "error", message });
  }

  async function run<T>(key: string, operation: Operation, action: (session: NonNullable<typeof active.current>) => Promise<Result<T> | null>,
    success: (value: T, session: NonNullable<typeof active.current>) => void, fail = showActionError) {
    const session = active.current;
    if (!session || session.port !== port || session.operations.has(key) || session.watchFailed) return false;
    session.operations.set(key, operation);
    setOperations(new Map(session.operations));
    try {
      const result = await action(session);
      if (session !== active.current) return false;
      if (!result) return false;
      if (!result.ok) {
        fail(messageFor(result.error.code));
        return false;
      }
      success(result.value, session);
      return true;
    } catch {
      if (session === active.current) fail("The app could not finish the operation.");
      return false;
    } finally {
      session.operations.delete(key);
      if (session === active.current) setOperations(new Map(session.operations));
    }
  }

  const pending = operations.get(composerKey);
  const pendingPairs = snapshot?.pendingPairing ?? [];
  const pairingBusy = operations.get("pairing");
  const pairingDisabled = !snapshot || !!watchError;
  const devices = snapshot?.devices ?? [];
  const chosen = devices.find(device => device.id === selectedId && device.paired);
  const target = chosen?.online ? chosen : undefined;
  const offerBlocked = selection && mobile?.offerBlockedReason?.(selection);
  const intent = target && selection && !offerBlocked ? { deviceId: target.id, selectionId: selection.selectionId } : null;
  const reportGesture = useCallback((feedback: WorkspaceGestureFeedback) => {
    setGestureFeedback(current => current?.target === feedback.target && current.phase === feedback.phase ? current : feedback);
  }, []);
  useEffect(() => {
    if (!gestureFeedback || !["failed", "canceled", "interrupted"].includes(gestureFeedback.phase)) return;
    const timer = window.setTimeout(() => {
      setGestureFeedback(current => current === gestureFeedback ? undefined : current);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [gestureFeedback]);
  const heldDevice = gestureFeedback?.phase === "held" && gestureFeedback.target.kind === "send" &&
    gestureFeedback.target.deviceId === intent?.deviceId && gestureFeedback.target.selectionId === intent.selectionId
    ? intent.deviceId : undefined;
  const heldSelection = heldDevice ? intent?.selectionId : undefined;

  useEffect(() => {
    if (!heldDevice || !heldSelection || !port.checkReceiver) return;
    let disposed = false;
    let timer: number | undefined;
    const checkReceiver = port.checkReceiver.bind(port);
    async function check() {
      try {
        const result = await checkReceiver(heldDevice!);
        if (disposed) return;
        setReadiness(result.ok && result.value ? {
          deviceId: heldDevice!, selectionId: heldSelection!, expiresAt: Date.now() + 1500,
        } : undefined);
      } catch {
        if (!disposed) setReadiness(undefined);
      }
      if (!disposed) timer = window.setTimeout(() => void check(), 700);
    }
    void check();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      setReadiness(undefined);
    };
  }, [heldDevice, heldSelection, port]);

  useEffect(() => {
    if (!readiness) return;
    const timer = window.setTimeout(() => setReadiness(undefined), Math.max(0, readiness.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [readiness]);

  useEffect(() => {
    if (!receiveUntil) return;
    const timer = window.setTimeout(() => setReceiveUntil(0), Math.max(0, receiveUntil - Date.now()));
    function clearWhenHidden() {
      if (document.hidden) {
        setReceiveUntil(0);
        void port.setReceiverReady?.(false).catch(() => {});
      }
    }
    document.addEventListener("visibilitychange", clearWhenHidden);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", clearWhenHidden);
    };
  }, [port, receiveUntil]);

  function toggleReceive() {
    if (!port.setReceiverReady || !snapshot) return;
    const ready = !receiveUntil;
    void run("receiver", "readiness", () => port.setReceiverReady!(ready), duration => {
      if (ready && document.hidden) {
        void port.setReceiverReady?.(false).catch(() => {});
        return;
      }
      setReceiveUntil(ready ? Date.now() + duration : 0);
    });
  }

  function selectDevice(id: string | undefined) {
    if (!active.current || active.current.operations.has(composerKey)) return;
    active.current.selectedId = id;
    setSelectedId(id);
  }

  function chooseFile() {
    void selectWith(() => port.selectFile());
  }

  function selectWith(picker: AppPort["selectFile"]) {
    return run(composerKey, "file", () => picker(), (file, session) => {
      if (!file || watchSelection) return;
      session.selection = file;
      setSelection(file);
    });
  }

  function clearSelection() {
    const session = active.current;
    if (!session?.selection || session.operations.has(composerKey)) return;
    const file = session.selection;
    const clear = () => {
      if (session.selection?.selectionId !== file.selectionId) return;
      ignoredSelection.current = file.selectionId;
      session.selection = null;
      setSelection(null);
    };
    if (port.clearFile) {
      void run(composerKey, "file", () => port.clearFile!(file.selectionId), clear);
    } else clear();
  }

  function send(captured: TransferIntent) {
    const request = Symbol();
    return run(composerKey, "send", session => {
      if (session.selection && mobile?.offerBlockedReason?.(session.selection)) return Promise.resolve(null);
      const peer = session.snapshot?.devices.find(device => device.id === session.selectedId);
      const result = offerTransfer(port, peer, session.selection, captured);
      if (peer?.online && peer.paired && peer.id === captured.deviceId && session.selection?.selectionId === captured.selectionId) {
        const glyph = dockGlyph.current?.getBoundingClientRect();
        setDeparture({ request, file: session.selection, deviceId: captured.deviceId,
          from: glyph && { x: glyph.left + glyph.width / 2, y: glyph.top + glyph.height / 2 } });
      }
      return result;
    }, (receipt, session) => {
        if (session.selection?.selectionId === captured.selectionId) {
          session.selection = null;
          setSelection(null);
        }
        setDeparture(current => current?.request === request ? { ...current, receipt } : current);
      }).then(offered => {
      if (!offered) setDeparture(current => current?.request === request ? undefined : current);
      return offered;
    });
  }

  function updateTransfer(request: Exclude<TransferRequest, { action: "offer" }>, expectedPeer?: string, chosenOffer?: string) {
    const operation = request.action === "cancel" ? "cancel" : request.accept ? "accept" : "decline";
    return run(transferKey(request.transferId), operation, session => {
      const transfer = session.snapshot?.transfers.find(item => item.id === request.transferId);
      if (!transfer || (expectedPeer !== undefined && transfer.deviceId !== expectedPeer)) return Promise.resolve(null);
      if (chosenOffer !== undefined) {
        const peer = session.snapshot?.devices.find(device => device.id === session.selectedId && device.paired && device.online);
        const sendIntent = peer && session.selection ? { deviceId: peer.id, selectionId: session.selection.selectionId } : null;
        const offers = session.snapshot?.transfers
          .filter(item => item.direction === "incoming" && item.state === "pending")
          .map(item => ({ transferId: item.id, deviceId: item.deviceId })) ?? [];
        const candidate = automaticGestureTarget(sendIntent, offers, chosenOffer);
        if (candidate?.kind !== "receive" || candidate.transferId !== transfer.id || candidate.deviceId !== transfer.deviceId) {
          return Promise.resolve(null);
        }
      }
      const awaitingConsent = transfer.state === "pending" && transfer.direction === "incoming";
      const allowed = request.action === "respond" ? awaitingConsent
        : !awaitingConsent && ["pending", "accepted", "transferring"].includes(transfer.state);
      return allowed ? port.transfer(request) : Promise.resolve(null);
    }, () => {});
  }

  const incomingIntents = watchError ? [] : (snapshot?.transfers ?? [])
    .filter(item => item.direction === "incoming" && item.state === "pending" && !operations.has(transferKey(item.id)))
    .map(item => ({ transferId: item.id, deviceId: item.deviceId,
      label: `${item.file.name} · ${devices.find(device => device.id === item.deviceId)?.name ?? "Paired device"}` }));

  function accept({ transferId, deviceId }: IncomingTransferIntent, chosenOffer?: string) {
    return updateTransfer({ action: "respond", transferId, accept: true }, deviceId, chosenOffer);
  }

  function pair(request: PairingAction) {
    setPairError(undefined);
    setPairStatus(undefined);
    const key = request.action === "confirm" || request.action === "confirm_nearby" ? pairingKey(request.requestId) : "pairing";
    const operation = request.action === "confirm" || request.action === "confirm_nearby" ? request.accept ? "approve" : "deny" : request.action;
    return run(key, operation, session => {
      if (request.action === "confirm") {
        const pending = session.snapshot?.pendingPairing.find(item => item.requestId === request.requestId);
        if (!pending || Date.parse(pending.expiresAt) <= Date.now()) {
          return Promise.resolve({ ok: false, error: { code: "pairing_expired" } });
        }
      }
      if (request.action === "confirm_nearby") {
        const pending = request.outgoing ? session.snapshot?.nearbyPairingOutgoing : session.snapshot?.nearbyPairingIncoming;
        if (!pending || pending.requestId !== request.requestId || Date.parse(pending.expiresAt) <= Date.now()) {
          return Promise.resolve({ ok: false, error: { code: "pairing_expired" } });
        }
      }
      return port.pair(request);
    }, result => {
      if (result.state === "invitation") {
        setInvitation(result.invitation);
      } else if (result.state === "nearby_started") {
        setPairStatus("Compare the verification code on both devices.");
      } else if (result.state === "nearby_waiting") {
        setPairStatus("You approved. Waiting for the other device.");
      } else {
        if (request.action === "confirm") setInvitation(undefined);
        setPairStatus(result.state === "paired" ? `Paired with ${result.device.name}` : "Pairing declined");
      }
    }, error => setPairError(request.action === "start_nearby" ? "Nearby pairing could not start. Check that both devices have a compatible version and are visible to each other." : error));
  }

  const retry = connection?.retry ?? (() => setWatchAttempt(attempt => attempt + 1));
  const pairingCount = pendingPairs.length + Number(!!snapshot?.nearbyPairingIncoming) + Number(!!snapshot?.nearbyPairingOutgoing);
  const pairingLabel = pairingCount ? `Review pairing (${pairingCount})` : "Pair a device";
  const stageDiscovery = watchError ? "interrupted" : discovery ??
    (!snapshot ? "connecting" : devices.some(device => device.online) ? "available" : "empty");
  const ready = readinessMatches(readiness, gestureFeedback, intent, Date.now());
  const transfers = snapshot?.transfers ?? [];
  const rift = selectRift(transfers, aftermath, Date.now()) ??
    (departure?.receipt && !transfers.some(item => item.id === departure.receipt?.id) ? departure.receipt : undefined);
  const riftPeerId = rift?.deviceId ?? departure?.deviceId ?? selectedId;
  const nameOf = (id: string) => devices.find(device => device.id === id)?.name ?? "Paired device";
  const incoming = transfers.filter(item => item.direction === "incoming" && item.state === "pending");
  const channel = transfers.filter(item => item.direction === "incoming" && isTransferActive(item));
  if (rift && !channel.some(item => item.id === rift.id)) channel.push(rift);
  const liveHistory = hosted
    ? transfers.filter(transfer => activityFilter === "all" || isTransferActive(transfer) === (activityFilter === "active"))
    : transfers.filter(item => !channel.some(featured => item.id === featured.id));
  const archived = mobile?.archivedTransfers?.filter(item => !isTransferActive(item) &&
    !transfers.some(live => live.id === item.id)) ?? [];
  const outgoingObject = !departure?.receipt ? departure?.file ?? selection : selection;
  const outgoingPhase = outgoingObject && objectPhase(outgoingObject, selectedId, gestureFeedback);
  const gesturePhase = (rift && incomingObjectPhase(rift, gestureFeedback)) || outgoingPhase || undefined;
  const phase = environmentPhase({ transfer: riftVisible ? rift : undefined,
    gesture: riftVisible ? gesturePhase : undefined, receiverReady: riftVisible && (ready || !!receiveUntil),
    offering: !!departure && pending === "send", selected: !!(selection || selectedId), discovering: stageDiscovery === "searching" });
  const progress = rift?.state === "completed" ? 1 :
    rift?.file.sizeBytes ? Math.min(1, rift.bytesTransferred / rift.file.sizeBytes) : 0;
  const dockStatus = !selection && rift ? {
    pending: rift.direction === "incoming" ? "Incoming file" : "Offer started",
    accepted: "Transfer accepted",
    transferring: rift.direction === "incoming" ? "Receiving" : "Sending",
    completed: "Delivered",
    failed: "Transfer failed", cancelled: "Transfer cancelled", rejected: "Offer declined",
  }[rift.state] : undefined;
  const departureSnapshot = departure?.receipt && transfers.find(item => item.id === departure.receipt?.id);

  useLayoutEffect(() => {
    const stage = environment.current;
    if (!stage) return;
    function alignLight() {
      if (!stage) return;
      const receiver = rift?.direction === "incoming";
      const followsFile = phase === "hand" || phase === "held";
      const followsDestination = ["ready", "departure", "transferring", "receiving", "completed"].includes(phase);
      const peer = followsDestination && !receiver && riftPeerId
        ? Array.from(stage.querySelectorAll<HTMLElement>("[data-peer-anchor]")).find(node => node.dataset.peerAnchor === riftPeerId)
        : undefined;
      const local = stage.querySelector<HTMLElement>("[data-local-anchor]");
      const focus = followsFile ? dockGlyph.current ?? local : followsDestination ? peer ?? local : undefined;
      const box = focus?.getBoundingClientRect();
      for (const [key, position] of [
        ["experienceX", box && (box.x + box.width / 2) / window.innerWidth],
        ["experienceY", box && (box.y + box.height / 2) / window.innerHeight],
      ] as const) {
        if (position === undefined) delete stage.dataset[key];
        else {
          const value = Math.min(1, Math.max(0, position)).toFixed(3);
          if (stage.dataset[key] !== value) stage.dataset[key] = value;
        }
      }
    }
    alignLight();
    window.addEventListener("resize", alignLight);
    window.addEventListener("scroll", alignLight, { passive: true, capture: true });
    return () => {
      window.removeEventListener("resize", alignLight);
      window.removeEventListener("scroll", alignLight, true);
    };
  }, [phase, rift?.direction, riftPeerId]);

  useEffect(() => {
    const receipt = departure?.receipt;
    if (!receipt || (departureSnapshot && isTransferActive(departureSnapshot))) return;
    const timer = window.setTimeout(() => {
      setDeparture(current => current?.receipt?.id === receipt.id ? undefined : current);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [departure?.receipt, departureSnapshot?.state]);

  function transferActions(transfer: Transfer) {
    if (!isTransferActive(transfer)) {
      if (transfer.direction !== "outgoing" || transfer.state === "completed") return undefined;
      const device = devices.find(peer => peer.id === transfer.deviceId && peer.paired);
      return <Button variant="quiet" disabled={!!pending || !!watchError}
        onClick={() => {
          if (mobile) mobile.openRift();
          else if (onOpenRift) onOpenRift();
          else setDestination("send");
          selectDevice(device?.id);
          chooseFile();
        }}>Choose file to retry</Button>;
    }
    const operation = operations.get(transferKey(transfer.id));
    const offer = transfer.direction === "incoming" && transfer.state === "pending";
    return <div className="ae-actions">
      {offer ? <>
        <Button disabled={!!watchError || (operation !== undefined && operation !== "accept")}
          loading={operation === "accept"} loadingLabel="Accepting…"
          onClick={() => {
            transferRegion.current?.focus({ preventScroll: true });
            void accept({ transferId: transfer.id, deviceId: transfer.deviceId });
          }}>Accept</Button>
        <Button variant="quiet" disabled={!!watchError || (operation !== undefined && operation !== "decline")}
          loading={operation === "decline"} loadingLabel="Declining…"
          onClick={() => void updateTransfer({ action: "respond", transferId: transfer.id, accept: false })}>Decline</Button>
      </> : <Button variant="quiet" disabled={!!watchError || (operation !== undefined && operation !== "cancel")}
        loading={operation === "cancel"} loadingLabel="Cancelling…"
        onClick={() => void updateTransfer({ action: "cancel", transferId: transfer.id })}>Cancel transfer</Button>}
    </div>;
  }

  function riftCard(transfer: Transfer) {
    return <RiftExperience key={transfer.id} transfer={transfer} deviceName={nameOf(transfer.deviceId)}
      compactPath={destination === "activity" || devices.length > 6 || transfer.id !== rift?.id ||
        !devices.some(device => device.id === transfer.deviceId)}
      objectId={departure?.receipt?.id === transfer.id ? departure.file.selectionId : undefined}
      gestureState={incomingObjectPhase(transfer, gestureFeedback)}
      error={transfer.state === "failed" ? messageFor(transfer.error.code) : undefined}
      action={transferActions(transfer)} />;
  }

  const activitySection = <section key="activity" id={activityId} hidden={destination !== "activity"}
    aria-label={mobile ? "Transfer history" : undefined}
    aria-labelledby={mobile ? undefined : `${activityId}-heading`} className="ae-activity">
    {!mobile && <h2 id={`${activityId}-heading`}>{hosted ? "Transfer history" : "Activity"}</h2>}
    {hosted && <label className="aerift-activity-filter">Show
      <select value={activityFilter} onChange={event => {
        const value = event.currentTarget.value;
        setActivityFilter(value === "active" || value === "finished" ? value : "all");
      }}>
        <option value="all">All transfers</option>
        <option value="active">In progress</option>
        <option value="finished">Finished</option>
      </select>
    </label>}
    {liveHistory.length || archived.length ? <div className="ae-activity-list">
      {liveHistory.map(transfer => <TransferProgress key={transfer.id} transfer={transfer}
        deviceName={nameOf(transfer.deviceId)}
        error={transfer.state === "failed" ? messageFor(transfer.error.code) : undefined}
        action={transferActions(transfer)} />)}
      {archived.map(transfer => <TransferProgress key={transfer.id} transfer={transfer}
        deviceName={nameOf(transfer.deviceId)}
        error={transfer.state === "failed" ? messageFor(transfer.error.code) : undefined} />)}
    </div> : <div className="ae-activity-empty"><SpatialIcon name="activity" size={24} />
      <p>{hosted && activityFilter !== "all" ? "No transfers match this view." :
        !hosted && channel.length ? "No other transfers." : "No transfers yet."}</p></div>}
    {activityFooter}
  </section>;

  const transferSection = <section key="transfer-status" id={transferRegionId} ref={transferRegion}
    tabIndex={-1} className="ae-rift-board" aria-label="Transfer status" hidden={!channel.length || (hosted && !riftVisible)}>
    {channel.map(riftCard)}
  </section>;

  return <>
    {!hosted && <><header className="ae-experience-nav" data-destination={destination} data-mobile-shell={!!mobile}>
      <GlassSurface material="chrome" className="ae-nav-brand">{navigationStart}</GlassSurface>
      {!mobile && <GlassSurface material="chrome" className="ae-nav-destinations">
        <nav aria-label="AeRift destinations">
          <span className="ae-nav-indicator" aria-hidden="true" />
          <Button variant="quiet" onClick={() => setDestination("send")} aria-controls={titleId}
            aria-current={destination === "send" ? "page" : undefined}><SpatialIcon name="workspace" />Workspace</Button>
          <Button variant="quiet" onClick={() => setDestination("activity")} aria-controls={activityId}
            aria-current={destination === "activity" ? "page" : undefined}><SpatialIcon name="activity" />Activity</Button>
        </nav>
      </GlassSurface>}
      {navigationEnd && <GlassSurface material="chrome" className="ae-nav-tools">{navigationEnd}</GlassSurface>}
    </header>
    <div className="ae-offer-notice">
      <span role="status">{!!incoming.length && <Button variant="quiet"
        aria-controls={transferRegionId}
        onClick={() => {
          if (mobile && destination === "supplement") mobile.openActivity();
          else transferRegion.current?.focus();
        }}>
        <SpatialIcon name="drop" size={17} />{incoming.length} incoming {incoming.length === 1 ? "offer" : "offers"}
      </Button>}</span>
    </div>
    {discoveryNotice}</>}
    {watchError && desktopView !== "hidden" && <div className="ae-workspace-notice">
      <p role="alert">{watchError}</p><Button variant="quiet" onClick={retry}>Retry connection</Button>
    </div>}
    {mobile?.render({
      selection, selecting: pending === "file",
      canSelect: !!snapshot && !watchError && pending === undefined,
      select: selectWith,
      pairingAction: <Button data-ae-lens-role="control" disabled={pairingDisabled} onClick={() => setPairingOpen(true)}>
        <SpatialIcon name="pair" size={17} />{pairingLabel}
      </Button>,
    })}
    <div className="ae-transfer-space" ref={environment} data-experience-phase={phase} data-experience-progress={progress}
      data-mobile-view={mobile?.view} hidden={desktopView === "hidden" || destination === "supplement"}>
      <section id={titleId} hidden={!riftVisible} aria-label="Spatial workspace" className="ae-workspace-view">
        <SpatialScene devices={devices} selectedId={selectedId} onSelect={selectDevice} busy={!!pending}
          platform={platform} discovery={stageDiscovery} onPair={() => setPairingOpen(true)}
          pairingDisabled={pairingDisabled} pairingLabel={pairingLabel}
          receiverReady={!!receiveUntil}
          readinessPeerId={ready ? target?.id : rift?.state === "accepted" ? rift.deviceId : undefined}
          offeredPeerId={rift?.state === "pending" ? rift.deviceId : undefined}
          activePeerId={rift?.state === "accepted" || rift?.state === "transferring" ? rift.deviceId : undefined}
          interruptedPeerId={rift && ["failed", "rejected", "cancelled"].includes(rift.state) ? rift.deviceId : undefined}>
          {anchors => {
            const remote = riftPeerId && anchors.peers.get(riftPeerId);
            if ((anchors.compact && devices.length > 6) || !remote || !anchors.width || !anchors.height) return null;
            return <RiftLink key={rift?.id ?? riftPeerId} transfer={rift} ready={ready}
              departureFrom={departure && departure.deviceId === riftPeerId &&
                (!departure.receipt || departure.receipt.id === rift?.id) ? departure.from : undefined}
              geometry={{ width: anchors.width, height: anchors.height, source: anchors.local, destination: remote }} />;
          }}
        </SpatialScene>
        {gesture?.({ intent: watchError || !riftVisible ? null : intent,
          foreground: riftVisible, busy: pending !== undefined || pairingOpen || !riftVisible,
          send, incoming: riftVisible ? incomingIntents : [], accept, reportGesture })}
        <GlassSurface material="chrome" className="ae-transfer-dock" data-dock-phase={phase}>
          <div className="ae-dock-file">
            {outgoingObject ? <TransferObject key={outgoingObject.selectionId} objectId={outgoingObject.selectionId} glyphRef={dockGlyph}
              files={[outgoingObject]}
              state={departure?.file === outgoingObject && pending === "send" ? "departing" : outgoingPhase || "resting"} />
              : allowDrop && !dockStatus && <small>or drop a file here</small>}
            <div className="ae-dock-actions">
              <Button data-ae-lens-role={outgoingObject ? undefined : "control"} variant={outgoingObject ? "quiet" : "secondary"} onClick={chooseFile}
                loading={pending === "file"} loadingLabel="Opening picker…" disabled={!snapshot || (!!pending && pending !== "file")}>
                <SpatialIcon name="file" />{outgoingObject ? "Change file" : dockStatus ? "Choose another file" : "Choose file"}
              </Button>
              {selection && <Button variant="quiet" onClick={clearSelection} disabled={!!pending} aria-label="Clear selected file"
                title="Clear selected file"><SpatialIcon name="close" /></Button>}
            </div>
          </div>
          {outgoingObject && <div className="ae-dock-destination">
            <small role="status">{offerBlocked || (ready ? `${target?.name} is ready to receive` : chosen
              ? `${chosen.name}${chosen.online ? "" : " · Offline"}` : "Choose a paired device")}</small>
            {(intent || pending === "send") && <Button variant="primary" disabled={pending !== "send" && !!pending}
              loading={pending === "send"} loadingLabel="Offering…" onClick={() => { if (intent) void send(intent); }}>
              <SpatialIcon name="send" />Send file
            </Button>}
          </div>}
          {dockStatus && <Button variant="quiet" className="ae-dock-status" aria-controls={transferRegionId}
            onClick={() => transferRegion.current?.focus()}>{dockStatus}<SpatialIcon name="chevron" size={16} /></Button>}
          {port.setReceiverReady && (!outgoingObject || receiveUntil > 0) &&
            <Button variant="quiet" className="ae-dock-receive" aria-pressed={!!receiveUntil} disabled={!snapshot}
              onClick={toggleReceive} loading={operations.has("receiver")} loadingLabel="Updating…">
              <SpatialIcon name="drop" size={18} />{receiveUntil ? "Ready to receive" : "Signal ready"}
            </Button>}
        </GlassSurface>
      </section>
      {mobile?.view === "activity" ? [transferSection, activitySection] : [activitySection, transferSection]}
    </div>
    <Sheet open={pairingOpen} title="Pair a device" onClose={() => setPairingOpen(false)}>
      {pairingOpen && <PairingPanel invitation={invitation} requests={pendingPairs} disabled={pairingDisabled}
        busy={pairingBusy === "create" || pairingBusy === "redeem" || pairingBusy === "start_nearby" ? pairingBusy : undefined}
        nearby={snapshot?.nearbyVerification ? { candidates: devices.filter(device => device.online && !device.paired),
          incoming: snapshot.nearbyPairingIncoming, outgoing: snapshot.nearbyPairingOutgoing } : undefined}
        requestBusy={id => {
          const current = operations.get(pairingKey(id));
          return current === "approve" || current === "deny" ? current : undefined;
        }} onPair={pair} status={pairStatus} error={pairError} />}
    </Sheet>
    <Toast message={toast?.message} kind={toast?.kind} onDismiss={() => setToast(undefined)} />
  </>;
}
