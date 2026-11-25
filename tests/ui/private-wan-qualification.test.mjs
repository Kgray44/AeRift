import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const assets = new URL("../../apps/aerift/src-tauri/src/wan_qualification_assets/", import.meta.url);
const read = name => readFileSync(new URL(name, assets), "utf8");

function mockWindow() {
  function element(id) {
    return {
      value: "", checked: false, hidden: false, textContent: "", children: [],
      replaceChildren() { this.children = []; },
      append(...children) { this.children.push(...children); },
      reset() {
        for (const child of ({ create: ["their-card", "recipient-verified"],
          redeem: ["issuer-card", "their-invite", "issuer-verified"] })[id] ?? []) {
          get(child).value = ""; get(child).checked = false;
        }
      },
      select() {},
    };
  }
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const eventHandlers = new Map();
  const calls = [];
  const snap = {
    type: "snapshot", card: "synthetic-device-card",
    pending: { request: "synthetic-request", device: { name: "Known device", id: "known" } },
    devices: [{ id: "known", name: "Known device" }],
    offers: [{ peer: "known", offer: "synthetic-offer", name: "<fixture>", size: 5, state: "pending" }],
  };
  const window = {
    __TAURI_INTERNALS__: { async invoke(name, { action }) {
      calls.push([name, JSON.parse(JSON.stringify(action))]);
      if (action.type === "snapshot") return snap;
      if (action.type === "createInvite") return { type: "invitation", code: "synthetic-private-code" };
      if (action.type === "chooseAndSend") return { type: "sent", status: { state: "completed" } };
      return { type: "acknowledged" };
    }},
    addEventListener: (name, callback) => eventHandlers.set(name, callback),
    confirm: () => true,
  };
  const document = { getElementById: get, createElement: element,
    hidden: false, addEventListener: () => {} };
  vm.runInNewContext(read("remote-wan.js"), {
    window, document, navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: () => 1, setInterval: () => 1, clearTimeout() {}, clearInterval() {},
  });
  return { get, calls, eventHandlers };
}

const advance = () => new Promise(resolve => setImmediate(resolve));

test("qualification document drives the native wire and scrubs invitation fields", async () => {
  const { get, calls, eventHandlers } = mockWindow();
  const event = { preventDefault() {} };
  await advance();

  get("their-card").value = "recipient-card";
  get("recipient-verified").checked = true;
  get("create").onsubmit(event);
  await advance();
  assert.equal(get("my-invite").value, "synthetic-private-code");

  get("issuer-card").value = "issuer-card";
  get("issuer-verified").checked = true;
  get("their-invite").value = "private-proof";
  get("redeem").onsubmit(event);
  assert.equal(get("their-invite").value, "");
  await advance();

  get("pairing").children[0].children[1].onclick();
  await advance();
  assert.equal(get("my-invite").value, "");
  get("devices").children[0].children[1].onclick();
  await advance();
  get("offers").children[0].children[1].onclick();
  await advance();
  get("offers").children[0].children[2].onclick();
  await advance();

  assert.deepEqual(calls.filter(([, action]) => action.type !== "snapshot"), [
    ["private_wan_action", { type: "createInvite", card: "recipient-card", verified: true }],
    ["private_wan_action", { type: "redeem", issuerCard: "issuer-card", code: "private-proof", verified: true }],
    ["private_wan_action", { type: "pairDecision", request: "synthetic-request", allow: true }],
    ["private_wan_action", { type: "chooseAndSend", peer: "known" }],
    ["private_wan_action", { type: "offerDecision", peer: "known", offer: "synthetic-offer", allow: true }],
    ["private_wan_action", { type: "offerDecision", peer: "known", offer: "synthetic-offer", allow: false }],
  ]);
  eventHandlers.get("pagehide")();
  assert.equal(get("new-invite").hidden, true);
  assert.equal(get("their-invite").value, "");
});

test("assets are embedded only in the dedicated Windows feature, with no external scripts or storage", () => {
  const native = readFileSync(new URL("../private_remote_wan_qualification.rs", assets), "utf8");
  const lib = readFileSync(new URL("../lib.rs", assets), "utf8");
  assert.match(lib, /cfg\(all\(windows, feature = "private-remote-wan-host"\)\)\]\s*mod private_remote_wan_qualification;/);
  assert.match(native, /context\.set_assets\(Box::new\(QualificationAssets\)\)/);
  assert.match(native, /generate_handler!\[private_wan_action\]/);
  assert.match(native, /window\.label\(\) != WINDOW \|\| !window\.url/);
  assert.match(native, /url\.path\(\) == DOCUMENT_PATH/);
  assert.match(native, /blocking_pick_file\(\)/);
  assert.doesNotMatch(read("remote-wan.html"), /(?:href|src)=["']https?:/);
  assert.doesNotMatch(read("remote-wan.js"), /innerHTML|localStorage|sessionStorage|indexedDB|console\./);
});
