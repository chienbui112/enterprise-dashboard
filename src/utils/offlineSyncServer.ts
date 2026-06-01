import { type IDBPDatabase } from "idb";
import { SERVER_STORE, META_STORE, type OfflineFeature, type OfflineGeometry } from "./indexedDbHelper";

// "Server" nay nằm trong shared IndexedDB DB (WebGIS_Shared) -> mọi tab dùng chung.
// Transaction readwrite của IndexedDB được serialize giữa các kết nối (tab) trên cùng store,
// nên kiểm-version-rồi-ghi (CAS) là nguyên tử giữa các tab.

const SEQ_KEY = "seq";

export interface ServerRecord {
  id: string;
  version: number;
  seq: number; // số thứ tự thay đổi toàn cục (để pull theo since)
  kind: "point" | "polygon";
  note: string;
  geometry: OfflineGeometry;
  deleted: boolean;
  clientId: string; // máy ghi bản này gần nhất
  updatedAt: number;
}

export type SyncResult =
  | { status: "ok"; version: number; seq: number }
  | { status: "conflict"; serverVersion: number; serverNote: string; serverDeleted: boolean };

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Đẩy 1 feature lên server. CAS: chấp nhận nếu bản ghi mới HOẶC base local khớp version server.
export const pushToServer = async (sharedDb: IDBPDatabase, item: OfflineFeature): Promise<SyncResult> => {
  await delay(400); // giả lập độ trễ mạng — TRƯỚC khi mở txn (await ngoài-IDB sẽ đóng txn)

  const tx = sharedDb.transaction([SERVER_STORE, META_STORE], "readwrite");
  const serverStore = tx.objectStore(SERVER_STORE);
  const metaStore = tx.objectStore(META_STORE);

  const rec: ServerRecord | undefined = await serverStore.get(item.id);
  const base = item.properties.baseVersion;

  if (!rec || rec.version === base) {
    const seq = ((await metaStore.get(SEQ_KEY)) ?? 0) + 1;
    await metaStore.put(seq, SEQ_KEY);
    const version = (rec?.version ?? 0) + 1;
    const next: ServerRecord = {
      id: item.id,
      version,
      seq,
      kind: item.properties.kind,
      note: item.properties.note,
      geometry: item.geometry,
      deleted: item.properties.deleted,
      clientId: item.properties.clientId,
      updatedAt: Date.now(),
    };
    await serverStore.put(next);
    await tx.done;
    return { status: "ok", version, seq };
  }

  await tx.done;
  return { status: "conflict", serverVersion: rec.version, serverNote: rec.note, serverDeleted: rec.deleted };
};

// Lấy mọi thay đổi server có seq > sinceSeq (kể cả của máy khác) + seq lớn nhất hiện tại.
export const pullChanges = async (sharedDb: IDBPDatabase, sinceSeq: number): Promise<{ changed: ServerRecord[]; maxSeq: number }> => {
  const all: ServerRecord[] = await sharedDb.getAll(SERVER_STORE);
  const changed = all.filter((r) => r.seq > sinceSeq).sort((a, b) => a.seq - b.seq);
  const maxSeq = (await sharedDb.get(META_STORE, SEQ_KEY)) ?? 0;
  return { changed, maxSeq };
};

export const getServerSeq = async (sharedDb: IDBPDatabase): Promise<number> => {
  return (await sharedDb.get(META_STORE, SEQ_KEY)) ?? 0;
};

// Mô phỏng "đồng nghiệp khác sửa trên server": tăng version + seq + đổi note cho các id đã có.
// Ghi vào shared DB nên các tab khác (online) sẽ pull thấy; tab có sửa-dở cùng bản ghi sẽ va conflict.
export const simulateServerEdit = async (sharedDb: IDBPDatabase, ids: string[]): Promise<number> => {
  const tx = sharedDb.transaction([SERVER_STORE, META_STORE], "readwrite");
  const serverStore = tx.objectStore(SERVER_STORE);
  const metaStore = tx.objectStore(META_STORE);
  let changed = 0;
  let seq = (await metaStore.get(SEQ_KEY)) ?? 0;
  for (const id of ids) {
    const rec: ServerRecord | undefined = await serverStore.get(id);
    if (rec) {
      seq += 1;
      rec.version += 1;
      rec.seq = seq;
      rec.note = `[Sửa bởi đồng nghiệp] ${rec.note}`;
      rec.updatedAt = Date.now();
      await serverStore.put(rec);
      changed++;
    }
  }
  await metaStore.put(seq, SEQ_KEY);
  await tx.done;
  return changed;
};
