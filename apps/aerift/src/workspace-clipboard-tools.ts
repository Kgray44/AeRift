export const clipboardQueryLimit = 180;

export interface ClipboardEntryDescription {
  name: string;
  text: string;
  format?: "plain" | "markdown";
}

export type ClipboardOptions = {
  query: string;
  format: "all" | "single-line" | "multiline" | "markdown";
  order: "saved" | "name" | "longest";
};

const lineBreak = /\r\n|[\r\n\u2028\u2029]/u;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function clipboardEntryDetails({ text, format }: Pick<ClipboardEntryDescription, "text" | "format">) {
  const trimmed = text.trim();
  return {
    format: format === "markdown" ? "Markdown" : "Plain text",
    lines: text ? text.split(lineBreak).length : 0,
    words: trimmed ? trimmed.split(/\s+/u).length : 0,
    characters: Array.from(text).length,
  };
}

export function browseClipboardEntries<T>(
  entries: readonly T[],
  describe: (entry: T) => ClipboardEntryDescription | undefined,
  options: ClipboardOptions,
): T[] {
  const terms = options.query.slice(0, clipboardQueryLimit).toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  const results = entries.flatMap((entry, index) => {
    const detail = describe(entry);
    // A dangling pin has no text to search or copy, but remains visible in the
    // unfiltered list so the owner can still remove it.
    if (!detail) return options.format === "all" && !terms.length ? [{ entry, index, detail }] : [];
    const multiline = lineBreak.test(detail.text);
    if (options.format === "multiline" && !multiline || options.format === "single-line" && multiline ||
      options.format === "markdown" && detail.format !== "markdown") return [];
    if (terms.length) {
      const searchable = `${detail.name}\n${detail.text}`.toLocaleLowerCase();
      if (!terms.every(term => searchable.includes(term))) return [];
    }
    return [{ entry, index, detail }];
  });
  if (options.order !== "saved") results.sort((a, b) => {
    if (!a.detail || !b.detail) return a.detail ? -1 : b.detail ? 1 : a.index - b.index;
    return (options.order === "name"
      ? collator.compare(a.detail.name, b.detail.name)
      : b.detail.text.length - a.detail.text.length) || a.index - b.index;
  });
  return results.map(({ entry }) => entry);
}

export type ClipboardWriter = (text: string) => Promise<void>;
export type ClipboardWriteResult = "copied" | "disabled" | "unavailable" | "denied" | "failed";

export async function writeWorkspaceClipboard(text: string, allowed: boolean, writer?: ClipboardWriter): Promise<ClipboardWriteResult> {
  if (!allowed) return "disabled";
  if (!writer) return "unavailable";
  try {
    await writer(text);
    return "copied";
  } catch (error) {
    const name = typeof error === "object" && error !== null && "name" in error ? error.name : undefined;
    if (name === "NotAllowedError" || name === "SecurityError") return "denied";
    return name === "NotSupportedError" ? "unavailable" : "failed";
  }
}
