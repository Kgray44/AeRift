import type { FileSelection, Result } from "@aerift/app-contract";
import type { DigitalObject, MediaPayload } from "@aerift/app-contract/digital-objects";
import { command } from "../nativeAppPort";

export type MediaSource = "files" | "photos";
export type ImportedMedia = DigitalObject & MediaPayload & { ownership: "local"; assetId: string };
export type MediaAction = "preview" | "export";
type NativeImport = Pick<ImportedMedia, "id" | "name" | "kind" | "sizeBytes">;

export interface MobileMediaPort {
  list(): Promise<Result<readonly ImportedMedia[]>>;
  import(source: MediaSource): Promise<Result<readonly ImportedMedia[]>>;
  remove(assetId: string): Promise<Result<readonly ImportedMedia[]>>;
  select(assetId: string): Promise<Result<FileSelection | null>>;
  present(assetId: string, action: MediaAction): Promise<Result<void>>;
}

async function readImports(name: string, args?: Record<string, unknown>): Promise<Result<readonly ImportedMedia[]>> {
  const result = await command<NativeImport[]>(name, args);
  return result.ok ? { ok: true, value: result.value.map(item => ({
    ...item, assetId: item.id, schemaVersion: 1, ownership: "local",
  })) } : result;
}

export const nativeMobileMedia: MobileMediaPort = {
  list: () => readImports("list_ios_media"),
  import: source => readImports("import_ios_media", { source }),
  remove: assetId => readImports("remove_ios_media", { assetId }),
  select: assetId => command<FileSelection | null>("select_ios_media", { assetId }),
  present: (assetId, action) => command<void>("present_ios_media", { assetId, action }),
};
