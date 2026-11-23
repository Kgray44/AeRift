import assert from "node:assert/strict";

const nextStates = {
  pending: ["accepted", "rejected", "cancelled", "failed"],
  accepted: ["transferring", "completed", "cancelled", "failed"],
  transferring: ["completed", "cancelled", "failed"],
  completed: [],
  rejected: [],
  cancelled: [],
  failed: [],
};

/** Check one complete, ordered v1 transfer trace on one device. */
export function assertTransferTrace(sizeBytes, updates, outcome) {
  assert.ok(Number.isSafeInteger(sizeBytes) && sizeBytes >= 0, "invalid offered size");
  assert.equal(updates[0]?.state, "pending", "capture the complete trace from the offer");
  assert.equal(updates.at(-1)?.state, outcome, "unexpected outcome");
  assert.ok(Object.hasOwn(nextStates, outcome) && nextStates[outcome].length === 0,
    "expected outcome must be terminal");

  let previous;
  for (const update of updates) {
    const { state, bytesTransferred, error } = update;
    assert.ok(Object.hasOwn(nextStates, state), `unknown state ${state}`);
    assert.ok(Number.isSafeInteger(bytesTransferred) && bytesTransferred >= 0 &&
      bytesTransferred <= sizeBytes, "invalid byte count");
    if (previous) {
      assert.ok(bytesTransferred >= previous.bytesTransferred, "byte count regressed");
      if (state !== previous.state) {
        assert.ok(nextStates[previous.state].includes(state),
          `invalid transition ${previous.state} to ${state}`);
        if (previous.state === "accepted" && state === "completed") {
          assert.equal(sizeBytes, 0, "nonempty transfer skipped streaming");
        }
      } else if (nextStates[state].length === 0) {
        assert.deepEqual(update, previous, "terminal receipt changed");
      }
    }
    if (["pending", "accepted", "rejected"].includes(state)) {
      assert.equal(bytesTransferred, 0, `unexpected bytes in ${state}`);
    }
    if (state === "completed") assert.equal(bytesTransferred, sizeBytes, "incomplete publication");
    if (state === "failed") assert.ok(typeof error?.code === "string" && error.code.length);
    previous = update;
  }
}
