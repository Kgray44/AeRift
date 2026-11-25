import type { FriendsSnapshot } from "@aerift/app-contract/friends";

export function windowsFriendsFixture(snapshot: () => FriendsSnapshot, empty: boolean, personTransfersAvailable = !empty) {
  const commands: string[] = [];
  const token = "a".repeat(64);
  let outgoing: [string, number, string | null] | null = null;
  let operationPending = true;
  let accepted = false;
  let declined = false;
  const contacts = () => empty ? [] : snapshot().contacts;
  Object.defineProperty(window, "__aeWindowsFriendsFixtureCommands", { get: () => commands.slice() });
  return (command: string, args?: Record<string, unknown>) => {
    const request = args?.request as { action?: string; friendId?: string; device?: string; allowIncoming?: boolean } | undefined;
    commands.push(`${command}${request?.action ? ":" + request.action : ""}`);
    switch (command) {
      case "friends_setup_view":
        return { profile: token, contacts: contacts(),
          pendingRecipient: operationPending && !empty ? { id: "synthetic-review", verification: "b".repeat(64), expiresAt: 1893456000 } : null };
      case "friends_setup_card": return "fixture-card";
      case "friends_setup_answer": operationPending = false; return;
      case "friends_setup_contact": return;
      case "friends_files_view": return {
        personTransfersAvailable, outgoing,
        incoming: personTransfersAvailable && !declined ? [{ id: "offer-a", issuer: "d".repeat(64), sender: "friend-b",
          label: "Field notes.txt", sizeBytes: 4299, accepted }] : [],
        receipts: [], canRelease: false,
      };
      case "friends_files_action": {
        if (request?.action === "offer_contact") {
          if (!personTransfersAvailable || request.friendId !== "friend-a" || request.device) throw { code: "invalid_request" };
          outgoing = ["fixture-outgoing", 1, null];
        } else if (request?.action === "withdraw") outgoing = null;
        else if (request?.action === "accept_contact_offer") accepted = true;
        else if (request?.action === "decline_contact_offer") declined = true;
        else throw { code: "invalid_request" };
        return null;
      }
      case "friends_member": {
        if (request?.action !== "view") throw { code: "invalid_request" };
        return { type: "view", localDevice: token, memberContacts: 0 };
      }
      default: throw { code: "invalid_request" };
    }
  };
}
