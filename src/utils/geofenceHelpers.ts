import type { Feature, FeatureCollection, Polygon } from "geojson";

// ============================================================================
// Cấu hình dashboard Geofencing — phiên bản "diện tích lớn" (toàn Việt Nam).
// ============================================================================
export const VEHICLE_COUNT = 50_000;
export const GEOFENCE_COUNT = 1_000;

// Bbox bao toàn bộ Việt Nam (đất liền): [minLng, minLat, maxLng, maxLat].
export const VIETNAM_BBOX: [number, number, number, number] = [102.0, 8.0, 110.0, 23.6];
// Worker dùng bbox này cho tick đầu (trước khi map gửi viewport thật) + làm phạm vi cho grid index.
export const INITIAL_BBOX: [number, number, number, number] = VIETNAM_BBOX;
export const VN_CENTER: [number, number] = [106.5, 16.0];

// Bán kính "lượn" của mỗi xe quanh nhà (độ) — xe đổi đích trong phạm vi này khi tới nơi.
export const ROAM_RADIUS = 0.12;

// Lưới spatial index: ô ~0.3° -> ~27×52 ≈ 1.400 ô cho cả nước, mỗi ô chứa rất ít vùng cấm.
export const GRID_CELL_DEG = 0.3;

// Các cụm đô thị (anchor) rải Bắc -> Nam, kèm trọng số ~ quy mô (HN/HCM đông hơn).
// Xe & vùng cấm cùng bám quanh anchor -> đảm bảo có nhiều sự kiện ra/vào thay vì rải đều ra biển.
const CITY_ANCHORS: { lng: number; lat: number; weight: number }[] = [
  { lng: 105.83, lat: 21.03, weight: 5 }, // Hà Nội
  { lng: 106.68, lat: 20.86, weight: 2 }, // Hải Phòng
  { lng: 105.78, lat: 19.8, weight: 1 }, // Thanh Hóa
  { lng: 105.69, lat: 18.68, weight: 1 }, // Vinh
  { lng: 107.59, lat: 16.46, weight: 1 }, // Huế
  { lng: 108.22, lat: 16.05, weight: 3 }, // Đà Nẵng
  { lng: 109.22, lat: 13.78, weight: 1 }, // Quy Nhơn
  { lng: 109.19, lat: 12.24, weight: 1 }, // Nha Trang
  { lng: 108.44, lat: 11.94, weight: 1 }, // Đà Lạt
  { lng: 106.7, lat: 10.78, weight: 5 }, // TP. Hồ Chí Minh
  { lng: 107.08, lat: 10.35, weight: 1 }, // Vũng Tàu
  { lng: 105.78, lat: 10.03, weight: 1 }, // Cần Thơ
];

// Bảng tích lũy trọng số để bốc anchor theo phân phối (xác suất ~ weight).
const WEIGHT_TOTAL = CITY_ANCHORS.reduce((s, a) => s + a.weight, 0);
const pickAnchor = (): { lng: number; lat: number } => {
  let r = Math.random() * WEIGHT_TOTAL;
  for (const a of CITY_ANCHORS) {
    r -= a.weight;
    if (r <= 0) return a;
  }
  return CITY_ANCHORS[0];
};

// Offset ngẫu nhiên đều trong đĩa bán kính R (độ), có co lng theo vĩ độ cho tròn đều.
const offsetInDisc = (lat: number, R: number): [number, number] => {
  const r = R * Math.sqrt(Math.random());
  const t = Math.random() * Math.PI * 2;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  return [(Math.cos(t) * r) / cosLat, Math.sin(t) * r];
};

// --- Dữ liệu xe (SoA) — phiên bản theo cụm. Thêm homeLngs/homeLats để worker re-roll đích quanh nhà. ---
export interface VehiclesSoA {
  lngs: Float64Array;
  lats: Float64Array;
  bearings: Float64Array;
  destLngs: Float64Array;
  destLats: Float64Array;
  homeLngs: Float64Array; // tâm "nhà" của xe (anchor + lệch cụm) -> xe lượn quanh điểm này
  homeLats: Float64Array;
}

const CLUSTER_SPREAD = 0.3; // bán kính blob đô thị quanh anchor

