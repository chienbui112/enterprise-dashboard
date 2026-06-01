import maplibre, { type Map } from "maplibre-gl";
import { type IDBPDatabase } from "idb";
import { cacheTile, getCachedTile } from "./indexedDbHelper";

// Cache-on-browse: ta đăng ký một custom protocol "offline://" cho raster source.
// MapLibre khai triển {z}/{x}/{y} thành URL cụ thể rồi gọi handler -> ta tra IndexedDB trước,
// online thì fetch + lưu lại, offline (giả lập) thì serve từ cache hoặc trả tile xám fallback.

export const TILE_PROTOCOL = "offline";
// 1 subdomain cố định để URL prefetch trùng khớp URL runtime (cùng cache key).
export const RASTER_URL = `https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png`;
const stripProto = (u: string) => u.replace(`${TILE_PROTOCOL}://`, "");

// Trạng thái mạng "hiệu lực" (gồm cả toggle giả lập). Handler đọc ở đây để biết có được fetch không.
export const netState = { online: typeof navigator !== "undefined" ? navigator.onLine : true };

let _db: IDBPDatabase | null = null;
export const setTileDb = (db: IDBPDatabase) => {
  _db = db;
};

// Tile xám 256px hiển thị khi offline mà chưa có cache (thay vì lỗi/ô trắng).
let _fallback: ArrayBuffer | null = null;
const makeFallbackTile = async (): Promise<ArrayBuffer> => {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#1c1917";
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = "#292524";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, 255, 255);
  ctx.fillStyle = "#44403c";
  ctx.font = "12px sans-serif";
  ctx.fillText("offline · no cache", 12, 24);
  const blob: Blob = await new Promise((res) => canvas.toBlob((b) => res(b!), "image/png"));
  return blob.arrayBuffer();
};

let _registered = false;
export const registerOfflineTileProtocol = async () => {
  if (_registered) return;
  _fallback ||= await makeFallbackTile();
  _registered = true;

  maplibre.addProtocol(TILE_PROTOCOL, async (params: { url: string }) => {
    const url = stripProto(params.url);

    // 1. Có trong cache -> trả ngay (đây là thứ giúp xem được vùng đã duyệt khi offline)
    if (_db) {
      const hit = await getCachedTile(_db, url);
      if (hit) return { data: hit };
    }

    // 2. Không cache + đang offline -> tile fallback xám (không làm vỡ bản đồ)
    if (!netState.online) return { data: _fallback!.slice(0) };

    // 3. Online -> fetch thật rồi lưu vào IndexedDB cho lần offline sau
    try {
      const resp = await fetch(url);
      const buf = await resp.arrayBuffer();
      if (_db) await cacheTile(_db, url, buf);
      return { data: buf };
    } catch {
      return { data: _fallback!.slice(0) };
    }
  });
};

export const unregisterOfflineTileProtocol = () => {
  if (!_registered) return;
  maplibre.removeProtocol(TILE_PROTOCOL);
  _registered = false;
};

// ----------------------- Slippy-map tile math -----------------------

const lon2tileX = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2tileY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};
const tileUrl = (z: number, x: number, y: number) => RASTER_URL.replace("{z}", `${z}`).replace("{x}", `${x}`).replace("{y}", `${y}`);

// "Tải vùng này": prefetch toàn bộ tile của viewport hiện tại (zoom hiện tại + 1 mức) vào IndexedDB.
// Trả về tiến trình qua onProgress; giới hạn số tile để tránh tải quá tay.
export const prefetchViewport = async (
  map: Map,
  onProgress?: (done: number, total: number) => void,
): Promise<{ cached: number; total: number }> => {
  if (!_db) return { cached: 0, total: 0 };

  const b = map.getBounds();
  const baseZ = Math.min(Math.round(map.getZoom()), 16);

  // Gom danh sách tile của 2 mức zoom (baseZ, baseZ+1).
  const urls: string[] = [];
  for (let z = baseZ; z <= baseZ + 1; z++) {
    const xMin = lon2tileX(b.getWest(), z);
    const xMax = lon2tileX(b.getEast(), z);
    const yMin = lat2tileY(b.getNorth(), z); // bắc -> y nhỏ
    const yMax = lat2tileY(b.getSouth(), z);
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) urls.push(tileUrl(z, x, y));
    }
  }

  // Cap an toàn: nếu quá nhiều (zoom quá xa) thì chỉ lấy mức zoom hiện tại.
  const MAX = 400;
  const list = urls.length > MAX ? urls.slice(0, MAX) : urls;
  const total = list.length;

  let done = 0;
  let cached = 0;
  for (const url of list) {
    try {
      const existing = await getCachedTile(_db, url);
      if (!existing) {
        const resp = await fetch(url);
        const buf = await resp.arrayBuffer();
        await cacheTile(_db, url, buf);
      }
      cached++;
    } catch {
      // bỏ qua tile lỗi (vd offline) — vẫn tiếp tục các tile khác
    }
    done++;
    onProgress?.(done, total);
  }

  return { cached, total };
};
