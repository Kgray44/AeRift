import { Button } from "@aerift/ui";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { insertNoteMarkup, noteInlineParts, notePreviewLines, noteWordCount, workspaceNoteLimit,
  type NoteFilter, type NoteFormat, type NoteMarkup } from "./workspace-note-tools";

const tools: readonly [NoteMarkup, string][] = [
  ["bold", "Bold"], ["italic", "Italic"], ["heading", "Heading"], ["bullet", "Bullet"],
  ["task", "Checklist"], ["code", "Code"],
];

export function WorkspaceNoteSearch({ filter, onChange, count }: {
  filter: NoteFilter; onChange: (next: NoteFilter) => void; count: number;
}) {
  return <section className="ae-surface aw-note-search" data-material="control" aria-label="Find notes">
    <label>Search notes<input type="search" value={filter.query} maxLength={180} placeholder="Title or note content"
      onChange={event => onChange({ ...filter, query: event.currentTarget.value })} /></label>
    <label>Format<select value={filter.format}
      onChange={event => onChange({ ...filter, format: event.currentTarget.value as NoteFilter["format"] })}>
      <option value="any">All notes</option><option value="plain">Plain text</option><option value="markdown">Markdown</option>
    </select></label>
    <span role="status">{count} {count === 1 ? "note" : "notes"}</span>
  </section>;
}

function InlineNote({ text, markdown }: { text: string; markdown: boolean }) {
  return <>{markdown ? noteInlineParts(text).map((part, index) =>
    part.kind === "bold" ? <strong key={index}>{part.text}</strong> :
    part.kind === "italic" ? <em key={index}>{part.text}</em> :
    part.kind === "code" ? <code key={index}>{part.text}</code> : part.text) : text}</>;
}

export function WorkspaceNoteEditor({ value, format, disabled, onChange, onFormat }: {
  value: string; format: NoteFormat; disabled?: boolean;
  onChange: (value: string) => void; onFormat: (format: NoteFormat) => void;
}) {
  const field = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const restore = useRef<{ start: number; end: number } | null>(null);
  const [preview, setPreview] = useState(false);

  useLayoutEffect(() => {
    if (!restore.current || !input.current) return;
    const { start, end } = restore.current;
    restore.current = null;
    input.current.focus();
    input.current.setSelectionRange(start, end);
  }, [value]);

  function apply(markup: NoteMarkup) {
    const textarea = input.current;
    if (!textarea) return;
    const next = insertNoteMarkup(value, textarea.selectionStart, textarea.selectionEnd, markup);
    if (next.value.length > workspaceNoteLimit) return;
    restore.current = next;
    onFormat("markdown");
    onChange(next.value);
  }

  return <div className="aw-note-editor">
    <div className="ae-actions aw-note-toolbar" role="group" aria-label="Note formatting">
      {tools.map(([id, label]) => <Button key={id} type="button" variant="quiet" disabled={disabled || preview}
        onClick={() => apply(id)}>{label}</Button>)}
      <Button type="button" variant="quiet" aria-pressed={preview} onClick={() => setPreview(current => !current)}>
        {preview ? "Return to editor" : "Preview"}
      </Button>
    </div>
    <label htmlFor={field} hidden={preview}>Note</label>
    <textarea ref={input} id={field} name="text" value={value} rows={8} required={!preview} aria-label="Note"
      maxLength={workspaceNoteLimit} hidden={preview} disabled={disabled}
      onChange={event => onChange(event.currentTarget.value)} />
    {preview && <section className="ae-surface aw-note-preview" data-material="content" aria-label="Note preview">
      {value ? notePreviewLines(value, format === "markdown").map(({ kind, text }, index) =>
        kind === "heading" ? <h4 key={index}>{text}</h4> : kind === "code" ? <code key={index}>{text}</code> :
        <p key={index} data-note-line={kind}>{kind === "done" ? "✓ " : kind === "task" ? "☐ " : kind === "bullet" ? "• " : ""}<InlineNote text={text || "\u00a0"} markdown={format === "markdown"} /></p>)
        : <p>Nothing to preview yet.</p>}
    </section>}
    <div className="aw-note-footer">
      {format === "markdown" && <input type="hidden" name="noteMarkdown" value="yes" />}
      <Button type="button" variant="secondary" disabled={disabled} aria-pressed={format === "markdown"}
        onClick={() => onFormat(format === "markdown" ? "plain" : "markdown")}>Markdown</Button>
      <small>{noteWordCount(value)} words · {value.length.toLocaleString()} / {workspaceNoteLimit.toLocaleString()} characters</small>
    </div>
  </div>;
}

export function DesktopNoteEditor({ text = "", format = "plain", disabled }: {
  text?: string; format?: NoteFormat; disabled?: boolean;
}) {
  const [draft, setDraft] = useState(text);
  const [currentFormat, setFormat] = useState(format);
  return <WorkspaceNoteEditor value={draft} format={currentFormat} disabled={disabled}
    onChange={setDraft} onFormat={setFormat} />;
}
