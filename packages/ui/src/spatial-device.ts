import type { Device } from "@aerift/app-contract";

export function devicePresence(device: Pick<Device, "online" | "paired">, signals: {
  selected?: boolean; ready?: boolean; offered?: boolean; active?: boolean; interrupted?: boolean;
}) {
  if (signals.interrupted) return ["interrupted", "Transfer interrupted"] as const;
  if (signals.ready && device.online && device.paired) return ["ready", "Ready to receive"] as const;
  if (signals.active) return ["active", "Transfer active"] as const;
  if (signals.offered) return ["offered", "Offer pending"] as const;
  if (!device.online) return ["offline", "Offline"] as const;
  if (!device.paired) return ["unpaired", "Unpaired"] as const;
  return signals.selected ? ["selected", "Selected"] as const : ["available", "Available"] as const;
}
