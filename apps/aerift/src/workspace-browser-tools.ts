export interface WorkspaceBrowserHistory {
  enabled: boolean;
  items: readonly { url: string; openedAt: number }[];
}

export const workspaceBrowserHistoryLimit = 80;
export const workspaceBrowserHistoryEvent = "aerift:workspace-browser-history";
const maxAddressBytes = 4096;
const maxSearchLength = 500;
const maxHistoryJsonLength = workspaceBrowserHistoryLimit * (maxAddressBytes + 80) + 64;
const unsafeAddressCharacters = /[\u0000-\u0020\u007f\\]/u;
const bareDomain = /^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z\d](?:[a-z\d-]*[a-z\d])?(?::\d+)?(?:[/?#]|$)/iu;

export function workspaceBrowserDestination(input: string): string | undefined {
  const value = input.trim();
  if (!value || value.length > maxAddressBytes || unsafeAddressCharacters.test(value)) return;
  const candidate = /^https?:\/\//iu.test(value) ? value : bareDomain.test(value) ? `https://${value}` : undefined;
  if (!candidate || !/^https?:\/\/[^/?#]/iu.test(candidate)) return;
  if (candidate.slice(candidate.indexOf("//") + 2).split(/[/?#]/u, 1)[0]?.includes("@")) return;
  try {
    const url = new URL(candidate);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password) return;
    const href = url.href;
    if (href.length <= maxAddressBytes && new TextEncoder().encode(href).length <= maxAddressBytes) return href;
  } catch { /* The native launch receives only a well-formed web destination. */ }
}

export function workspaceBrowserSearch(input: string): string | undefined {
  const value = input.trim();
  if (!value || value.length > maxSearchLength || /[\u0000-\u001f\u007f]/u.test(value)
    || /\b[a-z][a-z\d+.-]*:\/\/|\b(?:javascript|data|file|blob|about|mailto):/iu.test(value)
    || bareDomain.test(value)) return;
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", value);
  return workspaceBrowserDestination(url.href);
}

function storageAddress(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^https?:\/\//iu.test(value)) return;
  const destination = workspaceBrowserDestination(value);
  if (!destination) return;
  const url = new URL(destination);
  url.search = "";
  url.hash = "";
  return url.href;
}

const emptyHistory: WorkspaceBrowserHistory = { enabled: false, items: [] };

export function decodeWorkspaceBrowserHistory(source: string | null): WorkspaceBrowserHistory {
  if (!source || source.length > maxHistoryJsonLength) return emptyHistory;
  try {
    const data: unknown = JSON.parse(source);
    if (!data || typeof data !== "object" || !("enabled" in data) || data.enabled !== true
      || !("items" in data) || !Array.isArray(data.items)) return emptyHistory;
    const items: { url: string; openedAt: number }[] = [];
    const seen = new Set<string>();
    for (const item of data.items.slice(0, workspaceBrowserHistoryLimit)) {
      if (!item || typeof item !== "object" || !Number.isSafeInteger(item.openedAt)
        || item.openedAt <= 0 || item.openedAt > 8_640_000_000_000_000) continue;
      const url = storageAddress(item.url);
      if (url && !seen.has(url)) {
        seen.add(url);
        items.push({ url, openedAt: item.openedAt });
      }
    }
    return { enabled: true, items };
  } catch { return emptyHistory; }
}

export function appendWorkspaceBrowserHistory(history: WorkspaceBrowserHistory, address: string, openedAt = Date.now()): WorkspaceBrowserHistory {
  if (!history.enabled) return history;
  const url = storageAddress(address);
  if (!url || !Number.isSafeInteger(openedAt) || openedAt <= 0 || openedAt > 8_640_000_000_000_000) return history;
  return { enabled: true, items: [{ url, openedAt }, ...history.items.filter(item => item.url !== url)].slice(0, workspaceBrowserHistoryLimit) };
}

type HistoryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(storage?: HistoryStorage) {
  return storage ?? window.localStorage;
}

export function readWorkspaceBrowserHistory(key: string, storage?: HistoryStorage): WorkspaceBrowserHistory {
  try { return decodeWorkspaceBrowserHistory(browserStorage(storage).getItem(key)); }
  catch { return emptyHistory; }
}

function publish(key: string, history: WorkspaceBrowserHistory, storage?: HistoryStorage): boolean {
  try {
    const target = browserStorage(storage);
    if (history.enabled) target.setItem(key, JSON.stringify(history));
    else target.removeItem(key);
    if (!storage && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(workspaceBrowserHistoryEvent, { detail: key }));
    }
    return true;
  } catch { return false; }
}

export function setWorkspaceBrowserHistory(key: string, enabled: boolean, storage?: HistoryStorage): boolean {
  return publish(key, enabled ? { enabled, items: readWorkspaceBrowserHistory(key, storage).items } : emptyHistory, storage);
}

export function clearWorkspaceBrowserHistory(key: string, storage?: HistoryStorage): boolean {
  return publish(key, { ...readWorkspaceBrowserHistory(key, storage), items: [] }, storage);
}

export function recordWorkspaceBrowserLaunch(key: string, address: string, storage?: HistoryStorage): boolean {
  const history = readWorkspaceBrowserHistory(key, storage);
  const next = appendWorkspaceBrowserHistory(history, address);
  return next === history || publish(key, next, storage);
}
