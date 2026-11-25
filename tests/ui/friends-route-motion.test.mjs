import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = path => readFileSync(new URL("../../" + path, import.meta.url), "utf8");
test("mobile Friends uses one immediately interactive React presence pane and preserves desktop split view", () => {
  const source = read("apps/aerift/src/FriendsWorkspace.tsx");
  assert.match(source, /<MobileRoutePresence[\s\S]*?routeKey=\{contact\?\.id \?\? headingId\}/);
  assert.match(source, /contact \? detail : list[\s\S]*?: <>{list}{detail}<\/>/);
  assert.doesNotMatch(source, /data-ae-route-enter=/);
  assert.match(source, /rowRefs\.current\.get\(previousContact\)/);
  assert.match(source, /focus\(\{ preventScroll: true \}\)/);
});

test("the outgoing React presence pane is inert, and both reduction sources settle it", () => {
  const presence = read("packages/ui/src/MobileRoutePresence.tsx");
  assert.match(presence, /<AnimatePresence[\s\S]*?mode="sync"/);
  assert.match(presence, /aria-hidden=\{!present \|\| undefined\}[\s\S]*?inert=\{!present\}/);
  assert.match(presence, /useQuietMotion/);
  const shared = read("packages/ui/src/MotionAffordance.tsx");
  assert.match(shared, /visibilitychange/);
  assert.match(shared, /useAppearanceMotion/);
  assert.match(shared, /prefers-reduced-motion/);
  assert.match(presence, /variants=\{paneVariants\}/);
});
