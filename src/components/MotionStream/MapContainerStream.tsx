import React, { useEffect, useRef } from "react";
import maplibre, { Map, NavigationControl, Popup, type GeoJSONSource, type MapGeoJSONFeature, type MapMouseEvent } from "maplibre-gl";
import { lerpCoordinate, computeBearing } from "../../utils/interpolationHelper";
import { driverName, haversineKm } from "../../utils/geoHelpers";
import { MapLoadingOverlay } from "../MapLoadingOverlay";
import type { StreamPacket, InterpolationMode } from "./index";
import "maplibre-gl/dist/maplibre-gl.css";

interface MapContainerStreamProps {
  isInterpolating: boolean;
  isLoading: boolean;
  // Dashboard gán handler vào ref này; worker.onmessage gọi nó với packet mới (không qua React state).
  packetHandlerRef: React.RefObject<((p: StreamPacket) => void) | null>;
  onMapMove: (bbox: [number, number, number, number]) => void;
  setIsInteracting: (active: boolean) => void;
  setFps: (fps: number) => void;
  setVisibleCount: (n: number) => void;
  setInterpolationMode: (m: InterpolationMode) => void;
}

// Cadence "nhỏ giọt" — PHẢI KHỚP ĐÚNG STREAM_INTERVAL của motionStream.worker.ts.
const STREAM_INTERVAL = 3000;
// Trần xe nội suy đồng thời (setData symbol-layer xoay mỗi frame). Vượt -> fallback "snap".
// Hysteresis: vào snap khi > CAP_ENTER, về smooth khi < CAP_EXIT (tránh nhấp nháy ở biên).
const CAP_ENTER = 8000;
const CAP_EXIT = 7000;

// GeoJSON Feature 1 xe — tái dùng (object pool), mutate tại chỗ mỗi frame.
// `idx` đưa vào properties để click queryRenderedFeatures lấy lại được định danh tài xế.
type CarFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { idx: number; bearing: number };
};

// Trạng thái nội suy 1 xe. Pooled: không cấp phát lại khi xe còn hiển thị.
interface Entry {
  lastLng: number;
  lastLat: number;
  nextLng: number;
  nextLat: number;
  bearing: number; // tính 1 lần/tick từ last→next (const theo segment) -> không recompute mỗi frame
  seen: number; // tick stamp để mark-and-sweep eviction
  feature: CarFeature;
}

const newEntry = (): Entry => ({
  lastLng: 0,
  lastLat: 0,
  nextLng: 0,
  nextLat: 0,
  bearing: 0,
  seen: 0,
  feature: {
    type: "Feature",
    geometry: { type: "Point", coordinates: [0, 0] },
    properties: { idx: 0, bearing: 0 },
  },
});

// La bàn 8 hướng từ bearing (độ).
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compassOf = (deg: number) => COMPASS[Math.round(deg / 45) % 8];

// Popup thông tin tài xế. Tốc độ suy ra từ quãng last→next đi trong 1 tick (3s) -> km/h.
const buildPopupHTML = (idx: number, e: Entry): string => {
  const km3s = haversineKm(e.lastLng, e.lastLat, e.nextLng, e.nextLat);
  const kmh = km3s * (3600 / (STREAM_INTERVAL / 1000)); // km/3s -> km/h
  const [lng, lat] = e.feature.geometry.coordinates;
  return `
    <div style="font-family:sans-serif; min-width:200px;">
      <div style="font-weight:700; font-size:14px; margin-bottom:6px; color:#0f172a;">${driverName(idx)}</div>
      <table style="font-size:12px; color:#334155; width:100%; border-collapse:collapse;">
        <tr><td style="color:#64748b; padding:2px 0;">Hướng</td><td style="text-align:right; font-weight:600;">${Math.round(e.bearing)}° (${compassOf(e.bearing)})</td></tr>
        <tr><td style="color:#64748b; padding:2px 0;">Tốc độ</td><td style="text-align:right; font-weight:700; color:#059669;">~${kmh.toFixed(0)} km/h</td></tr>
        <tr><td style="color:#64748b; padding:2px 0;">Vị trí</td><td style="text-align:right;">${lat.toFixed(5)}, ${lng.toFixed(5)}</td></tr>
      </table>
    </div>`;
};

