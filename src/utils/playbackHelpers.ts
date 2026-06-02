// ============================================================================
// History Playback — cấu trúc dữ liệu Không-Thời gian + phát hiện va chạm gần.
//
// Bài toán: tua lại lịch sử di chuyển của 5.000 xe trong cửa sổ 300 giây và
// phát hiện cặp xe lại gần nhau dưới 5 mét.
//
// CẤU TRÚC DỮ LIỆU (tối ưu RAM, truy xuất O(1) khi tua):
//   Thay vì mảng lồng nhau Vehicle[][] (mỗi giây 1 mảng object -> hàng triệu
//   object, phình RAM + GC), ta dùng MỘT Float32Array phẳng duy nhất ("cube"
//   không-thời gian) bố trí theo dạng [frame][vehicle][lng,lat]:
//
//     offset(t, i) = t * STRIDE + i * 2     (STRIDE = count * 2)
//
//   - id của xe CHÍNH LÀ index i (ổn định qua mọi frame) -> không cần lưu id.
//   - frame của giây t là một subarray view (zero-copy) lên cùng buffer
//     -> Map<timestamp, view> cho truy xuất O(1) mà không cấp phát thêm.
//   - 5.000 xe × 301 frame × 2 float × 4 byte ≈ 12 MB cho toàn bộ lịch sử.
// ============================================================================

export const VEHICLE_COUNT = 5_000;
export const DURATION_SEC = 300; // cửa sổ giả lập (giây)
export const FRAME_COUNT = DURATION_SEC + 1; // 0..300 -> 301 mốc giây
export const PROXIMITY_M = 5; // ngưỡng cảnh báo va chạm (mét)

// Vùng giả lập: một khu phố Hà Nội ~3.5km × 2.8km. Cố tình gọn để mật độ xe đủ
// cao -> các cặp xe thực sự có lúc lại gần < 5m (nếu trải rộng sẽ không bao giờ va).
export const REGION: [number, number, number, number] = [105.812, 21.012, 105.847, 21.037];
export const REGION_CENTER: [number, number] = [
  (REGION[0] + REGION[2]) / 2,
  (REGION[1] + REGION[3]) / 2,
];

// Hằng số quy đổi độ <-> mét (xấp xỉ phẳng quanh vĩ độ vùng — sai số sub-mét ở quy mô km).
const M_PER_DEG_LAT = 111_320;
const LAT_MID = (REGION[1] + REGION[3]) / 2;
const M_PER_DEG_LNG = 111_320 * Math.cos((LAT_MID * Math.PI) / 180);

// --- Khối không-thời gian đã sinh ---
export interface SpaceTimeCube {
  cube: Float32Array; // phẳng: [t*stride + i*2] = lng, +1 = lat
  count: number; // số xe
  frames: number; // số mốc giây
  stride: number; // count * 2
}

// Map<timestamp, view>: key = giây, value = subarray view (zero-copy) trỏ vào cube.
// Truy xuất frame của một giây là O(1) và KHÔNG cấp phát bộ nhớ mới.
export const buildFrameIndex = (c: SpaceTimeCube): Map<number, Float32Array> => {
  const index = new Map<number, Float32Array>();
  for (let t = 0; t < c.frames; t++) {
    index.set(t, c.cube.subarray(t * c.stride, (t + 1) * c.stride));
  }
  return index;
};

