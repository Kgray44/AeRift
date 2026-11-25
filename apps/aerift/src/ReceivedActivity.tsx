import { Button, GlassSurface, IconAction, SpatialIcon } from "@aerift/ui";
import { useId, useRef, useState, type ReactNode } from "react";
import {
  findReceivedRows, groupReceivedTimeline, receivedFileKind, receivedQueryLimit, receivedTime,
  type ReceivedActivityRow,
} from "./received-activity";
import "./received-activity.css";

const firstPageSize = 36;
const timelineSize = 12;
const formatDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export interface ReceivedActivityProps<Row extends ReceivedActivityRow> {
  rows: readonly Row[];
  timelineRows?: readonly Row[];
  title?: string;
  loading?: boolean;
  error?: string;
  truncated?: boolean;
  disabled?: boolean;
  onSearch?: (query: string) => void;
  onRefresh?: () => void;
  canOpen?: (row: Row) => boolean;
  canPreview?: (row: Row) => boolean;
  onOpen?: (row: Row) => boolean | Promise<boolean>;
  onPreview?: (row: Row) => boolean | Promise<boolean>;
  renderActions?: (row: Row) => ReactNode;
  renderPreview?: (row: Row) => ReactNode;
  children?: ReactNode;
}

function ReceiptTime({ item }: { item: ReceivedActivityRow }) {
  const time = receivedTime(item.receivedAt);
  return time === undefined ? <span>Receipt time unavailable</span> :
    <time dateTime={new Date(time).toISOString()}>{formatDate.format(time)}</time>;
}

function safeBytes(value: number) {
  return Number.isSafeInteger(value) && value >= 0 ? `${value.toLocaleString()} bytes` : "Size unavailable";
}

