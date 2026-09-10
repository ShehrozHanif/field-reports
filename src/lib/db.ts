import type { QueueItem } from './sync-core.mjs';

/**
 * The queue lives in IndexedDB, not in React state and not in memory.
 *
 * That is the whole reason it survives a hard close: the brief asks for the
 * queue to come back after the tab (or the browser, or the app) is killed and
 * relaunched, which rules out anything that only exists while the page does.
 * localStorage would technically survive too, but it is synchronous, string
 * only, and small - IndexedDB is the right shape for a growing outbox.
 */

const DB_NAME = 'field-reports';
const DB_VERSION = 1;
const STORE = 'outbox';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // Keyed by client_report_id, so writing the same report twice can only
        // ever overwrite one row. The queue cannot fork by accident.
        db.createObjectStore(STORE, { keyPath: 'client_report_id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  });
  return dbPromise;
}

function run<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

export function readAll(): Promise<QueueItem[]> {
  return run<QueueItem[]>('readonly', (s) => s.getAll());
}

export function write(item: QueueItem): Promise<unknown> {
  return run('readwrite', (s) => s.put(item));
}

export function remove(clientReportId: string): Promise<unknown> {
  return run('readwrite', (s) => s.delete(clientReportId));
}

export function supported(): boolean {
  return typeof indexedDB !== 'undefined';
}
