import type { AppSnapshot, GestureCommand, Transfer } from "../../packages/app-contract/src/v1.js";

const file = { name: "sample.bin", sizeBytes: 123 };
const transfer = {
  id: "2febcbf0-268d-41c5-b35d-47c881861a80",
  deviceId: "a".repeat(64),
  direction: "outgoing",
  file,
} as const;

export const examples = {
  snapshot: { version: 1, devices: [], transfers: [], pendingPairing: [] } satisfies AppSnapshot,
  gesture: { version: 1, action: "release", intentId: "local-intent" } satisfies GestureCommand,
  completed: { ...transfer, state: "completed", bytesTransferred: 123 } satisfies Transfer,
  failed: {
    ...transfer,
    state: "failed",
    bytesTransferred: 64,
    error: { code: "integrity_failed" },
  } satisfies Transfer,
};
