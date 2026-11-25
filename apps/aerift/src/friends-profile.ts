export const AVATAR_COLORS = ["violet", "blue", "mint", "coral", "gold", "slate"] as const;
export const AVATAR_GLASS = ["prism", "reef", "opal", "ember", "moon", "ripple"] as const;
export type ProfileAvatar = { kind: "initials" } | { kind: "color"; value: typeof AVATAR_COLORS[number] } |
  { kind: "glass"; value: typeof AVATAR_GLASS[number] } | { kind: "photo"; value: string };
export type FriendPresentation = { localName: string; nickname: string; avatar: ProfileAvatar };
export type ProfileStorage = Pick<Storage, "getItem" | "setItem">;
type Profiles = { self: FriendPresentation; people: Record<string, FriendPresentation> };

export const PROFILE_LABEL_LIMIT = 64;
export const AVATAR_FILE_LIMIT = 8 * 1024 * 1024;
export const AVATAR_SIZE = 192;
const AVATAR_DATA_LIMIT = 64 * 1024;
const MAX_PROFILES = 300;
const RECORD_LIMIT = 2_500_000;
const KEY = "aerift.friends-presentation.v1";
const JPEG_PREFIX = "data:image/jpeg;base64,";
const validKey = (key: string) => /^[a-z0-9_-]{1,128}$/i.test(key) && !["constructor", "prototype", "__proto__", "self"].includes(key);

export function emptyPresentation(): FriendPresentation {
  return { localName: "", nickname: "", avatar: { kind: "initials" } };
}
export function emptyFriendProfiles(): Profiles {
  return { self: emptyPresentation(), people: Object.create(null) as Profiles["people"] };
}
function label(value: unknown) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "").trim().slice(0, PROFILE_LABEL_LIMIT)
    : "";
}
function cleanAvatar(value: unknown): ProfileAvatar {
  if (value && typeof value === "object" && "kind" in value && "value" in value) {
    if (value.kind === "color" && AVATAR_COLORS.includes(value.value as typeof AVATAR_COLORS[number]))
      return { kind: "color", value: value.value as typeof AVATAR_COLORS[number] };
    if (value.kind === "glass" && AVATAR_GLASS.includes(value.value as typeof AVATAR_GLASS[number]))
      return { kind: "glass", value: value.value as typeof AVATAR_GLASS[number] };
    if (value.kind === "photo" && typeof value.value === "string" && value.value.length <= AVATAR_DATA_LIMIT &&
        value.value.startsWith(JPEG_PREFIX) && /^[A-Za-z0-9+/]+={0,2}$/.test(value.value.slice(JPEG_PREFIX.length))) {
      try {
        const encoded = value.value.slice(JPEG_PREFIX.length);
        const image = imageHeader(Uint8Array.from(atob(encoded), char => char.charCodeAt(0)));
        if (image?.type === "image/jpeg" && image.width === AVATAR_SIZE && image.height === AVATAR_SIZE)
          return { kind: "photo", value: value.value };
      } catch { /* Malformed persisted photos are ignored. */ }
    }
  }
  return { kind: "initials" };
}
function cleanPresentation(value: unknown): FriendPresentation {
  if (!value || typeof value !== "object") return emptyPresentation();
  const candidate = value as Partial<FriendPresentation>;
  return { localName: label(candidate.localName), nickname: label(candidate.nickname), avatar: cleanAvatar(candidate.avatar) };
}
function isEmpty(value: FriendPresentation) {
  return !value.localName && !value.nickname && value.avatar.kind === "initials";
}
export function readFriendProfiles(store: ProfileStorage): Profiles {
  const raw = store.getItem(KEY);
  const result = emptyFriendProfiles();
  if (!raw || raw.length > RECORD_LIMIT) return result;
  try {
    const decoded = JSON.parse(raw) as Partial<Profiles> | null;
    result.self = cleanPresentation(decoded?.self);
    if (decoded?.people && typeof decoded.people === "object") {
      for (const [key, value] of Object.entries(decoded.people).slice(0, MAX_PROFILES)) {
        if (!validKey(key)) continue;
        const profile = cleanPresentation(value);
        if (!isEmpty(profile)) result.people[key] = profile;
      }
    }
  } catch { /* An invalid copy is never turned into an account or a verified profile. */ }
  return result;
}
export function saveFriendPresentation(store: ProfileStorage, key: string, value: FriendPresentation): Profiles {
  const all = readFriendProfiles(store);
  const clean = cleanPresentation(value);
  if (value.avatar.kind === "photo" && clean.avatar.kind !== "photo") throw Error("The picture could not be saved.");
  if (key === "self") all.self = clean;
  else if (!validKey(key)) throw Error("This friendship cannot be edited.");
  else if (isEmpty(clean)) delete all.people[key];
  else all.people[key] = clean;
  const serialized = JSON.stringify(all);
  if (serialized.length > RECORD_LIMIT || Object.keys(all.people).length > MAX_PROFILES)
    throw Error("Your local profile storage is full. Remove a saved picture and try again.");
  store.setItem(KEY, serialized);
  return all;
}
export function friendDisplayName(verifiedName: string, local?: FriendPresentation): string {
  return local?.nickname || local?.localName || verifiedName;
}

