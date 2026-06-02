import { booleanPointInPolygon } from "@turf/turf";
import type { Feature, Polygon } from "geojson";
import { bearingDeg } from "../utils/geoHelpers";
import {
  generateVehiclesSoA,
  generateGeofences,
  geofencesToGeoJSON,
  buildSpatialGrid,
  ROAM_RADIUS,
  type Geofence,
  type SpatialGrid,
} from "../utils/geofenceHelpers";

// ============================================================================
// Worker giám sát vùng cấm — quy mô lớn (toàn VN: ~50k xe, ~1000 polygon).
// Mỗi tick: (1) di chuyển xe quanh "nhà", (2) lọc 2 tầng VỚI spatial grid index,
// (3) so cache trạng thái -> phát alert Enter/Exit, (4) gửi subset trong viewport.
// Điểm khác bản nhỏ: Tầng 1 KHÔNG còn quét mọi vùng — chỉ các vùng trong ô lưới của xe.
// ============================================================================

// --- Master state SoA (Float64 tích lũy chuyển động chính xác) ---
let lngs: Float64Array = new Float64Array(0);
let lats: Float64Array = new Float64Array(0);
let bearings: Float64Array = new Float64Array(0);
let destLngs: Float64Array = new Float64Array(0);
let destLats: Float64Array = new Float64Array(0);
let homeLngs: Float64Array = new Float64Array(0);
let homeLats: Float64Array = new Float64Array(0);
let count = 0;

// --- Vùng cấm + grid index phục vụ 2 tầng ---
let zonePolys: Feature<Polygon>[] = []; // dựng MỘT LẦN -> Tầng 2 không cấp phát polygon
let zoneBboxFlat: Float64Array = new Float64Array(0); // [minLng,minLat,maxLng,maxLat] × nZones cho Tầng 1
let grid: SpatialGrid | null = null;

// --- Cache trạng thái (typed array, KHÔNG dùng React state): -1 = OUTSIDE mọi vùng ---
let zoneOf: Int16Array = new Int16Array(0);
let primed = false; // tick đầu chỉ set baseline, không phát alert

let currentBbox: [number, number, number, number] | null = null;
let tickId: ReturnType<typeof setInterval> | null = null;
let isInteracting = false;
let lastPipCount = 0; // số lần gọi Turf PiP ở tick gần nhất (đo hiệu quả của grid)

// Cadence 250ms (4Hz): đủ "real-time" cho alert, nhẹ hơn cho main thread khi setData 50k circle.
const TICK_MS = 250;
const BASE_STEP = 0.0006; // quãng mỗi tick ở tốc độ 1.0× (đã hạ so với bản trước cho êm)
const ARRIVED_DEG = 0.002;
const JITTER = 0.00004;
// Hệ số tốc độ do người dùng chỉnh qua thanh trượt (0 = đứng yên). Nhân vào cả bước đi lẫn nhiễu.
let speedFactor = 1;

const post = self.postMessage as (message: unknown, transfer?: Transferable[]) => void;

self.onmessage = (event: MessageEvent) => {
  const { type, payload } = event.data;

  switch (type) {
    case "INIT_DATA": {
      const soa = generateVehiclesSoA(payload.count);
      lngs = soa.lngs;
      lats = soa.lats;
      bearings = soa.bearings;
      destLngs = soa.destLngs;
      destLats = soa.destLats;
      homeLngs = soa.homeLngs;
      homeLats = soa.homeLats;
      count = payload.count;
      currentBbox = payload.bbox;

      // Sinh vùng cấm + tiền xử lý bbox (Tầng 1) + polygon (Tầng 2) + grid index.
      const zones: Geofence[] = generateGeofences(payload.geofenceCount);
      zoneBboxFlat = new Float64Array(zones.length * 4);
      zonePolys = zones.map((z, i) => {
        zoneBboxFlat[i * 4] = z.bbox[0];
        zoneBboxFlat[i * 4 + 1] = z.bbox[1];
        zoneBboxFlat[i * 4 + 2] = z.bbox[2];
        zoneBboxFlat[i * 4 + 3] = z.bbox[3];
        return { type: "Feature", geometry: { type: "Polygon", coordinates: [z.ring] }, properties: { id: z.id } };
      });
      grid = buildSpatialGrid(zones, payload.bbox);

      zoneOf = new Int16Array(count).fill(-1);
      primed = false;

      post({ type: "GEOFENCES_READY", geojson: geofencesToGeoJSON(zones) });

      startMonitoring();
      tick(); // tick baseline ngay (không phát alert)
      break;
    }

    case "UPDATE_BBOX":
      currentBbox = payload.bbox;
      sendRenderFrame([]); // re-pack viewport mới, không chạy lại simulation
      break;

    case "SET_STREAMING":
      if (payload.isActive) startMonitoring();
      else stopMonitoring();
      break;

    case "SET_SPEED":
      speedFactor = payload.factor; // 0 = đứng yên -> không phát sinh sự kiện mới
      break;

    case "SET_INTERACTING":
      isInteracting = payload.isActive;
      if (!isInteracting) sendRenderFrame([]);
      break;
  }
};

