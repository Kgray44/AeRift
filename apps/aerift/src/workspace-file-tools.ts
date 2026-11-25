export const workspaceFileQueryLimit = 120;
const maxRecents = 8;
const historyKey = (scope: string) => `aerift.workspace.file-searches.v1:${scope}`;

export type WorkspaceFileKind = "file" | "document" | "photo" | "video" | "other";
export type WorkspaceFileFilter = Exclude<WorkspaceFileKind, "file"> | "all";
export type WorkspaceFileSort = "library" | "name" | "newest" | "largest" | "smallest";

export interface WorkspaceFileMetadata {
  name: string;
  sizeBytes?: number;
  mediaType?: string;
  kind?: WorkspaceFileKind;
  updatedAt?: string;
}

export interface WorkspaceFileOptions {
  query: string;
  kind: WorkspaceFileFilter;
  sort: WorkspaceFileSort;
}

type SearchStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function cleanQuery(value: string) {
  return value.slice(0, workspaceFileQueryLimit).replace(/[\s\u0000-\u001f\u007f]+/gu, " ").trim();
}

function fold(value: string) {
  return value.normalize("NFKC").toLowerCase();
}

function fileCategory(metadata: WorkspaceFileMetadata): Exclude<WorkspaceFileFilter, "all"> {
  if (metadata.kind && metadata.kind !== "file") return metadata.kind;
  const mime = metadata.mediaType?.toLowerCase() ?? "";
  if (mime.startsWith("image/") || /\.(avif|gif|heic|heif|jpeg|jpg|png|svg|tiff?|webp)$/iu.test(metadata.name)) return "photo";
  if (mime.startsWith("video/") || /\.(avi|m4v|mkv|mov|mp4|webm)$/iu.test(metadata.name)) return "video";
  return "other";
}

const nameOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareNumber(a: number | undefined, b: number | undefined, descending: boolean) {
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  return (a - b) * (descending ? -1 : 1);
}

function known(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function browseWorkspaceFiles<T>(
  entries: readonly T[],
  describe: (entry: T) => WorkspaceFileMetadata,
  options: WorkspaceFileOptions,
): T[] {
  const terms = fold(cleanQuery(options.query)).split(" ").filter(Boolean);
  const results = entries.map(entry => ({ entry, metadata: describe(entry) })).filter(({ metadata }) => {
    const kind = fileCategory(metadata);
    if (options.kind !== "all" && options.kind !== kind) return false;
    if (terms.length === 0) return true;
    const haystack = fold(`${metadata.name} ${metadata.mediaType ?? ""} ${kind}`);
    return terms.every(term => haystack.includes(term));
  });

  if (options.sort !== "library") {
    results.sort(({ metadata: a }, { metadata: b }) => {
      if (options.sort === "name") return nameOrder.compare(a.name, b.name);
      if (options.sort === "newest") return compareNumber(known(Date.parse(a.updatedAt ?? "")), known(Date.parse(b.updatedAt ?? "")), true);
      return compareNumber(known(a.sizeBytes), known(b.sizeBytes), options.sort === "largest");
    });
  }
  return results.map(({ entry }) => entry);
}

function distinctHistory(values: readonly unknown[]) {
  const knownQueries = new Set<string>();
  const history: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const query = cleanQuery(value);
    const key = fold(query);
    if (!query || knownQueries.has(key)) continue;
    knownQueries.add(key);
    history.push(query);
    if (history.length === maxRecents) break;
  }
  return history;
}

export function readWorkspaceFileSearches(storage: SearchStorage | undefined, scope: string) {
  try {
    const raw = storage?.getItem(historyKey(scope));
    if (!raw || raw.length > 16_384) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? distinctHistory(parsed) : [];
  } catch {
    return [];
  }
}

export function rememberWorkspaceFileSearch(storage: SearchStorage | undefined, scope: string, query: string, recent: readonly string[] = []) {
  const existing = distinctHistory([...recent, ...readWorkspaceFileSearches(storage, scope)]);
  if (!cleanQuery(query)) return existing;
  const next = distinctHistory([query, ...existing]);
  try { storage?.setItem(historyKey(scope), JSON.stringify(next)); } catch { /* Search is still available. */ }
  return next;
}

export function clearWorkspaceFileSearches(storage: SearchStorage | undefined, scope: string) {
  try {
    storage?.removeItem(historyKey(scope));
    return true;
  } catch {
    return false;
  }
}
