import type { DestinationId } from "@aerift/app-contract/experience";

export const destinationIntent: Partial<Record<DestinationId, string>> = {
  rift: "Send an object to a paired device, or receive an incoming transfer.",
  devices: "Find devices nearby, pair with ones you recognize, and manage trust.",
  friends: "Keep your trusted contacts and their devices together.",
  activity: "Review incoming offers, progress, and transfer history.",
  settings: "Choose how AeRift looks and which features it can use.",
};
