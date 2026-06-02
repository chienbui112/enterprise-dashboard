import React, { useEffect, useRef } from "react";
import maplibre, { Map, NavigationControl, Popup, type GeoJSONSource, type MapGeoJSONFeature, type MapMouseEvent } from "maplibre-gl";
import type { FeatureCollection, Polygon } from "geojson";
import { driverName } from "../../utils/geoHelpers";
import { MapLoadingOverlay } from "../MapLoadingOverlay";
import type { GeofencePacket } from "./index";
import "maplibre-gl/dist/maplibre-gl.css";

interface MapContainerGeofenceProps {
  isLoading: boolean;
  fitBbox: [number, number, number, number]; // map zoom-out để thấy toàn diện tích lúc load
  geofences: FeatureCollection<Polygon> | null;
  // Dashboard gán handler vào ref này; worker.onmessage gọi nó với packet mới (không qua React state).
  renderHandlerRef: React.RefObject<((p: GeofencePacket) => void) | null>;
  onMapMove: (bbox: [number, number, number, number]) => void;
  setIsInteracting: (active: boolean) => void;
}

// GeoJSON Feature 1 xe — tái dùng (object pool), mutate tại chỗ mỗi tick.
// `v` = cờ vi phạm (1 = trong vùng cấm); `idx` để click query lấy lại định danh.
type VehicleFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { idx: number; v: number };
};

const newFeature = (): VehicleFeature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [0, 0] },
  properties: { idx: 0, v: 0 },
});

// Bbox nới 20% mỗi chiều -> prefetch điểm sát rìa, pan nhẹ không pop-in.
const paddedBbox = (map: Map): [number, number, number, number] => {
  const b = map.getBounds();
  const west = b.getWest();
  const south = b.getSouth();
  const east = b.getEast();
  const north = b.getNorth();
  const padX = (east - west) * 0.2;
  const padY = (north - south) * 0.2;
  return [west - padX, south - padY, east + padX, north + padY];
};

