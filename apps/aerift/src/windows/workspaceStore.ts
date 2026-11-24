import { decodeObject, serializeObject, type DigitalObject } from "@aerift/app-contract/digital-objects";

export interface WorkspaceEntry {
  object: DigitalObject;
  asset?: Blob;
}

export interface WorkspaceMetadata {
  object: DigitalObject;
  hasAsset: boolean;
}

interface StoredEntry {
  id: string;
  document: string;
  asset?: Blob;
}

const objects = "objects";
const pageSize = 128;

let database: Promise<IDBDatabase> | undefined;

function openWorkspace() {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      // Keep the exact installed tester schema. A metadata sidecar cannot be
      // kept in sync by older writers, and bumping the version blocks rollback.
      const request = indexedDB.open("aerift.desktop.workspace", 1);
      request.onupgradeneeded = () => request.result.createObjectStore(objects, { keyPath: "id" });
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

export async function loadWorkspace(): Promise<WorkspaceMetadata[]> {
  const db = await openWorkspace();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(objects);
    const store = tx.objectStore(objects);
    const result: WorkspaceMetadata[] = [];
    tx.onabort = () => reject(tx.error ?? new Error("Workspace list aborted"));
    tx.oncomplete = () => resolve(result);
    function page(after?: string) {
      const request = store.getAll(after === undefined ? undefined : IDBKeyRange.lowerBound(after, true), pageSize);
      request.onsuccess = () => {
        const rows = request.result as StoredEntry[];
        for (const row of rows) {
          const object = decodeObject(row.document);
          if (object) result.push({ object, hasAsset: !!row.asset });
        }
        if (rows.length === pageSize) page(rows[rows.length - 1].id);
      };
    }
    page();
  });
}

export async function loadWorkspaceAsset(id: string): Promise<Blob | undefined> {
  const db = await openWorkspace();
  return new Promise((resolve, reject) => {
    const request = db.transaction(objects).objectStore(objects).get(id);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve((request.result as StoredEntry | undefined)?.asset);
  });
}

export async function applyWorkspaceChanges(entries: readonly WorkspaceEntry[], deleted: readonly string[] = []) {
  const rows = entries.map(({ object, asset }): StoredEntry => ({
    id: object.id, document: serializeObject(object), asset,
  }));
  const db = await openWorkspace();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(objects, "readwrite");
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Workspace write aborted"));
    const store = transaction.objectStore(objects);
    try {
      for (const id of deleted) store.delete(id);
      for (const row of rows) store.put(row);
    } catch (error) {
      transaction.abort();
      reject(error);
    }
  });
}
