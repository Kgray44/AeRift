export type ReceivedActivityRow = {
  id: string;
  name: string;
  sizeBytes: number;
  receivedAt?: string;
  source?: string;
  note?: string;
};

// A display hint only, never authorization to preview or execute a file.
export function receivedFileKind(name: string) {
  const extension = /\.([a-z0-9]+)$/iu.exec(name)?.[1]?.toLowerCase() ?? "";
  if (/^(avif|bmp|gif|heic|heif|jpeg|jpg|png|tif|tiff|webp)$/u.test(extension)) return "Image";
  if (/^(avi|m4v|mkv|mov|mp4|mpeg|mpg|webm)$/u.test(extension)) return "Video";
  if (/^(aac|flac|m4a|mp3|ogg|opus|wav)$/u.test(extension)) return "Audio";
  if (/^(pdf|docx?|odt|rtf|epub|pages|pptx?|key|odp|xlsx?|ods|numbers|csv|tsv)$/u.test(extension)) return "Document";
  if (/^(md|text|txt)$/u.test(extension)) return "Text";
  if (/^(zip|7z|gz|tar)$/u.test(extension)) return "Archive";
  return "File";
}

export const receivedQueryLimit = 64;

export function findReceivedRows<T extends ReceivedActivityRow>(rows: readonly T[], query: string): T[] {
  const terms = query.slice(0, receivedQueryLimit).trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (!terms.length) return [...rows];
  return rows.filter(row => {
    const searchable = [row.name, receivedFileKind(row.name), row.source ?? ""].join(" ").toLocaleLowerCase();
    return terms.every(term => searchable.includes(term));
  });
}

// No guessed or display-only times are accepted. An explicit zone is required.
export function receivedTime(value: unknown): number | undefined {
  if (typeof value !== "string") return;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) return;
  const [, y, m, d, h, min, sec] = match;
  const [year, month, day, hour, minute, second] = [y, m, d, h, min, sec].map(Number);
  if (year < 1000 || month < 1 || month > 12 || day < 1 ||
      day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
      hour > 23 || minute > 59 || second > 59) return;
  const time = Date.parse(value);
  if (Number.isFinite(time)) return time;
}

export function groupReceivedTimeline<T extends ReceivedActivityRow>(rows: readonly T[]) {
  const dated: { row: T; time: number }[] = [];
  const undated: T[] = [];
  for (const row of rows) {
    const time = receivedTime(row.receivedAt);
    if (time === undefined) undated.push(row);
    else dated.push({ row, time });
  }
  return { dated: dated.sort((a, b) => b.time - a.time).map(entry => entry.row), undated };
}
