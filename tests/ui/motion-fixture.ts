import type { AppSnapshot, Transfer, TransferRequest } from "@aerift/app-contract";

export const motionPhases = ["offered", "accepted", "transport", "verifying", "delivered", "failed", "cancelled"] as const;
type Phase = (typeof motionPhases)[number];
type Direction = Transfer["direction"];
type Geometry = Pick<Transfer, "deviceId" | "file">;
type MotionFixture = { set(direction: Direction, phase: Phase): Transfer };
type MotionFixtureWindow = Window & { aeMotionFixture?: MotionFixture };

/** A production-shaped snapshot stream, available only in opt-in browser fixtures. */
export function installMotionFixture(peer: string, getSnapshot: () => AppSnapshot, broadcast: (snapshot: AppSnapshot) => void) {
  let serial = 0;
  let activeId: string | undefined;
  const set: MotionFixture["set"] = (direction, phase) => {
    if (!["incoming", "outgoing"].includes(direction) || !motionPhases.includes(phase)) {
      throw new RangeError("Unknown motion fixture direction or phase");
    }
    const current = getSnapshot().transfers.find(item => item.id === activeId);
    const fresh = !current || current.direction !== direction || phase === "offered";
    const id = fresh ? `motion-${direction}-${++serial}` : current.id;
    const geometry: Geometry = { deviceId: peer, file: {
      name: direction === "incoming" ? "Motion study incoming.pdf" : "Motion study outgoing.pdf",
      sizeBytes: 100_000,
    } };
    const base = { ...geometry, id, interactionId: `fixture-${id}`, direction };
    const previousBytes = fresh ? 0 : current.bytesTransferred;
    const transfer: Transfer = phase === "failed" ?
      { ...base, state: "failed", bytesTransferred: previousBytes, error: { code: "peer_unavailable" } } :
      phase === "cancelled" ?
      { ...base, state: "cancelled", bytesTransferred: previousBytes } :
      phase === "delivered" ?
      { ...base, state: "completed", bytesTransferred: geometry.file.sizeBytes } :
      phase === "verifying" ?
      { ...base, state: "transferring", bytesTransferred: geometry.file.sizeBytes } :
      phase === "transport" ?
      { ...base, state: "transferring", bytesTransferred: 36_000 } :
      { ...base, state: phase === "accepted" ? "accepted" : "pending", bytesTransferred: 0 };

    const fixtures = getSnapshot();
    broadcast({ ...fixtures, transfers: [transfer, ...fixtures.transfers.filter(
      item => item.id !== activeId && item.id !== transfer.id,
    )] });
    activeId = id;
    return transfer;
  };
  (window as MotionFixtureWindow).aeMotionFixture = { set };
  set("incoming", "offered");

  // Visible controls are independently opt-in so timing captures stay clean.
  if (new URLSearchParams(location.search).get("motionControls") === "1") {
    const panel = document.createElement("details");
    panel.style.cssText = "position:fixed;inset:8px 8px auto auto;z-index:999;background:#172132;color:white;padding:8px;border-radius:8px;font:14px system-ui;max-width:240px";
    const heading = document.createElement("summary");
    heading.textContent = "Transfer motion fixture";
    panel.append(heading);
    for (const direction of ["incoming", "outgoing"] as const) {
      const line = document.createElement("div");
      line.textContent = direction + " ";
      for (const phase of motionPhases) {
        const button = document.createElement("button");
        button.textContent = phase;
        button.setAttribute("aria-label", `${direction} ${phase}`);
        button.addEventListener("click", () => set(direction, phase));
        line.append(button);
      }
      panel.append(line);
    }
    document.body.append(panel);
  }
}

/** Let the native accept, reject and cancel buttons affect fixture receipts. */
export function respondToMotionReceipt(request: TransferRequest, snapshot: AppSnapshot): Transfer | undefined {
  if (request.action === "offer") return undefined;
  const current = snapshot.transfers.find(item => item.id === request.transferId && item.id.startsWith("motion-"));
  if (!current || !["pending", "accepted", "transferring"].includes(current.state)) return undefined;
  if (request.action === "respond" && (current.state !== "pending" || current.direction !== "incoming")) return undefined;
  return { ...current, state: request.action === "cancel" ? "cancelled" : request.accept ? "accepted" : "rejected" };
}

/** Independent send/receive receipts for the transfer island, never compiled into the app. */
export function installTransferIslandFixture(peer: string, getSnapshot: () => AppSnapshot, broadcast: (snapshot: AppSnapshot) => void) {
  type IslandState = "pending" | "accepted" | "transferring" | "completed" | "cancelled";
  const set = (direction: Direction, state: IslandState, bytesTransferred: number) => {
    if (!["incoming", "outgoing"].includes(direction) ||
        !["pending", "accepted", "transferring", "completed", "cancelled"].includes(state)) {
      throw new RangeError("Unknown transfer island fixture state");
    }
    const id = `island-${direction}`;
    const file = { name: direction === "incoming" ? "Tidal charts.pdf" : "Survey recording.wav", sizeBytes: 4_000 };
    const transfer: Transfer = { id, direction, deviceId: peer, file, state, bytesTransferred };
    const snapshot = getSnapshot();
    broadcast({ ...snapshot, transfers: [transfer, ...snapshot.transfers.filter(item => item.id !== id)] });
  };
  (window as Window & { aeTransferIslandFixture?: { set: typeof set } }).aeTransferIslandFixture = { set };
  set("incoming", "pending", 0);
}
