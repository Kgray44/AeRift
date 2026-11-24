import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const path = "apps/aerift/src/windows/workspaceStore.ts", baseline = process.argv[2];
if (!baseline) throw new Error("Pass a baseline Git revision.");
const { IDBFactory, IDBObjectStore, IDBKeyRange } = await import(process.env.AERIFT_IDB_MODULE
  ? pathToFileURL(process.env.AERIFT_IDB_MODULE).href : "fake-indexeddb");
globalThis.IDBKeyRange = IDBKeyRange;
function load(source, dependency) {
  const out = {};
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  new Function("exports", "require", outputText)(out, () => dependency);
  return out;
}
const contract = load(readFileSync("packages/app-contract/src/digital-objects.ts", "utf8"));
const oldSource = execFileSync("git", ["show", baseline + ":" + path], { encoding: "utf8" });
const before = load(oldSource, contract);
const candidate = load(readFileSync(path, "utf8"), contract);
const name = "aerift.desktop.workspace";
const result = req => new Promise((resolve, reject) => {
  req.addEventListener("success", () => resolve(req.result));
  req.addEventListener("error", () => reject(req.error));
});
const blob = new Blob([Buffer.alloc(1024 * 1024, 37)], { type: "application/pdf" });
const binary = id => ({ id, name: id + ".pdf", schemaVersion: 1, ownership: "local", kind: "file", sizeBytes: blob.size });
const record = (object, asset) => ({ id: object.id, document: contract.serializeObject(object), asset });
const digest = async value => createHash("sha256").update(Buffer.from(await value.arrayBuffer())).digest("hex");
const bundle = { id: "bundle", schemaVersion: 1, ownership: "local", kind: "collection", name: "Bundle", itemIds: ["asset-0001", "asset-0639"] };

async function seed() {
  globalThis.indexedDB = new IDBFactory();
  const open = indexedDB.open(name, 1);
  open.onupgradeneeded = () => open.result.createObjectStore("objects", { keyPath: "id" });
  const db = await result(open);
  const tx = db.transaction("objects", "readwrite"), store = tx.objectStore("objects");
  const done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
  for (let i = 0; i < 640; i++) {
    const id = "asset-" + String(i).padStart(4, "0");
    store.put(record(i % 3 ? binary(id) : { ...binary(id), name: id + ".png", kind: "photo" }, blob));
  }
  store.put(record(bundle));
  store.put({ id: "future", document: '{"schemaVersion":99}', asset: blob });
  await done;
  db.close();
}

const meters = [];
for (const method of ["get", "getAll"]) {
  const native = IDBObjectStore.prototype[method];
  IDBObjectStore.prototype[method] = function (...args) {
    const request = native.apply(this, args);
    request.addEventListener("success", () => {
      const rows = [].concat(request.result ?? []);
      meters.push({ store: this.name, method, limit: args[1] ?? null, rows: rows.length,
        blobBytes: rows.reduce((sum, row) => sum + (row.asset?.size ?? 0), 0) });
    });
    return request;
  };
}

await seed();
const initial = await before.loadWorkspace();
const [legacyRead] = meters.splice(0);
assert.equal(legacyRead.blobBytes, 641 * blob.size);
await seed();
const metadata = await candidate.loadWorkspace();
assert.deepEqual(metadata.map(row => row.object), initial.map(row => row.object), "same objects and order");
assert.equal(metadata.filter(row => row.hasAsset).length, 640);
const listing = meters.splice(0);
assert.equal(listing.length, 6);
assert.ok(listing.every(row => row.store === "objects" && row.limit === 128 && row.rows <= 128 && row.blobBytes <= 128 * blob.size));
assert.equal(listing.reduce((sum, row) => sum + row.blobBytes, 0), legacyRead.blobBytes);
assert.ok(metadata.every(row => !("asset" in row)));
const saved = await candidate.loadWorkspaceAsset("asset-0001");
assert.equal(saved.type, blob.type);
assert.equal(await digest(saved), await digest(blob));
const [preview] = meters.splice(0);
assert.equal(preview.blobBytes, blob.size);
await candidate.applyWorkspaceChanges([{ object: { ...bundle, itemIds: ["asset-0639"] } }], ["asset-0001"]);
assert.equal(await candidate.loadWorkspaceAsset("asset-0001"), undefined);
assert.deepEqual((await candidate.loadWorkspace()).find(row => row.object.id === bundle.id).object.itemIds, ["asset-0639"]);
await candidate.applyWorkspaceChanges([{ object: binary("new-file"), asset: blob }]);
assert.equal((await candidate.loadWorkspace()).find(row => row.object.id === "new-file").hasAsset, true);
assert.equal(await digest(await candidate.loadWorkspaceAsset("new-file")), await digest(blob));

const put = IDBObjectStore.prototype.put;
IDBObjectStore.prototype.put = function (row, ...args) {
  if (this.name === "objects" && row.id === "bad-write") throw new Error("Synthetic canonical write failure");
  return put.call(this, row, ...args);
};
await assert.rejects(candidate.applyWorkspaceChanges([{ object: binary("bad-write"), asset: blob }], ["new-file"]));
IDBObjectStore.prototype.put = put;
assert.equal(await candidate.loadWorkspaceAsset("bad-write"), undefined);
assert.equal(await digest(await candidate.loadWorkspaceAsset("new-file")), await digest(blob));
const priorInstalledBuild = load(oldSource, contract);
const priorList = await priorInstalledBuild.loadWorkspace();
assert.equal(priorList.length, 641);
assert.equal(await digest(priorList.find(row => row.object.id === "new-file").asset), await digest(blob));
assert.ok(!priorList.some(row => row.object.id === "bad-write"));
await priorInstalledBuild.applyWorkspaceChanges([
  { object: { ...binary("new-file"), name: "Edited by the prior build.pdf" }, asset: blob },
], ["asset-0639"]);
const reopened = await candidate.loadWorkspace();
assert.equal(reopened.find(row => row.object.id === "new-file").object.name, "Edited by the prior build.pdf");
assert.ok(!reopened.some(row => row.object.id === "asset-0639"));
const db = await result(indexedDB.open(name, 1));
assert.equal(db.version, 1);
assert.deepEqual([...db.objectStoreNames], ["objects"]);
const unknown = await result(db.transaction("objects").objectStore("objects").get("future"));
assert.equal(unknown.document, '{"schemaVersion":99}');
assert.equal(await digest(unknown.asset), await digest(blob));
db.close();
console.log(JSON.stringify({ legacyRead, listing, preview }, null, 2));
