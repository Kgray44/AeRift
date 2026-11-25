export const workspaceNoteLimit = 24_000;

export type NoteFormat = "plain" | "markdown";
export type NoteFilter = { query: string; format: "any" | NoteFormat };
export type NoteMarkup = "bold" | "italic" | "heading" | "bullet" | "task" | "code";

export function matchesWorkspaceNote(note: { name: string; text: string; format: NoteFormat }, filter: NoteFilter) {
  if (filter.format !== "any" && filter.format !== note.format) return false;
  const parts = filter.query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const searchable = `${note.name}\n${note.text}`.toLocaleLowerCase();
  return parts.every(part => searchable.includes(part));
}

export function insertNoteMarkup(value: string, start: number, end: number, markup: NoteMarkup) {
  const boundedStart = Math.min(value.length, Math.max(0, start));
  const boundedEnd = Math.min(value.length, Math.max(boundedStart, end));
  const prefix = { heading: "## ", bullet: "- ", task: "- [ ] " } as const;
  if (markup === "heading" || markup === "bullet" || markup === "task") {
    const line = boundedStart === 0 ? 0 : value.lastIndexOf("\n", boundedStart - 1) + 1;
    const marker = prefix[markup];
    return {
      value: value.slice(0, line) + marker + value.slice(line),
      start: boundedStart + marker.length,
      end: boundedEnd + marker.length,
    };
  }
  const marker = markup === "bold" ? "**" : markup === "italic" ? "_" : "`";
  return {
    value: value.slice(0, boundedStart) + marker + value.slice(boundedStart, boundedEnd) + marker + value.slice(boundedEnd),
    start: boundedStart + marker.length,
    end: boundedEnd + marker.length,
  };
}

type NoteLine = { kind: "heading" | "done" | "task" | "bullet" | "code" | "text"; text: string };

// A deliberately small text-only preview; links and raw HTML are never interpreted.
export function notePreviewLines(value: string, markdown: boolean): NoteLine[] {
  if (!markdown) return [{ kind: "text", text: value }];
  let code = false;
  return value.split(/\r?\n/u).flatMap((line): NoteLine[] => {
    if (/^\s*```/u.test(line)) {
      code = !code;
      return [];
    }
    if (code) return [{ kind: "code", text: line }];
    const heading = /^#{1,6}\s+(.+)$/u.exec(line);
    if (heading) return [{ kind: "heading", text: heading[1] }];
    const task = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/u.exec(line);
    if (task) return [{ kind: task[1] === " " ? "task" : "done", text: task[2] }];
    const bullet = /^\s*[-*]\s+(.+)$/u.exec(line);
    if (bullet) return [{ kind: "bullet", text: bullet[1] }];
    return [{ kind: "text", text: line }];
  });
}

export function noteWordCount(value: string) {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

export function noteInlineParts(value: string) {
  const result: { kind: "text" | "bold" | "italic" | "code"; text: string }[] = [];
  let cursor = 0;
  for (const match of value.matchAll(/\*\*([^*\n]+)\*\*|_([^_\n]+)_|`([^`\n]+)`/gu)) {
    const at = match.index ?? cursor;
    if (at > cursor) result.push({ kind: "text", text: value.slice(cursor, at) });
    result.push(match[1] ? { kind: "bold", text: match[1] } : match[2] ? { kind: "italic", text: match[2] } : { kind: "code", text: match[3] });
    cursor = at + match[0].length;
  }
  if (cursor < value.length) result.push({ kind: "text", text: value.slice(cursor) });
  return result;
}
