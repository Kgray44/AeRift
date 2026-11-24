import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, qualify } from "./capture.mjs";

const tab = { id: 9, active: true, incognito: false, url: "https://example.test/a" };
const state = { documentId: "alpha", frameId: 0, result: { url: tab.url, selection: "explicit", media: "https://example.test/movie.mp4" } };
test("selection outranks explicit target and active media", () => {
  assert.deepEqual(plan(tab, state, { frameId:0, linkUrl:"https://example.test/secondary" }),
    { version:1, kind:"selection", value:"explicit" });
});
test("target then active media then page: URL references only", () => {
  const clear = { ...state, result:{ ...state.result, selection:"" } };
  assert.equal(plan(tab, clear, { frameId:0, srcUrl:"https://example.test/photo.png" }).kind,"target");
  assert.equal(plan(tab, clear, { srcUrl:"https://example.test/photo.png" }).kind,"target");
  assert.equal(plan(tab, clear).kind,"media");
  assert.equal(plan(tab, { ...state, result:{ url:tab.url } }).kind,"page");
  assert.equal(plan(tab, clear, { frameId:0, linkUrl:"javascript:noop()" }),null);
});
test("incognito, subframes, editable contexts and navigation are rejected", () => {
  assert.equal(qualify({...tab, incognito:true}),false);
  assert.equal(plan(tab, {...state, frameId:1}),null);
  assert.equal(plan(tab, {...state, result:{...state.result, sensitive:true}}),null);
  assert.equal(plan({...tab,url:"https://example.test/b"},state),null);
  assert.equal(plan(tab,{...state,result:{...state.result, selection:"x".repeat(16385)}}),null);
});
