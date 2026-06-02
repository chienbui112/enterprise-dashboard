import React, { useEffect, useRef } from "react";
import maplibre, { Map, NavigationControl, Popup, LngLatBounds, type GeoJSONSource, type MapMouseEvent, type MapGeoJSONFeature } from "maplibre-gl";
import { MapLoadingOverlay } from "../MapLoadingOverlay";
import type { DeliveryPoint, TravelMode } from "../../utils/routeApiHelper";
import "maplibre-gl/dist/maplibre-gl.css";

// 1 chặng đã gán phương thức, sẵn sàng vẽ (toạ độ chi tiết + mode để tô màu/nét).
export interface DrawLeg {
  coords: [number, number][];
  mode: TravelMode;
}

interface MapContainerTspProps {
  isLoading: boolean;
  loadingLabel: string;
  // --- Cầu nối imperative (kiểu packetHandlerRef của MotionStream) ---
  // Dashboard gán callback vào các ref này; map gọi tới khi cần. Hình học KHÔNG đi qua React state.
  renderPointsRef: React.RefObject<((pts: DeliveryPoint[]) => void) | null>;
  drawRouteRef: React.RefObject<((legs: DrawLeg[], order: number[]) => void) | null>;
  clearRouteRef: React.RefObject<(() => void) | null>;
  // Vẽ chồng lộ trình Nearest Neighbor (đường thẳng nối điểm) để so sánh; null = ẩn.
  drawCompareRef: React.RefObject<((coords: [number, number][] | null) => void) | null>;
}

// order[r] = index điểm thăm thứ r. Dựng map idx -> rank để gán nhãn thứ tự lên điểm.
type RankMap = Record<number, number>;

// Dựng FeatureCollection cho 20 điểm. `rankByIdx` null = chưa tối ưu (điểm giao không có nhãn số).
const buildPointsFC = (pts: DeliveryPoint[], rankByIdx: RankMap | null) => ({
  type: "FeatureCollection" as const,
  features: pts.map((p, idx) => ({
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
    properties: {
      idx,
      name: p.name,
      isDepot: p.isDepot,
      // Kho luôn hiện "K"; điểm giao hiện số thứ tự thăm sau khi tối ưu, trống khi chưa.
      label: p.isDepot ? "K" : rankByIdx && rankByIdx[idx] != null ? String(rankByIdx[idx]) : "",
    },
  })),
});

const EMPTY_FC = { type: "FeatureCollection" as const, features: [] };