// ---------------------------------------------------------------------------
// SINH LỊCH SỬ DI CHUYỂN
// Mỗi xe là một "dòng giao thông": có hướng + tốc độ, mỗi giây bẻ lái nhẹ và
// dội lại khi chạm biên vùng. Nhiều xe cùng lượn trong khu phố nhỏ -> đường đi
// cắt nhau -> sinh ra các pha lại gần < 5m một cách tự nhiên (không dàn dựng).
// ---------------------------------------------------------------------------
export const generateTrajectoryCube = (count: number, frames: number): SpaceTimeCube => {
  const stride = count * 2;
  const cube = new Float32Array(frames * stride);

  const [minLng, minLat, maxLng, maxLat] = REGION;

  // Trạng thái mô phỏng tạm (SoA) — chỉ dùng trong lúc sinh, không giữ lại.
  const lngs = new Float64Array(count);
  const lats = new Float64Array(count);
  const heading = new Float64Array(count); // radian
  const speed = new Float64Array(count); // độ/giây (đã quy từ km/h)

  // Tốc độ đô thị 15–45 km/h -> độ vĩ độ mỗi giây.
  const kmhToDegPerSec = (kmh: number) => (kmh * 1000) / 3600 / M_PER_DEG_LAT;

  for (let i = 0; i < count; i++) {
    lngs[i] = minLng + Math.random() * (maxLng - minLng);
    lats[i] = minLat + Math.random() * (maxLat - minLat);
    heading[i] = Math.random() * Math.PI * 2;
    speed[i] = kmhToDegPerSec(15 + Math.random() * 30);
    // Frame 0.
    cube[i * 2] = lngs[i];
    cube[i * 2 + 1] = lats[i];
  }

  const aspect = M_PER_DEG_LAT / M_PER_DEG_LNG; // co bước lng cho chuyển động tròn đều

  for (let t = 1; t < frames; t++) {
    const base = t * stride;
    for (let i = 0; i < count; i++) {
      // Bẻ lái ngẫu nhiên nhẹ -> quỹ đạo cong tự nhiên thay vì đường thẳng.
      heading[i] += (Math.random() - 0.5) * 0.6;
      const s = speed[i];
      let nx = lngs[i] + Math.cos(heading[i]) * s * aspect;
      let ny = lats[i] + Math.sin(heading[i]) * s;

      // Dội biên: phản xạ hướng để xe ở lại trong khu phố (giữ mật độ).
      if (nx < minLng) {
        nx = minLng;
        heading[i] = Math.PI - heading[i];
      } else if (nx > maxLng) {
        nx = maxLng;
        heading[i] = Math.PI - heading[i];
      }
      if (ny < minLat) {
        ny = minLat;
        heading[i] = -heading[i];
      } else if (ny > maxLat) {
        ny = maxLat;
        heading[i] = -heading[i];
      }

      lngs[i] = nx;
      lats[i] = ny;
      cube[base + i * 2] = nx;
      cube[base + i * 2 + 1] = ny;
    }
  }

  return { cube, count, frames, stride };
};

// ---------------------------------------------------------------------------
// PHÁT HIỆN VA CHẠM GẦN — Spatial Hash Grid (chia lưới không gian)
//
// Vòng lặp O(N²) (12.5 triệu cặp với 5.000 xe) là không khả thi ở 60 FPS.
// Thay vào đó: băm xe vào lưới ô có cạnh ≈ ngưỡng va chạm. Hai xe chỉ có thể
// < 5m nếu nằm cùng ô hoặc ô kề -> với mỗi xe chỉ cần so với các xe trong 9 ô
// xung quanh. Độ phức tạp tụt về ~O(N) khi mật độ đều.
//
// Lưới dùng HASH (Map) chứ không phải mảng phẳng cố định: vùng nhỏ nhưng cạnh
// ô ~5m -> ~600×500 ≈ 300k ô, đa số rỗng; hash chỉ tạo ô có xe. Bucket array
// được TÁI DÙNG qua free-list nên sau lần đầu gần như không cấp phát/GC.
// ---------------------------------------------------------------------------
export interface ProximityHit {
  i: number; // index xe A (i < j)
  j: number; // index xe B
  lng: number; // tọa độ trung điểm (vẽ vòng cảnh báo)
  lat: number;
  dist: number; // khoảng cách thực (mét)
}

export interface ProximityResult {
  hits: ProximityHit[];
  flags: Uint8Array; // flags[i] = 1 nếu xe i đang dính cảnh báo (để tô đỏ)
  checks: number; // số phép so cặp THỰC SỰ đã chạy (đối chiếu với brute-force N²/2)
}