export const MapContainerGeofence: React.FC<MapContainerGeofenceProps> = ({
  isLoading,
  fitBbox,
  geofences,
  renderHandlerRef,
  onMapMove,
  setIsInteracting,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const mapLoadedRef = useRef(false);

  // Ref-for-prop: listener gắn 1 lần, đọc giá trị mới nhất qua ref (tránh stale closure).
  const onMapMoveRef = useRef(onMapMove);
  onMapMoveRef.current = onMapMove;
  const setIsInteractingRef = useRef(setIsInteracting);
  setIsInteractingRef.current = setIsInteracting;

  // Object pool: feature tái dùng giữa các tick -> không cấp phát 10k object mỗi 150ms.
  const featurePoolRef = useRef<VehicleFeature[]>([]);

  // Vùng cấm giữ trong ref để callback "load" (chạy bất đồng bộ) đọc được giá trị mới nhất.
  const geofencesRef = useRef<FeatureCollection<Polygon> | null>(geofences);
  geofencesRef.current = geofences;

  // Click -> popup; lưu idx + cờ vi phạm gần nhất theo idx để popup cập nhật trạng thái.
  const popupRef = useRef<Popup | null>(null);
  const selectedIdxRef = useRef<number | null>(null);

  useEffect(() => {
    if (!mapContainerRef.current) return;

    const map = new maplibre.Map({
      container: mapContainerRef.current,
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      center: [106.5, 16.0], // trung tâm VN — sẽ fitBounds lại theo bbox khi load xong
      zoom: 5,
    });
    map.addControl(new NavigationControl(), "top-right");
    mapRef.current = map;

    // Đẩy packet hiện tại (đã mutate pool) vào source xe — 1 lần/tick.
    const renderPacket = (p: GeofencePacket) => {
      const src = mapRef.current?.getSource("vehicles-source") as GeoJSONSource | undefined;
      if (!src) return;

      const pool = featurePoolRef.current;
      while (pool.length < p.count) pool.push(newFeature());

      const feats: VehicleFeature[] = new Array(p.count);
      for (let i = 0; i < p.count; i++) {
        const f = pool[i];
        f.geometry.coordinates[0] = p.coords[i * 2];
        f.geometry.coordinates[1] = p.coords[i * 2 + 1];
        f.properties.idx = p.idx[i];
        f.properties.v = p.violating[i];
        feats[i] = f;
      }
      // Slice mới (reference khác) để MapLibre nhận diện thay đổi; feature object thì tái dùng.
      src.setData({ type: "FeatureCollection", features: feats });

      // Cập nhật popup xe đang chọn nếu còn trong viewport (đổi màu/trạng thái theo tick).
      const sel = selectedIdxRef.current;
      if (sel != null && popupRef.current) {
        let found = -1;
        for (let i = 0; i < p.count; i++) {
          if (p.idx[i] === sel) {
            found = i;
            break;
          }
        }
        if (found === -1) {
          popupRef.current.remove();
          popupRef.current = null;
        } else {
          popupRef.current.setLngLat([p.coords[found * 2], p.coords[found * 2 + 1]]);
          popupRef.current.setHTML(buildPopupHTML(sel, p.violating[found] === 1));
        }
      }
    };
    renderHandlerRef.current = renderPacket;

    // Interaction lock + bbox update.
    const handleMoveStart = () => setIsInteractingRef.current(true);
    const handleMoveEnd = () => {
      setIsInteractingRef.current(false);
      onMapMoveRef.current(paddedBbox(map));
    };
    map.on("movestart", handleMoveStart);
    map.on("zoomstart", handleMoveStart);
    map.on("moveend", handleMoveEnd);
    map.on("zoomend", handleMoveEnd);

    map.on("load", () => {
      // --- Vùng cấm: fill + outline (vẽ DƯỚI lớp xe) ---
      map.addSource("geofence-source", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "geofence-fill",
        type: "fill",
        source: "geofence-source",
        paint: { "fill-color": "#ef4444", "fill-opacity": 0.12 },
      });
      map.addLayer({
        id: "geofence-outline",
        type: "line",
        source: "geofence-source",
        paint: { "line-color": "#f87171", "line-width": 1.5, "line-opacity": 0.7 },
      });

      // --- Xe: circle layer (GPU). Màu data-driven theo cờ vi phạm `v`. ---
      map.addSource("vehicles-source", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "vehicles-layer",
        type: "circle",
        source: "vehicles-source",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2.2, 14, 4, 16, 6],
          // Vi phạm -> đỏ; bình thường -> xanh dương.
          "circle-color": ["case", ["==", ["get", "v"], 1], "#ef4444", "#38bdf8"],
          "circle-stroke-color": ["case", ["==", ["get", "v"], 1], "#fee2e2", "#0c4a6e"],
          "circle-stroke-width": ["case", ["==", ["get", "v"], 1], 1.4, 0.4],
          "circle-opacity": 0.9,
        },
      });

      // Nếu geofence đã về trước khi map load xong -> vẽ ngay.
      if (geofencesRef.current) {
        (map.getSource("geofence-source") as GeoJSONSource).setData(geofencesRef.current);
      }

      // Click vào xe -> popup trạng thái.
      map.on("click", "vehicles-layer", (e: MapMouseEvent & { features?: MapGeoJSONFeature[] }) => {
        const feat = e.features?.[0];
        if (!feat) return;
        const idx = feat.properties?.idx as number;
        const v = (feat.properties?.v as number) === 1;

        popupRef.current?.remove();
        selectedIdxRef.current = idx;
        popupRef.current = new maplibre.Popup({ closeButton: true, closeOnClick: false, offset: 10, maxWidth: "240px" })
          .setLngLat(e.lngLat)
          .setHTML(buildPopupHTML(idx, v))
          .addTo(map);
        popupRef.current.on("close", () => {
          selectedIdxRef.current = null;
        });
      });
      map.on("mouseenter", "vehicles-layer", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "vehicles-layer", () => (map.getCanvas().style.cursor = ""));

      mapLoadedRef.current = true;
      // Zoom-out để thấy toàn bộ diện tích (cả nước). moveend sau đó tự gửi bbox thật cho worker.
      map.fitBounds(
        [
          [fitBbox[0], fitBbox[1]],
          [fitBbox[2], fitBbox[3]],
        ],
        { padding: 30, animate: false },
      );
      onMapMoveRef.current(paddedBbox(map)); // gửi bbox thật đầu tiên
    });

    return () => {
      renderHandlerRef.current = null;
      popupRef.current?.remove();
      popupRef.current = null;
      selectedIdxRef.current = null;
      mapLoadedRef.current = false;
      if (mapRef.current) {
        mapRef.current.off("movestart", handleMoveStart);
        mapRef.current.off("zoomstart", handleMoveStart);
        mapRef.current.off("moveend", handleMoveEnd);
        mapRef.current.off("zoomend", handleMoveEnd);
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Vùng cấm tới (một lần) -> vẽ khi map đã load xong.
  useEffect(() => {
    if (!geofences || !mapLoadedRef.current) return;
    const src = mapRef.current?.getSource("geofence-source") as GeoJSONSource | undefined;
    src?.setData(geofences);
  }, [geofences]);

  return (
    <div style={{ flex: 1, position: "relative", height: "100vh" }}>
      <div ref={mapContainerRef} style={{ width: "100%", height: "100%" }} />
      <MapLoadingOverlay visible={isLoading} label="Đang sinh 10k xe + 50 vùng cấm..." />
    </div>
  );
};

// Popup thông tin xe.
const buildPopupHTML = (idx: number, violating: boolean): string => `
  <div style="font-family:sans-serif; min-width:180px;">
    <div style="font-weight:700; font-size:14px; margin-bottom:6px; color:#0f172a;">${driverName(idx)}</div>
    <div style="display:flex; align-items:center; gap:6px; font-size:12px;">
      <span style="width:10px; height:10px; border-radius:50%; background:${violating ? "#ef4444" : "#38bdf8"};"></span>
      <strong style="color:${violating ? "#dc2626" : "#0284c7"};">${violating ? "VI PHẠM — trong vùng cấm" : "An toàn — ngoài vùng cấm"}</strong>
    </div>
  </div>`;
