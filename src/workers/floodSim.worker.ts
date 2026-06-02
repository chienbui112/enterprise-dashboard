// floodSim.worker.ts
// Worker MỘT-LẦN (one-shot) sinh toàn bộ "bản sao số" của thành phố cho mô phỏng ngập lụt:
//   - Cụm toà nhà 3D (GeoJSON Polygon có height/min_height/base_color) — phần nặng CPU
//     (sinh chuỗi JSON lớn + JSON.parse) chạy trong worker để main thread không bị block,
//     đúng tinh thần dashboard 3D Buildings.
//   - Mảng instance phẳng cho cây xanh & rào chắn cứu hộ (Float32Array, transferable).
// Sau khi gửi xong, worker không stream gì thêm (giống History Playback) — playback ngập
// lụt + animation sóng diễn ra hoàn toàn trên main thread bằng custom WebGL layer.

import {
  SCENE_CENTER,
  SCENE_HALF_DEG,
  TREE_STRIDE,
  BARRIER_STRIDE,
  type FloodBuildingCollection,
  type FloodBuildingFeature,
} from "../utils/floodHelpers";

// tsconfig dùng lib "DOM" -> self bị suy ra là Window; ép kiểu để có overload transferable.
const post = self.postMessage as (message: unknown, transfer?: Transferable[]) => void;

// Phân bố kiểu "chuông" quanh tâm: trung bình 3 random -> co cụm vào giữa thành phố.
const bell = () => ((Math.random() + Math.random() + Math.random()) / 3 - 0.5) * 2;

// Toà nhà tông XÁM SÁNG/trắng-xanh để tách bạch rõ với cây (xanh lá), rào (cam) và nước (đỏ).
const BUILDING_COLORS = ["#cbd5e1", "#e2e8f0", "#b8c4d4", "#d6dee8", "#aab6c6", "#f1f5f9"];

const generateBuildingsJson = (count: number): string => {
  const [cLng, cLat] = SCENE_CENTER;
  const features: FloodBuildingFeature[] = [];

  for (let i = 0; i < count; i++) {
    const lng = cLng + bell() * SCENE_HALF_DEG * 0.85;
    const lat = cLat + bell() * SCENE_HALF_DEG * 0.85;

    // Kích thước chân đế ~12–28m, chuyển sang độ kinh/vĩ.
    const wMeters = 12 + Math.random() * 16;
    const sx = wMeters / (111320 * Math.cos((cLat * Math.PI) / 180));
    const sy = wMeters / 110540;

    // Toà nhà gần tâm cao hơn (lõi đô thị); một số có min_height (nhà trên bệ/đường trên cao).
    const distFactor = 1 - Math.min(1, (Math.abs(lng - cLng) + Math.abs(lat - cLat)) / SCENE_HALF_DEG);
    const floors = Math.floor(2 + Math.random() * (6 + distFactor * 34));
    const height = floors * 3.4;
    const min_height = Math.random() < 0.12 ? Math.random() * 4 : 0;

    features.push({
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [lng, lat],
            [lng + sx, lat],
            [lng + sx, lat + sy],
            [lng, lat + sy],
            [lng, lat],
          ],
        ],
      },
      properties: {
        id: `bldg-${i}`,
        height,
        min_height,
        base_color: BUILDING_COLORS[Math.floor(Math.random() * BUILDING_COLORS.length)],
      },
    });
  }

  return JSON.stringify({ type: "FeatureCollection", features });
};

// Cây xanh: rải dày hơn ở rìa cụm (công viên/đường phố), cao 4–10m.
const generateTrees = (count: number): Float32Array => {
  const [cLng, cLat] = SCENE_CENTER;
  const arr = new Float32Array(count * TREE_STRIDE);
  for (let i = 0; i < count; i++) {
    const o = i * TREE_STRIDE;
    arr[o] = cLng + bell() * SCENE_HALF_DEG;
    arr[o + 1] = cLat + bell() * SCENE_HALF_DEG;
    arr[o + 2] = 4 + Math.random() * 6; // chiều cao thật (m) = scale
    arr[o + 3] = Math.random() * Math.PI * 2; // góc quay
  }
  return arr;
};

// Rào chắn cứu hộ: đặt thành các tuyến ngắn (mô phỏng chốt chặn đường ngập).
const generateBarriers = (count: number): Float32Array => {
  const [cLng, cLat] = SCENE_CENTER;
  const arr = new Float32Array(count * BARRIER_STRIDE);
  let i = 0;
  while (i < count) {
    // Một "chốt" gồm 3–6 rào nối tiếp theo cùng hướng.
    const baseLng = cLng + bell() * SCENE_HALF_DEG * 0.9;
    const baseLat = cLat + bell() * SCENE_HALF_DEG * 0.9;
    const rot = Math.random() * Math.PI * 2;
    const segLen = 0.00005; // ~5m bước giữa các rào
    const n = 3 + Math.floor(Math.random() * 4);
    for (let k = 0; k < n && i < count; k++, i++) {
      const o = i * BARRIER_STRIDE;
      arr[o] = baseLng + Math.cos(rot) * segLen * k;
      arr[o + 1] = baseLat + Math.sin(rot) * segLen * k;
      arr[o + 2] = 0.9 + Math.random() * 0.4; // scale
      arr[o + 3] = rot;
    }
  }
  return arr;
};

self.onmessage = (event: MessageEvent) => {
  const { type, buildingCount, treeCount, barrierCount } = event.data;
  if (type !== "GENERATE") return;

  const t0 = performance.now();

  // Phần nặng nhất: sinh chuỗi JSON lớn rồi parse ngay trong worker.
  const rawJson = generateBuildingsJson(buildingCount);
  const buildings = JSON.parse(rawJson) as FloodBuildingCollection;

  const trees = generateTrees(treeCount);
  const barriers = generateBarriers(barrierCount);

  const genMs = performance.now() - t0;

  // buildings là object (structured-clone) — count vài nghìn nên rẻ; trees/barriers
  // chuyển quyền sở hữu ArrayBuffer (zero-copy).
  post(
    {
      type: "SCENE_READY",
      buildings,
      trees,
      barriers,
      treeCount,
      barrierCount,
      genMs,
    },
    [trees.buffer, barriers.buffer],
  );
};
