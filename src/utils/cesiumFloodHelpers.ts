// cesiumFloodHelpers.ts
// Lõi dữ liệu + thuật toán cho dashboard "3D Digital Twin ngập lụt (CesiumJS)".
//
// File này CỐ Ý KHÔNG import "cesium": nó được dùng chung bởi cả main thread (component map)
// LẪN Web Worker phân tích ngập (floodIntersection.worker.ts). Worker không có quyền truy cập
// WebGL/Cesium, nên mọi thứ ở đây chỉ là toán học thuần + typed array.
//
// Tư tưởng kiến trúc (khớp ethos của repo):
//   - Toàn bộ trạng thái "động" của mực nước nằm trong FloodController — một đối tượng mutable
//     được giữ trong useRef ở React và đọc bởi Cesium.CallbackProperty mỗi khung hình. Nhờ vậy
//     kéo Slider hay nhận gói tin IoT KHÔNG kích hoạt re-render React và KHÔNG dựng lại hình học.
//   - Mặt nước không phẳng: mỗi ô lưới có một độ cao riêng nội suy IDW từ 50 cảm biến hố ga.

export const MAX_LEVEL = 5; // mét — biên độ ngập tối đa (slider + storm + IoT)

// Khu vực mô phỏng: chỉ bao quanh TRUNG TÂM Hà Nội (~10 km × 10 km) — Hoàn Kiếm, Ba Đình,
// Đống Đa, Hai Bà Trưng và ven hồ Tây / sông Hồng.
export const CITY_CENTER: readonly [number, number] = [105.8342, 21.0278];
export const SIM_HALF_LON = 0.05; // ~5.2 km mỗi bên theo kinh độ tại vĩ độ 21
export const SIM_HALF_LAT = 0.045; // ~5.0 km mỗi bên theo vĩ độ

// Lưới mặt nước: GRID_N×GRID_N ô. Mỗi ô là một Entity polygon có extrudedHeight = CallbackProperty.
// 20×20 = 400 ô (~0.5 km/ô ở quy mô trung tâm): đủ mịn để thấy gợn IDW mà vẫn giữ ~60 FPS.
export const GRID_N = 20;

export const SENSOR_COUNT = 50; // số trạm cảm biến hố ga (IoT)

// Ngưỡng trạng thái theo độ sâu nước (m) tại hố ga.
export const WARNING_LEVEL = 1.5;
export const DANGER_LEVEL = 3.0;

export type SensorStatus = "normal" | "warning" | "danger";

// Mã hoá trạng thái thành số để nhét vào Uint8Array (0/1/2) cho rẻ.
export const STATUS_CODE: Record<SensorStatus, number> = { normal: 0, warning: 1, danger: 2 };

export const statusFromLevel = (level: number): SensorStatus =>
  level >= DANGER_LEVEL ? "danger" : level >= WARNING_LEVEL ? "warning" : "normal";

// Gói tin IoT đúng cấu trúc đề bài yêu cầu.
export interface SensorPacket {
  sensor_id: string;
  current_water_level: number; // mét
  status: SensorStatus;
}

export interface SensorStation {
  id: string; // "HG-01"
  lon: number;
  lat: number;
  // Tham số riêng dùng cho đường cong bão giả lập (mỗi trạm dâng khác nhau -> mặt nước gồ ghề).
  surgeMax: number; // mực nước đỉnh trạm này sẽ đạt khi bão cực đại (m)
  surgeRate: number; // tốc độ dâng tương đối (0.5..1.5)
  phase: number; // lệch pha dao động thuỷ triều
}

export interface BuildingDatum {
  id: string;
  lon: number;
  lat: number;
  widthM: number; // bề rộng chân đế (m)
  depthM: number; // bề sâu chân đế (m)
  heightM: number; // chiều cao toà nhà (m)
  floorHeight: number; // cao độ "ngưỡng cửa" (m) — ngập khi mực nước cục bộ vượt giá trị này
}

export interface GridConfig {
  n: number;
  minLon: number;
  minLat: number;
  lonStep: number;
  latStep: number;
  // Tâm mỗi ô (n*n) — phục vụ nội suy IDW.
  centerLon: Float64Array;
  centerLat: Float64Array;
}

// cos(vĩ độ) tại tâm thành phố: quy đổi chênh kinh độ sang khoảng cách phẳng gần đúng cho IDW.
const COS_LAT = Math.cos((CITY_CENTER[1] * Math.PI) / 180);
const IDW_EPS = 1e-8; // tránh chia 0 khi điểm trùng đúng vị trí cảm biến

