import { Button, GlassSurface } from "@aerift/ui";
import { useId, useRef, useState } from "react";
import {
  browseClipboardEntries, clipboardEntryDetails, clipboardQueryLimit, writeWorkspaceClipboard,
  type ClipboardEntryDescription, type ClipboardOptions, type ClipboardWriteResult, type ClipboardWriter,
} from "./workspace-clipboard-tools";

const defaults: ClipboardOptions = { query: "", format: "all", order: "saved" };

function systemWriter(): ClipboardWriter | undefined {
  try {
    const clipboard = globalThis.navigator?.clipboard;
    return typeof clipboard?.writeText === "function" ? text => clipboard.writeText(text) : undefined;
  } catch {
    return undefined;
  }
}

const resultMessages: Record<ClipboardWriteResult, string> = {
  copied: "Copied to the system clipboard.",
  disabled: "Clipboard actions are off in settings.",
  unavailable: "System clipboard copy is unavailable here.",
  denied: "The system denied clipboard access.",
  failed: "Could not copy this pin. Try again.",
};

export function useWorkspaceClipboardTools({ copyAllowed, writer }: {
  copyAllowed: boolean; writer?: ClipboardWriter;
}) {
  const [options, setOptions] = useState<ClipboardOptions>(defaults);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ClipboardWriteResult>();
  const writing = useRef(false);
  const revision = useRef(0);

  // Owners with persistent mounts may call this when leaving Clipboard.
  function reset() {
    revision.current++;
    setOptions(defaults);
    setResult(undefined);
  }

  async function copy(text: string) {
    if (writing.current) return;
    const at = revision.current;
    writing.current = true;
    setBusy(true);
    setResult(undefined);
    try {
      // Call the platform writer synchronously from the click path, before any
      // await that could consume the browser's transient user activation.
      const outcome = await writeWorkspaceClipboard(text, copyAllowed, copyAllowed ? writer ?? systemWriter() : undefined);
      if (at === revision.current) setResult(outcome);
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }

  return {
    options, copyAllowed, busy, result,
    reset,
    update: (next: Partial<ClipboardOptions>) => setOptions(previous => ({ ...previous, ...next })),
    browse<T>(entries: readonly T[], describe: (entry: T) => ClipboardEntryDescription | undefined) {
      return browseClipboardEntries(entries, describe, options);
    },
    copy,
  };
}

export function WorkspaceClipboardTools({ tools, count, total }: {
  tools: ReturnType<typeof useWorkspaceClipboardTools>; count: number; total: number;
}) {
  const id = useId();
  return <GlassSurface material="content" className="aw-file-tools aw-clipboard-tools">
    <section aria-labelledby={id}>
      <h4 id={id}>Pinned clipboard</h4>
      <div className="ae-actions">
        <label>Search pinned text
          <input type="search" maxLength={clipboardQueryLimit} autoComplete="off" spellCheck={false}
            data-ae-lens-role="control" value={tools.options.query}
            onChange={event => tools.update({ query: event.currentTarget.value })} />
        </label>
        <label>Format
          <select data-ae-lens-role="control" value={tools.options.format}
            onChange={event => tools.update({ format: event.currentTarget.value as ClipboardOptions["format"] })}>
            <option value="all">All text</option>
            <option value="single-line">Single line</option>
            <option value="multiline">Multiple lines</option>
            <option value="markdown">Markdown</option>
          </select>
        </label>
        <label>Order
          <select data-ae-lens-role="control" value={tools.options.order}
            onChange={event => tools.update({ order: event.currentTarget.value as ClipboardOptions["order"] })}>
            <option value="saved">Saved order</option>
            <option value="name">Name</option>
            <option value="longest">Longest text</option>
          </select>
        </label>
        {(tools.options.query || tools.options.format !== "all" || tools.options.order !== "saved") &&
          <Button variant="quiet" type="button" onClick={tools.reset}>Reset clipboard filters</Button>}
      </div>
      <small role="status">{count} of {total} {total === 1 ? "pin" : "pins"}</small>
      {total > 0 && count === 0 && <p>No pins match your filters.</p>}
      {tools.result && <p role="status">{resultMessages[tools.result]}</p>}
    </section>
  </GlassSurface>;
}

export function WorkspaceClipboardCopy({ tools, name, text }: {
  tools: ReturnType<typeof useWorkspaceClipboardTools>; name: string; text: string;
}) {
  return <Button type="button" variant="quiet" disabled={!tools.copyAllowed || tools.busy}
    aria-label={`Copy ${name} to the clipboard`} onClick={() => void tools.copy(text)}>Copy text</Button>;
}

export function WorkspaceClipboardDetails({ text, format }: Pick<ClipboardEntryDescription, "text" | "format">) {
  const details = clipboardEntryDetails({ text, format });
  return <small>{details.format} · {details.lines} {details.lines === 1 ? "line" : "lines"} · {details.words} {details.words === 1 ? "word" : "words"}</small>;
}
