import React, { useEffect, useRef } from "react";
import maplibre, { Map, NavigationControl, type StyleSpecification, type MapMouseEvent, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { TILE_PROTOCOL, RASTER_URL } from "../../utils/tileCacheHelper";
import type { OfflineFeature } from "../../utils/indexedDbHelper";

export type DrawMode = "select" | "point" | "polygon";

interface MapContainerOfflineProps {
  features: OfflineFeature[];
  drawMode: DrawMode;
  selectedId: string | null;
  onCreatePoint: (coords: [number, number]) => void;
  onCreatePolygon: (ring: [number, number][]) => void;
  onSelectFeature: (id: string | null) => void;
  // Dashboard mượn map instance để prefetch tile theo viewport.
  mapApiRef: React.RefObject<Map | null>;
}

const EMPTY_FC = { type: "FeatureCollection" as const, features: [] };

// Style raster (BẮT BUỘC cho cache-on-browse): tile đi qua protocol "offline://" -> qua IndexedDB.
const offlineStyle: StyleSpecification = {
  version: 8,
  sources: {
    carto: { type: "raster", tiles: [`${TILE_PROTOCOL}://${RASTER_URL}`], tileSize: 256, attribution: "© CARTO" },
  },
  layers: [{ id: "carto", type: "raster", source: "carto" }],
};

export const MapContainerOffline: React.FC<MapContainerOfflineProps> = ({
  features,
  drawMode,
  selectedId,
  onCreatePoint,
  onCreatePolygon,
  onSelectFeature,
  mapApiRef,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);

  // Ref-for-prop: handler gắn 1 lần trong useEffect[] nên đọc prop mới nhất qua ref.
  const drawModeRef = useRef(drawMode);
  drawModeRef.current = drawMode;
  const onCreatePointRef = useRef(onCreatePoint);
  onCreatePointRef.current = onCreatePoint;
  const onCreatePolygonRef = useRef(onCreatePolygon);
  onCreatePolygonRef.current = onCreatePolygon;
  const onSelectFeatureRef = useRef(onSelectFeature);
  onSelectFeatureRef.current = onSelectFeature;

  // Đỉnh polygon đang vẽ dở (chưa đóng vùng).
  const vertsRef = useRef<[number, number][]>([]);

  // Vẽ lại layer phụ trợ thể hiện vùng đang vẽ dở.
  const drawTemp = () => {
    const map = mapRef.current;
    if (!map) return;
    const src = map.getSource("draw-src") as GeoJSONSource | undefined;
    if (!src) return;
    const verts = vertsRef.current;
    const feats: GeoJSON.Feature[] = verts.map((c) => ({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: {} }));
    if (verts.length >= 2) {
      feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: verts }, properties: {} });
    }
    src.setData({ type: "FeatureCollection", features: feats });
  };

  // Cập nhật dữ liệu feature đã lưu lên bản đồ.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const src = map.getSource("features-src") as GeoJSONSource | undefined;
    if (src) src.setData({ type: "FeatureCollection", features } as GeoJSON.FeatureCollection);
  }, [features]);

  // Highlight feature đang chọn (đổi filter của layer highlight).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer("sel-pts")) return;
    const idMatch = selectedId ?? "__none__";
    map.setFilter("sel-pts", ["all", ["==", ["geometry-type"], "Point"], ["==", ["get", "id"], idMatch]]);
    map.setFilter("sel-poly", ["all", ["==", ["geometry-type"], "Polygon"], ["==", ["get", "id"], idMatch]]);
  }, [selectedId]);

  // Đổi draw mode: con trỏ + bật/tắt double-click-zoom + dọn vùng vẽ dở khi rời polygon.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = drawMode === "select" ? "" : "crosshair";
    if (drawMode === "polygon") map.doubleClickZoom.disable();
    else {
      map.doubleClickZoom.enable();
      if (vertsRef.current.length) {
        vertsRef.current = [];
        drawTemp();
      }
    }
  }, [drawMode]);

  useEffect(() => {
    if (!mapContainerRef.current) return;

    const map = new maplibre.Map({
      container: mapContainerRef.current,
      style: offlineStyle,
      center: [105.85, 21.03], // Hoàn Kiếm, Hà Nội
      zoom: 13,
    });
    map.addControl(new NavigationControl(), "top-right");
    mapRef.current = map;
    mapApiRef.current = map;

    // Biểu thức màu theo trạng thái: đỏ = conflict, xanh lá = đã sync, cam = đang chờ trong queue.
    const statusColor = [
      "case",
      ["boolean", ["get", "conflict"], false],
      "#ef4444",
      ["boolean", ["get", "synced"], false],
      "#22c55e",
      "#ea580c",
    ] as maplibre.ExpressionSpecification;

    map.on("load", () => {
      // Source feature đã lưu + source vùng đang vẽ dở.
      map.addSource("features-src", { type: "geojson", data: EMPTY_FC });
      map.addSource("draw-src", { type: "geojson", data: EMPTY_FC });

      // Polygon: nền + viền.
      map.addLayer({
        id: "poly-fill",
        type: "fill",
        source: "features-src",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": statusColor, "fill-opacity": 0.25 },
      });
      map.addLayer({
        id: "poly-line",
        type: "line",
        source: "features-src",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "line-color": statusColor, "line-width": 2 },
      });
      // Highlight polygon đang chọn (đặt trước điểm để không che marker).
      map.addLayer({
        id: "sel-poly",
        type: "line",
        source: "features-src",
        filter: ["all", ["==", ["geometry-type"], "Polygon"], ["==", ["get", "id"], "__none__"]],
        paint: { "line-color": "#fff", "line-width": 4 },
      });

      // Điểm khảo sát.
      map.addLayer({
        id: "pts",
        type: "circle",
        source: "features-src",
        filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 7, "circle-color": statusColor, "circle-stroke-width": 2, "circle-stroke-color": "#fff" },
      });
      // Highlight điểm đang chọn.
      map.addLayer({
        id: "sel-pts",
        type: "circle",
        source: "features-src",
        filter: ["all", ["==", ["geometry-type"], "Point"], ["==", ["get", "id"], "__none__"]],
        paint: { "circle-radius": 11, "circle-color": "rgba(0,0,0,0)", "circle-stroke-width": 3, "circle-stroke-color": "#fff" },
      });

      // Vùng đang vẽ dở: đường nét đứt + đỉnh.
      map.addLayer({
        id: "draw-line",
        type: "line",
        source: "draw-src",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-color": "#38bdf8", "line-width": 2, "line-dasharray": [2, 1] },
      });
      map.addLayer({
        id: "draw-verts",
        type: "circle",
        source: "draw-src",
        filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 4, "circle-color": "#38bdf8", "circle-stroke-width": 1, "circle-stroke-color": "#fff" },
      });
    });

    // Click: tuỳ draw mode -> chấm điểm / thêm đỉnh polygon (hoặc đóng vùng) / chọn feature.
    map.on("click", (e: MapMouseEvent) => {
      const mode = drawModeRef.current;
      const coords: [number, number] = [e.lngLat.lng, e.lngLat.lat];

      if (mode === "point") {
        onCreatePointRef.current(coords);
        return;
      }

      if (mode === "polygon") {
        const verts = vertsRef.current;
        // Click gần đỉnh đầu (>=3 đỉnh) -> đóng vùng (UX vẽ polygon kinh điển, tránh dùng dblclick).
        if (verts.length >= 3) {
          const p0 = map.project(verts[0]);
          if (Math.hypot(p0.x - e.point.x, p0.y - e.point.y) < 14) {
            onCreatePolygonRef.current([...verts, verts[0]]);
            vertsRef.current = [];
            drawTemp();
            return;
          }
        }
        verts.push(coords);
        drawTemp();
        return;
      }

      // select mode -> chọn feature dưới con trỏ.
      const hits = map.queryRenderedFeatures(e.point, { layers: ["pts", "poly-fill"] });
      onSelectFeatureRef.current(hits.length ? (hits[0].properties?.id as string) : null);
    });

    return () => {
      mapApiRef.current = null;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ flex: 1, position: "relative", height: "100vh" }}>
      <div ref={mapContainerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
};
