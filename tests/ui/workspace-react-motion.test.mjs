import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = path => readFileSync(new URL("../../" + path, import.meta.url), "utf8");
test("desktop and mobile library cards share production React Motion gestures without moving the target", () => {
  const library = read("apps/aerift/src/WorkspaceLibrary.tsx");
  const motion = read("packages/ui/src/MotionAffordance.tsx");
  assert.match(library, /<MotionCardAccent[^>]*layoutId=\{section\.id\}/);
  assert.match(read("apps/aerift/src/windows/DesktopWorkspace.tsx"), /<MotionFeedbackProvider group="desktop-workspace">/);
  assert.match(read("apps/aerift/src/ios/MobileWorkspace.tsx"), /<MotionFeedbackProvider group="mobile-workspace">/);
  assert.match(library, /<MotionCardButton/);
  assert.match(library, /<MotionCardAccent[^>]*role="symbol"/);
  assert.match(motion, /whileHover=\{quiet \? undefined : "hover"\}[^>]*whileTap=\{quiet \? undefined : "press"\}/s);
  assert.match(motion, /<m\.span[^>]*variants=/s);
  assert.doesNotMatch(motion, /<m\.button[^>]*variants=/s);
});
test("the prebuilt Motion features share both AeRift and OS reduced-motion policy", () => {
  const motion = read("packages/ui/src/MotionAffordance.tsx");
  assert.match(motion, /<LazyMotion features=\{loadMotionFeatures\}/);
  assert.match(motion, /useAppearanceMotion\(\)/);
  assert.match(motion, /reducedMotion=\{reduction === "reduce" \? "always" : "user"\}/);
});

test("the chosen Workspace card keeps the same glass medallion across root and detail", () => {
  const library = read("apps/aerift/src/WorkspaceLibrary.tsx");
  assert.equal((library.match(/layoutId=\{section\.id\}/g) ?? []).length, 2);
  const motion = read("packages/ui/src/MotionAffordance.tsx");
  assert.match(motion, /<LayoutGroup id=\{group\}>\{children\}<\/LayoutGroup>/);
  assert.match(motion, /layoutId=\{quiet \? undefined : layoutId\}/);
  assert.match(motion, /transition=\{\{ layout: settle \}\}/);
});
