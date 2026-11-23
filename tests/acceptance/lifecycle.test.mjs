import assert from "node:assert/strict";
import { test } from "node:test";
import { assertTransferTrace } from "./lifecycle.mjs";

const pending = { state: "pending", bytesTransferred: 0 };
const accepted = { state: "accepted", bytesTransferred: 0 };
const streaming = { state: "transferring", bytesTransferred: 2 };
const completed = { state: "completed", bytesTransferred: 4 };

test("accepts ordered progress and stable repeated terminal receipts", () => {
  assertTransferTrace(4, [pending, accepted, streaming, completed, completed], "completed");
  assertTransferTrace(0, [pending, accepted, { ...completed, bytesTransferred: 0 }], "completed");
});

test("accepts failed, cancelled and rejected traces", () => {
  assertTransferTrace(4, [pending, accepted, streaming, {
    state: "failed", bytesTransferred: 2, error: { code: "network_error" },
  }], "failed");
  assertTransferTrace(4, [pending, accepted, {
    state: "cancelled", bytesTransferred: 0,
  }], "cancelled");
  assertTransferTrace(4, [pending, { state: "rejected", bytesTransferred: 0 }], "rejected");
});

test("rejects transfer before consent, skipped streaming, and early completion", () => {
  assert.throws(() => assertTransferTrace(4, [pending, streaming, completed], "completed"),
    /invalid transition/);
  assert.throws(() => assertTransferTrace(4, [pending, accepted, completed], "completed"),
    /skipped streaming/);
  assert.throws(() => assertTransferTrace(4, [
    pending, accepted, streaming, { ...completed, bytesTransferred: 3 },
  ], "completed"), /incomplete publication/);
});

test("rejects regressing progress and cancellation after publication", () => {
  assert.throws(() => assertTransferTrace(4, [
    pending, accepted, streaming, { ...streaming, bytesTransferred: 1 }, completed,
  ], "completed"), /regressed/);
  assert.throws(() => assertTransferTrace(4, [
    pending, accepted, streaming, completed, { state: "cancelled", bytesTransferred: 4 },
  ], "cancelled"), /invalid transition/);
});
