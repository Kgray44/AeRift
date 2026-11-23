import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ERROR_CODES, PROTOCOL_VERSION } from "../../dist/packages/app-contract/src/v1.js";
import { examples } from "../../dist/tests/contracts/examples.mjs";

test("app fixtures use the version carried by the native constants", async () => {
  const source = await readFile(new URL("../../crates/protocol/src/lib.rs", import.meta.url), "utf8");
  assert.match(source, new RegExp(`pub const VERSION: u8 = ${PROTOCOL_VERSION};`));
  assert.equal(examples.snapshot.version, PROTOCOL_VERSION);
  assert.equal(examples.gesture.version, PROTOCOL_VERSION);
});

test("terminal failure and completion examples agree with the contract", () => {
  assert.ok(ERROR_CODES.includes(examples.failed.error.code));
  assert.equal(examples.completed.bytesTransferred, examples.completed.file.sizeBytes);
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length);
});