export const MapContainerTsp: React.FC<MapContainerTspProps> = ({
  isLoading,
  loadingLabel,
  renderPointsRef,
  drawRouteRef,
  clearRouteRef,
  drawCompareRef,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const loadedRef = useRef(false);

  // Trạng thái hình học mới nhất (ref, không state): điểm + nhãn rank hiện hành.
  const pointsRef = useRef<DeliveryPoint[]>([]);
  const rankMapRef = useRef<RankMap | null>(null);
  const popupRef = useRef<Popup | null>(null);

  useEffect(() => {
    if (!mapContainerRef.current) return;

    const map = new maplibre.Map({
      container: mapContainerRef.current,
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      center: [105.84, 21.02],
      zoom: 11,
    });
    map.addControl(new NavigationControl(), "top-right");
    mapRef.current = map;

    // --- Áp điểm hiện hành lên source (đọc từ ref); fit bounds nếu được yêu cầu ---
    const applyPoints = (fit: boolean) => {
      if (!loadedRef.current) return;
      const src = map.getSource("points-source") as GeoJSONSource | undefined;
      if (!src) return;
      src.setData(buildPointsFC(pointsRef.current, rankMapRef.current));
      if (fit && pointsRef.current.length) {
        const b = new LngLatBounds();
        for (const p of pointsRef.current) b.extend([p.lng, p.lat]);
        map.fitBounds(b, { padding: 80, duration: 600, maxZoom: 14 });
      }
    };

    // === Cầu nối 1: render 20 điểm mới (reset nhãn + xoá lộ trình cũ) ===
    renderPointsRef.current = (pts: DeliveryPoint[]) => {
      pointsRef.current = pts;
      rankMapRef.current = null;
      popupRef.current?.remove();
      (map.getSource("route-source") as GeoJSONSource | undefined)?.setData(EMPTY_FC);
      (map.getSource("compare-source") as GeoJSONSource | undefined)?.setData(EMPTY_FC);
      applyPoints(true);
    };

    // === Cầu nối 2: vẽ lộ trình tối ưu (polyline chi tiết theo chặng) + gán nhãn thứ tự lên điểm ===
    drawRouteRef.current = (legs: DrawLeg[], order: number[]) => {
      if (!loadedRef.current) return;
      // order[r] -> rank r (r=0 là kho). Điểm giao nhận số 1..N-1 theo thứ tự thăm.
      const rankByIdx: RankMap = {};
      order.forEach((idx, rank) => (rankByIdx[idx] = rank));
      rankMapRef.current = rankByIdx;
      applyPoints(false); // cập nhật nhãn, không fit lại

      // Mỗi chặng là 1 LineString mang property `mode` -> 2 layer lọc theo mode để vẽ nét/màu khác nhau.
      const routeSrc = map.getSource("route-source") as GeoJSONSource | undefined;
      routeSrc?.setData({
        type: "FeatureCollection",
        features: legs.map((leg) => ({
          type: "Feature",
          geometry: { type: "LineString", coordinates: leg.coords },
          properties: { mode: leg.mode },
        })),
      });
    };

    // === Cầu nối 3: xoá lộ trình + nhãn (khi bắt đầu giải lại) ===
    clearRouteRef.current = () => {
      if (!loadedRef.current) return;
      rankMapRef.current = null;
      (map.getSource("route-source") as GeoJSONSource | undefined)?.setData(EMPTY_FC);
      (map.getSource("compare-source") as GeoJSONSource | undefined)?.setData(EMPTY_FC);
      applyPoints(false);
    };

    // === Cầu nối 4: vẽ chồng lộ trình NN (đường thẳng) để so sánh; null = ẩn ===
    drawCompareRef.current = (coords: [number, number][] | null) => {
      if (!loadedRef.current) return;
      const src = map.getSource("compare-source") as GeoJSONSource | undefined;
      if (!src) return;
      src.setData(
        coords
          ? { type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: {} }
          : EMPTY_FC,
      );
    };

    map.on("load", () => {
      loadedRef.current = true;

      // --- Source lộ trình đặt DƯỚI điểm để điểm không bị đường che ---
      // Hai layer riêng vì `line-dasharray` KHÔNG data-driven trong MapLibre: không thể
      // đổi nét đứt/liền per-feature bằng expression -> tách layer, lọc theo property `mode`.
      map.addSource("route-source", { type: "geojson", data: EMPTY_FC });
      // Xe máy: nét liền xanh lá.
      map.addLayer({
        id: "route-ride",
        type: "line",
        source: "route-source",
        filter: ["==", ["get", "mode"], "ride"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#22c55e", "line-width": 4, "line-opacity": 0.9 },
      });
      // Đi bộ: nét đứt xanh dương (chặng ngắn "vào ngõ").
      map.addLayer({
        id: "route-walk",
        type: "line",
        source: "route-source",
        filter: ["==", ["get", "mode"], "walk"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#3b82f6", "line-width": 4, "line-opacity": 0.95, "line-dasharray": [2, 2] },
      });

      // --- Lộ trình Nearest Neighbor để so sánh: đường THẲNG nối điểm, nét đứt đỏ mờ ---
      // Cố ý vẽ thẳng (không bám phố): các cạnh cắt chéo nhau của NN chính là "nút thắt"
      // mà 2-opt/Held-Karp tháo ra -> nét thẳng làm chỗ chéo lộ rõ khi đặt cạnh lộ trình tối ưu.
      map.addSource("compare-source", { type: "geojson", data: EMPTY_FC });
      map.addLayer({
        id: "compare-line",
        type: "line",
        source: "compare-source",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#f87171", "line-width": 2, "line-opacity": 0.65, "line-dasharray": [1.5, 1.5] },
      });

      // --- Source 20 điểm ---
      map.addSource("points-source", { type: "geojson", data: EMPTY_FC });
      // Vòng tròn: kho (gold, to) vs điểm giao (indigo).
      map.addLayer({
        id: "points-circle",
        type: "circle",
        source: "points-source",
        paint: {
          "circle-radius": ["case", ["get", "isDepot"], 11, 8],
          "circle-color": ["case", ["get", "isDepot"], "#fbbf24", "#6366f1"],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#0f172a",
        },
      });
      // Nhãn thứ tự thăm (số) / "K" cho kho.
      map.addLayer({
        id: "points-label",
        type: "symbol",
        source: "points-source",
        layout: {
          "text-field": ["get", "label"],
          "text-size": 12,
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: { "text-color": "#0f172a" },
      });

      // Click điểm -> popup tên + toạ độ.
      map.on("click", "points-circle", (e: MapMouseEvent & { features?: MapGeoJSONFeature[] }) => {
        const feat = e.features?.[0];
        if (!feat) return;
        const idx = feat.properties?.idx as number;
        const p = pointsRef.current[idx];
        if (!p) return;
        const rank = rankMapRef.current?.[idx];
        const stop = p.isDepot ? "Điểm xuất phát" : rank != null ? `Điểm dừng #${rank}` : "Chưa xếp lộ trình";
        popupRef.current?.remove();
        popupRef.current = new maplibre.Popup({ closeButton: true, closeOnClick: false, offset: 14 })
          .setLngLat([p.lng, p.lat])
          .setHTML(
            `<div style="font-family:sans-serif;min-width:170px;">
               <div style="font-weight:700;color:#0f172a;margin-bottom:4px;">${p.name}</div>
               <div style="font-size:12px;color:#475569;">${stop}</div>
               <div style="font-size:12px;color:#475569;">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div>
             </div>`,
          )
          .addTo(map);
      });
      map.on("mouseenter", "points-circle", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "points-circle", () => (map.getCanvas().style.cursor = ""));

      // Có thể đã có điểm chờ sẵn (dashboard render trước khi map load xong).
      applyPoints(true);
    });

    return () => {
      renderPointsRef.current = null;
      drawRouteRef.current = null;
      clearRouteRef.current = null;
      drawCompareRef.current = null;
      popupRef.current?.remove();
      popupRef.current = null;
      loadedRef.current = false;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ flex: 1, position: "relative", height: "100vh" }}>
      <div ref={mapContainerRef} style={{ width: "100%", height: "100%" }} />
      <MapLoadingOverlay visible={isLoading} label={loadingLabel} />
    </div>
  );
};
