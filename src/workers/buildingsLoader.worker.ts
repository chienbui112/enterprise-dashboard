// buildingsLoader.worker.ts
// Đọc + parse + LỌC file hn_buildings.geojson (rất lớn ~88MB) NGOÀI main thread để không treo UI.
// Chỉ giữ các toà nhà có TÂM nằm trong hộp mô phỏng + giới hạn số lượng (maxCount), rồi trả về
// dữ liệu tối thiểu: vành ngoài (flat lon,lat), chiều cao, và properties (để click xem thông tin).
//
// Quy tắc chiều cao: building_l có giá trị -> height = building_l * 3.4 m; không có -> 4.5 m.

const post = self.postMessage as (message: unknown, transfer?: Transferable[]) => void;

interface LoadMsg {
  type: "LOAD";
  url: string;
  west: number;
  south: number;
  east: number;
  north: number;
  maxCount: number;
}

export interface LoadedBuilding {
  ring: number[]; // vành ngoài đa giác: [lon,lat, lon,lat, ...]
  heightM: number;
  cLon: number; // tâm (để nội suy cao độ nền + lọc bbox)
  cLat: number;
  props: Record<string, unknown>;
}

const FLOOR_HEIGHT = 3.4; // m mỗi tầng
const DEFAULT_HEIGHT = 4.5; // m khi không có building_l

self.onmessage = async (event: MessageEvent<LoadMsg>) => {
  const data = event.data;
  if (data.type !== "LOAD") return;
  const { url, west, south, east, north, maxCount } = data;

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const gj = (await resp.json()) as { features?: unknown[] };
    const feats = Array.isArray(gj.features) ? gj.features : [];
    const total = feats.length;
    const out: LoadedBuilding[] = [];

    for (let i = 0; i < feats.length && out.length < maxCount; i++) {
      const f = feats[i] as {
        properties?: Record<string, unknown>;
        geometry?: { type?: string; coordinates?: unknown };
      };
      const g = f.geometry;
      if (!g || !g.coordinates) continue;

      // Lấy vành ngoài của đa giác ĐẦU TIÊN (Polygon: coords[0]; MultiPolygon: coords[0][0]).
      let ring0: number[][] | null = null;
      if (g.type === "Polygon") {
        ring0 = (g.coordinates as number[][][])[0] ?? null;
      } else if (g.type === "MultiPolygon") {
        ring0 = (g.coordinates as number[][][][])[0]?.[0] ?? null;
      }
      if (!ring0 || ring0.length < 4) continue;

      // Tâm (trung bình các đỉnh) để lọc bbox + nội suy cao độ nền.
      let sx = 0;
      let sy = 0;
      for (let k = 0; k < ring0.length; k++) {
        sx += ring0[k][0];
        sy += ring0[k][1];
      }
      const cLon = sx / ring0.length;
      const cLat = sy / ring0.length;
      if (cLon < west || cLon > east || cLat < south || cLat > north) continue;

      // Chiều cao theo building_l (số tầng).
      const bl = f.properties ? f.properties["building_l"] : null;
      const floors = bl !== null && bl !== undefined && bl !== "" && !Number.isNaN(Number(bl)) ? Number(bl) : null;
      const heightM = floors !== null ? floors * FLOOR_HEIGHT : DEFAULT_HEIGHT;

      const ring: number[] = [];
      for (let k = 0; k < ring0.length; k++) {
        ring.push(ring0[k][0], ring0[k][1]);
      }
      out.push({ ring, heightM, cLon, cLat, props: f.properties ?? {} });
    }

    post({ type: "BUILDINGS_LOADED", buildings: out, total, kept: out.length });
  } catch (err) {
    post({ type: "BUILDINGS_ERROR", message: String(err) });
  }
};