// Cạnh ô lưới theo độ (cố tình = ngưỡng để cặp gần chỉ nằm trong 9 ô).
const cellLatDeg = PROXIMITY_M / M_PER_DEG_LAT;
const cellLngDeg = PROXIMITY_M / M_PER_DEG_LNG;
// Hệ số gộp (cx, cy) -> key số nguyên duy nhất. cols của vùng < ~10.000 nên 1e5 đủ rộng.
const HASH_STRIDE = 100_000;

export class ProximityDetector {
  private grid = new Map<number, number[]>();
  private bucketPool: number[][] = []; // tái dùng mảng bucket -> tránh GC mỗi frame
  private flags: Uint8Array;
  private cellIdx: Int32Array; // ô lưới của mỗi xe (tái dùng giữa các frame)
  private readonly minLng: number;
  private readonly minLat: number;
  private readonly thresholdM: number;

  constructor(count: number, thresholdM = PROXIMITY_M) {
    this.flags = new Uint8Array(count);
    this.cellIdx = new Int32Array(count);
    this.minLng = REGION[0];
    this.minLat = REGION[1];
    this.thresholdM = thresholdM;
  }

  // Quét toàn bộ xe ở frame hiện tại (mảng phẳng [lng,lat] xen kẽ).
  detect(coords: Float32Array, count: number): ProximityResult {
    const grid = this.grid;
    const pool = this.bucketPool;

    // Trả mọi bucket về pool rồi clear (không cấp phát Map mới mỗi frame).
    for (const arr of grid.values()) {
      arr.length = 0;
      pool.push(arr);
    }
    grid.clear();
    this.flags.fill(0);

    const minLng = this.minLng;
    const minLat = this.minLat;
    const thr = this.thresholdM;
    const thr2 = thr * thr;
    const flags = this.flags;
    const hits: ProximityHit[] = [];
    let checks = 0;

    // Băm từng xe vào ô của nó.
    const cellIdx = this.cellIdx; // nhớ lại ô của mỗi xe để khỏi tính lại
    for (let i = 0; i < count; i++) {
      const cx = Math.floor((coords[i * 2] - minLng) / cellLngDeg);
      const cy = Math.floor((coords[i * 2 + 1] - minLat) / cellLatDeg);
      const key = cy * HASH_STRIDE + cx;
      cellIdx[i] = key;
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = pool.pop() ?? [];
        grid.set(key, bucket);
      }
      bucket.push(i);
    }

    // Với mỗi xe, so với các xe trong 9 ô (ô của nó + 8 ô kề). Chỉ xét j > i (mỗi cặp 1 lần).
    for (let i = 0; i < count; i++) {
      const xi = coords[i * 2];
      const yi = coords[i * 2 + 1];
      const baseKey = cellIdx[i];
      const cy = Math.floor(baseKey / HASH_STRIDE);
      const cx = baseKey - cy * HASH_STRIDE;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const bucket = grid.get((cy + dy) * HASH_STRIDE + (cx + dx));
          if (!bucket) continue;
          for (let b = 0; b < bucket.length; b++) {
            const j = bucket[b];
            if (j <= i) continue; // tránh đếm 2 lần & tự so với chính mình
            // Khoảng cách thực theo mét (xấp xỉ phẳng).
            const ddx = (coords[j * 2] - xi) * M_PER_DEG_LNG;
            const ddy = (coords[j * 2 + 1] - yi) * M_PER_DEG_LAT;
            checks++;
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 <= thr2) {
              flags[i] = 1;
              flags[j] = 1;
              hits.push({
                i,
                j,
                lng: (xi + coords[j * 2]) / 2,
                lat: (yi + coords[j * 2 + 1]) / 2,
                dist: Math.sqrt(d2),
              });
            }
          }
        }
      }
    }

    return { hits, flags, checks };
  }
}
