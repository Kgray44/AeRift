import { Channel, invoke } from "@tauri-apps/api/core";
import {
  ERROR_CODES,
  type AppPort,
  type AppSnapshot,
  type ErrorCode,
  type FileSelection,
  type PairingResult,
  type ProtocolError,
  type Result,
  type Transfer,
} from "@aerift/app-contract";

function protocolError(error: unknown): ProtocolError {
  if (error && typeof error === "object" && "code" in error &&
    ERROR_CODES.includes(error.code as ErrorCode)) return { code: error.code as ErrorCode };
  return { code: "internal_error" };
}

async function command<T>(name: string, args?: Record<string, unknown>): Promise<Result<T>> {
  try {
    return { ok: true, value: await invoke<T>(name, args) };
  } catch (error) {
    return { ok: false, error: protocolError(error) };
  }
}

export const nativeAppPort: AppPort = {
  async watch(listener) {
    const updates = new Channel<AppSnapshot>(listener);
    const subscribed = await command<string>("watch_app", { updates });
    if (!subscribed.ok) {
      updates.onmessage = () => {};
      return subscribed;
    }

    return {
      ok: true,
      value: () => {
        updates.onmessage = () => {};
        void command<void>("unwatch_app", { subscriptionId: subscribed.value });
      },
    };
  },
  selectFile() {
    return command<FileSelection | null>("select_app_file");
  },
  pair(request) {
    return command<PairingResult>("pair_app_peer", { request });
  },
  transfer(request) {
    return command<Transfer>("transfer_app_file", { request });
  },
};

export type ReceiveFolder = { active: string | null; next: string | null };

export const desktopSettings = {
  folder: () => command<ReceiveFolder>("get_receive_folder"),
  chooseFolder: () => command<ReceiveFolder | null>("choose_receive_folder"),
};

type DropUpdate =
  | { kind: "dropped"; selection: FileSelection }
  | { kind: "rejected"; error: ProtocolError };

export function watchFileDrop(listener: (update: DropUpdate) => void) {
  const updates = new Channel<DropUpdate>(listener);
  void command<void>("watch_file_selection", { updates });
  return () => { updates.onmessage = () => {}; };
}
