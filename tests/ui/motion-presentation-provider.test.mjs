import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PUBLIC_MOTION_PRESENTATION, validateMotionPresentation } from "../../packages/ui/src/motion-presentation-contract.ts";

test("public motion v1 preserves current Workspace decoration tuning", () => {
  const p = validateMotionPresentation(PUBLIC_MOTION_PRESENTATION);
  assert.ok(p);
  assert.deepEqual(p.workspaceCard, {
    settle: { stiffness: 490, damping: 32, mass: 0.56 },
    push: { stiffness: 670, damping: 42, mass: 0.44 },
    symbol: { hoverScale: 1.045, hoverY: -2, pressScale: 0.96 },
    chevron: { hoverX: 3, pressX: 1 },
  });
});

test("presentation-only payload rejects malformed, nonfinite and arbitrary fields", () => {
  const schema = PUBLIC_MOTION_PRESENTATION;
  for (const value of [
    null,
    { ...schema, version: 2 },
    { ...schema, command: () => {} },
    { ...schema, workspaceCard: { ...schema.workspaceCard, settle: { stiffness: 500, damping: Infinity, mass: 1 } } },
    { ...schema, workspaceCard: { ...schema.workspaceCard, chevron: { hoverX: 30, pressX: 1 } } },
    { ...schema, workspaceCard: { ...schema.workspaceCard, get symbol() { assert.fail("accessor read"); } } },
  ]) {
    assert.equal(validateMotionPresentation(value), undefined);
  }
});

test("decoded tuning is independent and cannot mutate the imported provider", () => {
  const supplied = structuredClone(PUBLIC_MOTION_PRESENTATION);
  supplied.workspaceCard.symbol.hoverScale = 1.09;
  const tuning = validateMotionPresentation(supplied);
  assert.equal(tuning?.workspaceCard.symbol.hoverScale, 1.09);
  supplied.workspaceCard.symbol.hoverScale = 1.04;
  assert.equal(tuning?.workspaceCard.symbol.hoverScale, 1.09);
});

test("the actual shared Workspace card consumes provider only on inner accent nodes", () => {
  const source = readFileSync(new URL("../../packages/ui/src/MotionAffordance.tsx", import.meta.url), "utf8");
  assert.match(source, /import .* from "\.\/motion-presentation-provider"/);
  assert.match(source, /validateMotionPresentation\(presentationProvider\) \?\? PUBLIC_MOTION_PRESENTATION/);
  assert.match(source, /variants=\{quiet \? undefined : accents\[role\]\}/);
  assert.match(source, /layoutId=\{quiet \? undefined : layoutId\}/);
  assert.doesNotMatch(source, /<m\.button[^>]*variants=/s);
});
