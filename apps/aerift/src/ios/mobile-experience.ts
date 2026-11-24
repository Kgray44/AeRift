import type { AppSnapshot } from "@aerift/app-contract";

import { getNavigation, restorePreferences, type DestinationId } from "@aerift/app-contract/experience";

export type MobileDestination = Exclude<DestinationId, "settings">;
export function getMobileNavigation(friendsAvailable: boolean) {
  return getNavigation("mobile", restorePreferences(undefined),
    { ambient: "unsupported", camera: "unknown", friends: friendsAvailable ? "available" : "unsupported" });
}
export const mobileNavigation = getMobileNavigation(false);
export const mobileDestinations = mobileNavigation.primary.map(({ id }) => id)
  .filter((id): id is MobileDestination => id !== "settings");

export function summarizeMobile(snapshot: AppSnapshot | undefined) {
  const devices = snapshot?.devices ?? [];
  const transfers = snapshot?.transfers ?? [];
  const available = devices.filter(device => device.online);
  return {
    available: available.length,
    trustedOnline: available.filter(device => device.paired).length,
    pairRequests: snapshot?.pendingPairing.length ?? 0,
    incomingOffers: transfers.filter(item => item.direction === "incoming" && item.state === "pending").length,
    active: transfers.filter(item => item.state === "pending" || item.state === "accepted" || item.state === "transferring"),
    received: transfers.filter(item => item.direction === "incoming" && item.state === "completed"),
  };
}
