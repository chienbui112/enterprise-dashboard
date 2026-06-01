import { generateLargeBuildingJsonString, type BuildingFeature, type BuildingFeatureCollection } from "../utils/geoHelpers3d";

// tsconfig dùng lib "DOM" -> self bị suy ra là Window; trong worker đây là DedicatedWorkerGlobalScope.
const post = self.postMessage as (message: unknown) => void;

// Master dataset (toàn bộ toà nhà) giữ trong worker; main thread chỉ nhận phần trong viewport.
let master: BuildingFeature[] = [];
let currentBbox: [number, number, number, number] | null = null;

self.onmessage = (event: MessageEvent) => {
  const { type, count, bbox } = event.data;

  switch (type) {
    case "GENERATE_AND_PARSE": {
      // 1. Sinh chuỗi JSON nặng NGAY TRONG worker (mô phỏng payload tải từ API) -> main thread không bị block
      const rawJsonString = generateLargeBuildingJsonString(count);

      // 2. Tác vụ tốn CPU nhất: parse chuỗi lớn. Đo riêng để báo cáo chính xác cho UI.
      const startTime = performance.now();
      const geojsonData = JSON.parse(rawJsonString) as BuildingFeatureCollection;
      const parseMs = performance.now() - startTime;

      master = geojsonData.features;
      console.log(`Worker: Parsed ${master.length} buildings in ${parseMs.toFixed(2)}ms`);

      post({ type: "GENERATE_DONE", total: master.length, parseMs });
      sendVisible(); // gửi ngay phần nằm trong viewport hiện tại
      break;
    }

    case "UPDATE_BBOX":
      currentBbox = bbox;
      sendVisible();
      break;
  }
};

// Lọc toà nhà theo viewport rồi gửi về main (chỉ render phần đang nhìn -> nhẹ GPU)
const sendVisible = () => {
  if (!currentBbox || master.length === 0) return;
  const [minLng, minLat, maxLng, maxLat] = currentBbox;

  const features: BuildingFeature[] = [];
  for (let i = 0; i < master.length; i++) {
    // Dùng góc đầu tiên của polygon làm điểm đại diện (toà nhà ~50m nên đủ chính xác)
    const [lng, lat] = master[i].geometry.coordinates[0][0];
    if (lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat) {
      features.push(master[i]);
    }
  }

  post({ type: "VISIBLE_DATA", payload: { type: "FeatureCollection", features } });
};
