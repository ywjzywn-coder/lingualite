/**
 * 翻译缓存（IndexedDB）。
 *
 * 只在 Service Worker 中使用：内容脚本运行在页面源下，其 IndexedDB 属于页面而非扩展，
 * 读写会互相污染，因此缓存统一由 SW 持有。
 */

const DB_NAME = 'lingualite';
const DB_VERSION = 1;
const STORE = 'translations';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ROWS = 20000;

export interface CacheRow {
  key: string;
  texts: string[];
  engine: string;
  createdAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function promisify<T>(req: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

export async function cacheGetMany(keys: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (keys.length === 0) return out;
  const db = await openDb();
  if (!db) return out;
  try {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    await Promise.all(
      keys.map(async (key) => {
        const row = (await promisify(store.get(key))) as CacheRow | null;
        if (row && Array.isArray(row.texts)) out.set(key, row.texts);
      }),
    );
  } catch {
    // 缓存失败不影响主流程
  }
  return out;
}

export async function cachePutMany(rows: CacheRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const row of rows) store.put(row);
  } catch {
    // 忽略
  }
}

export async function cacheClear(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
  } catch {
    // 忽略
  }
}

/** 淘汰过期与超额记录。SW 启动时调用一次即可。 */
export async function cachePrune(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const count = (await promisify(db.transaction(STORE, 'readonly').objectStore(STORE).count())) ?? 0;
    if (count > MAX_ROWS) {
      // 超出上限时按创建时间从旧到新删除，直到回到上限以内。
      const tx = db.transaction(STORE, 'readwrite');
      const index = tx.objectStore(STORE).index('createdAt');
      let removed = 0;
      const target = count - MAX_ROWS;
      await new Promise<void>((resolve) => {
        const cursorReq = index.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor || removed >= target) {
            resolve();
            return;
          }
          cursor.delete();
          removed += 1;
          cursor.continue();
        };
        cursorReq.onerror = () => resolve();
      });
      return;
    }
    const cutoff = Date.now() - MAX_AGE_MS;
    const tx = db.transaction(STORE, 'readwrite');
    const index = tx.objectStore(STORE).index('createdAt');
    await new Promise<void>((resolve) => {
      const cursorReq = index.openCursor(IDBKeyRange.upperBound(cutoff));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          resolve();
          return;
        }
        cursor.delete();
        cursor.continue();
      };
      cursorReq.onerror = () => resolve();
    });
  } catch {
    // 忽略
  }
}
