/** Version 1 DTOs for the trusted webview/native boundary. */
export const PROTOCOL_VERSION = 1;

export const ERROR_CODES = [
  "permission_denied",
  "unsupported_version",
  "invalid_request",
  "peer_unavailable",
  "peer_untrusted",
  "pairing_expired",
  "pairing_rejected",
  "transfer_rejected",
  "conflict",
  "integrity_failed",
  "storage_failed",
  "cancelled",
  "network_error",
  "internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
export type Platform = "windows" | "ios" | "android" | "macos" | "linux";
export type DeviceId = string;
export type TransferId = string;
export type SelectionId = string;

export interface ProtocolError {
  code: ErrorCode;
}

export interface Device {
  id: DeviceId;
  name: string;
  platform: Platform;
  paired: boolean;
  online: boolean;
}

export interface PairingInvitation {
  code: string;
  expiresAt: string;
}

export type PairingRequest =
  | { action: "create" }
  | { action: "redeem"; code: string }
  | { action: "confirm"; requestId: string; accept: boolean }
  | { action: "revoke"; deviceId: DeviceId };

export type PairingResult =
  | { state: "invitation"; invitation: PairingInvitation }
  | { state: "paired"; device: Device }
  | { state: "rejected" }
  | { state: "revoked" };

export interface FileInfo {
  name: string;
  sizeBytes: number;
}

export interface FileSelection extends FileInfo {
  selectionId: SelectionId;
}

export type TransferFailure = {
  state: "failed";
  bytesTransferred: number;
  error: ProtocolError;
};

export type TransferProgress =
  | {
      state: "pending" | "accepted" | "transferring" | "rejected" | "cancelled" | "completed";
      bytesTransferred: number;
    }
  | TransferFailure;

export type Transfer = {
  id: TransferId;
  deviceId: DeviceId;
  direction: "outgoing" | "incoming";
  file: FileInfo;
} & TransferProgress;

export type TransferRequest =
  | { action: "offer"; deviceId: DeviceId; selectionId: SelectionId }
  | { action: "respond"; transferId: TransferId; accept: boolean }
  | { action: "cancel"; transferId: TransferId };

export type GestureCommand =
  | { version: 1; action: "arm"; intentId: string }
  | { version: 1; action: "release"; intentId: string }
  | { version: 1; action: "interrupt"; intentId: string };

export interface AppSnapshot {
  version: 1;
  devices: readonly Device[];
  transfers: readonly Transfer[];
  pendingPairing: readonly { requestId: string; device: Device; expiresAt: string }[];
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ProtocolError };

export interface AppPort {
  /** Emit an initial snapshot and ordered updates. The callback's return value is ignored. */
  watch(listener: (snapshot: AppSnapshot) => void): Promise<Result<() => void>>;
  /** Resolve successfully with null when the user closes the picker. */
  selectFile(): Promise<Result<FileSelection | null>>;
  pair(request: PairingRequest): Promise<Result<PairingResult>>;
  transfer(request: TransferRequest): Promise<Result<Transfer>>;
}
