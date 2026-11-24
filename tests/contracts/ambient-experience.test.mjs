import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as experience from '../../dist/packages/app-contract/src/ambient-experience.js';

const frame = (overrides = {}) => ({
  version: 1, interaction: "cafe2035", sequence: 1, phase: "picked-up",
  ...overrides,
});

test("stale, duplicate and unchanged terminal A4 frames do not replay an animation", () => {
  const step = experience.advanceAmbientChoreography;
  const start = step(undefined, frame());
  const progress = step(start, frame({ sequence: 2, phase: "transferring", progress: .5 }));
  assert.equal(step(progress, frame()), progress);
  assert.equal(step(progress, frame({ sequence: 2, phase: "offering" })), progress);
  assert.equal(step(progress, frame({ sequence: 3, phase: "transferring", progress: .1 })), progress);
  const settled = step(progress, frame({ sequence: 4, phase: "completed", verified: true }));
  assert.equal(settled.phase, "completed");
  assert.equal(step(settled, frame({ sequence: 5, phase: "failed" })), settled);
  assert.equal(step(settled, frame({ interaction: "bbbbb009", sequence: 5 })), settled);
});

test("only verified native completion is visible, and ingress strips all nonvisual fields", () => {
  const step = experience.advanceAmbientChoreography;
  const latest = step(undefined, frame({ password: "fixture", filePath: "not displayable" }));
  assert.deepEqual(latest, frame());
  assert.equal(step(latest, frame({ sequence: 2, phase: "completed" })), latest);
  assert.equal(step(latest, frame({ version: 2, sequence: 3 })), latest);
  assert.equal(step(latest, frame({ sequence: 4, phase: "transferring", progress: Infinity })), latest);
});

test("an active carry may recover from ambiguity without substituting its object count", () => {
  const step = experience.advanceAmbientChoreography;
  const held = step(undefined, frame({ phase: "held", count: 2 }));
  const ambiguous = step(held, frame({ sequence: 2, phase: "ambiguous" }));
  assert.equal(ambiguous.phase, "ambiguous");
  assert.equal(ambiguous.count, 2);
  assert.equal(step(ambiguous, frame({ sequence: 3, phase: "held", count: 3 })), ambiguous);
  const ready = step(ambiguous, frame({ sequence: 4, phase: "destination-ready" }));
  assert.equal(ready.count, 2);
  const rejected = step(ready, frame({ sequence: 5, phase: "rejected" }));
  assert.ok(experience.isAmbientTerminal(rejected.phase));
  assert.equal(step(rejected, frame({ sequence: 6, phase: "completed", verified: true })), rejected);
});
