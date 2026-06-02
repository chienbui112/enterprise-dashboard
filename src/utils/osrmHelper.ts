import { haversineKm } from "./geoHelpers";
import type { DeliveryPoint, RouteLeg, TravelMode } from "./routeApiHelper";

// Bọc OSRM (Open Source Routing Machine) — server demo công khai. Cho ma trận khoảng cách
// THẬT trên mạng đường (/table) và hình học đường THẬT theo từng chặng (/route).
// Mọi hàm có thể throw (mạng/CORS/rate-limit) -> caller bắt và lui về fallback.

const OSRM_BASE = "https://router.project-osrm.org";

// Chặng ngắn hơn ngưỡng này -> coi là "đi bộ vào ngõ" (chỉ MINH HOẠ đa phương thức;
// OSRM demo chỉ có profile ô tô nên hình học thực ra vẫn theo đường xe).
const WALK_THRESHOLD_M = 300;

// OSRM nhận toạ độ dạng "lng,lat;lng,lat;..." (KINH ĐỘ trước).
const toCoordStr = (coords: [number, number][]): string =>
  coords.map(([lng, lat]) => `${lng},${lat}`).join(";");

// === /table: ma trận N×N thời gian (giây) + khoảng cách (mét) giữa mọi cặp điểm ===
// 20 điểm -> 400 ô, trả về trong vài ms nhờ Contraction Hierarchies.
export const fetchOsrmTable = async (
  points: DeliveryPoint[],
): Promise<{ distances: number[][]; durations: number[][] }> => {
  const coords = points.map((p) => [p.lng, p.lat] as [number, number]);
  const url = `${OSRM_BASE}/table/v1/driving/${toCoordStr(coords)}?annotations=duration,distance`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM /table -> ${res.status}`);
  const data = await res.json();
  if (data.code !== "Ok" || !data.distances || !data.durations) {
    throw new Error(`OSRM /table code=${data.code}`);
  }
  return { distances: data.distances, durations: data.durations };
};

// === /route: hình học chi tiết của lộ trình đã sắp thứ tự, TÁCH theo từng chặng ===
// 1 request duy nhất cho cả lộ trình (tránh rate-limit). Dùng steps=true để lấy hình học
// từng leg: nối toạ độ các step trong leg[i] -> coords của chặng i.
export const fetchOsrmRoute = async (orderedCoords: [number, number][]): Promise<RouteLeg[]> => {
  const url = `${OSRM_BASE}/route/v1/driving/${toCoordStr(orderedCoords)}?overview=full&geometries=geojson&steps=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM /route -> ${res.status}`);
  const data = await res.json();
  const route = data.routes?.[0];
  if (data.code !== "Ok" || !route) throw new Error(`OSRM /route code=${data.code}`);

  return route.legs.map((leg: { distance: number; steps: { geometry: { coordinates: [number, number][] } }[] }) => {
    const coords: [number, number][] = [];
    for (const step of leg.steps) {
      for (const c of step.geometry.coordinates) coords.push(c);
    }
    return { coords, distanceM: leg.distance };
  });
};

// === Fallback ma trận khi /table lỗi: haversine (great-circle), mét ===
export const haversineMatrix = (points: DeliveryPoint[]): number[][] => {
  const n = points.length;
  const m: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = haversineKm(points[i].lng, points[i].lat, points[j].lng, points[j].lat) * 1000;
      m[i][j] = d;
      m[j][i] = d;
    }
  }
  return m;
};

// Gán phương thức cho 1 chặng theo độ dài (luật minh hoạ).
export const assignMode = (distanceM: number): TravelMode => (distanceM < WALK_THRESHOLD_M ? "walk" : "ride");