export function ReceivedActivity<Row extends ReceivedActivityRow>({
  rows, timelineRows, title = "Received files", loading = false, error, truncated, disabled,
  onSearch, onRefresh, canOpen, canPreview, onOpen, onPreview, renderActions, renderPreview, children,
}: ReceivedActivityProps<Row>) {
  const heading = useId();
  const detailHeading = useId();
  const timelineHeading = useId();
  const detail = useRef<HTMLElement>(null);
  const lastTrigger = useRef<HTMLElement | null>(null);
  const actionRunning = useRef(false);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [pageSize, setPageSize] = useState(firstPageSize);
  const [action, setAction] = useState<"open" | "preview">();
  const [notice, setNotice] = useState<{ id: string; text: string; failed: boolean }>();
  const libraryQuery = onSearch ? submitted : query;
  const result = groupReceivedTimeline(onSearch ? rows : findReceivedRows(rows, libraryQuery));
  const ordered = [...result.dated, ...result.undated];
  const timeline = groupReceivedTimeline(timelineRows ?? rows);
  const selected = ordered.find(row => row.id === selectedId) ?? timelineRows?.find(row => row.id === selectedId);
  const controlsDisabled = disabled || actionRunning.current;
  const previewContent = selected ? renderPreview?.(selected) : undefined;
  const allowOpen = !!selected && !!onOpen && (!canOpen || canOpen(selected));
  const allowPreview = !!selected && !!onPreview && (!canPreview || canPreview(selected));

  function selectRow(row: Row, trigger: HTMLElement) {
    setSelectedId(row.id);
    lastTrigger.current = trigger;
    // The panel is mounted even without a selection, so keyboard focus is
    // synchronous; row actions do not navigate the privileged webview.
    detail.current?.focus();
  }

  async function present(row: Row, kind: "open" | "preview") {
    const handler = kind === "open" ? onOpen : onPreview;
    const admissible = kind === "open" ? canOpen : canPreview;
    if (!handler || (admissible && !admissible(row)) || disabled || actionRunning.current) return;
    actionRunning.current = true;
    setAction(kind);
    setNotice(undefined);
    let ok = false;
    try {
      ok = await handler(row);
    } catch { /* The native adapter can reject. Keep the original intact. */ }
    setNotice({ id: row.id, failed: !ok, text: ok ? (kind === "open" ? "Opened received copy." : "Preview opened.") :
      `Could not ${kind} this received copy.` });
    actionRunning.current = false;
    setAction(undefined);
  }

  return <GlassSurface material="content" className="aw-received-activity aerift-desktop-inbox">
    <section aria-labelledby={heading}>
      <header className="aw-received-header aerift-inbox-heading">
        <h3 id={heading}><SpatialIcon name="drop" />{title}</h3>
        <form role="search" aria-label={title === "Inbox" ? "Inbox files" : "Received files"}
          onSubmit={event => {
            event.preventDefault();
            const next = query.trim();
            setSubmitted(next);
            setPageSize(firstPageSize);
            onSearch?.(next);
          }}>
          <label className="aw-received-query">Find a file
            <input type="search" placeholder="Find a file" maxLength={receivedQueryLimit} value={query}
              autoComplete="off" spellCheck={false} onChange={event => {
                setQuery(event.currentTarget.value);
                if (!onSearch) setPageSize(firstPageSize);
              }} />
          </label>
          <IconAction type="submit" label={title === "Inbox" ? "Search Inbox" : "Search received files"} icon="search"
            disabled={controlsDisabled} />
          {onRefresh && <IconAction label={title === "Inbox" ? "Refresh Inbox" : "Refresh received files"}
            icon="retry" disabled={controlsDisabled} onClick={onRefresh} />}
        </form>
      </header>
      {children}
      {loading && <p role="status">Loading {title === "Inbox" ? "Inbox" : "received files"}…</p>}
      {error && <p role="alert">{error}</p>}
      {truncated && <p>Some files aren’t shown. Search by name to narrow the list.</p>}
      {!loading && !error && ordered.length === 0 && <p>{libraryQuery ? "No matching files." :
        title === "Inbox" ? "No files saved to Inbox yet." : "No received files yet."}</p>}
      {!loading && (ordered.length > 0 || selected || timeline.dated.length > 0) && <div className="aw-received-layout">
        <div>
          <ul className="aerift-inbox-list aw-received-list" aria-label="Received file library">
            {ordered.slice(0, pageSize).map(row => <li key={row.id}>
              <div className="aerift-inbox-file">
                <SpatialIcon name="file" size={20} />
                <div>
                  <button type="button" className="aw-received-file-link" aria-label={`View received ${row.name}`}
                    aria-current={row.id === selectedId ? true : undefined}
                    onClick={event => selectRow(row, event.currentTarget)}>{row.name}</button>
                  <small>{receivedFileKind(row.name)} · {safeBytes(row.sizeBytes)}{row.source ? ` · ${row.source}` : ""}</small>
                </div>
              </div>
              {renderActions?.(row)}
            </li>)}
          </ul>
          {ordered.length > pageSize && <Button variant="quiet" onClick={() => setPageSize(size => size + firstPageSize)}>
            Show more received files</Button>}
        </div>
        <section className="aw-received-detail" ref={detail} tabIndex={-1} aria-labelledby={detailHeading}>
          <h4 id={detailHeading}>File preview</h4>
          {selected ? <>
            <strong>{selected.name}</strong>
            <dl>
              <div><dt>Type</dt><dd>{receivedFileKind(selected.name)}</dd></div>
              <div><dt>Size</dt><dd>{safeBytes(selected.sizeBytes)}</dd></div>
              {selected.source && <div><dt>From</dt><dd>{selected.source}</dd></div>}
              <div><dt>Received</dt><dd><ReceiptTime item={selected} /></dd></div>
            </dl>
            {selected.note && <p>{selected.note}</p>}
            {previewContent}
            <GlassSurface material="chrome" className="ae-actions aw-received-actions">
              {allowPreview && <IconAction type="button" icon="maximize" label="Preview file" disabled={controlsDisabled}
                loading={action === "preview"} onClick={() => void present(selected, "preview")} />}
              {allowOpen && <IconAction type="button" icon="folder" label="Open file" disabled={controlsDisabled}
                loading={action === "open"} onClick={() => void present(selected, "open")} />}
              <IconAction type="button" icon="close" label="Close details" onClick={() => {
                setSelectedId(undefined);
                if (lastTrigger.current?.isConnected) lastTrigger.current.focus();
              }} />
            </GlassSurface>
            {!allowPreview && !allowOpen && !previewContent && <small>File content preview is unavailable here. The original is unchanged.</small>}
            {notice?.id === selected.id && <p role={notice.failed ? "alert" : "status"}>{notice.text}</p>}
          </> : <p>Select a received file to see its details.</p>}
        </section>
      </div>}
      {!loading && (timeline.dated.length > 0 || timeline.undated.length > 0) && <section className="aw-received-timeline" aria-labelledby={timelineHeading}>
        <h4 id={timelineHeading}>Receipt timeline</h4>
        {timeline.dated.length > 0 ? <ol>
          {timeline.dated.slice(0, timelineSize).map(row => <li key={row.id}>
            <button type="button" className="aw-received-file-link" aria-label={`View timeline entry for ${row.name}`}
              onClick={event => selectRow(row, event.currentTarget)}>{row.name}</button>
            <small><ReceiptTime item={row} /></small>
          </li>)}
        </ol> : <p>There are no receipts with a recorded time in this view.</p>}
        {timeline.undated.length > 0 && <small>{timeline.undated.length} {timeline.undated.length === 1 ? "file has" : "files have"} no recorded receipt time. You can still open their details in the library.</small>}
      </section>}
    </section>
  </GlassSurface>;
}
