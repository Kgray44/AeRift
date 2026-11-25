import type { FileSelection, Result } from "@aerift/app-contract";
import type { BrowserLink } from "./local-objects";
import type { ImportedMedia, MediaAction, MediaSource, MobileMediaPort } from "./mobile-media";

export type MobilePlatform = "ios" | "android";
export type ReceivedCopy = { id: string; name: string; sizeBytes: number };
type InvokeCommand = <T>(name: string, args?: Record<string, unknown>) => Promise<Result<T>>;
type NativeImport = Pick<ImportedMedia, "id" | "name" | "kind" | "sizeBytes">;

export function mobileStorageKeys(platform: MobilePlatform) {
  const owner = `aerift.${platform}`;
  return {
    appearance: `${owner}.appearance.v1`, workspace: `${owner}.workspace.v1`,
    gestures: `${owner}.gestures.enabled`, history: `${owner}.activity.v1`,
    objects: `${owner}.objects.v1`, noteAttachments: `${owner}.note-attachments.v1`,
  };
}

export function createMobileOperations(platform: MobilePlatform, call: InvokeCommand) {
  async function readImports(name: string, args?: Record<string, unknown>): Promise<Result<readonly ImportedMedia[]>> {
    const result = await call<NativeImport[]>(name, args);
    return result.ok ? { ok: true, value: result.value.map(item => ({
      ...item, assetId: item.id, schemaVersion: 1, ownership: "local",
    })) } : result;
  }
  const media: MobileMediaPort = {
    list: () => readImports(`list_${platform}_media`),
    import: source => readImports(`import_${platform}_media`, { source }),
    remove: assetId => readImports(`remove_${platform}_media`, { assetId }),
    select: assetId => call<FileSelection | null>(`select_${platform}_media`, { assetId }),
    present: (assetId, action) => call<void>(`present_${platform}_media`, { assetId, action }),
  };
  return {
    media,
    pick: (source: MediaSource) => call<FileSelection | null>("select_app_file", { source }),
    retryDiscovery: () => call<void>(`retry_${platform}_discovery`),
    presentSelection: (selectionId: string, action: MediaAction) => call<void>(`present_${platform}_selection`, { selectionId, action }),
    listReceived: platform === "android" ? () => call<readonly ReceivedCopy[]>("list_android_received") : undefined,
    previewReceivedText: platform === "ios" ? (receiptId: string) =>
      call<string | null>("preview_ios_received_text", { receiptId }) : undefined,
    presentReceived: platform === "android" ? (transferId: string, action: "preview" | "share") =>
      call<void>("present_android_received", { transferId, action }) : undefined,
    clipboardImageAvailable: () => call<boolean>(`${platform}_clipboard_image_available`),
    stageClipboardImage: () => call<FileSelection | null>(`stage_${platform}_clipboard_image`),
    stageText: (payload: Record<string, unknown>) => call<FileSelection | null>(`stage_${platform}_text`, payload),
    openBrowser: (url: string) => call<BrowserLink[]>(`open_${platform}_browser`, { url }),
  };
}

export type MobileOperations = ReturnType<typeof createMobileOperations>;

export const mobilePlatformCopy = {
  ios: {
    device: "this iPhone",
    discoveryMessage: "Allow Local Network access in iOS Settings to find AeRift devices nearby.",
    cameraDenied: "Allow camera access for AeRift in iOS Settings, then return to Rift.",
    fileSources: "Browse Files, cloud providers and On My iPhone.",
    receivedFolder: "Files → On My iPhone → AeRift → Received",
    receivedTip: "Open the AeRift Received folder under On My iPhone in Files.",
    previewer: "Quick Look",
    clipboardImageUnavailable: "Image paste requires iOS 16 or later.",
    browserTip: "In the in-app browser, choose Share → Collect in AeRift, then Done. You can also enter an address here.",
  },
  android: {
    device: "this Android device",
    discoveryMessage: "Check Wi-Fi or nearby access for AeRift in Android Settings, then retry discovery.",
    cameraDenied: "Allow camera access for AeRift in Android app settings, then return to Rift.",
    fileSources: "Browse local storage, downloads and supported cloud providers.",
    receivedFolder: "AeRift’s Received storage",
    receivedTip: "Use AeRift’s Received list to find files saved on this Android device.",
    previewer: "Your file viewer",
    clipboardImageUnavailable: "Copy a non-sensitive image in another app, then return here to paste it.",
    browserTip: "In a supported browser tab, choose menu → Collect in AeRift, then close the tab. You can also save an address here.",
  },
} as const;

export type MobilePlatformCopy = typeof mobilePlatformCopy[MobilePlatform];
