import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createMotionBuild, MOTION_PROVIDER_ID } from "../../apps/aerift/motion-provider-build.mjs";

const bytes = Buffer.from('{"version":1,"workspaceCard":{"mass":2}}\n');
const validator = value => value.version === 1 && value.workspaceCard?.mass === 2 ? value : undefined;

test("public mode is independent of provider paths, credentials, and package access", () => {
  assert.deepEqual(createMotionBuild({ env: { REACTBITS_LICENSE_KEY: "not-consumed" } }), {});
  assert.throws(() => createMotionBuild({ env: { AERIFT_MOTION_PROVIDER: "/not-read" } }), /select premium/i);
});

test("requested premium fails closed on public CI, invalid profile or missing input", () => {
  assert.throws(() => createMotionBuild({ env: { AERIFT_MOTION_PROFILE: "premium", GITHUB_ACTIONS: "true" } }), /CI/);
  assert.throws(() => createMotionBuild({ env: { AERIFT_MOTION_PROFILE: "typo" } }), /unknown/i);
  assert.throws(() => createMotionBuild({ env: { AERIFT_MOTION_PROFILE: "premium" } }), /provider manifest/i);
});

test("premium Vite wiring binds exact importer, fails on invalid data, and exports only validated data", t => {
  const dir = mkdtempSync(join(tmpdir(), "aerift-motion-fixture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifest = join(dir, "motion.json");
  writeFileSync(manifest, bytes);
  const env = { AERIFT_MOTION_PROFILE: "premium", AERIFT_MOTION_PROVIDER: manifest };
  const root = resolve("ignored-public-root");
  const options = { env, publicRoot: root, validate: validator };
  const { plugin } = createMotionBuild(options);
  const caller = join(root, "packages/ui/src/MotionAffordance.tsx");
  assert.equal(plugin.resolveId("./motion-presentation-provider", caller), MOTION_PROVIDER_ID);
  assert.equal(plugin.resolveId("./motion-presentation-provider", caller + ".other"), undefined);
  assert.equal(plugin.resolveId("./motion-presentation-provider-spoof", caller), undefined);
  assert.equal(plugin.load(MOTION_PROVIDER_ID), 'export default {"version":1,"workspaceCard":{"mass":2}};');
  assert.throws(() => createMotionBuild({ ...options, publicRoot: dir }), /outside the public checkout/i);
  assert.throws(() => createMotionBuild({ ...options, validate: () => undefined }), /incompatible/i);
  assert.throws(() => createMotionBuild({ ...options, command: "serve", nativeDevHost: "0.0.0.0" }), /loopback/i);
  writeFileSync(manifest, "malformed");
  assert.throws(() => createMotionBuild(options), /invalid/i);
});
