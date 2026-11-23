import type { AppPort, Device, FileSelection } from "@aerift/app-contract";

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
