export const documentPreviewBytes = 65_536;
const textExtensions = /\.(txt|text|md|csv|tsv|log)$/iu;

export function documentPreviewAvailable(name: string, size?: number) {
  return textExtensions.test(name) && (size === undefined ||
    (Number.isSafeInteger(size) && size >= 0 && size <= documentPreviewBytes));
}

// A conservative local read from an already-imported, caller-supplied Blob.
// No URLs, active content, HTML/Markdown interpreters or native shell access.
export async function readDocumentText(name: string, asset?: Blob): Promise<string | undefined> {
  if (!asset || !documentPreviewAvailable(name, asset.size)) return;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await asset.arrayBuffer());
    if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return text;
  } catch { /* No usable preview. */ }
}