// ---------------------------------------------------------------------------
// Sinh dữ liệu tĩnh (chạy một lần lúc khởi tạo dashboard)
// ---------------------------------------------------------------------------

// 50 hố ga rải khắp khu vực. surgeMax cao hơn ở nửa Tây-Nam (giả lập vùng trũng gần sông)
// để bão về thì khu đó ngập sâu trước -> mặt nước nội suy nghiêng, không phẳng đều.
export const generateStations = (): SensorStation[] => {
  const [cLon, cLat] = CITY_CENTER;
  const stations: SensorStation[] = [];
  for (let i = 0; i < SENSOR_COUNT; i++) {
    const u = Math.random() * 2 - 1;
    const v = Math.random() * 2 - 1;
    const lon = cLon + u * SIM_HALF_LON;
    const lat = cLat + v * SIM_HALF_LAT;
    // "Độ trũng": càng về Tây-Nam (u<0, v<0) càng dễ ngập sâu.
    const lowGround = (0.5 - u / 2) * 0.5 + (0.5 - v / 2) * 0.5; // 0..1
    const surgeMax = 2.0 + lowGround * (MAX_LEVEL - 2.0) + Math.random() * 0.4;
    stations.push({
      id: `HG-${String(i + 1).padStart(2, "0")}`,
      lon,
      lat,
      surgeMax: Math.min(MAX_LEVEL, surgeMax),
      surgeRate: 0.6 + lowGround * 0.8 + Math.random() * 0.2,
      phase: Math.random() * Math.PI * 2,
    });
  }
  return stations;
};

// Lưới ô vuông phủ khu vực mô phỏng.
export const buildGrid = (): GridConfig => {
  const [cLon, cLat] = CITY_CENTER;
  const minLon = cLon - SIM_HALF_LON;
  const minLat = cLat - SIM_HALF_LAT;
  const lonStep = (SIM_HALF_LON * 2) / GRID_N;
  const latStep = (SIM_HALF_LAT * 2) / GRID_N;
  const centerLon = new Float64Array(GRID_N * GRID_N);
  const centerLat = new Float64Array(GRID_N * GRID_N);
  for (let r = 0; r < GRID_N; r++) {
    for (let c = 0; c < GRID_N; c++) {
      const k = r * GRID_N + c;
      centerLon[k] = minLon + (c + 0.5) * lonStep;
      centerLat[k] = minLat + (r + 0.5) * latStep;
    }
  }
  return { n: GRID_N, minLon, minLat, lonStep, latStep, centerLon, centerLat };
};

// Cụm toà nhà tổng hợp (phân bố "chuông" co cụm vào lõi). Dùng cho:
//   (a) render hộp 3D khi KHÔNG có ion token (chế độ offline), và
//   (b) tập điểm phân tích ngập trong Web Worker ở mọi chế độ (đếm "toà nhà bị ngập").
export const generateBuildings = (count: number): BuildingDatum[] => {
  const [cLon, cLat] = CITY_CENTER;
  const bell = () => ((Math.random() + Math.random() + Math.random()) / 3 - 0.5) * 2;
  const out: BuildingDatum[] = [];
  for (let i = 0; i < count; i++) {
    const lon = cLon + bell() * SIM_HALF_LON * 0.92;
    const lat = cLat + bell() * SIM_HALF_LAT * 0.92;
    const distF = 1 - Math.min(1, (Math.abs(lon - cLon) / SIM_HALF_LON + Math.abs(lat - cLat) / SIM_HALF_LAT) / 2);
    const floors = Math.floor(2 + Math.random() * (5 + distF * 30));
    out.push({
      id: `BLD-${i}`,
      lon,
      lat,
      widthM: 12 + Math.random() * 16,
      depthM: 12 + Math.random() * 16,
      heightM: floors * 3.4,
      // Ngưỡng cửa 0..1.4 m: một số nhà nền cao nên ngập muộn hơn -> phân hoá theo địa hình.
      floorHeight: Math.random() * 1.4,
    });
  }
  return out;
};

// ---------------------------------------------------------------------------
// IDW (Inverse Distance Weighting) — nội suy giá trị từ N cảm biến về 1 điểm
// ---------------------------------------------------------------------------
// power = 2 (trọng số 1/d²). Khoảng cách dùng xấp xỉ phẳng (đủ chính xác ở quy mô vài km).
export const idwAt = (
  lon: number,
  lat: number,
  sLon: Float64Array,
  sLat: Float64Array,
  sVal: Float64Array,
  n: number,
): number => {
  let wSum = 0;
  let vSum = 0;
  for (let i = 0; i < n; i++) {
    const dLon = (lon - sLon[i]) * COS_LAT;
    const dLat = lat - sLat[i];
    const d2 = dLon * dLon + dLat * dLat;
    const w = 1 / (d2 + IDW_EPS);
    wSum += w;
    vSum += w * sVal[i];
  }
  return vSum / wSum;
};

