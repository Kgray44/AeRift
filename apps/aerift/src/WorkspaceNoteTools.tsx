import { Button, GlassSurface } from "@aerift/ui";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { insertNoteMarkup, noteInlineParts, notePreviewLines, noteWordCount, workspaceNoteLimit,
  type NoteFilter, type NoteFormat, type NoteMarkup } from "./workspace-note-tools";

const tools: readonly [NoteMarkup, string][] = [
  ["bold", "Bold"], ["italic", "Italic"], ["heading", "Heading"], ["bullet", "Bullet"],
  ["task", "Checklist"], ["code", "Code"],
];

const noteIcons = {
  bold: <path d="M7 4h6a4 4 0 0 1 0 8H7m7 0a4 4 0 0 1 0 8H7V4" />,
  italic: <path d="M13 4h7M4 20h7m-5 0 10-16" />,
  heading: <path d="M5 4v16M19 4v16M5 12h14" />,
  bullet: <><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4" cy="6" r=".7" /><circle cx="4" cy="12" r=".7" /><circle cx="4" cy="18" r=".7" /></>,
  task: <><rect x="3" y="5" width="5" height="5" rx="1" /><path d="M4 7.5 5.5 9 8 6m3 1h10M11 17h10" /><rect x="3" y="14.5" width="5" height="5" rx="1" /></>,
  code: <path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16" />,
  preview: <><path d="M2 12s3.6-6.4 10-6.4 10 6.4 10 6.4-3.6 6.4-10 6.4S2 12 2 12Z" /><circle cx="12" cy="12" r="2.4" /></>,
  edit: <path d="m3 21 5-.9L21 7l-4-4L4 16l-1 5ZM14 6l4 4" />,
  markdown: <path d="M3 7h18v10H3zm3 7v-4l2 2 2-2v4m3-2h5m-2-2 2 2-2 2" />,
  save: <path d="M4 4h13l3 3v13H4V4Zm4 0v6h8V4M8 20v-6h8v6" />,
  trash: <path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  send: <path d="m3 10 18-7-7 18-3-8Zm8 3L21 3" />,
  folder: <path d="M3 7h6l2 2h10v11H3V7Z" />,
} as const;

type NoteIconName = keyof typeof noteIcons;
export function NoteIconButton({ label, icon, ...props }: Omit<React.ComponentProps<typeof Button>, "children" | "aria-label" | "title"> & {
  label: string; icon: NoteIconName;
}) {
  return <Button variant="quiet" {...props} className={`ae-icon-action aw-note-tool ${props.className ?? ""}`}
    title={label} aria-label={label} loadingLabel="">
    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.65"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{noteIcons[icon]}</svg>
  </Button>;
}

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

export function WorkspaceNoteEditor({ value, format, disabled, onChange, onFormat, actions }: {
  value: string; format: NoteFormat; disabled?: boolean; actions?: ReactNode;
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
    <div className="aw-note-canvas">
      <GlassSurface className="ae-actions aw-note-toolbar aw-note-palette" material="control" role="group" aria-label="Note tools">
        {tools.map(([id, label]) => <NoteIconButton key={id} type="button" icon={id} label={label} disabled={disabled || preview}
          onPointerDown={event => event.preventDefault()} onClick={() => apply(id)} />)}
        <NoteIconButton type="button" icon={preview ? "edit" : "preview"} label={preview ? "Return to editor" : "Preview"}
          aria-pressed={preview} onClick={() => setPreview(current => !current)} />
        <NoteIconButton type="button" icon="markdown" label="Markdown" disabled={disabled} aria-pressed={format === "markdown"}
          onClick={() => onFormat(format === "markdown" ? "plain" : "markdown")} />
        {actions}
      </GlassSurface>
      <label htmlFor={field} className="ae-note-sidebar-visually-hidden" hidden={preview}>Note</label>
      <textarea ref={input} id={field} name="text" value={value} rows={8} required={!preview} aria-label="Note"
        maxLength={workspaceNoteLimit} hidden={preview} disabled={disabled}
        onChange={event => onChange(event.currentTarget.value)} />
      {preview && <section className="ae-surface aw-note-preview" data-material="content" aria-label="Note preview">
        {value ? notePreviewLines(value, format === "markdown").map(({ kind, text }, index) =>
          kind === "heading" ? <h4 key={index}>{text}</h4> : kind === "code" ? <code key={index}>{text}</code> :
          <p key={index} data-note-line={kind}>{kind === "done" ? "✓ " : kind === "task" ? "☐ " : kind === "bullet" ? "• " : ""}<InlineNote text={text || "\u00a0"} markdown={format === "markdown"} /></p>)
          : <p>Nothing to preview yet.</p>}
      </section>}
    </div>
    <div className="aw-note-footer">
      {format === "markdown" && <input type="hidden" name="noteMarkdown" value="yes" />}
      <small>{noteWordCount(value)} words · {value.length.toLocaleString()} / {workspaceNoteLimit.toLocaleString()} characters</small>
    </div>
  </div>;
}
