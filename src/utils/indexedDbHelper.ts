import { openDB, type IDBPDatabase } from "idb";

// ===== 2 database tách biệt =====
// - Local per-tab (mỗi "máy" một bản): WebGIS_Local_<clientId> -> features + tile cache của riêng tab.
// - Shared (server chung mọi tab): WebGIS_Shared -> server-records + meta(seq).
const LOCAL_DB_PREFIX = "WebGIS_Local_";
const SHARED_DB_NAME = "WebGIS_Shared";
const DB_VERSION = 1;

export const FEATURES_STORE = "offline-features";
export const TILE_STORE = "tile-cache";
export const SERVER_STORE = "server-records";
export const META_STORE = "meta";

// clientId per-tab: sessionStorage (mỗi tab một giá trị; sống qua reload, mất khi đóng tab).
const CLIENT_ID_KEY = "offline-clientId";
export const getClientId = (): string => {
  let id = sessionStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
};

// Hình học hỗ trợ vẽ offline: điểm khảo sát + vùng (polygon).
export type OfflineGeometry =
  | { type: "Point"; coordinates: [number, number] }
  | { type: "Polygon"; coordinates: [number, number][][] };

// Bản ghi là GeoJSON Feature hợp lệ (có `type:"Feature"`) để setData thẳng vào MapLibre.
export interface OfflineFeature {
  type: "Feature";
  id: string; // UUID toàn cục (crypto.randomUUID) -> không trùng giữa các máy
  geometry: OfflineGeometry;
  properties: {
    id: string; // lặp lại id ở properties để dùng trong filter expression của layer
    clientId: string; // máy tạo/giữ bản sao này
    kind: "point" | "polygon";
    note: string;
    createdAt: number;
    updatedAt: number;
    deleted: boolean; // tombstone (xoá mềm để lan truyền qua sync)
    // --- Trạng thái đồng bộ ---
    synced: boolean; // đã đẩy về server thành công chưa
    baseVersion: number; // version server mà bản local này dựa trên (0 = bản ghi mới)
    seq: number; // seq server gần nhất đã biết của bản ghi này (0 nếu chưa lên server)
    conflict: boolean; // server đã đổi version cao hơn baseVersion -> cần người dùng xử lý
    serverVersion?: number; // version server báo về khi conflict
    serverNote?: string; // nội dung phía server khi conflict (để so sánh / lấy về)
  };
}

// Mở local DB riêng cho 1 tab (stores: features + tile-cache).
export const openLocalDb = async (clientId: string): Promise<IDBPDatabase> => {
  return openDB(`${LOCAL_DB_PREFIX}${clientId}`, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(FEATURES_STORE)) db.createObjectStore(FEATURES_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(TILE_STORE)) db.createObjectStore(TILE_STORE);
    },
  });
};

// Mở shared DB (server chung): server-records + meta.
export const openSharedDb = async (): Promise<IDBPDatabase> => {
  return openDB(SHARED_DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(SERVER_STORE)) db.createObjectStore(SERVER_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
    },
  });
};

// ----------------------- Feature CRUD (local DB) -----------------------

export const saveFeatureOffline = async (db: IDBPDatabase, feature: OfflineFeature) => {
  await db.put(FEATURES_STORE, feature);
};

export const getAllFeatures = async (db: IDBPDatabase): Promise<OfflineFeature[]> => {
  return db.getAll(FEATURES_STORE);
};

export const getFeature = async (db: IDBPDatabase, id: string): Promise<OfflineFeature | undefined> => {
  return db.get(FEATURES_STORE, id);
};

// Hàng đợi sync = chưa synced VÀ không đang conflict (conflict đợi người dùng xử lý thủ công).
export const getUnsyncedFeatures = async (db: IDBPDatabase): Promise<OfflineFeature[]> => {
  const all: OfflineFeature[] = await db.getAll(FEATURES_STORE);
  return all.filter((f) => !f.properties.synced && !f.properties.conflict);
};

