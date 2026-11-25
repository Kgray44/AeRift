import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { spring } from "motion";
import { DOCK_SETTLE_LIMIT_MS, dockPointerPosition, dockSpring, dockSquash, isDockScrub } from "../../packages/ui/src/dock-motion-math.ts";

test("touch position respects tab centers, direction and physical bounds", () => {
  for (const mirrored of [false, true]) {
    const x = value => mirrored ? 100 + (500 - value) : value;
    assert.equal(dockPointerPosition(x(140), 100, 400, 5, mirrored), 0);
    assert.equal(dockPointerPosition(x(300), 100, 400, 5, mirrored), 2);
    assert.equal(dockPointerPosition(x(180), 100, 400, 5, mirrored), .5);
    assert.equal(dockPointerPosition(x(-40), 100, 400, 5, mirrored), 0);
    assert.equal(dockPointerPosition(x(700), 100, 400, 5, mirrored), 4);
  }
  assert.equal(dockPointerPosition(50, 0, 0, 5, false), 0);
});
test("squash is bounded, symmetric and returns an undistorted glass lens at rest", () => {
  for (const velocity of [0, 4, 18, 100, Infinity]) {
    const strain = dockSquash(velocity);
    assert.equal(strain, dockSquash(-velocity));
    assert.ok(strain >= 0 && strain <= .14);
  }
  assert.equal(dockSquash(0), 0);
  assert.ok(dockSquash(4) < dockSquash(10));
});
test("finger intent leaves ordinary taps and vertical scrolling alone", () => {
  assert.equal(isDockScrub(4, 2), false);
  assert.equal(isDockScrub(2, 50), false);
  assert.equal(isDockScrub(15, 5), true);
  assert.equal(isDockScrub(-15, 5), true);
});
test("one shared MotionValue spring drives the decorative dock, with a finite cleanup bound", () => {
  const source = readFileSync(new URL("../../packages/ui/src/MobileDockMotion.tsx", import.meta.url), "utf8");
  assert.match(source, /useMotionValue\(/);
  assert.match(source, /useSpring\(target/);
  assert.match(source, /useVelocity\(spring\)/);
  assert.match(source, /useTransform\(velocity, dockSquash\)/);
  assert.match(source, /useQuietMotion\(\)/);
  assert.match(source, /settleAt\([^)]+\)[\s\S]*?DOCK_SETTLE_LIMIT_MS/);
  assert.doesNotMatch(source, /\.animate\(|useState\(/);
});

test("pinned Motion spring reaches rest across a full six-tab dock within the hard limit", () => {
  for (const [from, to, velocity] of [[0, 5, 0], [5, 0, 0], [0, 5, -42], [5, 0, 42]]) {
    const model = spring({ ...dockSpring, keyframes: [from, to], velocity });
    const halfway = model.next(130);
    assert.ok(!halfway.done);
    assert.ok(halfway.value > 0 && halfway.value < 5);
    const settled = model.next(DOCK_SETTLE_LIMIT_MS);
    assert.equal(settled.done, true);
    assert.equal(settled.value, to);
  }
});
