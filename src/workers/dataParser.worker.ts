import { generateDriversSoA, bearingDeg } from "../utils/geoHelpers";

// Master state dạng Struct-of-Arrays. Đây là nguồn sự thật cho toàn bộ 100k tài xế.
// Float64 để tích lũy chuyển động chính xác qua nhiều tick; downcast Float32 chỉ khi gửi đi render.
let lngs: Float64Array = new Float64Array(0);
let lats: Float64Array = new Float64Array(0);
let bearings: Float64Array = new Float64Array(0);
let statuses: Uint8Array = new Uint8Array(0);
let destLngs: Float64Array = new Float64Array(0);
let destLats: Float64Array = new Float64Array(0);
let count = 0;

let isBboxFilterActive = true;
let currentBbox: [number, number, number, number] | null = null;
let streamIntervalId: ReturnType<typeof setInterval> | null = null;
// Khi người dùng đang pan/zoom, tạm dừng filter + postMessage để giải phóng CPU (main thread cũng đang bỏ qua render)
let isInteracting = false;

// Quãng đường mỗi tick (độ) ~ tương ứng tốc độ giao hàng nội đô; ngưỡng coi như "đã tới đích"
const STEP_DEG = 0.0006;
const ARRIVED_DEG = 0.0015;

const post = self.postMessage as (message: unknown, transfer?: Transferable[]) => void;

// Lắng nghe chỉ thị từ Main Thread
self.onmessage = (event: MessageEvent) => {
  const { type, payload } = event.data;

  switch (type) {
    case "INIT_DATA": {
      // Sinh dữ liệu NGAY TRONG worker -> main thread không bị block lúc khởi tạo
      const soa = generateDriversSoA(payload.count);
      lngs = soa.lngs;
      lats = soa.lats;
      bearings = soa.bearings;
      statuses = soa.statuses;
      destLngs = soa.destLngs;
      destLats = soa.destLats;
      count = payload.count;
      currentBbox = payload.bbox;
      isBboxFilterActive = payload.isBboxFilterActive;

      // Điểm đến là dữ liệu TĨNH -> gửi 1 lần (transferable), không lặp lại mỗi tick
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

    case "TOGGLE_FILTER":
      isBboxFilterActive = payload.isActive;
      processAndSend();
      break;

    case "SET_STREAMING":
      if (payload.isActive) {
        startStreaming();
      } else {
        stopStreaming();
      }
      break;

    case "SET_INTERACTING":
      isInteracting = payload.isActive;
      // Vừa thả chuột (kết thúc pan/zoom) -> flush ngay dữ liệu mới nhất cho viewport hiện tại
      if (!isInteracting) processAndSend();
      break;
  }
};

// Lọc theo viewport rồi đóng gói vào typed array, Transfer (zero-copy) sang main thread.
const processAndSend = () => {
  if (!currentBbox) return;
  // Đang pan/zoom: main thread sẽ vứt bỏ data, nên không phí công filter + serialize ở đây
  if (isInteracting) return;

  const [minLng, minLat, maxLng, maxLat] = currentBbox;
  const filterOn = isBboxFilterActive;

  // Pass 1: đếm số điểm hiển thị để cấp phát buffer đúng kích thước một lần duy nhất
  let visible = 0;
  for (let i = 0; i < count; i++) {
    if (!filterOn || (lngs[i] >= minLng && lngs[i] <= maxLng && lats[i] >= minLat && lats[i] <= maxLat)) {
      visible++;
    }
  }

  // Pass 2: pack. Float32 cho tọa độ (đủ chính xác ~1.4m ở Hà Nội, giảm một nửa lưu lượng transfer)
  const coords = new Float32Array(visible * 2);
  const bearing = new Float32Array(visible);
  const status = new Uint8Array(visible);
  const idx = new Uint32Array(visible);

  let w = 0;
  for (let i = 0; i < count; i++) {
    if (filterOn && !(lngs[i] >= minLng && lngs[i] <= maxLng && lats[i] >= minLat && lats[i] <= maxLat)) continue;
    coords[w * 2] = lngs[i];
    coords[w * 2 + 1] = lats[i];
    bearing[w] = bearings[i];
    status[w] = statuses[i];
    idx[w] = i;
    w++;
  }

  // Transfer quyền sở hữu các ArrayBuffer -> không deep-clone, chi phí gần như 0
  post({ type: "DATA_UPDATED", count: visible, coords, bearing, status, idx }, [coords.buffer, bearing.buffer, status.buffer, idx.buffer]);
};

// Giả lập luồng dữ liệu stream: mỗi tài xế tiến dần về điểm đến của mình
const startStreaming = () => {
  if (streamIntervalId) return;

  streamIntervalId = setInterval(() => {
    // Mutate TẠI CHỖ trên Float64Array: 0 object cấp phát -> không gây GC churn dù có 100k xe
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

      // Bước một đoạn về phía đích + chút nhiễu để quỹ đạo tự nhiên
      lngs[i] += (dLng / dist) * STEP_DEG + (Math.random() - 0.5) * 0.00008;
      lats[i] += (dLat / dist) * STEP_DEG + (Math.random() - 0.5) * 0.00008;
      bearings[i] = bearingDeg(lngs[i], lats[i], destLngs[i], destLats[i]);
    }

    processAndSend();
  }, 5000); // Cập nhật mỗi 5 giây
};

const stopStreaming = () => {
  if (streamIntervalId) {
    clearInterval(streamIntervalId);
    streamIntervalId = null;
  }
};
