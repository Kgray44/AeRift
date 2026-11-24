import assert from "node:assert/strict";
import { test } from "node:test";
import { snapshotFlights, visibleRefresh } from "../../dist/packages/app-contract/src/visible-refresh.js";

function controlled(initiallyVisible = true) {
  let now = 0;
  let visible = initiallyVisible;
  const listeners = new Set();
  const timers = new Map();
  let id = 0;
  return {
    environment: {
      visible: () => visible,
      now: () => now,
      later(fn, ms) {
        const current = ++id;
        timers.set(current, { fn, deadline: now + ms });
        return () => timers.delete(current);
      },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    },
    setVisible(value) { visible = value; listeners.forEach(fn => fn()); },
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const candidate = [...timers].sort((a, b) => a[1].deadline - b[1].deadline)[0];
        if (!candidate || candidate[1].deadline > end) break;
        timers.delete(candidate[0]);
        now = candidate[1].deadline;
        candidate[1].fn();
        await Promise.resolve();
      }
      now = end;
    },
  };
}

test("quick snapshots retain the actual visible 750ms cadence and no hidden traffic", async () => {
  const scenario = controlled();
  const events = [];
  let stale = 0;
  const scheduler = visibleRefresh(scenario.environment, 750, async () => scenario.environment.now(),
    value => events.push(value), () => stale++, assert.fail);
  await scenario.advance(3000);
  assert.deepEqual(events, [0, 750, 1500, 2250, 3000]);
  scenario.setVisible(false);
  assert.equal(stale, 1);
  scheduler.refresh();
  await scenario.advance(180000);
  assert.equal(events.length, 5);
  scenario.setVisible(true);
  await scenario.advance(0);
  assert.equal(events.at(-1), 183000);
  scheduler.close();
  await scenario.advance(2000);
  assert.equal(events.length, 6);
});

test("a slow snapshot can never overlap, and a post-mutation invalidation delivers one new reply", async () => {
  const scenario = controlled();
  const completions = [];
  const delivered = [];
  const scheduler = visibleRefresh(scenario.environment, 1000,
    () => new Promise(resolve => completions.push(resolve)), value => delivered.push(value), assert.fail, assert.fail);
  await scenario.advance(0);
  await scenario.advance(5000);
  assert.equal(completions.length, 1);
  scheduler.refresh();
  scheduler.refresh();
  completions[0]("stale pre-mutation view");
  await Promise.resolve();
  await scenario.advance(0);
  assert.equal(completions.length, 2);
  assert.deepEqual(delivered, []);
  completions[1]("confirmed new view");
  await Promise.resolve();
  assert.deepEqual(delivered, ["confirmed new view"]);
  scheduler.close();
});

test("ignore stale hidden replies and end effect rehearsals without IPC or updates", async () => {
  const scenario = controlled();
  const completions = [];
  const delivered = [];
  const mount = () => visibleRefresh(scenario.environment, 750, () =>
    new Promise(resolve => completions.push(resolve)), value => delivered.push(value), () => {}, assert.fail);
  const rehearsal = mount();
  rehearsal.close();
  const scheduler = mount();
  await scenario.advance(0);
  assert.equal(completions.length, 1);
  scenario.setVisible(false);
  scenario.setVisible(true);
  await scenario.advance(2000);
  assert.equal(completions.length, 1);
  completions[0]("stale hidden reply");
  await Promise.resolve();
  await scenario.advance(0);
  assert.equal(completions.length, 2);
  assert.deepEqual(delivered, []);
  scheduler.close();
  completions[1]("after runtime unmounted");
  await Promise.resolve();
  assert.deepEqual(delivered, []);
});


test("exact command scopes are single-flight and never share state across lanes", async () => {
  const issue = snapshotFlights();
  let native = 0;
  let complete;
  const first = issue("remote", () => { native++; return new Promise(resolve => { complete = resolve; }); });
  const remount = issue("remote", () => { native++; return Promise.resolve("unexpected"); });
  const friends = issue("friends", () => { native++; return Promise.resolve("friends"); });
  assert.deepEqual(await friends, { value: "friends", reused: false });
  assert.equal(native, 2);
  complete("in flight");
  assert.deepEqual(await first, { value: "in flight", reused: false });
  assert.deepEqual(await remount, { value: "in flight", reused: true });
  assert.deepEqual(await issue("remote", () => Promise.resolve("new read")), { value: "new read", reused: false });
});
