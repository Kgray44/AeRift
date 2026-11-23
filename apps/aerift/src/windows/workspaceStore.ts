import { decodeObject, serializeObject, type DigitalObject } from "@aerift/app-contract/digital-objects";

export interface WorkspaceEntry {
  object: DigitalObject;
  asset?: Blob;
}

interface StoredEntry {
  id: string;
  document: string;
  asset?: Blob;
}

let database: Promise<IDBDatabase> | undefined;

function openWorkspace() {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("aerift.desktop.workspace", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("objects", { keyPath: "id" });
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          database = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    }).catch(error => {
      database = undefined;
      throw error;
    });
  }
  return database;
}

export async function loadWorkspace(): Promise<WorkspaceEntry[]> {
  const db = await openWorkspace();
  return new Promise((resolve, reject) => {
    const request = db.transaction("objects").objectStore("objects").getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve((request.result as StoredEntry[]).flatMap(row => {
      const object = decodeObject(row.document);
      return object ? [{ object, asset: row.asset }] : [];
    }));
  });
}

export async function applyWorkspaceChanges(entries: readonly WorkspaceEntry[], deleted: readonly string[] = []) {
  const rows = entries.map(({ object, asset }): StoredEntry => ({
    id: object.id, document: serializeObject(object), asset,
  }));
  const db = await openWorkspace();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("objects", "readwrite");
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Workspace write aborted"));
    const store = transaction.objectStore("objects");
    for (const id of deleted) store.delete(id);
    for (const row of rows) store.put(row);
  });
}
