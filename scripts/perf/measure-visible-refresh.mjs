// Run npm test first to compile the exact scheduler imported by the UI.
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { visibleRefresh } from "../../dist/packages/app-contract/src/visible-refresh.js";

const run = async (label, period, mode) => {
  let visible = true;
  let active = 0;
  let peak = 0;
  let resumedAt;
  let phase = "initial";
  let postActionRefreshes = 0;
  const starts = [];
  const hooks = new Set();
  const environment = {
    now: () => performance.now(),
    visible: () => visible,
    later(fn, ms) { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
    subscribe(fn) { hooks.add(fn); return () => hooks.delete(fn); },
  };
  const setVisible = value => { visible = value; hooks.forEach(fn => fn()); };
  const invokeFixture = async () => {
    starts.push({ phase, visible, at: performance.now() });
    peak = Math.max(peak, ++active);
    await sleep(phase === "initial" || phase === "hidden" ? 35 : 1250);
    active--;
  };
  let close;
  let refresh;
  if (mode === "new") {
    const controller = visibleRefresh(environment, period, invokeFixture, () => {}, () => {}, () => {});
    close = () => controller.close();
    refresh = () => controller.refresh();
  } else {
    // Original Private Remote had no in-flight guard and a direct post-action
    // invoke; Friends dropped any trigger while a snapshot was running.
    const baseline = () => { if (label !== "friends" || !active) void invokeFixture(); };
    baseline();
    const timer = setInterval(baseline, period);
    close = () => clearInterval(timer);
    refresh = label === "folder" ? () => {} : baseline;
  }
  await sleep(3200);
  phase = "hidden";
  setVisible(false);
  await sleep(3900);
  phase = "resumed";
  resumedAt = performance.now();
  setVisible(true);
  await sleep(210);
  for (let i = 0; i < 3; i++) { ++postActionRefreshes; refresh(); }
  await sleep(3550);
  close();
  return {
    fixture: label, scheduler: mode, periodMs: period,
    firstVisibleStarts: starts.filter(start => start.phase === "initial").length,
    hiddenStarts: starts.filter(start => !start.visible).length,
    resumedStarts: starts.filter(start => start.phase === "resumed").length,
    resumeFirstMs: Math.round(starts.find(start => start.phase === "resumed").at - resumedAt),
    peakConcurrent: peak, postActionRefreshes,
  };
};
for (const round of [1, 2, 3]) {
  for (const sample of await Promise.all([
    run("remote", 750, "old"), run("remote", 750, "new"),
    run("friends", 1000, "old"), run("friends", 1000, "new"),
    run("folder", 1000, "old"), run("folder", 1000, "new"),
  ])) console.log(JSON.stringify({ round, ...sample }));
}
