import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import type { FileInfo, Transfer } from "@aerift/app-contract";
import { formatFileSize } from "./components";

export type TransferObjectState = "resting" | "anticipating" | "held" | "departing" | "arriving" | "settled" | "recovering";

interface Point { x: number; y: number }

export interface RiftGeometry {
  width: number;
  height: number;
  source: Point;
  destination: Point;
}

function FileGlyph({ name }: { name: string }) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const image = /^(avif|gif|heic|jpeg|jpg|png|svg|webp)$/.test(extension);
  const video = /^(m4v|mov|mp4|mkv|webm)$/.test(extension);
  const audio = /^(aac|flac|m4a|mp3|ogg|wav)$/.test(extension);
  const archive = /^(7z|gz|rar|tar|zip)$/.test(extension);
  const mark = image ? "M7 17l3-3 2 2 2-3 3 4M9 11h.01"
    : video ? "M10 11l5 3-5 3z"
      : audio ? "M12 16v-5l3 1M12 16c0 1-1 2-2 2s-2-.6-2-1.5 1-1.5 2-1.5 2 0 2 1z"
        : archive ? "M12 9v2m0 2v2m-1 3h2v-2h-2z"
          : "M8 13h8m-8 4h6";
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"
    strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
    <path d="M14 3v5h5" />
    <path d={mark} />
  </svg>;
}

export function TransferObject({ files, state, objectId, destination, thumbnailUrl, glyphRef }: {
  files: readonly FileInfo[];
  state: TransferObjectState;
  objectId: string;
  destination?: string;
  /** Local, authorized preview supplied by the caller. */
  thumbnailUrl?: string;
  glyphRef?: Ref<HTMLSpanElement>;
}) {
  const file = files[0];
  if (!file) return null;
  const count = files.length;
  const size = formatFileSize(files.reduce((total, entry) => total + entry.sizeBytes, 0));
  return <div className="ae-object" data-object-state={state} data-object-id={objectId} data-group={count > 1}>
    <span className="ae-object-icon" aria-hidden="true" ref={glyphRef}>
      {thumbnailUrl ? <img src={thumbnailUrl} alt="" decoding="async" /> : <FileGlyph name={file.name} />}
    </span>
    <span className="ae-object-copy">
      <strong title={file.name}>{file.name}</strong>
      <small>{count > 1 && `${count} files · `}{size}{destination && <> · {destination}</>}</small>
    </span>
    {state === "held" && <span className="ae-object-held">Held</span>}
  </div>;
}

function getProgress(transfer: Transfer) {
  const { sizeBytes } = transfer.file;
  const bytes = Math.max(0, Math.min(sizeBytes, transfer.bytesTransferred));
  return { bytes, ratio: sizeBytes ? bytes / sizeBytes : 0 };
}

function riftPhase(transfer: Transfer) {
  switch (transfer.state) {
    case "pending": return "offered";
    case "accepted": return "accepted";
    case "transferring": return transfer.file.sizeBytes > 0 && transfer.bytesTransferred >= transfer.file.sizeBytes
      ? "verifying" : "transport";
    case "completed": return "delivered";
    case "rejected":
    case "cancelled":
    case "failed": return "interrupted";
  }
}

export function RiftExperience({ transfer, deviceName, action, error, objectId, gestureState, compactPath = false }: {
  transfer: Transfer;
  deviceName?: string;
  action?: ReactNode;
  error?: string;
  objectId?: string;
  gestureState?: TransferObjectState;
  compactPath?: boolean;
}) {
  const id = useId();
  const incoming = transfer.direction === "incoming";
  const phase = riftPhase(transfer);
  const { bytes, ratio } = getProgress(transfer);
  const percent = Math.floor(ratio * 100);
  const labels = {
    offered: incoming ? "Awaiting your acceptance" : "Preparing or awaiting acceptance",
    accepted: incoming ? "Accepted · preparing to receive" : "Receiver accepted",
    transport: incoming ? "Receiving" : "Sending",
    verifying: "Awaiting delivery confirmation",
    delivered: incoming ? "Received and stored" : "Delivered",
    interrupted: transfer.state === "rejected" ? "Offer declined" : transfer.state === "cancelled" ? "Transfer cancelled" : "Transfer failed",
  };
  const objectState = gestureState ?? (phase === "delivered" ? "settled" : phase === "interrupted" ? "recovering" : incoming ? "arriving" : "departing");
  const interaction = transfer.interactionId ?? transfer.id;
  return <section className="ae-rift" data-phase={phase} data-transfer-state={transfer.state}
    data-transfer-id={interaction} aria-labelledby={id}>
    <div className="ae-rift-head">
      <h2 id={id}>The Rift</h2>
      <span>{incoming ? "Incoming" : "Outgoing"}{deviceName && ` · ${deviceName}`}</span>
    </div>
    {compactPath && phase !== "interrupted" && <div className="ae-rift-inline" aria-hidden="true"
      data-direction={transfer.direction} data-arrived={phase === "delivered"}>
      <div className="ae-rift-inline-track">
        <span className="ae-rift-inline-fill" style={{ transform: `scaleX(${phase === "delivered" ? 1 : ratio})` }} />
        <span className="ae-rift-inline-carrier" style={{ "--ae-rift-travel": `${phase === "delivered" ? 100 : ratio * 100}%` } as CSSProperties}>
          <span className="ae-rift-inline-object"><FileGlyph name={transfer.file.name} /></span>
        </span>
      </div>
    </div>}
    <div className="ae-rift-content">
      <TransferObject files={[transfer.file]} state={objectState} objectId={objectId ?? interaction} />
      <div className="ae-rift-feedback">
        <span className="ae-rift-status" role="status">{labels[phase]}</span>
        {(phase === "transport" || phase === "verifying") && transfer.file.sizeBytes > 0 &&
          <span className="ae-rift-measure" role="progressbar" aria-label={`Transfer progress for ${transfer.file.name}`}
            aria-valuenow={percent} aria-valuetext={`${formatFileSize(bytes)} of ${formatFileSize(transfer.file.sizeBytes)}`}>
            {formatFileSize(bytes)} of {formatFileSize(transfer.file.sizeBytes)} · {percent}%
          </span>}
        {error && <small className="ae-rift-error">{error}</small>}
      </div>
      {action && <div className="ae-rift-actions">{action}</div>}
    </div>
  </section>;
}

