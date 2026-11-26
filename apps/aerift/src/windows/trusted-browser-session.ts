// Trust boundary for app-owned chrome only. No Tauri invoke or WebView bridge.
import { workspaceBrowserDestination } from "../workspace-browser-tools";

export type NativeViewport = Readonly<{ widthPx: number; heightPx: number }>;
export type BrowserWitness =
  | { state: "unavailable" }
  | { state: "fixture-only" } // Cannot be used by product chrome.
  | { state: "verified"; boundary: "isolated-native-host" };
export type NativeBrowserRequest =
  | { kind: "present"; generation: number; address: string }
  | { kind: "navigate"; generation: number; address: string }
  | { kind: "back" | "forward" | "reload" | "close"; generation: number };
export type NativeBrowserReply =
  | { kind: "unavailable" | "denied" | "accepted" | "closed" }
  | { kind: "presented"; viewport: NativeViewport; canBack: boolean; canForward: boolean };

export interface NativeBrowserLifecycle {
  /** Static admission statement set by trusted composition, never from webpage or env. */
  readonly witness: BrowserWitness;
  /**
   * Native independently derives the viewport from trusted HWND/client layout and
   * checks caller, origin policy and generation. Close invalidates generations
   * immediately, including unresolved requests. No upload/IPC/history contracts.
   */
  request(command: NativeBrowserRequest): Promise<NativeBrowserReply>;
}

export type TrustedBrowserState =
  | { kind: "external-only" | "closed" | "pending" | "unavailable" | "denied" }
  | { kind: "presented"; viewport: NativeViewport; canBack: boolean; canForward: boolean };

function viewportIsBounded(viewport: NativeViewport) {
  return [viewport.widthPx, viewport.heightPx].every(n => Number.isInteger(n) && n >= 64 && n <= 16_384);
}

export function createTrustedBrowserSession(port: NativeBrowserLifecycle | undefined, changed: (state: TrustedBrowserState) => void) {
  const admitted = port?.witness.state === "verified" && port.witness.boundary === "isolated-native-host";
  let generation = 0;
  let state: TrustedBrowserState = { kind: admitted ? "closed" : "external-only" };
  function publish(next: TrustedBrowserState) { state = next; changed(next); }
  async function close() {
    const previous = generation++;
    publish({ kind: admitted ? "closed" : "external-only" });
    if (admitted && port) {
      try { await port.request({ kind: "close", generation: previous }); }
      catch { /* Native owner independently hides/drops on route departure. */ }
    }
  }
  async function command(action: "open" | "back" | "forward" | "reload", input = "") {
    if (!admitted || !port || state.kind === "pending") return;
    const wasPresented = state.kind === "presented";
    if (action !== "open" && !wasPresented) return;
    if ((action === "back" || action === "forward") &&
      !(state.kind === "presented" && (action === "back" ? state.canBack : state.canForward))) return;
    const address = action === "open" ? workspaceBrowserDestination(input) : undefined;
    if (action === "open" && !address) return;
    const current = generation;
    const request: NativeBrowserRequest = address
      ? { kind: wasPresented ? "navigate" : "present", generation: current, address }
      : { kind: action as "back" | "forward" | "reload", generation: current };
    publish({ kind: "pending" });
    try {
      const result = await port.request(request);
      if (current !== generation) return;
      if (result.kind === "presented" && viewportIsBounded(result.viewport)) {
        publish({ kind: "presented", viewport: result.viewport, canBack: result.canBack, canForward: result.canForward });
      } else {
        // Accepted only means queued; no native window or loaded page is claimed.
        // A fixture/unrecognized reply never preserves an apparently live pane.
        if (result.kind === "accepted") return;
        await close();
        if (generation === current + 1) publish({ kind: result.kind === "denied" ? "denied" : "unavailable" });
      }
    } catch {
      if (current !== generation) return;
      await close();
      if (generation === current + 1) publish({ kind: "unavailable" });
    }
  }
  return { state: () => state, command, close };
}
