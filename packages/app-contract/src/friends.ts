import type { DeviceId, Result } from "./v1.js";

export type FriendId = string;
export const FRIEND_OBJECT_KINDS = ["file", "folder", "photo", "video", "link", "clipboard", "note"] as const;
export type FriendObjectKind = (typeof FRIEND_OBJECT_KINDS)[number];
export type FriendDevice = { id: DeviceId; label: string; availability: "online" | "offline" | "unknown" };
export type FriendContact = {
  id: FriendId; label: string; verification: string;
  incomingAllowed: boolean; devices: readonly FriendDevice[];
};
export type FriendOffer = {
  id: string; friendId: FriendId; label: string; kind: FriendObjectKind; direction: "incoming" | "outgoing";
  state: "pending" | "accepted" | "transferring" | "completed" | "declined" | "withdrawn" | "failed" | "queued";
  deviceId?: DeviceId;
};
export type FriendsSnapshot = {
  version: 1;
  contacts: readonly FriendContact[];
  offers: readonly FriendOffer[];
  invitations: readonly { id: string; label: string; verification: string; expiresAt: string }[];
  supportedObjects: readonly FriendObjectKind[];
};
export type FriendTarget = { friendId: FriendId; deviceId?: DeviceId };
export type FriendsRequest =
  | { action: "redeem_invitation"; invitation: string }
  | { action: "respond_invitation"; invitationId: string; accept: boolean }
  | { action: "authorize_device"; friendId: FriendId; invitation: string }
  | { action: "revoke_device"; friendId: FriendId; deviceId: DeviceId }
  | { action: "set_permissions"; friendId: FriendId; allowIncoming: boolean }
  | { action: "remove_friend"; friendId: FriendId }
  | { action: "offer"; target: FriendTarget; selectionId: string }
  | { action: "respond_offer"; offerId: string; accept: boolean };
export interface FriendsPort {
  createContactCard(): Promise<Result<{ card: string }>>;
  createInvitation(recipientCard: string): Promise<Result<{ invitation: string; expiresAt: string }>>;
  pickObject(kind: FriendObjectKind): Promise<Result<{ selectionId: string; label: string } | null>>;
  apply(request: FriendsRequest): Promise<Result<void>>;
}

/** This list never moves a friend's devices into Nearby or My Devices. Authority is native. */
export function ordinaryDevices<T extends { id: DeviceId }>(devices: readonly T[], friends?: FriendsSnapshot): readonly T[] {
  if (friends?.version !== 1) return devices;
  const friendDeviceIds = new Set(friends.contacts.flatMap(contact => contact.devices.map(({ id }) => id)));
  return devices.filter(({ id }) => !friendDeviceIds.has(id));
}

export function friendTargets(friends: FriendsSnapshot, friendId: FriendId): readonly FriendDevice[] {
  return friends.contacts.find(contact => contact.id === friendId)?.devices ?? [];
}

/** Nearby pairing is never evidence of personal-device authorization. */
export function partitionDevices<T extends { id: DeviceId }>(
  devices: readonly T[], friends?: FriendsSnapshot, personalDeviceIds: readonly DeviceId[] = [],
): { personal: readonly T[]; nearby: readonly T[] } {
  const personalIds = new Set(personalDeviceIds);
  const personal: T[] = [];
  const nearby: T[] = [];
  for (const device of ordinaryDevices(devices, friends)) {
    (personalIds.has(device.id) ? personal : nearby).push(device);
  }
  return { personal, nearby };
}