// ---------------------------------------------------------------------------
// FloodController — nguồn sự thật DUY NHẤT của trạng thái ngập (ngoài React)
// ---------------------------------------------------------------------------
// MÔ HÌNH NGẬP ĐÚNG VẬT LÝ: mặt nước là một MẶT PHẲNG NGANG ở cao độ tuyệt đối W (ellipsoid, m).
// Địa hình thật quyết định nơi nào ngập (chỗ trũng ngập trước). Mọi giá trị (đất/nhà/nước) cùng
// hệ ellipsoid nên số đo nhất quán. KHÔNG còn lưới IDW cho mặt nước — W là MỘT giá trị toàn cục.
export class FloodController {
  readonly stations: SensorStation[];

  // Vị trí cảm biến (để đặt marker + sample địa hình).
  readonly sLon: Float64Array;
  readonly sLat: Float64Array;
  // Cao độ ĐỊA HÌNH tại mỗi hố ga (ellipsoid, m) — điền sau khi sample địa hình xong.
  readonly sensorTerrain: Float64Array;

  // Dải cao độ địa hình của khu vực.
  minTerrain = 0;
  maxTerrain = 0;
  lowBase = -5; // đáy khối nước (chôn dưới điểm thấp nhất) = minTerrain - 5
  terrainReady = false;

  manualLevel = 0; // mức dâng slider (m, so điểm thấp nhất minTerrain)
  waterElevation = 0; // W hiện tại (ellipsoid, m) — đọc bởi CallbackProperty mỗi khung hình
  targetElevation = 0; // W mục tiêu — waterElevation lerp dần về đây

  constructor(stations: SensorStation[]) {
    this.stations = stations;
    const n = stations.length;
    this.sLon = new Float64Array(n);
    this.sLat = new Float64Array(n);
    this.sensorTerrain = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.sLon[i] = stations[i].lon;
      this.sLat[i] = stations[i].lat;
    }
  }

  // Gọi sau khi sample địa hình xong: nạp cao độ đất cho hố ga, đặt dải min/max.
  // Khởi tạo W = minTerrain (khô ráo — mặt nước nằm ngay điểm thấp nhất).
  setTerrainSamples(minT: number, maxT: number, sensorElev: number[]): void {
    this.minTerrain = minT;
    this.maxTerrain = maxT;
    this.lowBase = minT - 5;
    this.sensorTerrain.set(sensorElev);
    this.waterElevation = minT;
    this.targetElevation = minT;
    this.terrainReady = true;
  }

  // Dải mức dâng hợp lý cho slider/bão (đủ phủ chênh cao địa hình).
  get waterRange(): number {
    return Math.max(MAX_LEVEL, Math.ceil(this.maxTerrain - this.minTerrain) + 2);
  }

  // Thủ công + bão dùng chung: mức dâng (m) so điểm thấp nhất -> W tuyệt đối.
  setRise(meters: number): void {
    this.manualLevel = meters;
    this.targetElevation = this.minTerrain + meters;
  }

  // Độ sâu ngập tại một hố ga = W trừ cao độ đất tại đó (>=0). Trạm trũng ngập sâu/sớm hơn.
  sensorDepth(i: number): number {
    return Math.max(0, this.waterElevation - this.sensorTerrain[i]);
  }
  sensorStatusCode(i: number): number {
    return STATUS_CODE[statusFromLevel(this.sensorDepth(i))];
  }

  // Lerp W mượt về mục tiêu mỗi khung hình (nước dâng liên tục, 60 FPS).
  tick(dtSeconds: number): void {
    const a = 1 - Math.exp(-5 * Math.min(dtSeconds, 0.1));
    this.waterElevation += (this.targetElevation - this.waterElevation) * a;
  }
}

export const createFloodController = (): FloodController => new FloodController(generateStations());

// Bản đồ nền (Carto raster, không cần key). Đặt ở đây (file non-component) để file map chỉ export
// component + type — tránh cảnh báo react-refresh khi export hằng số runtime từ file component.
export type BasemapId = "dark" | "light" | "voyager";
export const BASEMAP_OPTIONS: { id: BasemapId; label: string; url: string }[] = [
  { id: "dark", label: "🌑 Tối", url: "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png" },
  { id: "light", label: "☀️ Sáng", url: "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png" },
  { id: "voyager", label: "🗺️ Voyager", url: "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png" },
];
