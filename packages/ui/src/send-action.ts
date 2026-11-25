import type { AppPort, AppSnapshot, Device, FileSelection } from "@aerift/app-contract";

import { ordinaryDevices, type FriendsSnapshot } from "@aerift/app-contract/friends";

/** Windows also loads its verified Friends roster through a separate native command. */
export function ordinaryWorkspaceDevices(snapshot: Pick<AppSnapshot, "devices" | "friends"> | undefined,
  separateRoster?: FriendsSnapshot): readonly Device[] {
  return ordinaryDevices(ordinaryDevices(snapshot?.devices ?? [], snapshot?.friends), separateRoster);
}

export interface TransferIntent {
  readonly deviceId: string;
  readonly selectionId: string;
}

export async function offerTransfer(port: Pick<AppPort, "transfer">, device: Device | undefined,
  selection: FileSelection | null, intent: TransferIntent) {
  if (!device?.paired || !device.online || device.id !== intent.deviceId ||
    selection?.selectionId !== intent.selectionId) return null;
  return port.transfer({ action: "offer", ...intent });
}
