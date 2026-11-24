const maxSelectionBytes = 16 * 1024;
const maxUrlBytes = 2048;
const encoder = new TextEncoder();

function webUrl(value) {
  if (typeof value !== "string" || value.length > maxUrlBytes) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function reference(value) {
  const url = webUrl(value);
  if (!url) return null;
  url.search = "";
  url.hash = "";
  return encoder.encode(url.href).length <= maxUrlBytes ? url.href : null;
}

export function qualify(tab) {
  return tab?.incognito === false && tab.active === true && Number.isInteger(tab.id)
    && webUrl(tab.url) !== null;
}

export function plan(tab, frame, target) {
  if (!qualify(tab) || frame?.frameId !== 0 || !frame.documentId || frame.result?.url !== tab.url
      || frame.result.sensitive || (target && (target.frameId ?? 0) !== 0)) return null;
  const selection = frame.result.selection;
  if (selection) {
    if (typeof selection !== "string" || selection.length > maxSelectionBytes
        || encoder.encode(selection).length > maxSelectionBytes || selection.includes("\0")) return null;
    return { version: 1, kind: "selection", value: selection };
  }
  for (const [kind, value] of [
    ["target", target?.linkUrl ?? target?.srcUrl],
    ["media", frame.result.media],
    ["page", frame.result.url],
  ]) {
    if (!value) continue;
    const url = reference(value);
    return url !== null ? { version: 1, kind, value: url } : null;
  }
  return null;
}

// Runs once in the isolated world after an explicit action and only in frame 0.
// Do not close over extension state: Chrome serializes this function.
export function snapshotDocument() {
  const url = location.href;
  const sensitiveElement = (node) => (node?.nodeType === 1 ? node : node?.parentElement)
    ?.closest("input, textarea, select, [contenteditable], [role='textbox'], [role='combobox'], iframe");
  if (sensitiveElement(document.activeElement)) return { url, sensitive: true };

  const choice = document.getSelection();
  let selection;
  if (choice && !choice.isCollapsed) {
    if (choice.rangeCount !== 1 || sensitiveElement(choice.anchorNode) || sensitiveElement(choice.focusNode)) {
      return { url, sensitive: true };
    }
    const range = choice.getRangeAt(0);
    // Only read an explicit range inside one ordinary text node. Do not walk an
    // unbounded document or accidentally include an intervening editable node.
    if (range.startContainer !== range.endContainer || range.startContainer.nodeType !== 3
        || range.endOffset - range.startOffset > 16384) return { url, sensitive: true };
    if (range.startContainer.getRootNode() !== document) return { url, sensitive: true };
    selection = range.startContainer.substringData(range.startOffset, range.endOffset - range.startOffset);
  }
  let media;
  if (document.activeElement instanceof HTMLMediaElement) {
    media = document.activeElement.currentSrc || document.activeElement.src;
  }
  return { url, selection, media };
}
