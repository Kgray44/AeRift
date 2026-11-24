# Reversible Desktop Workspace qualification

Baseline `e8cab6efff8e4f100ff582b2ef7d945de3fcd64e`. No IndexedDB version, object-store, or record-shape change. Use the existing v1 canonical database across both builds. A persistent projection cannot detect an unchanged installed tester binary updating a same-ID record; an IndexedDB v2 sidecar would block that binary on rollback. The v2 experiment is not the release candidate.

```sh
scratch="$(mktemp -d)"
npm install --prefix "$scratch" --no-save --ignore-scripts fake-indexeddb@6.2.4
AERIFT_IDB_MODULE="$scratch/node_modules/fake-indexeddb/build/esm/index.js" \
  node scripts/measure-workspace-metadata.mjs e8cab6ef
```

Actual TypeScript functions run on an IndexedDB-compatible implementation. The seed has 642 v1 records: 640 one-MiB binary assets, one collection and one unknown-schema record with an asset. The old list returns 642 rows exposing 641 MiB of Blob handles in one request. The candidate asks for at most 128 rows per request; in this fixture the largest result exposes 128 MiB of handles. This is a row cap, not a universal byte cap. Total handle sizes still sum to 641 MiB across six calls. The result kept by the UI carries metadata and booleans, not asset handles. An explicit preview reads one asset by key. The category mounts at most 48 rows per page, preserves cross-page selection and retains the complete metadata catalog for counts and collection references.

The old→new→old→new fixture checks same records/order, canonical checksum and media type, unknown-record survival, and an old writer's update/delete becoming visible to the candidate. A synthetic synchronous write failure after a staged deletion aborts the transaction rather than partially committing. Browser fixture covers 52 imports, paging, selection, category counts, v1-only reopening/read/write and the candidate reloading writes. It requires actual hosted Chromium qualification on the exact candidate; not run here. No claim about browser heap, disk I/O, migration throughput, or installed WebView performance.