function riftPath(source: Point, destination: Point, height: number) {
  const distance = Math.hypot(destination.x - source.x, destination.y - source.y);
  const midX = (source.x + destination.x) / 2;
  const midY = (source.y + destination.y) / 2;
  const lift = Math.min(distance * .22, height * .14, 82);
  const curveY = midY > lift + 20 ? midY - lift : midY + lift;
  return `M ${source.x} ${source.y} Q ${midX} ${curveY} ${destination.x} ${destination.y}`;
}

function RiftLaunch({ file, from, source }: { file: FileInfo; from: Point; source: Point }) {
  const glyph = useRef<HTMLSpanElement>(null);
  const [delta, setDelta] = useState<Point>();
  const { x: fromX, y: fromY } = from;
  const { x, y } = source;
  useLayoutEffect(() => {
    const bounds = glyph.current?.parentElement?.getBoundingClientRect();
    if (bounds) setDelta({ x: fromX - bounds.left - x, y: fromY - bounds.top - y });
  }, [fromX, fromY, x, y]);

  const style: CSSProperties & Record<`--${string}`, string> = { left: x, top: y };
  if (delta) {
    style["--ae-launch-x"] = `${delta.x}px`;
    style["--ae-launch-y"] = `${delta.y}px`;
  }
  return <span ref={glyph} className="ae-rift-flight ae-rift-launch" data-measured={Boolean(delta)} style={style}>
    <FileGlyph name={file.name} />
  </span>;
}

/** Stage overlay. Measured points are relative to the stage, with the local device as source. */
export function RiftLink({ geometry, transfer, ready = false, departureFrom }: {
  geometry: RiftGeometry;
  transfer?: Transfer;
  ready?: boolean;
  /** Viewport center of the dock glyph at the moment of a valid send. */
  departureFrom?: Point;
}) {
  const gradient = useId();
  const { width, height } = geometry;
  if (width <= 0 || height <= 0) return null;
  const incoming = transfer?.direction === "incoming";
  const source = incoming ? geometry.destination : geometry.source;
  const destination = incoming ? geometry.source : geometry.destination;
  const phase = transfer ? riftPhase(transfer) : ready ? "ready" : "selected";
  const path = riftPath(source, destination, height);
  const ratio = !transfer ? 0 : phase === "delivered" ? 1 : getProgress(transfer).ratio;
  const arrival = incoming && phase === "delivered";
  const launch = !incoming && departureFrom && phase !== "interrupted" && phase !== "delivered";
  const marker = !arrival && (phase === "accepted" || phase === "transport" || phase === "verifying" || phase === "delivered");
  return <div className="ae-rift-link" aria-hidden="true" data-phase={phase} key={transfer?.id}>
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="ae-rift-vector">
      <defs>
        <linearGradient id={gradient} x1={source.x} y1={source.y} x2={destination.x} y2={destination.y} gradientUnits="userSpaceOnUse">
          <stop offset="0%" className="ae-rift-stop-source" />
          <stop offset="46%" className="ae-rift-stop-center" />
          <stop offset="100%" className="ae-rift-stop-destination" />
        </linearGradient>
      </defs>
      <path className="ae-rift-guide" d={path} />
      <path className="ae-rift-flow" d={path} stroke={`url(#${gradient})`} />
      <path className="ae-rift-byte-path" d={path} pathLength="1" strokeDasharray="1" strokeDashoffset={1 - ratio} />
      <g transform={`translate(${source.x} ${source.y})`}>
        <circle className="ae-rift-field ae-rift-origin" r="40" />
      </g>
      <g transform={`translate(${destination.x} ${destination.y})`}>
        <circle className="ae-rift-field ae-rift-mouth" r="47" />
        <circle className="ae-rift-field ae-rift-wave" r="47" />
        <path className="ae-rift-sparks" d="M-53-23h2m60-27h1m36 13h2m-69 84h2m63-18h1m-101 10h1" />
      </g>
    </svg>
    {transfer && launch && <RiftLaunch file={transfer.file} from={departureFrom} source={source} />}
    {transfer && arrival && <span className="ae-rift-flight ae-rift-arrival" style={{ left: destination.x, top: destination.y }}>
      <FileGlyph name={transfer.file.name} />
    </span>}
    {transfer && marker && <span className="ae-rift-payload" style={{ offsetPath: `path('${path}')`, offsetDistance: `${ratio * 100}%` } satisfies CSSProperties}>
      <FileGlyph name={transfer.file.name} />
    </span>}
  </div>;
}
