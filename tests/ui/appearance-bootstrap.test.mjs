import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = () => readFileSync(new URL("../../apps/aerift/public/appearance-bootstrap.js", import.meta.url), "utf8");

function startup(navigator, entries) {
  const dataset = {};
  const localStorage = { getItem: key => entries[key] ?? null };
  runInNewContext(source(), { navigator, localStorage, document: { documentElement: { dataset } } });
  return dataset.startupAppearance;
}

test("the startup canvas honors explicit settings before mounting React", () => {
  const entries = {
    "aerift.settings.v1": JSON.stringify({ appearance: { scheme: "dark" } }),
    "aerift.ios.appearance.v1": JSON.stringify({ scheme: "light" }),
  };
  assert.equal(startup({ userAgent: "Windows" }, entries), "dark");
  assert.equal(startup({ userAgent: "iPhone" }, entries), "light");
  assert.equal(startup({ userAgent: "Macintosh", maxTouchPoints: 4 }, entries), "light");
});

test("missing, system and malformed startup preferences defer to native appearance", () => {
  const platform = { userAgent: "Windows" };
  for (const data of [undefined, "{", JSON.stringify({ appearance: { scheme: "system" } })]) {
    assert.equal(startup(platform, { "aerift.settings.v1": data }), undefined);
  }
});
