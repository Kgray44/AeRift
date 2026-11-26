import type { FileSelection, Result } from "@aerift/app-contract";
import type { DigitalObject, MediaPayload } from "@aerift/app-contract/digital-objects";

export type MediaSource = "files" | "photos";
export type ImportedMedia = DigitalObject & MediaPayload & { ownership: "local"; assetId: string };
export type MediaAction = "preview" | "export";

export interface MobileMediaPort {
  list(): Promise<Result<readonly ImportedMedia[]>>;
  import(source: MediaSource): Promise<Result<readonly ImportedMedia[]>>;
  remove(assetId: string): Promise<Result<readonly ImportedMedia[]>>;
  select(assetId: string): Promise<Result<FileSelection | null>>;
  thumbnail?(assetId: string): Promise<Result<string>>;
  present(assetId: string, action: MediaAction): Promise<Result<void>>;
}
