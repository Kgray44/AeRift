import { Channel } from "@tauri-apps/api/core";
import type { FileSelection, ProtocolError } from "@aerift/app-contract";
import { command } from "../nativeAppPort";

export type ReceiveFolder = { active: string | null; next: string | null };

export const desktopSettings = {
  folder: () => command<ReceiveFolder>("get_receive_folder"),
  chooseFolder: () => command<ReceiveFolder | null>("choose_receive_folder"),
};

export type SelectionUpdate =
  | { kind: "changed"; selection: FileSelection | null }
  | { kind: "rejected"; error: ProtocolError };

export function watchFileSelection(listener: (update: SelectionUpdate) => void) {
  const updates = new Channel<SelectionUpdate>(listener);
  let disposed = false;
  void command<void>("watch_file_selection", { updates }).then(result => {
    if (!disposed && !result.ok) listener({ kind: "rejected", error: result.error });
  });
  return () => {
    disposed = true;
    updates.onmessage = () => {};
  };
}
