/** Scheduler for optional view snapshots, never for transport authority. */
export type RefreshEnvironment = {
  visible(): boolean;
  now(): number;
  later(fn: () => void, ms: number): () => void;
  subscribe(fn: () => void): () => void;
};

export function visibleRefresh<T>(
  environment: RefreshEnvironment,
  intervalMs: number,
  read: () => Promise<T>,
  receive: (value: T) => void,
  stale: () => void,
  failure: () => void,
) {
  let closed = false;
  let visible = environment.visible();
  let inFlight = false;
  let pending = false;
  let generation = 0;
  let unschedule: (() => void) | undefined;

  function schedule(ms: number) {
    unschedule?.();
    if (closed || !visible || inFlight) return;
    unschedule = environment.later(() => {
      unschedule = undefined;
      void tick();
    }, ms);
  }

  async function tick() {
    if (closed || !visible || inFlight) return;
    inFlight = true;
    pending = false;
    const revision = generation;
    const started = environment.now();
    try {
      const result = await read();
      if (!closed && visible && generation === revision) receive(result);
    } catch {
      if (!closed && visible && generation === revision) failure();
    } finally {
      inFlight = false;
      if (!closed && visible) {
        const elapsed = Math.max(0, environment.now() - started);
        // Align to the next unused cadence slot; a slow native command does
        // not cause a burst or faster-than-original catch-up polling.
        schedule(pending ? 0 : intervalMs - elapsed % intervalMs);
      }
    }
  }

  function visibility() {
    const next = environment.visible();
    if (next === visible || closed) return;
    visible = next;
    ++generation;
    if (visible) {
      pending = true;
      schedule(0);
    } else {
      unschedule?.();
      unschedule = undefined;
      stale();
    }
  }

  const unsubscribe = environment.subscribe(visibility);
  // Deferral lets React StrictMode discard its rehearsal effect without IPC.
  schedule(0);
  return {
    refresh() {
      if (closed || !visible) return;
      // A reply started before a mutation cannot replace the post-action view.
      ++generation;
      pending = true;
      schedule(0);
    },
    close() {
      closed = true;
      unschedule?.();
      unsubscribe();
    },
  };
}

/** Share one active read per exact scoped command. Never cache settled data. */
export function snapshotFlights() {
  const inflight = new Map<string, Promise<unknown>>();
  return function issue<T>(scope: string, read: () => Promise<T>): Promise<{ value: T; reused: boolean }> {
    const pending = inflight.get(scope);
    if (pending) return (pending as Promise<T>).then(value => ({ value, reused: true }));
    const flight = read().finally(() => { if (inflight.get(scope) === flight) inflight.delete(scope); });
    inflight.set(scope, flight);
    return flight.then(value => ({ value, reused: false }));
  };
}