// Sinh xe phân bố theo cụm đô thị trên toàn VN.
export const generateVehiclesSoA = (count: number): VehiclesSoA => {
  const lngs = new Float64Array(count);
  const lats = new Float64Array(count);
  const bearings = new Float64Array(count);
  const destLngs = new Float64Array(count);
  const destLats = new Float64Array(count);
  const homeLngs = new Float64Array(count);
  const homeLats = new Float64Array(count);

  for (let i = 0; i < count; i++) {
    const a = pickAnchor();
    const [hdx, hdy] = offsetInDisc(a.lat, CLUSTER_SPREAD);
    const hLng = a.lng + hdx;
    const hLat = a.lat + hdy;
    homeLngs[i] = hLng;
    homeLats[i] = hLat;

    const [sdx, sdy] = offsetInDisc(hLat, 0.05);
    lngs[i] = hLng + sdx;
    lats[i] = hLat + sdy;

    const [ddx, ddy] = offsetInDisc(hLat, ROAM_RADIUS);
    destLngs[i] = hLng + ddx;
    destLats[i] = hLat + ddy;

    bearings[i] = Math.random() * 360;
  }

  return { lngs, lats, bearings, destLngs, destLats, homeLngs, homeLats };
};

// --- Vùng cấm ---
export interface Geofence {
  id: number;
  ring: [number, number][]; // vành ngoài đã đóng
  bbox: [number, number, number, number]; // [minLng, minLat, maxLng, maxLat] — dữ liệu cho Tầng 1
}

// Polygon "hình thù bất kỳ": đỉnh trên các bước góc đều nhưng bán kính ngẫu nhiên.
const makeRing = (cx: number, cy: number): [number, number][] => {
  const verts = 5 + Math.floor(Math.random() * 5);
  const baseR = 0.004 + Math.random() * 0.012;
  const cosLat = Math.cos((cy * Math.PI) / 180);
  const ring: [number, number][] = [];
  for (let k = 0; k < verts; k++) {
    const ang = (k / verts) * Math.PI * 2;
    const r = baseR * (0.55 + Math.random() * 0.9);
    ring.push([cx + (Math.cos(ang) * r) / cosLat, cy + Math.sin(ang) * r]);
  }
  ring.push(ring[0]);
  return ring;
};

const ringBbox = (ring: [number, number][]): [number, number, number, number] => {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLng, minLat, maxLng, maxLat];
};

// Vùng cấm cũng bám quanh các anchor (trong blob đô thị) để chồng lên khu vực xe lượn.
export const generateGeofences = (count: number): Geofence[] => {
  const zones: Geofence[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const a = pickAnchor();
    const [dx, dy] = offsetInDisc(a.lat, CLUSTER_SPREAD);
    const ring = makeRing(a.lng + dx, a.lat + dy);
    zones[i] = { id: i, ring, bbox: ringBbox(ring) };
  }
  return zones;
};

export const geofencesToGeoJSON = (zones: Geofence[]): FeatureCollection<Polygon> => ({
  type: "FeatureCollection",
  features: zones.map(
    (z): Feature<Polygon> => ({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [z.ring] },
      properties: { id: z.id },
    }),
  ),
});

// ============================================================================
// SPATIAL GRID INDEX — đây là chìa khóa để mở rộng diện tích.
// Thay vì Tầng 1 quét MỌI xe × MỌI vùng (O(N·M)), ta băm vùng cấm vào lưới ô đều.
// Mỗi xe chỉ là 1 ô -> chỉ kiểm tra các vùng đã đăng ký trong ô đó (O(N · vùng/ô)).
// Một vùng được đăng ký vào MỌI ô mà bbox của nó chạm tới (bảo toàn: không bỏ sót).
// ============================================================================
export interface SpatialGrid {
  cols: number;
  rows: number;
  minLng: number;
  minLat: number;
  invStep: number; // 1 / GRID_CELL_DEG (dùng chung cho lng & lat)
  cells: Int32Array[]; // cells[row*cols + col] = mảng id vùng cấm trong ô đó
}

export const buildSpatialGrid = (zones: Geofence[], bbox: [number, number, number, number]): SpatialGrid => {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const cols = Math.max(1, Math.ceil((maxLng - minLng) / GRID_CELL_DEG));
  const rows = Math.max(1, Math.ceil((maxLat - minLat) / GRID_CELL_DEG));
  const invStep = 1 / GRID_CELL_DEG;

  // Dựng bằng mảng động trước, rồi nén sang Int32Array để truy cập nhanh, ít rác.
  const buckets: number[][] = Array.from({ length: cols * rows }, () => []);
  const clampCol = (c: number) => (c < 0 ? 0 : c >= cols ? cols - 1 : c);
  const clampRow = (r: number) => (r < 0 ? 0 : r >= rows ? rows - 1 : r);

  for (const z of zones) {
    const c0 = clampCol(Math.floor((z.bbox[0] - minLng) * invStep));
    const c1 = clampCol(Math.floor((z.bbox[2] - minLng) * invStep));
    const r0 = clampRow(Math.floor((z.bbox[1] - minLat) * invStep));
    const r1 = clampRow(Math.floor((z.bbox[3] - minLat) * invStep));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) buckets[r * cols + c].push(z.id);
    }
  }

  const cells = buckets.map((b) => Int32Array.from(b));
  return { cols, rows, minLng, minLat, invStep, cells };
};
