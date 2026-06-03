// floodIntersection.worker.ts
// Web Worker phân tích giao cắt không gian (Spatial Intersection) cho hệ thống cảnh báo ngập.
//
// Nhiệm vụ (đề bài mục 5): so sánh cao độ chân (floorHeight) của TỪNG toà nhà với mực nước nội
// suy IDW hiện tại tại vị trí toà nhà đó. Nếu mực nước cục bộ vượt ngưỡng cửa -> toà nhà "bị ngập",
// trả về độ sâu ngập để main thread tô màu (đỏ + nhấp nháy theo độ sâu).
//
// Đặt trong Worker để vòng lặp O(toà_nhà × cảm_biến) không chiếm UI thread — main thread chỉ
// đẩy mảng mực nước (~50 số) mỗi ~250ms và nhận về typed array transferable (zero-copy).
//
// Worker import IDW + kiểu dữ liệu từ cesiumFloodHelpers (file thuần TS, không đụng tới Cesium).

import { idwAt } from "../utils/cesiumFloodHelpers";

// tsconfig dùng lib "DOM" -> self bị suy ra là Window; ép kiểu để có overload transferable.
const post = self.postMessage as (message: unknown, transfer?: Transferable[]) => void;

// Trạng thái master của worker (giữ giữa các tick).
let bLon: Float64Array = new Float64Array(0);
let bLat: Float64Array = new Float64Array(0);
let bFloor: Float64Array = new Float64Array(0); // cao độ ngưỡng cửa mỗi toà nhà (m)
let count = 0;

let sLon: Float64Array = new Float64Array(0); // vị trí cảm biến (cố định sau INIT)
let sLat: Float64Array = new Float64Array(0);
let sCount = 0;

// Buffer kết quả tái sử dụng (cấp phát một lần) — nhưng buffer transferable bị "neuter" sau khi
// gửi, nên ta cấp phát mới mỗi lần gửi. Vẫn rẻ vì kích thước nhỏ.

interface InitMsg {
  type: "INIT";
  buildingLon: Float64Array;
  buildingLat: Float64Array;
  buildingFloor: Float64Array;
  stationLon: Float64Array;
  stationLat: Float64Array;
}

interface AnalyzeMsg {
  type: "ANALYZE";
  levels: number[]; // mực nước mỗi cảm biến (m), cùng thứ tự với stationLon/Lat
}

self.onmessage = (event: MessageEvent<InitMsg | AnalyzeMsg>) => {
  const data = event.data;

  if (data.type === "INIT") {
    bLon = data.buildingLon;
    bLat = data.buildingLat;
    bFloor = data.buildingFloor;
    count = bLon.length;
    sLon = data.stationLon;
    sLat = data.stationLat;
    sCount = sLon.length;
    return;
  }

  if (data.type === "ANALYZE") {
    if (count === 0 || sCount === 0) return;

    // Mực nước mỗi cảm biến (copy vào Float64Array để idwAt dùng).
    const sVal = new Float64Array(sCount);
    for (let i = 0; i < sCount; i++) sVal[i] = data.levels[i] ?? 0;

    const flooded = new Uint8Array(count);
    const depth = new Float32Array(count);
    let floodedCount = 0;

    for (let b = 0; b < count; b++) {
      const localDepth = idwAt(bLon[b], bLat[b], sLon, sLat, sVal, sCount);
      const over = localDepth - bFloor[b];
      if (over > 0) {
        flooded[b] = 1;
        depth[b] = over;
        floodedCount++;
      }
    }

    post(
      { type: "FLOOD_RESULT", flooded, depth, floodedCount },
      [flooded.buffer, depth.buffer],
    );
  }
};
