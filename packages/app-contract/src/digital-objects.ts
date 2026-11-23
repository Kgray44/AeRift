import type { DeviceId, FileSelection, TransferId, TransferRequest } from "./v1.js";

export type ObjectId = string;
export type AssetId = string;
export type MediaKind = "file" | "photo" | "video";
export type TextFormat = "plain" | "markdown";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ReceivedProvenance {
  deviceId: DeviceId;
  transferId: TransferId;
  receivedAt: string;
}

type Ownership =
  | { ownership: "local" }
  | { ownership: "received"; provenance: ReceivedProvenance };

export type MediaPayload = {
  kind: MediaKind;
  sizeBytes: number;
  mediaType?: string;
  assetId?: AssetId;
};

export type DigitalObject = { schemaVersion: 1; id: ObjectId; name: string } & Ownership & (
  | MediaPayload
  | { kind: "text" | "note"; format: TextFormat; text: string }
  | { kind: "url"; url: string }
  | { kind: "clipboard"; objectId: ObjectId }
  | { kind: "collection"; itemIds: readonly ObjectId[] }
  | { kind: "structured"; namespace: string; version: number; value: JsonValue }
);

export type ObjectPresentation = Readonly<{
  label: string;
  icon: DigitalObject["kind"];
  preview: "file" | "image" | "video" | "text" | "link" | "summary";
}>;

const previewByKind = {
  file: "file", photo: "image", video: "video", text: "text", url: "link",
  note: "text", clipboard: "summary", collection: "summary", structured: "summary",
} as const satisfies Record<DigitalObject["kind"], ObjectPresentation["preview"]>;

export function getObjectPresentation(object: DigitalObject): ObjectPresentation {
  return { label: object.name, icon: object.kind, preview: previewByKind[object.kind] };
}

export interface ObjectSelection {
  readonly ids: readonly ObjectId[];
}

export interface ObjectRepository {
  get(id: ObjectId): Promise<DigitalObject | undefined>;
  put(object: DigitalObject): Promise<void>;
  remove(id: ObjectId): Promise<void>;
}

export type DestinationAction = "preview" | "save" | "import" | "open";
export interface ObjectDestination {
  availableActions(object: DigitalObject): readonly DestinationAction[];
  handle(object: DigitalObject, action: DestinationAction): Promise<void>;
}

/** Owned by the active native picker session. Persist only the object. */
export interface LegacySelectionBinding {
  readonly objectId: ObjectId;
  readonly selection: Readonly<FileSelection>;
}

export function importLegacySelection(id: ObjectId, selection: FileSelection, kind: MediaKind = "file") {
  const object: DigitalObject & MediaPayload = {
    schemaVersion: 1, id, kind, ownership: "local", name: selection.name, sizeBytes: selection.sizeBytes,
  };
  return { object, binding: { objectId: id, selection: { ...selection } } satisfies LegacySelectionBinding };
}

/** Produces a candidate. The native AppPort still validates picker state, trust and transfer permissions. */
export function createLegacyFileOffer(
  object: DigitalObject,
  binding: LegacySelectionBinding | undefined,
  deviceId: DeviceId,
): Extract<TransferRequest, { action: "offer" }> | undefined {
  if (!binding || object.id !== binding.objectId || object.ownership !== "local" ||
      !("sizeBytes" in object) || object.name !== binding.selection.name ||
      object.sizeBytes !== binding.selection.sizeBytes) {
    return undefined;
  }
  return { action: "offer", deviceId, selectionId: binding.selection.selectionId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safeInteger(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

function isWebUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

const payloadKeys = {
  file: ["sizeBytes", "mediaType", "assetId"],
  photo: ["sizeBytes", "mediaType", "assetId"],
  video: ["sizeBytes", "mediaType", "assetId"],
  text: ["format", "text"], note: ["format", "text"], url: ["url"],
  clipboard: ["objectId"], collection: ["itemIds"], structured: ["namespace", "version", "value"],
} as const satisfies Record<DigitalObject["kind"], readonly string[]>;

function isKind(value: unknown): value is DigitalObject["kind"] {
  return typeof value === "string" && Object.hasOwn(payloadKeys, value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function hasValidOwnership(value: Record<string, unknown>): boolean {
  if (value.ownership === "local") return !Object.hasOwn(value, "provenance");
  const p = value.provenance;
  return value.ownership === "received" && isRecord(p) &&
    hasOnlyKeys(p, ["deviceId", "transferId", "receivedAt"]) &&
    nonempty(p.deviceId) && nonempty(p.transferId) && nonempty(p.receivedAt) &&
    Number.isFinite(Date.parse(p.receivedAt));
}

/** Accept only a known object document. Structured values are inert JSON supplied by JSON.parse. */
export function decodeObject(serialized: string): DigitalObject | undefined {
  let value: unknown;
  try {
    value = JSON.parse(serialized, (_key, entry: unknown) => {
      if (typeof entry === "number" && !Number.isFinite(entry)) {
        throw new TypeError("AeRift object numbers must be finite");
      }
      return entry;
    });
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !nonempty(value.id) || !nonempty(value.name) ||
      !isKind(value.kind) || !hasValidOwnership(value) ||
      !hasOnlyKeys(value, ["schemaVersion", "id", "name", "kind", "ownership", "provenance", ...payloadKeys[value.kind]])) {
    return undefined;
  }

  if (!validPayload(value.kind, value)) return undefined;
  return value as DigitalObject;
}

function validPayload(kind: DigitalObject["kind"], value: Record<string, unknown>): boolean {
  switch (kind) {
    case "file":
    case "photo":
    case "video":
      return safeInteger(value.sizeBytes, 0) &&
        (value.mediaType === undefined || nonempty(value.mediaType)) &&
        (value.assetId === undefined || nonempty(value.assetId));
    case "text":
    case "note":
      return (value.format === "plain" || value.format === "markdown") && typeof value.text === "string";
    case "url":
      return isWebUrl(value.url);
    case "clipboard":
      return nonempty(value.objectId) && value.objectId !== value.id;
    case "collection":
      return Array.isArray(value.itemIds) && value.itemIds.every((id) => nonempty(id) && id !== value.id) &&
        new Set(value.itemIds).size === value.itemIds.length;
    case "structured":
      return typeof value.namespace === "string" && /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(value.namespace) &&
        safeInteger(value.version, 1) && Object.hasOwn(value, "value");
  }
}

export function serializeObject(object: DigitalObject): string {
  const serialized = JSON.stringify(object);
  if (!decodeObject(serialized)) throw new TypeError("Invalid AeRift object document");
  return serialized;
}
