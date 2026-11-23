import type { ObjectId } from "./digital-objects.js";
import type { DeviceId, Transfer, TransferId } from "./v1.js";

export const DESTINATIONS = {
  home: { id: "home", label: "Home", icon: "home" },
  workspace: { id: "workspace", label: "Workspace", icon: "workspace" },
  rift: { id: "rift", label: "Rift", icon: "rift" },
  devices: { id: "devices", label: "Devices", icon: "devices" },
  activity: { id: "activity", label: "Activity", icon: "activity" },
  settings: { id: "settings", label: "Settings", icon: "settings" },
} as const;

export type DestinationId = keyof typeof DESTINATIONS;
export type Destination = (typeof DESTINATIONS)[DestinationId];
export type WindowMode = "simplified" | "full";
export type DesktopNavigation = "orbit" | "conventional";
export type FormFactor = "mobile" | "desktop";

export const WORKSPACE_MODULES = [
  { id: "files", label: "Files", icon: "file" },
  { id: "photos", label: "Photos and videos", icon: "photo" },
  { id: "browser", label: "Browser", icon: "url" },
  { id: "notes", label: "Notes", icon: "note" },
  { id: "clipboard", label: "Clipboard", icon: "clipboard" },
  { id: "collections", label: "Collections", icon: "collection" },
] as const;

export type Module = (typeof WORKSPACE_MODULES)[number];
export type ModuleId = Module["id"];
export type WorkspaceModuleRegistry<Renderer> = Partial<Readonly<Record<ModuleId, Renderer>>>;

export interface ExperiencePreferences {
  version: 1;
  windowMode: WindowMode;
  desktopNavigation: DesktopNavigation;
  ambientEnabled: boolean;
  hiddenModules: readonly ModuleId[];
  theme: string;
  scheme: "system" | "light" | "dark";
  contrast: "system" | "increase";
  transparency: "system" | "reduce";
  motion: "system" | "reduce";
}

const moduleIds = new Set<string>(WORKSPACE_MODULES.map(({ id }) => id));

function isModuleId(value: unknown): value is ModuleId {
  return typeof value === "string" && moduleIds.has(value);
}

/** Restore known fields from local storage. UI-only preferences never authorize OS access. */
export function restorePreferences(value: unknown): ExperiencePreferences {
  const input = typeof value === "object" && value !== null && "version" in value && value.version === 1
    ? value as Record<string, unknown> : {};
  return {
    version: 1,
    windowMode: input.windowMode === "full" ? "full" : "simplified",
    desktopNavigation: input.desktopNavigation === "conventional" ? "conventional" : "orbit",
    ambientEnabled: input.ambientEnabled === true,
    hiddenModules: Array.isArray(input.hiddenModules) ? [...new Set(input.hiddenModules.filter(isModuleId))] : [],
    theme: typeof input.theme === "string" && /^[a-z][a-z0-9-]*$/.test(input.theme) ? input.theme : "glass",
    scheme: input.scheme === "dark" || input.scheme === "light" ? input.scheme : "system",
    contrast: input.contrast === "increase" ? "increase" : "system",
    transparency: input.transparency === "reduce" ? "reduce" : "system",
    motion: input.motion === "reduce" ? "reduce" : "system",
  };
}

export function getVisibleModules(preferences: ExperiencePreferences): readonly Module[] {
  return WORKSPACE_MODULES.filter(({ id }) => !preferences.hiddenModules.includes(id));
}

export type CapabilityStatus = "available" | "unknown" | "denied" | "unsupported";

export interface PlatformCapabilities {
  ambient: CapabilityStatus;
  camera: CapabilityStatus;
}

export interface NavigationPresentation {
  presentation: DesktopNavigation | "bottom";
  primary: readonly Destination[];
  settings: typeof DESTINATIONS.settings;
  ambient: boolean;
}

export function getNavigation(
  formFactor: FormFactor,
  preferences: ExperiencePreferences,
  capabilities: PlatformCapabilities,
): NavigationPresentation {
  const mobile = formFactor === "mobile";
  const primary: Destination[] = [DESTINATIONS.home];
  if (mobile || preferences.windowMode === "full") primary.push(DESTINATIONS.workspace);
  primary.push(DESTINATIONS.rift, DESTINATIONS.devices, DESTINATIONS.activity);
  if (!mobile) primary.push(DESTINATIONS.settings);
  return {
    presentation: mobile ? "bottom" : preferences.desktopNavigation,
    primary,
    settings: DESTINATIONS.settings,
    ambient: !mobile && preferences.ambientEnabled && capabilities.ambient === "available",
  };
}

export type NavigationCause = "user" | "restore" | "mode-change";
export interface NavigationChange {
  from: DestinationId;
  to: DestinationId;
  cause: NavigationCause;
  focus: "destination-heading";
}

export function createNavigationChange(
  navigation: NavigationPresentation,
  from: DestinationId,
  target: DestinationId,
  cause: NavigationCause,
): NavigationChange | undefined {
  const available = navigation.settings.id === target || navigation.primary.some(({ id }) => id === target);
  if (!available && cause === "user") return undefined;
  const to = available ? target : DESTINATIONS.home.id;
  if (from === to) return undefined;
  return { from, to, cause, focus: "destination-heading" };
}

export type NavigationLifecycle =
  | ({ phase: "requested" | "committed" | "cancelled"; transitionId: string } & NavigationChange);

export interface NavigationState {
  current: DestinationId;
  pending?: NavigationChange & { transitionId: string };
}

/** Give each request a fresh transition ID. Stale callbacks are ignored. */
export function applyNavigationEvent(state: NavigationState, event: NavigationLifecycle): NavigationState {
  if (event.from !== state.current) return state;
  if (event.phase === "requested") {
    const { phase: _phase, ...pending } = event;
    return { current: state.current, pending };
  }
  const pending = state.pending;
  if (!pending || event.transitionId !== pending.transitionId || event.to !== pending.to) return state;
  return { current: event.phase === "committed" ? pending.to : state.current };
}

export type GlassRole = "field" | "raised" | "content" | "chrome" | "overlay" | "control";
export type MotionIntent = "spatial" | "feedback";
export type MotionTreatment = MotionIntent | "direct";

export function resolveMotion(intent: MotionIntent, reduced: boolean): MotionTreatment {
  return reduced ? "direct" : intent;
}

export type GestureInteraction =
  | { state: "idle" | "unavailable" | "paused" }
  | { state: "ready" }
  | { state: "engaged"; intentId: string; objectId: ObjectId };

export interface TransferChoreography {
  readonly transferId: TransferId;
  readonly deviceId: DeviceId;
  readonly objectId?: ObjectId;
  readonly phase: Transfer["state"];
}
