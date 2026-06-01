import { generateDriversSoA, bearingDeg } from "../utils/geoHelpers";

// Master state SoA — nguồn sự thật cho toàn bộ 100k tài xế (giống dataParser.worker.ts).
// Float64 để tích lũy chuyển động chính xác qua nhiều tick; downcast Float32 khi gửi đi.
let lngs: Float64Array = new Float64Array(0);
let lats: Float64Array = new Float64Array(0);
let bearings: Float64Array = new Float64Array(0);
let destLngs: Float64Array = new Float64Array(0);
let destLats: Float64Array = new Float64Array(0);
let count = 0;

let currentBbox: [number, number, number, number] | null = null;
let streamIntervalId: ReturnType<typeof setInterval> | null = null;
// Khi user pan/zoom: tạm dừng filter + postMessage để giải phóng CPU cho hiệu ứng mượt
let isInteracting = false;

// Cadence "nhỏ giọt" = 3s — PHẢI KHỚP ĐÚNG lerp window bên main (MapContainerStream STREAM_INTERVAL).
const STREAM_INTERVAL = 3000;
// Quãng đường mỗi tick (độ): ~62m/3s @ 25km/h — đủ thấy chuyển động, không teleport qua đoạn lerp
const STEP_DEG = 0.0005;
const ARRIVED_DEG = 0.0015;
// Nhiễu nhỏ để quỹ đạo tự nhiên. Cố ý GIỮ NHỎ: nhiễu lớn làm cached per-segment bearing (main)
// sai vì lerp giả định đường thẳng giữa last→next.
const JITTER = 0.00003;

const post = self.postMessage as (message: unknown, transfer?: Transferable[]) => void;

self.onmessage = (event: MessageEvent) => {
  const { type, payload } = event.data;

  switch (type) {
    case "INIT_DATA": {
      // Sinh dữ liệu NGAY TRONG worker -> main thread không bị block lúc khởi tạo
      const soa = generateDriversSoA(payload.count);
      lngs = soa.lngs;
      lats = soa.lats;
      bearings = soa.bearings;
      destLngs = soa.destLngs;
      destLats = soa.destLats;
      count = payload.count;
      currentBbox = payload.bbox;

      // Fleet tĩnh = demo dở: bật stream "nhỏ giọt" ngay khi init.
      startStreaming();
      processAndSend();
      break;
    }

    case "UPDATE_BBOX":
      currentBbox = payload.bbox;
      processAndSend();
      break;

    case "SET_STREAMING":
      // Stream độc lập với nội suy bên main: tắt stream = ngừng cập nhật vị trí thật.
      if (payload.isActive) startStreaming();
      else stopStreaming();
      break;

    case "SET_INTERACTING":
      isInteracting = payload.isActive;
      // Vừa thả chuột -> flush ngay subset của viewport hiện tại
      if (!isInteracting) processAndSend();
      break;
  }
};

// Lọc theo viewport (two-pass count-then-pack) rồi Transfer (zero-copy) sang main thread.
const processAndSend = () => {
  if (!currentBbox) return;
  if (isInteracting) return; // đang pan/zoom: main sẽ drop, không phí công filter + serialize

  const [minLng, minLat, maxLng, maxLat] = currentBbox;

  // Pass 1: đếm số điểm trong viewport để cấp phát buffer đúng kích thước một lần
  let visible = 0;
  for (let i = 0; i < count; i++) {
    if (lngs[i] >= minLng && lngs[i] <= maxLng && lats[i] >= minLat && lats[i] <= maxLat) visible++;
  }

  // Pass 2: pack. Float32 cho tọa độ (đủ chính xác ~1.4m ở Hà Nội, giảm một nửa lưu lượng).
  const coords = new Float32Array(visible * 2);
  const bearing = new Float32Array(visible);
  const idx = new Uint32Array(visible);

  let w = 0;
  for (let i = 0; i < count; i++) {
    if (!(lngs[i] >= minLng && lngs[i] <= maxLng && lats[i] >= minLat && lats[i] <= maxLat)) continue;
    coords[w * 2] = lngs[i];
    coords[w * 2 + 1] = lats[i];
    bearing[w] = bearings[i]; // hướng tức thời — main chỉ dùng cho xe mới vào viewport (snap)
    idx[w] = i; // KHÓA NỘI SUY: định danh ổn định để main re-anchor last→next theo từng xe
    w++;
  }

  // Transfer quyền sở hữu các ArrayBuffer -> không deep-clone, chi phí gần như 0
  post({ type: "DATA_UPDATED", count: visible, coords, bearing, idx }, [coords.buffer, bearing.buffer, idx.buffer]);
};

// Tick mỗi 3s: mỗi tài xế tiến dần về điểm đến, đổi đích khi tới
const startStreaming = () => {
  if (streamIntervalId) return;

  streamIntervalId = setInterval(() => {
    // Mutate TẠI CHỖ trên Float64Array: 0 object cấp phát -> không GC churn dù 100k xe
    for (let i = 0; i < count; i++) {
      const dLng = destLngs[i] - lngs[i];
      const dLat = destLats[i] - lats[i];
      const dist = Math.hypot(dLng, dLat);

      if (dist < ARRIVED_DEG) {
        // Đã tới đích -> giao điểm đến mới để tài xế tiếp tục di chuyển
        destLngs[i] = 105.75 + Math.random() * 0.18;
        destLats[i] = 20.95 + Math.random() * 0.15;
        continue;
      }

      lngs[i] += (dLng / dist) * STEP_DEG + (Math.random() - 0.5) * JITTER;
      lats[i] += (dLat / dist) * STEP_DEG + (Math.random() - 0.5) * JITTER;
      bearings[i] = bearingDeg(lngs[i], lats[i], destLngs[i], destLats[i]);
    }

    processAndSend();
  }, STREAM_INTERVAL);
};

const stopStreaming = () => {
  if (streamIntervalId) {
    clearInterval(streamIntervalId);
    streamIntervalId = null;
  }
};
