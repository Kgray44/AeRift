import assert from "node:assert/strict";
import test from "node:test";
import { orbitSlots, orbitNeighbor } from "../../packages/ui/src/orbit-geometry.ts";

test("four and five siblings fan out clockwise with clearance", () => {
  for (const count of [4, 5]) {
    const slots = orbitSlots(count, { right: 800, bottom: 544, diameter: 56 });
    assert.equal(slots.length, count);
    for (const [index, slot] of slots.entries()) {
      assert(slot.x > 0 && slot.y > 0);
      if (!index) continue;
      const previous = slots[index - 1];
      assert(slot.x < previous.x && slot.y > previous.y);
      assert(Math.hypot(slot.x - previous.x, slot.y - previous.y) >= 72);
    }
  }
});

test("chooses a conventional layout when the fan cannot fit", () => {
  assert.equal(orbitSlots(5, { right: 198, bottom: 250, diameter: 56 }), null);
  const compact = orbitSlots(4, { right: 237, bottom: 237, diameter: 52 });
  assert.equal(compact.length, 4);
  assert(compact.every(point => point.x + 26 <= 237 && point.y + 26 <= 237));
});

test("arrow directions correspond to the visible fan instead of wrapping behind it", () => {
  const slots = orbitSlots(5, { right: 800, bottom: 544, diameter: 56 });
  assert.equal(orbitNeighbor(slots.length, 2, "ArrowRight"), 1);
  assert.equal(orbitNeighbor(slots.length, 2, "ArrowDown"), 3);
  assert.equal(orbitNeighbor(slots.length, 0, "ArrowUp"), 0);
  assert.equal(orbitNeighbor(slots.length, 4, "ArrowLeft"), 4);
});