type Raster = { type: "image/png" | "image/jpeg" | "image/webp"; width: number; height: number };
function admitted(type: Raster["type"], width: number, height: number): Raster | undefined {
  return width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 12_000_000
    ? { type, width, height } : undefined;
}
export function imageHeader(bytes: Uint8Array): Raster | undefined {
  if (bytes.length < 20) return;
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const b = (i: number) => d.getUint8(i);
  const u24 = (i: number) => b(i) + b(i + 1) * 256 + b(i + 2) * 65536;
  if (bytes.length >= 29 && d.getUint32(0) === 0x89504e47 && d.getUint32(4) === 0x0d0a1a0a &&
      d.getUint32(8) === 13 && d.getUint32(12) === 0x49484452) {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = d.getUint32(offset);
      const chunk = d.getUint32(offset + 4);
      if (chunk === 0x6163544c) return; // APNG
      if (chunk === 0x49444154) break;
      if (length > bytes.length - offset - 12) return;
      offset += length + 12;
    }
    return admitted("image/png", d.getUint32(16), d.getUint32(20));
  }
  if (b(0) === 0xff && b(1) === 0xd8) {
    const frameMarkers = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf];
    let dimensions: Raster | undefined;
    for (let at = 2; at + 4 < bytes.length;) {
      if (b(at++) !== 0xff) return;
      while (at < bytes.length && b(at) === 0xff) at++;
      if (at + 2 >= bytes.length) return;
      const marker = b(at++);
      if (marker === 0xd9) return;
      const n = d.getUint16(at);
      if (n < 2 || at + n > bytes.length) return;
      if (marker === 0xda) return dimensions;
      if (frameMarkers.includes(marker)) {
        if (dimensions || n < 8) return;
        dimensions = admitted("image/jpeg", d.getUint16(at + 5), d.getUint16(at + 3));
        if (!dimensions) return;
      }
      at += n;
    }
  }
  if (bytes.length >= 30 && d.getUint32(0) === 0x52494646 && d.getUint32(8) === 0x57454250 &&
      d.getUint32(4, true) + 8 === bytes.length) {
    let canvas: Raster | undefined;
    let image: Raster | undefined;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const size = d.getUint32(offset + 4, true);
      const start = offset + 8;
      const end = start + size + (size & 1);
      if (end > bytes.length) return;
      switch (d.getUint32(offset)) {
        case 0x414e494d: // ANIM
        case 0x414e4d46: // ANMF
          return;
        case 0x56503858: // VP8X
          if (offset !== 12 || size !== 10 || (b(start) & 2) !== 0) return;
          canvas = admitted("image/webp", 1 + u24(start + 4), 1 + u24(start + 7));
          if (!canvas) return;
          break;
        case 0x5650384c: { // VP8L
          if (image || size < 5 || b(start) !== 0x2f) return;
          const packed = d.getUint32(start + 1, true);
          image = admitted("image/webp", (packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
          if (!image) return;
          break;
        }
        case 0x56503820: // VP8
          if (image || size < 10 || b(start + 3) !== 0x9d || b(start + 4) !== 1 || b(start + 5) !== 0x2a) return;
          image = admitted("image/webp", d.getUint16(start + 6, true) & 0x3fff, d.getUint16(start + 8, true) & 0x3fff);
          if (!image) return;
      }
      offset = end;
    }
    if (!canvas || (image && canvas.width === image.width && canvas.height === image.height)) return image;
  }
}

/** Render through a local blob URL; do not widen the app's image CSP. */
export function profilePhotoBlob(value: string): Blob | undefined {
  const admitted = cleanAvatar({ kind: "photo", value });
  if (admitted.kind !== "photo") return;
  return new Blob([Uint8Array.from(atob(admitted.value.slice(JPEG_PREFIX.length)), char => char.charCodeAt(0))], { type: "image/jpeg" });
}

export async function prepareProfilePhoto(file: Blob): Promise<ProfileAvatar> {
  if (!file.size || file.size > AVATAR_FILE_LIMIT)
    throw Error("Choose a PNG, JPEG, or WebP picture under 8 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const meta = imageHeader(bytes);
  if (!meta) throw Error("Choose a still PNG, JPEG, or WebP picture up to 4096 pixels per side (12 megapixels).");
  const url = URL.createObjectURL(new Blob([bytes], { type: meta.type }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (!admitted(meta.type, img.naturalWidth, img.naturalHeight))
      throw Error("The picture is too large.");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = AVATAR_SIZE;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw Error("This device couldn't resize the picture.");
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    context.fillStyle = "#162037";
    context.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    context.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2,
      side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    const output = canvas.toDataURL("image/jpeg", .83);
    const result = cleanAvatar({ kind: "photo", value: output });
    if (result.kind !== "photo") throw Error("This device couldn't prepare the picture.");
    return result;
  } catch {
    throw Error("Couldn't prepare this picture. Choose a different PNG, JPEG, or WebP and try again.");
  } finally {
    URL.revokeObjectURL(url);
  }
}
