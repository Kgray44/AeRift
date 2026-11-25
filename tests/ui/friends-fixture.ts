import type { FriendsPort, FriendsSnapshot } from "@aerift/app-contract/friends";
import type { AppSnapshot } from "@aerift/app-contract";

export function friendsFixture(current: () => AppSnapshot, publish: (value: AppSnapshot) => void): FriendsPort {
  const initial: FriendsSnapshot = { version: 1, invitations: [], supportedObjects: ["file"], contacts: [
    { id: "friend-a", label: "Test contact A", verification: "TEST-A", incomingAllowed: true,
      devices: [{ id: "friend-phone", label: "Test phone", availability: "online" }] },
    { id: "friend-b", label: "Test contact B", verification: "TEST-B", incomingAllowed: true,
      devices: [{ id: "friend-tablet", label: "Test tablet", availability: "offline" }] },
  ], offers: [{ id: "fixture-incoming", friendId: "friend-a", kind: "file",
    label: "Incoming fixture", direction: "incoming", state: "pending" }] };
  publish({ ...current(), friends: initial, devices: [...current().devices, {
    id: "friend-phone", name: "Test phone", platform: "ios", paired: true, online: true,
  }] });
  return {
    async createContactCard() { return { ok: true, value: { card: "fixture-card" } }; },
    async createInvitation(recipientCard) {
      if (recipientCard !== "recipient-fixture-card") return { ok: false, error: { code: "invalid_request" } };
      return { ok: true, value: { invitation: "test-fixture", expiresAt: "2030-01-01T00:00:00Z" } };
    },
    async pickObject() { return { ok: true, value: { selectionId: "fixture-picked", label: "Synthetic sample" } }; },
    async apply(request) {
      const app = current();
      const friends = app.friends!;
      if (request.action === "offer" && request.target.friendId === "friend-a" && request.target.deviceId === undefined
        && request.selectionId === "fixture-picked") {
        publish({ ...app, friends: { ...friends, offers: [...friends.offers, {
          id: "fixture-outgoing", friendId: "friend-a", kind: "file",
          label: "Synthetic sample", direction: "outgoing", state: "queued",
        }] } });
      } else if (request.action === "respond_offer" && request.offerId === "fixture-incoming") {
        publish({ ...app, friends: { ...friends, offers: friends.offers.map(offer => offer.id === request.offerId
          ? { ...offer, state: request.accept ? "accepted" : "declined" } : offer) } });
      } else return { ok: false, error: { code: "invalid_request" } };
      return { ok: true, value: undefined };
    },
  };
}
