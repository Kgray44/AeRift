import assert from "node:assert/strict";
import { test } from "node:test";
import { environmentPhase, incomingObjectPhase, objectPhase, reconcileTransfers, selectRift, readinessMatches, terminalTransition } from "../../packages/ui/src/rift-coordinator.ts";

const file = { name: "field-notes.pdf", sizeBytes: 32 };
const outgoing = { id: "first", deviceId: "phone", file, direction: "outgoing", state: "pending", bytesTransferred: 0 };
const incoming = { ...outgoing, direction: "incoming", id: "peer:remote" };
const selection = { ...file, selectionId: "selection" };
const target = { kind: "send", deviceId: "phone", selectionId: "selection" };

test("snapshots cannot roll back active progress or terminal delivery", () => {
  const partial = { ...outgoing, state: "transferring", bytesTransferred: 12 };
  const next = reconcileTransfers([partial], [outgoing, outgoing]);
  assert.deepEqual(next, [partial]);
  const complete = { ...outgoing, state: "completed", bytesTransferred: 32 };
  assert.deepEqual(reconcileTransfers([complete], [partial]), [complete]);
});

test("a missing receipt is removed and a different transfer starts independently", () => {
  const complete = { ...outgoing, state: "completed", bytesTransferred: 32 };
  assert.deepEqual(reconcileTransfers([complete], [incoming]), [incoming]);
  assert.equal(selectRift([complete], { id: "missing", expiresAt: 200 }, 100), undefined);
});

test("incoming offers take priority, and historical receipts do not replay", () => {
  const complete = { ...outgoing, state: "completed", bytesTransferred: 32 };
  assert.equal(selectRift([complete, incoming], { id: complete.id, expiresAt: 200 }, 100), incoming);
  assert.equal(selectRift([complete], { id: complete.id, expiresAt: 200 }, 100), complete);
  assert.equal(selectRift([complete], { id: complete.id, expiresAt: 200 }, 200), undefined);
  assert.equal(selectRift([complete], undefined, 100), undefined);
});

test("object choreography follows only matching live gesture intent", () => {
  assert.equal(objectPhase(selection, "phone", { target, phase: "hand-detected" }), "anticipating");
  assert.equal(objectPhase(selection, "phone", { target, phase: "held" }), "held");
  assert.equal(objectPhase(selection, "phone", { target, phase: "interrupted" }), "recovering");
  assert.equal(objectPhase(selection, "phone", { target, phase: "released" }), "resting");
  assert.equal(objectPhase({ ...selection, selectionId: "replacement" }, "phone", { target, phase: "held" }), "resting");
  assert.equal(objectPhase(selection, "laptop", { target, phase: "held" }), "resting");
});

test("remote readiness expires and applies only to the exact held intent", () => {
  const ready = { selectionId: "selection", deviceId: "phone", expiresAt: 200 };
  const gesture = { target, phase: "held" };
  assert.equal(readinessMatches(ready, gesture, target, 199), true);
  assert.equal(readinessMatches(ready, gesture, target, 200), false);
  assert.equal(readinessMatches(ready, { ...gesture, phase: "released" }, target, 100), false);
  assert.equal(readinessMatches(ready, gesture, { ...target, deviceId: "other" }, 100), false);
});

test("receiver choreography stays scoped to its chosen offer until consent changes the receipt", () => {
  const receive = { kind: "receive", transferId: incoming.id, deviceId: incoming.deviceId };
  assert.equal(incomingObjectPhase(incoming, { target: receive, phase: "hand-detected" }), "anticipating");
  assert.equal(incomingObjectPhase(incoming, { target: receive, phase: "held" }), "held");
  assert.equal(incomingObjectPhase({ ...incoming, id: "second" }, { target: receive, phase: "held" }), undefined);
  assert.equal(incomingObjectPhase({ ...incoming, state: "accepted" }, { target: receive, phase: "held" }), undefined);
});

test("a coalesced first failure is visible regardless of the offer reply order", () => {
  const failed = { ...outgoing, state: "failed", error: { code: "peer_unavailable" } };
  assert.equal(terminalTransition([], [failed]), failed);
  assert.equal(terminalTransition([outgoing], [failed]), failed);
  assert.equal(terminalTransition([failed], [failed]), undefined);
  assert.equal(terminalTransition(undefined, [failed]), undefined);
});

test("the environment distinguishes recognition, remote readiness and verified transfer", () => {
  const state = { receiverReady: false, offering: false, selected: false, discovering: true };
  assert.equal(environmentPhase(state), "discovery");
  assert.equal(environmentPhase({ ...state, gesture: "anticipating" }), "hand");
  assert.equal(environmentPhase({ ...state, gesture: "held" }), "held");
  assert.equal(environmentPhase({ ...state, gesture: "held", receiverReady: true }), "ready");
  assert.equal(environmentPhase({ ...state, transfer: outgoing }), "departure");
  assert.equal(environmentPhase({ ...state, transfer: { ...incoming, state: "transferring", bytesTransferred: 32 } }), "receiving");
  assert.equal(environmentPhase({ ...state, transfer: { ...incoming, state: "completed", bytesTransferred: 32 } }), "completed");
});
