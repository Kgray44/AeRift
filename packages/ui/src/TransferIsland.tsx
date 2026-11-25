import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Transfer } from "@aerift/app-contract";
import { GlassSurface } from "./components";
import { IconAction } from "./IconAction";
import { SpatialIcon } from "./SpatialScene";
import {
  activeIslandTransfers, formatIslandRate, formatIslandTime, observeIslandTransfers, readIslandMetrics,
  transferIslandSummary, transferMetricStaleMs, type TransferMetricSample,
} from "./transfer-island-metrics";
import "./transfer-island.css";

const noTransfers: readonly Transfer[] = [];
const noSamples: ReadonlyMap<string, TransferMetricSample> = new Map();
const emptyMeasurement = { now: 0, samples: noSamples };

export function TransferIsland({ transfers = noTransfers, mobile = false, suppressed = false }: {
  transfers?: readonly Transfer[];
  mobile?: boolean;
  suppressed?: boolean;
}) {
  const detailsId = useId();
  const [host, setHost] = useState<HTMLElement | null>(null);
  const mounted = useRef<HTMLSpanElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [measurement, setMeasurement] = useState(emptyMeasurement);
  const current = useMemo(() => activeIslandTransfers(transfers), [transfers]);
  const { count, outgoing, incoming, percent } = transferIslandSummary(current);
  const visible = count > 0 && !suppressed;

  useLayoutEffect(() => {
    // Leave routed/transformed content, but stay inside the production optical shell.
    setHost(mounted.current?.closest<HTMLElement>(".ae-shell") ?? null);
  }, []);

  useLayoutEffect(() => {
    if (!current.length) {
      setMeasurement(emptyMeasurement);
      setCollapsed(false);
      return;
    }
    const now = performance.now();
    setMeasurement(last => ({ now, samples: observeIslandTransfers(last.samples, current, now) }));
  }, [current]);

  useLayoutEffect(() => {
    if (visible || document.activeElement !== toggle.current) return;
    const previous = returnFocus.current;
    if (previous?.isConnected && !previous.closest("[hidden], [inert]")) previous.focus({ preventScroll: true });
    else host?.querySelector<HTMLElement>(".ae-main")?.focus({ preventScroll: true });
  }, [host, visible]);

  useEffect(() => {
    if (!visible || collapsed) return;
    let due = Infinity;
    for (const sample of measurement.samples.values()) {
      const expires = sample.changedAt + transferMetricStaleMs;
      if (sample.rate !== undefined && expires > measurement.now) due = Math.min(due, expires);
    }
    if (!Number.isFinite(due)) return;
    const timeout = setTimeout(() => {
      const now = performance.now();
      setMeasurement(last => ({ ...last, now }));
    }, Math.max(0, due - performance.now()));
    return () => clearTimeout(timeout);
  }, [visible, collapsed, measurement]);

  // Re-evaluate freshness when details return; no separate interval while minimized.
  function toggleDetails() {
    if (collapsed) {
      const now = performance.now();
      setMeasurement(last => ({ ...last, now }));
    }
    setCollapsed(!collapsed);
  }

  const direction = incoming && outgoing ? "Sending and receiving" : incoming ? "Receiving" : "Sending";
  return <>
    <span hidden ref={mounted} />
    {host && createPortal(
      <aside aria-label="Active transfers" hidden={!visible} inert={!visible}
        className="ae-transfer-island-frame" data-mobile={mobile} data-collapsed={collapsed}>
        <GlassSurface material="chrome" className="ae-transfer-island" data-visible={visible}>
          <canvas className="ae-transfer-island-optical" aria-hidden="true" />
          <div className="ae-transfer-island-summary">
            <span className="ae-transfer-island-symbol">
              <SpatialIcon name={incoming && outgoing ? "activity" : incoming ? "drop" : "send"} size={18} />
            </span>
            <div className="ae-transfer-island-summary-copy">
              <span className="ae-transfer-island-heading"><strong>{count > 0 ? direction : ""}</strong>
                {count > 0 && <small>{count} {count === 1 ? "file" : "files"}</small>}</span>
              {typeof percent === "number" && <small className="ae-transfer-island-overall">{percent}% of file data</small>}
            </div>
            <IconAction icon={collapsed ? "maximize" : "minimize"} ref={toggle}
              label={collapsed ? "Expand transfer island" : "Minimize transfer island"} onClick={toggleDetails}
              aria-controls={detailsId} aria-expanded={!collapsed} onFocus={event => {
                returnFocus.current = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
              }} />
          </div>
          <div id={detailsId} className="ae-transfer-island-details" inert={collapsed}
            aria-hidden={collapsed || undefined}>
            <ol aria-label="Files in progress">{current.map(receipt => {
              const metrics = readIslandMetrics(receipt, measurement.samples.get(receipt.id), measurement.now);
              const sending = receipt.direction === "outgoing";
              const progress = metrics.percent;
              return <li key={receipt.id} className="ae-transfer-island-row">
                <SpatialIcon name={sending ? "send" : "drop"} size={18} />
                <div className="ae-transfer-island-file">
                  <div className="ae-transfer-island-file-head">
                    <strong title={receipt.file.name}>{receipt.file.name}</strong>
                    {progress !== undefined && <span>{progress}%</span>}
                  </div>
                  <div role="progressbar" aria-label={`${sending ? "Sending" : "Receiving"} ${receipt.file.name}`}
                    aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="ae-progress"
                    data-indeterminate={progress === undefined || undefined}>
                    <span style={progress === undefined ? undefined : { transform: `scaleX(${progress / 100})` }} />
                  </div>
                  {progress === 100 ? <small>Awaiting verification</small> :
                    metrics.bytesPerSecond !== undefined && metrics.seconds !== undefined ?
                      <small>{sending ? "Upload" : "Download"} {formatIslandRate(metrics.bytesPerSecond)}
                        {" · "}{formatIslandTime(metrics.seconds)} left</small> :
                      <small>{sending ? "Upload" : "Download"} speed and time not yet available</small>}
                </div>
              </li>;
            })}</ol>
          </div>
        </GlassSurface>
      </aside>, host)}
  </>;
}
