import { haversineKm } from "./geoHelpers";

// Helper cho dashboard Route Optimizer (TSP): sinh điểm giao hàng + polyline fallback.
// Phần routing đường THẬT (OSRM) nằm ở osrmHelper.ts; file này lo dữ liệu gốc + dự phòng.

export interface DeliveryPoint {
  lng: number;
  lat: number;
  name: string;
  isDepot: boolean; // phần tử đầu (index 0) là kho xuất phát
}

// Phương thức di chuyển của 1 chặng — dùng để tô màu/nét đa phương thức trên map.
export type TravelMode = "walk" | "ride";

// 1 chặng của lộ trình: chuỗi toạ độ chi tiết + quãng đường (mét).
// Là đơn vị chung giữa OSRM (đường thật) và fallback (giả lập) -> pipeline vẽ dùng chung.
export interface RouteLeg {
  coords: [number, number][];
  distanceM: number;
}

// Vùng Hà Nội theo convention dự án (xem CLAUDE.md).
const BBOX = { minLng: 105.75, maxLng: 105.93, minLat: 20.95, maxLat: 21.1 };

// Sinh `count` điểm ngẫu nhiên đều trong bbox. Điểm 0 là KHO (depot) — TSP xuất phát từ đây.
export const generateDeliveryPoints = (count: number): DeliveryPoint[] => {
  const pts: DeliveryPoint[] = [];
  for (let i = 0; i < count; i++) {
    const lng = BBOX.minLng + Math.random() * (BBOX.maxLng - BBOX.minLng);
    const lat = BBOX.minLat + Math.random() * (BBOX.maxLat - BBOX.minLat);
    pts.push({
      lng,
      lat,
      isDepot: i === 0,
      name: i === 0 ? "Kho trung tâm" : `Điểm giao #${i}`,
    });
  }
  return pts;
};

// Số điểm trung gian chèn vào mỗi chặng -> polyline trông như đường có khúc cua, không phải đoạn thẳng.
const SUBDIVISIONS = 14;

// FALLBACK khi OSRM không gọi được: dựng polyline GIẢ LẬP theo từng chặng.
// Vì không có engine định tuyến thật, ta "bẻ cong" mỗi chặng AB bằng lệch ngang dạng sin theo
// vector pháp tuyến (vuông góc AB). Hàm sin bằng 0 ở hai đầu -> chặng nối liền mạch.
// Trả về theo TỪNG CHẶNG (RouteLeg[]) để khớp định dạng của OSRM -> render đa phương thức dùng chung.
export const buildSyntheticLegs = (waypoints: [number, number][]): RouteLeg[] => {
  const legs: RouteLeg[] = [];

  for (let s = 0; s < waypoints.length - 1; s++) {
    const [aLng, aLat] = waypoints[s];
    const [bLng, bLat] = waypoints[s + 1];
    const dLng = bLng - aLng;
    const dLat = bLat - aLat;
    const len = Math.hypot(dLng, dLat) || 1e-9;

    // Vector pháp tuyến đơn vị (xoay vector AB 90°): dùng để lệch ngang.
    const nLng = -dLat / len;
    const nLat = dLng / len;
    const amp = len * (0.04 + Math.random() * 0.06);
    const wiggles = 1 + Math.floor(Math.random() * 2);

    const coords: [number, number][] = [];
    for (let k = 0; k <= SUBDIVISIONS; k++) {
      const t = k / SUBDIVISIONS;
      const bend = Math.sin(Math.PI * t * wiggles) * amp;
      coords.push([aLng + dLng * t + nLng * bend, aLat + dLat * t + nLat * bend]);
    }
    legs.push({ coords, distanceM: haversineKm(aLng, aLat, bLng, bLat) * 1000 });
  }
  return legs;
};
