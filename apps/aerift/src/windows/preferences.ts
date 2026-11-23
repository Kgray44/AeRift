import { restorePreferences, type DestinationId, type ExperiencePreferences } from "@aerift/app-contract/experience";
import type { OrbitShortcut } from "@aerift/ui";
import type { CameraShortcut } from "./GestureCamera";

export const settingsKey = "aerift.settings.v1";

export type AmbientShortcut = "off" | "alt-shift-r" | "ctrl-alt-r";

export interface DesktopPreferences {
  experience: ExperiencePreferences;
  route: DestinationId;
  orbitShortcut: OrbitShortcut;
  gestures: boolean;
  cameraShortcut: CameraShortcut;
  cameraId: string;
  clipboard: boolean;
  ambientNotifications: boolean;
  ambientShortcut: AmbientShortcut;
}

export function parseDesktopPreferences(value: unknown): DesktopPreferences {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const appearance = input.appearance && typeof input.appearance === "object" ? input.appearance : {};
  const route = input.route;
  return {
    experience: restorePreferences(input.experience ?? { ...appearance, version: 1 }),
    route: route === "workspace" || route === "rift" || route === "activity" ||
      route === "devices" || route === "settings" ? route : "home",
    orbitShortcut: input.orbitShortcut === "off" || input.orbitShortcut === "alt-shift-o" ? input.orbitShortcut : "alt-o",
    gestures: (input.gestures ?? input.gesturesEnabled) === true,
    cameraShortcut: input.cameraShortcut === "off" || input.cameraShortcut === "v" ? input.cameraShortcut : "c",
    cameraId: typeof input.cameraId === "string" ? input.cameraId :
      typeof input.cameraDeviceId === "string" ? input.cameraDeviceId : "",
    clipboard: input.clipboard === true,
    ambientNotifications: input.ambientNotifications === true,
    ambientShortcut: input.ambientShortcut === "alt-shift-r" || input.ambientShortcut === "ctrl-alt-r"
      ? input.ambientShortcut : "off",
  };
}

export function readDesktopPreferences(): DesktopPreferences {
  try {
    return parseDesktopPreferences(JSON.parse(localStorage.getItem(settingsKey) ?? "null"));
  } catch {
    return parseDesktopPreferences(null);
  }
}