// Helper đọc-sửa-ghi trong 1 transaction.
const mutate = async (db: IDBPDatabase, id: string, fn: (f: OfflineFeature) => void) => {
  const tx = db.transaction(FEATURES_STORE, "readwrite");
  const store = tx.objectStore(FEATURES_STORE);
  const f: OfflineFeature | undefined = await store.get(id);
  if (f) {
    fn(f);
    await store.put(f);
  }
  await tx.done;
};

// Ghi đè/chèn 1 feature (dùng khi merge dữ liệu pull về từ server).
export const upsertLocal = async (db: IDBPDatabase, feature: OfflineFeature) => {
  await db.put(FEATURES_STORE, feature);
};

// Sync thành công: chốt baseVersion = version server, lưu seq, bỏ cờ conflict.
export const markAsSynced = async (db: IDBPDatabase, id: string, serverVersion: number, seq: number) => {
  await mutate(db, id, (f) => {
    f.properties.synced = true;
    f.properties.conflict = false;
    f.properties.baseVersion = serverVersion;
    f.properties.seq = seq;
    f.properties.serverVersion = undefined;
    f.properties.serverNote = undefined;
  });
};

// Đánh dấu conflict: lưu version + nội dung server để UI cho người dùng đối chiếu.
export const markConflict = async (db: IDBPDatabase, id: string, serverVersion: number, serverNote: string) => {
  await mutate(db, id, (f) => {
    f.properties.synced = false;
    f.properties.conflict = true;
    f.properties.serverVersion = serverVersion;
    f.properties.serverNote = serverNote;
  });
};

// Sửa ghi chú -> đưa lại vào hàng đợi (synced=false), giữ baseVersion để phát hiện conflict khi đẩy lên.
export const updateNote = async (db: IDBPDatabase, id: string, note: string) => {
  await mutate(db, id, (f) => {
    f.properties.note = note;
    f.properties.updatedAt = Date.now();
    f.properties.synced = false;
  });
};

// Xoá mềm (tombstone) -> re-queue để lan truyền việc xoá qua sync.
export const markDeleted = async (db: IDBPDatabase, id: string) => {
  await mutate(db, id, (f) => {
    f.properties.deleted = true;
    f.properties.updatedAt = Date.now();
    f.properties.synced = false;
  });
};

// Xử lý xung đột: "local" = giữ bản của tôi (rebase lên serverVersion rồi đẩy lại);
// "server" = lấy bản server (ghi đè note, coi như đã đồng bộ).
export const resolveConflict = async (db: IDBPDatabase, id: string, choice: "local" | "server") => {
  await mutate(db, id, (f) => {
    const sv = f.properties.serverVersion ?? f.properties.baseVersion;
    if (choice === "local") {
      f.properties.baseVersion = sv; // rebase: base = version server hiện tại
      f.properties.conflict = false;
      f.properties.synced = false; // sẽ được sync lại, lần này base khớp -> server chấp nhận
    } else {
      f.properties.note = f.properties.serverNote ?? f.properties.note;
      f.properties.baseVersion = sv;
      f.properties.conflict = false;
      f.properties.synced = true; // chấp nhận bản server, không cần đẩy lên
    }
    f.properties.serverVersion = undefined;
    f.properties.serverNote = undefined;
  });
};

// ----------------------- Tile cache (local DB) -----------------------

export const cacheTile = async (db: IDBPDatabase, url: string, data: ArrayBuffer) => {
  await db.put(TILE_STORE, data, url);
};

export const getCachedTile = async (db: IDBPDatabase, url: string): Promise<ArrayBuffer | undefined> => {
  return db.get(TILE_STORE, url);
};

export const countCachedTiles = async (db: IDBPDatabase): Promise<number> => {
  return db.count(TILE_STORE);
};

export const clearTileCache = async (db: IDBPDatabase) => {
  await db.clear(TILE_STORE);
};
