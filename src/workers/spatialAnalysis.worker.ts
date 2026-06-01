import KDBush from "kdbush";
import { generateDriversSoA, bearingDeg } from "../utils/geoHelpers";

// Master state SoA. Float64 cho tích lũy chuyển động chính xác qua nhiều tick.
// Downcast Float32 khi gửi để giảm bandwidth (sai số ~1.4m ở lat 21° — đủ).
let lngs: Float64Array = new Float64Array(0);
let lats: Float64Array = new Float64Array(0);
let bearings: Float64Array = new Float64Array(0);
let statuses: Uint8Array = new Uint8Array(0);
let destLngs: Float64Array = new Float64Array(0);
let destLats: Float64Array = new Float64Array(0);
let count = 0;

let currentBbox: [number, number, number, number] | null = null;
let isInteracting = false;
let streamIntervalId: ReturnType<typeof setInterval> | null = null;

// Quãng đường mỗi tick + ngưỡng đến đích (copy từ dataParser.worker.ts)
const STEP_DEG = 0.0006;
const ARRIVED_DEG = 0.0015;

const post = self.postMessage as (message: unknown, transfer?: Transferable[]) => void;

self.onmessage = (event: MessageEvent) => {
  const { type, payload } = event.data;

  switch (type) {
    case "INIT_DATA": {
      const soa = generateDriversSoA(payload.count);
      lngs = soa.lngs;
      lats = soa.lats;
      bearings = soa.bearings;
      statuses = soa.statuses;
      destLngs = soa.destLngs;
      destLats = soa.destLats;
      count = payload.count;
      currentBbox = payload.bbox;

      // Destinations TĨNH → gửi 1 lần (transferable). Cho popup ETA / đường nối đích.
      const destCoords = new Float32Array(count * 2);
      for (let i = 0; i < count; i++) {
        destCoords[i * 2] = destLngs[i];
        destCoords[i * 2 + 1] = destLats[i];
      }
      post({ type: "INIT_DESTINATIONS", destCoords }, [destCoords.buffer]);

      processAndSend();
      break;
    }

    case "UPDATE_BBOX":
      currentBbox = payload.bbox;
      processAndSend();
      break;

    case "SET_STREAMING":
      if (payload.isActive) startStreaming();
      else stopStreaming();
      break;

    case "SET_INTERACTING":
      isInteracting = payload.isActive;
      if (!isInteracting) processAndSend();
      break;
  }
};

// Pack visible subset (viewport-filtered) + rebuild kdbush + send.
// 4 transferables: viewport coords/bearing/status/idx + FULL positions (cho main rehydrate index) + kdbush buffer.
const processAndSend = () => {
  if (!currentBbox) return;
  if (isInteracting) return;

  const [minLng, minLat, maxLng, maxLat] = currentBbox;

  // Pass 1: đếm visible
  let visible = 0;
  for (let i = 0; i < count; i++) {
    if (lngs[i] >= minLng && lngs[i] <= maxLng && lats[i] >= minLat && lats[i] <= maxLat) visible++;
  }

  // Pass 2: pack viewport subset
  const coords = new Float32Array(visible * 2);
  const bearing = new Float32Array(visible);
  const status = new Uint8Array(visible);
  const idx = new Uint32Array(visible);

  let w = 0;
  for (let i = 0; i < count; i++) {
    if (!(lngs[i] >= minLng && lngs[i] <= maxLng && lats[i] >= minLat && lats[i] <= maxLat)) continue;
    coords[w * 2] = lngs[i];
    coords[w * 2 + 1] = lats[i];
    bearing[w] = bearings[i];
    status[w] = statuses[i];
    idx[w] = i;
    w++;
  }

  // FULL positions Float32 (downcast từ Float64 nội bộ). Cần thiết để main compute distance
  // cho matched ngoài viewport (rất phổ biến ở mode Find Nearest khi user click sát rìa).
  const fullLngs = new Float32Array(count);
  const fullLats = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    fullLngs[i] = lngs[i];
    fullLats[i] = lats[i];
  }

  // Rebuild kdbush. ~30-50ms cho 100k ở worker → off main thread.
  // Xảy ra MỖI tick vì positions đã mutate, tree cũ stale.
  const kd = new KDBush(count);
  for (let i = 0; i < count; i++) kd.add(lngs[i], lats[i]);
  kd.finish();

  post(
    {
      type: "DATA_UPDATED",
      count: visible,
      coords,
      bearing,
      status,
      idx,
      fullLngs,
      fullLats,
      kdData: kd.data,
    },
    [coords.buffer, bearing.buffer, status.buffer, idx.buffer, fullLngs.buffer, fullLats.buffer, kd.data],
  );
};

// Tick mỗi 5s: di chuyển từng driver về đích, đổi đích khi tới
const startStreaming = () => {
  if (streamIntervalId) return;

  streamIntervalId = setInterval(() => {
    for (let i = 0; i < count; i++) {
      const dLng = destLngs[i] - lngs[i];
      const dLat = destLats[i] - lats[i];
      const dist = Math.hypot(dLng, dLat);

      if (dist < ARRIVED_DEG) {
        destLngs[i] = 105.75 + Math.random() * 0.18;
        destLats[i] = 20.95 + Math.random() * 0.15;
        continue;
      }

      lngs[i] += (dLng / dist) * STEP_DEG + (Math.random() - 0.5) * 0.00008;
      lats[i] += (dLat / dist) * STEP_DEG + (Math.random() - 0.5) * 0.00008;
      bearings[i] = bearingDeg(lngs[i], lats[i], destLngs[i], destLats[i]);
    }

    processAndSend();
  }, 5000);
};

const stopStreaming = () => {
  if (streamIntervalId) {
    clearInterval(streamIntervalId);
    streamIntervalId = null;
  }
};
