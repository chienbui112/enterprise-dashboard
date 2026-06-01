// Version store của "server thật" — port từ src/utils/offlineSyncServer.ts sang Node.
// Single-process nên CAS không cần lock (khác Bước 1 phải dựa vào IndexedDB transaction).
// Lưu bền ra data.json (nạp lúc khởi động, ghi lại có debounce).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, "data.json");

// records: { [id]: { id, version, seq, kind, note, geometry, deleted, clientId, updatedAt } }
let records = {};
let seq = 0;

// ----- Persistence -----
const load = () => {
  if (!existsSync(DATA_FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(DATA_FILE, "utf8"));
    records = raw.records ?? {};
    seq = raw.seq ?? 0;
    console.log(`[store] loaded ${Object.keys(records).length} records, seq=${seq}`);
  } catch (e) {
    console.warn("[store] không đọc được data.json, bắt đầu rỗng:", e.message);
  }
};

let saveTimer = null;
const scheduleSave = () => {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      writeFileSync(DATA_FILE, JSON.stringify({ records, seq }, null, 2));
    } catch (e) {
      console.error("[store] ghi data.json lỗi:", e.message);
    }
  }, 300); // debounce
};

load();

// ----- API -----

// CAS: chấp nhận nếu bản ghi mới HOẶC base local khớp version server hiện tại.
export const push = (item) => {
  const rec = records[item.id];
  const base = item.properties.baseVersion;

  if (!rec || rec.version === base) {
    seq += 1;
    const version = (rec?.version ?? 0) + 1;
    records[item.id] = {
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
    scheduleSave();
    return { status: "ok", version, seq };
  }

  return { status: "conflict", serverVersion: rec.version, serverNote: rec.note, serverDeleted: rec.deleted };
};

export const pullSince = (sinceSeq) => {
  const changed = Object.values(records)
    .filter((r) => r.seq > sinceSeq)
    .sort((a, b) => a.seq - b.seq);
  return { changed, maxSeq: seq };
};

// Giả lập đồng nghiệp sửa trên server: tăng version + seq + đổi note cho các id đã có.
export const simulate = (ids) => {
  let changed = 0;
  for (const id of ids) {
    const rec = records[id];
    if (rec) {
      seq += 1;
      rec.version += 1;
      rec.seq = seq;
      rec.note = `[Sửa bởi đồng nghiệp] ${rec.note}`;
      rec.updatedAt = Date.now();
      changed++;
    }
  }
  if (changed) scheduleSave();
  return { changed };
};

export const currentSeq = () => seq;
