import { plan, qualify, snapshotDocument } from "./capture.mjs";

const MENU = "aerift-pickup";
const HOST = "com.aerift.ambient_browser";
let generation = 0;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => chrome.contextMenus.create({
    id: MENU, title: "Prepare AeRift pickup", contexts: ["selection", "link", "image", "audio", "video"],
    documentUrlPatterns: ["http://*/*", "https://*/*"],
  }));
});

async function capture(tab, target) {
  const current = ++generation;
  let status = "Unavailable";
  try {
    if (!qualify(tab) || (target && ((target.frameId ?? 0) !== 0 || target.editable === true || target.pageUrl !== tab.url))) return;
    const focused = await chrome.windows.getLastFocused();
    if (!focused.focused || focused.incognito !== false || focused.id !== tab.windowId
        || current !== generation) return;
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      func: snapshotDocument,
      injectImmediately: true,
    });
    const snapshot = plan(tab, frame, target);
    if (!snapshot || current !== generation) return;
    // activeTab persists across same-origin navigation. Qualify the document
    // identity explicitly again, and never scrape or reacquire on mismatch.
    const [same] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, documentIds: [frame.documentId] },
      func: () => location.href,
      injectImmediately: true,
    });
    const active = await chrome.tabs.get(tab.id);
    const stillFocused = await chrome.windows.getLastFocused();
    if (!same || same.frameId !== 0 || same.documentId !== frame.documentId || same.result !== tab.url
        || !qualify(active) || active.url !== tab.url || active.windowId !== tab.windowId
        || !stillFocused.focused || stillFocused.incognito !== false
        || stillFocused.id !== tab.windowId || current !== generation) return;
    const reply = await chrome.runtime.sendNativeMessage(HOST, snapshot);
    if (reply?.version === 1 && reply.status === "captured") status = "Snapshot validated; nothing sent";
  } catch {
    // Never log page data, selections, references, or native replies.
  } finally {
    if (current === generation && Number.isInteger(tab?.id)) {
      await chrome.action.setTitle({ tabId: tab.id, title: `AeRift: ${status}` }).catch(() => {});
    }
  }
}

chrome.action.onClicked.addListener((tab) => void capture(tab));
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU) void capture(tab, info);
});