// Một bước mô phỏng đầy đủ.
const tick = () => {
  if (!grid) return;

  // (1) Di chuyển TẠI CHỖ: xe tiến về đích, tới nơi -> bốc đích mới TRONG bán kính ROAM quanh nhà.
  const step = BASE_STEP * speedFactor;
  const jitter = JITTER * speedFactor;
  for (let i = 0; i < count; i++) {
    const dLng = destLngs[i] - lngs[i];
    const dLat = destLats[i] - lats[i];
    const dist = Math.hypot(dLng, dLat);
    if (dist < ARRIVED_DEG) {
      const r = ROAM_RADIUS * Math.sqrt(Math.random());
      const t = Math.random() * Math.PI * 2;
      const cosLat = Math.cos((homeLats[i] * Math.PI) / 180);
      destLngs[i] = homeLngs[i] + (Math.cos(t) * r) / cosLat;
      destLats[i] = homeLats[i] + Math.sin(t) * r;
      continue;
    }
    if (step === 0) continue; // tốc độ 0 -> đứng yên, vẫn chạy phát hiện nhưng không có chuyển trạng thái
    lngs[i] += (dLng / dist) * step + (Math.random() - 0.5) * jitter;
    lats[i] += (dLat / dist) * step + (Math.random() - 0.5) * jitter;
    bearings[i] = bearingDeg(lngs[i], lats[i], destLngs[i], destLats[i]);
  }

  // (2)+(3) Lọc 2 tầng cho TẤT CẢ xe qua grid index + phát hiện chuyển trạng thái.
  const alerts: { idx: number; zone: number; type: "enter" | "exit" }[] = [];
  const { cols, rows, minLng, minLat, invStep, cells } = grid;
  let pip = 0;

  for (let i = 0; i < count; i++) {
    const x = lngs[i];
    const y = lats[i];

    // Băm xe vào 1 ô lưới -> chỉ lấy danh sách vùng cấm trong ô đó (thay vì cả 1000 vùng).
    let cx = Math.floor((x - minLng) * invStep);
    let cy = Math.floor((y - minLat) * invStep);
    if (cx < 0) cx = 0;
    else if (cx >= cols) cx = cols - 1;
    if (cy < 0) cy = 0;
    else if (cy >= rows) cy = rows - 1;
    const candidates = cells[cy * cols + cx];

    let inZone = -1;
    for (let k = 0; k < candidates.length; k++) {
      const z = candidates[k];
      const b = z * 4;
      // --- Tầng 1: Bounding Box (đại số) — vẫn cần vì bbox vùng có thể tràn sang ô bên cạnh ---
      if (x < zoneBboxFlat[b] || x > zoneBboxFlat[b + 2] || y < zoneBboxFlat[b + 1] || y > zoneBboxFlat[b + 3]) {
        continue;
      }
      // --- Tầng 2: Point-in-Polygon chính xác bằng Turf.js ---
      pip++;
      if (booleanPointInPolygon([x, y], zonePolys[z])) {
        inZone = z;
        break;
      }
    }

    const prev = zoneOf[i];
    if (primed && inZone !== prev) {
      if (prev !== -1) alerts.push({ idx: i, zone: prev, type: "exit" });
      if (inZone !== -1) alerts.push({ idx: i, zone: inZone, type: "enter" });
    }
    zoneOf[i] = inZone;
  }

  lastPipCount = pip;
  primed = true;
  sendRenderFrame(alerts);
};

// Lọc theo viewport (two-pass count-then-pack) + cờ vi phạm rồi Transfer sang main.
const sendRenderFrame = (alerts: { idx: number; zone: number; type: "enter" | "exit" }[]) => {
  if (!currentBbox) return;
  if (isInteracting) {
    if (alerts.length) post({ type: "ALERTS_ONLY", alerts, totalViolating: countViolating(), pipCount: lastPipCount });
    return;
  }

  const [minLng, minLat, maxLng, maxLat] = currentBbox;

  let visible = 0;
  for (let i = 0; i < count; i++) {
    if (lngs[i] >= minLng && lngs[i] <= maxLng && lats[i] >= minLat && lats[i] <= maxLat) visible++;
  }

  const coords = new Float32Array(visible * 2);
  const violating = new Uint8Array(visible);
  const idx = new Uint32Array(visible);

  let w = 0;
  let totalViolating = 0;
  for (let i = 0; i < count; i++) {
    if (zoneOf[i] !== -1) totalViolating++; // đếm trên TOÀN đội xe (kể cả ngoài viewport)
    if (!(lngs[i] >= minLng && lngs[i] <= maxLng && lats[i] >= minLat && lats[i] <= maxLat)) continue;
    coords[w * 2] = lngs[i];
    coords[w * 2 + 1] = lats[i];
    violating[w] = zoneOf[i] !== -1 ? 1 : 0;
    idx[w] = i;
    w++;
  }

  post(
    { type: "DATA_UPDATED", count: visible, coords, violating, idx, totalViolating, pipCount: lastPipCount, alerts },
    [coords.buffer, violating.buffer, idx.buffer],
  );
};

const countViolating = (): number => {
  let n = 0;
  for (let i = 0; i < count; i++) if (zoneOf[i] !== -1) n++;
  return n;
};

const startMonitoring = () => {
  if (tickId) return;
  tickId = setInterval(tick, TICK_MS);
};

const stopMonitoring = () => {
  if (tickId) {
    clearInterval(tickId);
    tickId = null;
  }
};