// Icon mũi tên (SDF) vẽ bằng canvas — KHÔNG phụ thuộc sprite của basemap (rocket_15 có thể không tồn tại
// trong dark-matter -> MapLibre không vẽ gì). SDF cho phép tô màu qua icon-color, xoay qua icon-rotate.
const createCarImage = (): ImageData => {
  const size = 24;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.moveTo(size / 2, 2); // đỉnh (hướng Bắc khi bearing = 0)
  ctx.lineTo(size - 4, size - 3);
  ctx.lineTo(size / 2, size * 0.68);
  ctx.lineTo(4, size - 3);
  ctx.closePath();
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
};

// Bbox nới 20% mỗi chiều -> prefetch điểm sát rìa, pan nhẹ không pop-in (mượn từ Spatial).
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

export const MapContainerStream: React.FC<MapContainerStreamProps> = ({
  isInterpolating,
  isLoading,
  packetHandlerRef,
  onMapMove,
  setIsInteracting,
  setFps,
  setVisibleCount,
  setInterpolationMode,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);

  // Ref-for-prop: listener/RAF gắn 1 lần, đọc giá trị mới nhất qua ref (tránh stale closure).
  const isInterpolatingRef = useRef(isInterpolating);
  isInterpolatingRef.current = isInterpolating;
  const onMapMoveRef = useRef(onMapMove);
  onMapMoveRef.current = onMapMove;
  const setIsInteractingRef = useRef(setIsInteracting);
  setIsInteractingRef.current = setIsInteracting;

  // --- Engine nội suy (toàn ref: không trigger render) ---
  const entriesMapRef = useRef<globalThis.Map<number, Entry>>(new globalThis.Map<number, Entry>());
  const activeRef = useRef<Entry[]>([]); // mảng phẳng iterate mỗi frame (rebuild mỗi tick)
  const activeFeaturesRef = useRef<CarFeature[]>([]); // feature tương ứng activeRef -> setData
  const freeListRef = useRef<Entry[]>([]); // recycle Entry để pan-churn không hit GC
  const tickStampRef = useRef<number>(0);
  const segmentStartRef = useRef<number>(0);
  const rafIdRef = useRef<number>(0);
  const modeRef = useRef<InterpolationMode>("smooth");

  // Click -> popup thông tin tài xế, bám theo xe khi nội suy.
  const popupRef = useRef<Popup | null>(null);
  const selectedIdxRef = useRef<number | null>(null);

  // FPS đo thật trong RAF, publish ≤2Hz để panel không re-render mỗi frame.
  const framesSinceRef = useRef<number>(0);
  const lastFpsStampRef = useRef<number>(0);

  // Đẩy frame hiện tại (đã mutate poolFeature) vào source — 1 lần/frame.
  const flush = () => {
    const src = mapRef.current?.getSource("cars-source") as GeoJSONSource | undefined;
    if (src) src.setData({ type: "FeatureCollection", features: activeFeaturesRef.current });
  };

  useEffect(() => {
    if (!mapContainerRef.current) return;

    const map = new maplibre.Map({
      container: mapContainerRef.current,
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      center: [105.8342, 21.0278],
      zoom: 14, // street level -> visible count bị giới hạn, nội suy mượt
    });
    map.addControl(new NavigationControl(), "top-right");
    mapRef.current = map;

    // --- Reconcile mỗi tick "nhỏ giọt" (0.33Hz): cập nhật last/next theo idx ---
    const reconcileTick = (packet: StreamPacket) => {
      const m = mapRef.current;
      if (!m) return;
      const { count, coords, bearing, idx } = packet;

      // Mode (cap + hysteresis) quyết định theo số xe trong viewport.
      if (count > CAP_ENTER) modeRef.current = "snap";
      else if (count < CAP_EXIT) modeRef.current = "smooth";
      const smooth = modeRef.current === "smooth" && isInterpolatingRef.current;

      // Tỉ lệ tại thời điểm tick đến — để re-anchor xe đang lerp dở từ VỊ TRÍ ĐANG VẼ.
      const liveRatio = Math.min((performance.now() - segmentStartRef.current) / STREAM_INTERVAL, 1);

      const map_ = entriesMapRef.current;
      const stamp = ++tickStampRef.current;
      const active = activeRef.current;
      const feats = activeFeaturesRef.current;
      active.length = 0;
      feats.length = 0;

      for (let w = 0; w < count; w++) {
        const id = idx[w];
        const nLng = coords[w * 2];
        const nLat = coords[w * 2 + 1];
        let e = map_.get(id);

        if (e) {
          // Xe đã hiển thị tick trước: re-anchor last = vị trí lerp hiện tại (KHÔNG phải target cũ,
          // nếu không xe giật lùi về điểm chưa tới). Chi phí 1 lerp/xe/tick.
          if (smooth) {
            const cur = lerpCoordinate([e.lastLng, e.lastLat], [e.nextLng, e.nextLat], liveRatio);
            e.lastLng = cur[0];
            e.lastLat = cur[1];
          } else {
            // Snap mode: bỏ qua lerp dở, đặt thẳng last = next (target cũ vừa đạt).
            e.lastLng = e.nextLng;
            e.lastLat = e.nextLat;
          }
          e.nextLng = nLng;
          e.nextLat = nLat;
          e.bearing = computeBearing([e.lastLng, e.lastLat], [e.nextLng, e.nextLat]);
        } else {
          // Xe mới vào viewport: SNAP (last=next, đứng yên 1 tick) -> tránh lerp loạn từ origin cũ.
          e = freeListRef.current.pop() ?? newEntry();
          e.lastLng = nLng;
          e.lastLat = nLat;
          e.nextLng = nLng;
          e.nextLat = nLat;
          e.bearing = bearing[w]; // hướng tức thời của worker cho frame snap
          map_.set(id, e);
        }
        e.feature.properties.idx = id; // để click query lấy lại idx
        e.seen = stamp;
        active.push(e);
        feats.push(e.feature);
      }

      // Sweep: xe rời viewport -> recycle Entry vào freeList.
      for (const [id, e] of map_) {
        if (e.seen !== stamp) {
          freeListRef.current.push(e);
          map_.delete(id);
        }
      }

      segmentStartRef.current = performance.now();
      setVisibleCount(count);
      setInterpolationMode(modeRef.current);

      // Snap / tắt nội suy: ghi thẳng next vào feature + flush 1 lần (xe nhảy mỗi 3s).
      if (!smooth) {
        for (const e of active) {
          e.feature.geometry.coordinates[0] = e.nextLng;
          e.feature.geometry.coordinates[1] = e.nextLat;
          e.feature.properties.bearing = e.bearing;
        }
        flush();
      }

      // Popup tài xế đang chọn: rời viewport -> đóng; còn -> cập nhật nội dung (hướng/tốc độ segment mới).
      const sel = selectedIdxRef.current;
      if (sel != null && popupRef.current) {
        const e = map_.get(sel);
        if (!e) {
          popupRef.current.remove(); // -> trigger "close": reset selectedIdxRef
          popupRef.current = null;
        } else {
          popupRef.current.setHTML(buildPopupHTML(sel, e));
          if (!smooth) popupRef.current.setLngLat(e.feature.geometry.coordinates); // smooth do RAF bám vị trí
        }
      }
    };
    packetHandlerRef.current = reconcileTick;

    // --- RAF 60fps: luôn chạy mọi mode (giữ FPS meter sống + flip mode tức thì) ---
    const animateLoop = (ts: number) => {
      if (!mapRef.current) return;

      // Đo FPS thật, publish ≤2Hz.
      framesSinceRef.current++;
      const dt = ts - lastFpsStampRef.current;
      if (dt >= 500) {
        setFps(Math.round((framesSinceRef.current * 1000) / dt));
        framesSinceRef.current = 0;
        lastFpsStampRef.current = ts;
      }

      const smooth = modeRef.current === "smooth" && isInterpolatingRef.current;
      if (smooth) {
        const ratio = Math.min((ts - segmentStartRef.current) / STREAM_INTERVAL, 1);
        const active = activeRef.current;
        for (let i = 0; i < active.length; i++) {
          const e = active[i];
          const c = e.feature.geometry.coordinates;
          c[0] = e.lastLng + (e.nextLng - e.lastLng) * ratio;
          c[1] = e.lastLat + (e.nextLat - e.lastLat) * ratio;
          e.feature.properties.bearing = e.bearing; // cached -> không recompute trig/frame
        }
        flush();

        // Popup bám theo xe đang chọn: setLngLat theo vị trí nội suy mỗi frame (chỉ 1 popup, rẻ).
        const sel = selectedIdxRef.current;
        if (sel != null && popupRef.current) {
          const e = entriesMapRef.current.get(sel);
          if (e) popupRef.current.setLngLat(e.feature.geometry.coordinates);
        }
      }
      // snap/off: reconcileTick đã flush; ở đây chỉ đếm FPS rồi re-request.

      rafIdRef.current = requestAnimationFrame(animateLoop);
    };

    // Interaction lock + bbox update (mượn từ MapContainer 2D / Spatial).
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
      // Icon mũi tên SDF tự vẽ (không phụ thuộc sprite basemap).
      map.addImage("car-arrow", createCarImage(), { sdf: true });

      map.addSource("cars-source", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

      // Layer symbol: icon xoay theo bearing. allow-overlap + ignore-placement = TỚI HẠN:
      // tắt collision detection -> điều kiện để vẽ hàng nghìn symbol xoay mỗi frame mà không giật.
      map.addLayer({
        id: "cars-layer",
        type: "symbol",
        source: "cars-source",
        layout: {
          "icon-image": "car-arrow",
          "icon-size": 1.0,
          "icon-rotate": ["get", "bearing"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: {
          "icon-color": "#34d399", // emerald — khớp accent MotionStream
        },
      });

      // Click vào tài xế -> mở popup thông tin (bám theo xe khi nội suy).
      map.on("click", "cars-layer", (e: MapMouseEvent & { features?: MapGeoJSONFeature[] }) => {
        const feat = e.features?.[0];
        if (!feat) return;
        const idx = feat.properties?.idx as number;
        const entry = entriesMapRef.current.get(idx);
        if (!entry) return;

        // Đóng popup cũ TRƯỚC khi mở mới (tránh close-handler của popup cũ xoá selection mới).
        popupRef.current?.remove();
        selectedIdxRef.current = idx;
        popupRef.current = new maplibre.Popup({ closeButton: true, closeOnClick: false, offset: 12, maxWidth: "260px" })
          .setLngLat(entry.feature.geometry.coordinates)
          .setHTML(buildPopupHTML(idx, entry))
          .addTo(map);
        // closeOnClick:false -> đóng bằng nút X; khi đóng thì bỏ chọn.
        popupRef.current.on("close", () => {
          selectedIdxRef.current = null;
        });
      });

      // Con trỏ pointer khi rê qua xe.
      map.on("mouseenter", "cars-layer", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "cars-layer", () => (map.getCanvas().style.cursor = ""));

      segmentStartRef.current = performance.now();
      lastFpsStampRef.current = performance.now();
      rafIdRef.current = requestAnimationFrame(animateLoop);

      // Gửi bbox thật đầu tiên -> worker sync viewport.
      onMapMoveRef.current(paddedBbox(map));
    });

    return () => {
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
      packetHandlerRef.current = null;
      popupRef.current?.remove();
      popupRef.current = null;
      selectedIdxRef.current = null;
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

  // off->on: reset đồng hồ segment để lerp bắt đầu window mới (không clamp ngay ratio=1).
  useEffect(() => {
    if (isInterpolating) segmentStartRef.current = performance.now();
  }, [isInterpolating]);

  return (
    <div style={{ flex: 1, position: "relative", height: "100vh" }}>
      <div ref={mapContainerRef} style={{ width: "100%", height: "100%" }} />
      <MapLoadingOverlay visible={isLoading} label="Generating fleet (100k drivers)..." />
    </div>
  );
};
