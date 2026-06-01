import KDBush from "kdbush";
import { around, distance as geoDistance } from "geokdbush";
import type { Feature, Polygon } from "geojson";

export type BufferGeometry = Feature<Polygon>;

// Bỏ field `driver` (DriverFeature) — phù hợp với pattern SoA + worker:
// kdbush returns indices, main giữ flat positions array; UI lookup tên/popup từ idx.
export interface MatchedDriver {
  idx: number;
  distanceKm: number;
}

// Hand-rolled circle generator → polygon geographic (lng/lat).
// Equirectangular approximation: dLat = R/111, dLng = R/(111*cos(lat)).
// Tại radius vài km, lat trung bình → sai số sub-meter so với geodesic chuẩn.
const CIRCLE_STEPS = 64;
const KM_PER_LAT_DEG = 111;

export const createBufferCircle = (center: [number, number], radiusKm: number): BufferGeometry => {
  const [cLng, cLat] = center;
  const dLat = radiusKm / KM_PER_LAT_DEG;
  const dLng = radiusKm / (KM_PER_LAT_DEG * Math.cos((cLat * Math.PI) / 180));
  const ring: [number, number][] = new Array(CIRCLE_STEPS + 1);
  for (let i = 0; i <= CIRCLE_STEPS; i++) {
    const angle = (i / CIRCLE_STEPS) * Math.PI * 2;
    ring[i] = [cLng + dLng * Math.sin(angle), cLat + dLat * Math.cos(angle)];
  }
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: {},
  };
};

// Index reconstructed ở main từ kdbush buffer + master positions của worker.
// `lngs`/`lats` là FULL positions của 100k driver (Float32 sau khi worker downcast),
// để compute distance cho bất kỳ idx kdbush trả về (kể cả ngoài viewport).
export interface DriverIndex {
  kd: KDBush;
  lngs: Float32Array;
  lats: Float32Array;
}

// Wrap kdbush từ ArrayBuffer transferred từ worker (zero-copy).
// Worker tạo kdbush, transfer underlying buffer; main gọi KDBush.from() để reconstruct.
// Build cost ở worker (~30-50ms cho 100k), main chỉ wrap — gần như free.
export const rehydrateDriverIndex = (
  kdBuffer: ArrayBuffer,
  lngs: Float32Array,
  lats: Float32Array,
): DriverIndex => ({
  kd: KDBush.from(kdBuffer),
  lngs,
  lats,
});

// Lọc driver trong bán kính R. Trả về sorted ascending theo distance.
// Idx trả về là index trong SoA gốc (0..N-1, stable theo driver identity).
export const findDriversInRadius = (
  di: DriverIndex,
  center: [number, number],
  radiusKm: number,
): MatchedDriver[] => {
  const [cLng, cLat] = center;
  const idxs = around(di.kd, cLng, cLat, Infinity, radiusKm);
  return idxs.map((i) => ({
    idx: i,
    distanceKm: geoDistance(cLng, cLat, di.lngs[i], di.lats[i]),
  }));
};

// Tìm K driver gần nhất. Đã sort ascending.
export const findNearestDrivers = (
  di: DriverIndex,
  center: [number, number],
  k: number,
): MatchedDriver[] => {
  const [cLng, cLat] = center;
  const idxs = around(di.kd, cLng, cLat, k);
  return idxs.map((i) => ({
    idx: i,
    distanceKm: geoDistance(cLng, cLat, di.lngs[i], di.lats[i]),
  }));
};
