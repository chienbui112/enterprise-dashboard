import React, { useEffect, useRef } from "react";
import maplibre, { Map, NavigationControl, Popup, type GeoJSONSource, type MapGeoJSONFeature, type MapMouseEvent } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import { driverName, haversineKm } from "../../utils/geoHelpers";
import { MapLoadingOverlay } from "../MapLoadingOverlay";
import {
  ProximityDetector,
  REGION,
  REGION_CENTER,
  DURATION_SEC,
  PROXIMITY_M,
  type SpaceTimeCube,
} from "../../utils/playbackHelpers";
import type { RawCollision, MeasureInfo } from "./index";
import "maplibre-gl/dist/maplibre-gl.css";

interface MapContainerPlaybackProps {
  cube: SpaceTimeCube | null;
  isLoading: boolean;
  isPlaying: boolean;
  speed: number; // giây-giả-lập / giây-thực
  seekNonce: number; // bump khi người dùng kéo slider
  seekTime: number; // mốc giây cần tua tới
  onTimeChange: (t: number) => void; // publish vị trí timeline (throttle) -> đồng bộ slider
  onStats: (collisions: number, checks: number) => void;
  onFps: (fps: number) => void;
  onCollisions: (raw: RawCollision[]) => void; // cặp xe MỚI lại gần (transition)
  onEnded: () => void; // chạm cuối timeline -> auto-pause
  measureMode: boolean; // bật thước đo: bấm 2 xe để đo khoảng cách (dùng khi Pause)
  onMeasure: (info: MeasureInfo | null) => void; // báo kết quả đo về panel
}

// GeoJSON Feature 1 xe — tái dùng (object pool), mutate tại chỗ mỗi frame.
// `d` = cờ nguy hiểm (1 = đang trong một cặp va chạm gần) -> tô đỏ.
type VehicleFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { idx: number; d: number };
};

const newVehicleFeature = (): VehicleFeature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [0, 0] },
  properties: { idx: 0, d: 0 },
});

export const MapContainerPlayback: React.FC<MapContainerPlaybackProps> = ({
  cube,
  isLoading,
  isPlaying,
  speed,
  seekNonce,
  seekTime,
  onTimeChange,
  onStats,
  onFps,
  onCollisions,
  onEnded,
  measureMode,
  onMeasure,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const mapLoadedRef = useRef(false);

  // Ref-for-prop: RAF/listener gắn 1 lần, đọc giá trị mới nhất qua ref.
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const onTimeChangeRef = useRef(onTimeChange);
  onTimeChangeRef.current = onTimeChange;
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;
  const onFpsRef = useRef(onFps);
  onFpsRef.current = onFps;
  const onCollisionsRef = useRef(onCollisions);
  onCollisionsRef.current = onCollisions;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const seekTimeRef = useRef(seekTime);
  seekTimeRef.current = seekTime;

  // --- Engine playback (toàn ref: không trigger React render) ---
  const cubeRef = useRef<SpaceTimeCube | null>(null);
  const timeRef = useRef(0); // vị trí timeline hiện tại (giây, lẻ)
  const lastTsRef = useRef(0); // timestamp RAF trước -> tính dt
  const rafIdRef = useRef(0);
  const endedFiredRef = useRef(false);

  // Buffer tái dùng (cấp phát 1 lần khi cube tới).
  const curCoordsRef = useRef<Float32Array>(new Float32Array(0)); // [lng,lat] nội suy của frame hiện tại
  const detectorRef = useRef<ProximityDetector | null>(null);
  const featurePoolRef = useRef<VehicleFeature[]>([]);

  // Cặp đang trong vùng nguy hiểm -> phát alert chỉ khi cặp MỚI xuất hiện (giống Enter của geofence).
  const activePairsRef = useRef<Set<number>>(new Set());

  // Bộ đệm throttle (publish React ≤ vài Hz).
  const pendingRawRef = useRef<RawCollision[]>([]);
  const lastStatStampRef = useRef(0);
  const lastTimeStampRef = useRef(0);
  const lastAlertStampRef = useRef(0);
  const framesSinceRef = useRef(0);
  const lastFpsStampRef = useRef(0);

  // Click -> popup; bám theo xe khi tua.
  const popupRef = useRef<Popup | null>(null);
  const selectedIdxRef = useRef<number | null>(null);

  // --- Thước đo: chọn 2 xe (A, B) -> vẽ đường + nhãn khoảng cách (hữu ích khi Pause) ---
  const measureModeRef = useRef(measureMode);
  measureModeRef.current = measureMode;
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;
  const measureARef = useRef<number | null>(null);
  const measureBRef = useRef<number | null>(null);
  const measurePopupRef = useRef<Popup | null>(null);

  // Vẽ lại thước đo từ vị trí xe hiện tại + (khi Pause) đẩy kết quả về panel.
  const drawMeasure = () => {
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) return;
    const src = map.getSource("pb-measure") as GeoJSONSource | undefined;
    if (!src) return;
    const cur = curCoordsRef.current;
    const a = measureARef.current;
    const b = measureBRef.current;

    type MFeat = { type: "Feature"; properties: { role: string }; geometry: { type: "Point" | "LineString"; coordinates: number[] | number[][] } };
    const feats: MFeat[] = [];
    if (a != null) feats.push({ type: "Feature", properties: { role: "A" }, geometry: { type: "Point", coordinates: [cur[a * 2], cur[a * 2 + 1]] } });
    if (b != null) feats.push({ type: "Feature", properties: { role: "B" }, geometry: { type: "Point", coordinates: [cur[b * 2], cur[b * 2 + 1]] } });

    if (a != null && b != null) {
      const ax = cur[a * 2], ay = cur[a * 2 + 1], bx = cur[b * 2], by = cur[b * 2 + 1];
      feats.push({ type: "Feature", properties: { role: "line" }, geometry: { type: "LineString", coordinates: [[ax, ay], [bx, by]] } });
      const meters = haversineKm(ax, ay, bx, by) * 1000;
      const label = meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${meters.toFixed(1)} m`;
      const mid: [number, number] = [(ax + bx) / 2, (ay + by) / 2];
      if (!measurePopupRef.current) {
        measurePopupRef.current = new maplibre.Popup({ closeButton: false, closeOnClick: false, offset: 0, className: "pb-measure-popup" });
        measurePopupRef.current.addTo(map);
      }
      measurePopupRef.current.setLngLat(mid).setHTML(
        `<div style="font-family:sans-serif; font-weight:700; font-size:13px; color:#0f172a; white-space:nowrap;">📏 ${label}</div>`,
      );
      if (!isPlayingRef.current) onMeasureRef.current({ a, b, dist: meters });
    } else {
      measurePopupRef.current?.remove();
      measurePopupRef.current = null;
      if (!isPlayingRef.current) onMeasureRef.current(null);
    }

    src.setData({ type: "FeatureCollection", features: feats } as unknown as FeatureCollection);
  };
  const drawMeasureRef = useRef(drawMeasure);
  drawMeasureRef.current = drawMeasure;

  // Xoá toàn bộ trạng thái thước đo.
  const clearMeasure = () => {
    measureARef.current = null;
    measureBRef.current = null;
    measurePopupRef.current?.remove();
    measurePopupRef.current = null;
    drawMeasureRef.current();
  };

  // ----- Render một frame tại thời điểm t (giây, lẻ) -----
  // emitAlerts=false khi seek/khởi tạo (không đẩy sự kiện vào log lúc tua tay).
  const renderAt = (t: number, emitAlerts: boolean) => {
    const c = cubeRef.current;
    const map = mapRef.current;
    if (!c || !map || !mapLoadedRef.current) return;
    const detector = detectorRef.current;
    if (!detector) return;

    const { cube: data, count, stride, frames } = c;
    const cur = curCoordsRef.current;

    // Nội suy tuyến tính giữa hai mốc giây liền kề -> chuyển động mượt ở 60 FPS.
    const t0 = Math.min(Math.floor(t), frames - 1);
    const t1 = Math.min(t0 + 1, frames - 1);
    const f = t - t0;
    const o0 = t0 * stride;
    const o1 = t1 * stride;
    for (let k = 0; k < stride; k++) {
      cur[k] = data[o0 + k] + (data[o1 + k] - data[o0 + k]) * f;
    }

    // --- Phát hiện va chạm gần bằng spatial grid (chạy mỗi frame trên vị trí nội suy) ---
    const { hits, flags, checks } = detector.detect(cur, count);

    // Vẽ xe: object pool, chỉ tạo slice reference mới cho MapLibre.
    const pool = featurePoolRef.current;
    const feats: VehicleFeature[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const ft = pool[i];
      ft.geometry.coordinates[0] = cur[i * 2];
      ft.geometry.coordinates[1] = cur[i * 2 + 1];
      ft.properties.d = flags[i];
      feats[i] = ft;
    }
    (map.getSource("pb-vehicles") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: feats });

    // Vẽ vòng cảnh báo tại trung điểm mỗi cặp va chạm.
    const warnFeatures = hits.map((h) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [h.lng, h.lat] },
      properties: { dist: h.dist },
    }));
    (map.getSource("pb-warnings") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: warnFeatures });

    // --- Transition: cặp MỚI lại gần -> đẩy vào log (chỉ khi đang phát) ---
    const sec = Math.round(t);
    const prev = activePairsRef.current;
    const next = new Set<number>();
    for (let h = 0; h < hits.length; h++) {
      const hit = hits[h];
      const key = hit.i * count + hit.j;
      next.add(key);
      if (emitAlerts && !prev.has(key)) {
        pendingRawRef.current.push({ i: hit.i, j: hit.j, dist: hit.dist, sec });
      }
    }
    activePairsRef.current = next;

    // Thước đo: cập nhật đường + nhãn theo vị trí mới (nếu đang chọn 2 xe).
    if (measureARef.current != null) drawMeasureRef.current();

    // Popup xe đang chọn: cập nhật vị trí + trạng thái nguy hiểm.
    const sel = selectedIdxRef.current;
    if (sel != null && popupRef.current) {
      popupRef.current.setLngLat([cur[sel * 2], cur[sel * 2 + 1]]);
      popupRef.current.setHTML(buildPopupHTML(sel, flags[sel] === 1));
    }

    // --- Publish React (throttle để không re-render 60Hz) ---
    const now = performance.now();
    if (now - lastStatStampRef.current >= 200) {
      onStatsRef.current(hits.length, checks);
      lastStatStampRef.current = now;
    }
    if (now - lastTimeStampRef.current >= 60) {
      onTimeChangeRef.current(t);
      lastTimeStampRef.current = now;
    }
    if (pendingRawRef.current.length && now - lastAlertStampRef.current >= 200) {
      onCollisionsRef.current(pendingRawRef.current);
      pendingRawRef.current = [];
      lastAlertStampRef.current = now;
    }
  };
  const renderAtRef = useRef(renderAt);
  renderAtRef.current = renderAt;

  useEffect(() => {
    if (!mapContainerRef.current) return;

    const map = new maplibre.Map({
      container: mapContainerRef.current,
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      center: REGION_CENTER,
      zoom: 13.5,
    });
    map.addControl(new NavigationControl(), "top-right");
    mapRef.current = map;

    // --- RAF 60fps: tiến timeline khi đang phát + đo FPS ---
    const animate = (ts: number) => {
      if (!mapRef.current) return;

      // Đo FPS thật, publish ≤2Hz.
      framesSinceRef.current++;
      const fdt = ts - lastFpsStampRef.current;
      if (fdt >= 500) {
        onFpsRef.current(Math.round((framesSinceRef.current * 1000) / fdt));
        framesSinceRef.current = 0;
        lastFpsStampRef.current = ts;
      }

      if (isPlayingRef.current && cubeRef.current) {
        const dt = (ts - lastTsRef.current) / 1000; // giây thực trôi qua
        let nt = timeRef.current + dt * speedRef.current;
        if (nt >= DURATION_SEC) {
          nt = DURATION_SEC;
          timeRef.current = nt;
          renderAtRef.current(nt, true);
          if (!endedFiredRef.current) {
            endedFiredRef.current = true;
            onEndedRef.current();
            onTimeChangeRef.current(nt);
          }
        } else {
          timeRef.current = nt;
          endedFiredRef.current = false;
          renderAtRef.current(nt, true);
        }
      }
      lastTsRef.current = ts;
      rafIdRef.current = requestAnimationFrame(animate);
    };

    map.on("load", () => {
      // Vùng giả lập: viền mờ cho dễ định vị khu phố.
      map.addSource("pb-region", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [[
              [REGION[0], REGION[1]],
              [REGION[2], REGION[1]],
              [REGION[2], REGION[3]],
              [REGION[0], REGION[3]],
              [REGION[0], REGION[1]],
            ]],
          },
        },
      });
      map.addLayer({
        id: "pb-region-outline",
        type: "line",
        source: "pb-region",
        paint: { "line-color": "#475569", "line-width": 1, "line-dasharray": [3, 3] },
      });

      // --- Vòng cảnh báo va chạm: halo hổ phách + lõi đỏ (vẽ DƯỚI lớp xe) ---
      map.addSource("pb-warnings", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "pb-warning-halo",
        type: "circle",
        source: "pb-warnings",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 12, 16, 26],
          "circle-color": "#fbbf24",
          "circle-opacity": 0.28,
          "circle-blur": 0.4,
        },
      });
      map.addLayer({
        id: "pb-warning-core",
        type: "circle",
        source: "pb-warnings",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 4, 16, 8],
          "circle-color": "#ef4444",
          "circle-opacity": 0.9,
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 1,
        },
      });

      // --- Xe: circle layer (GPU). Màu data-driven theo cờ nguy hiểm `d`. ---
      map.addSource("pb-vehicles", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "pb-vehicles-layer",
        type: "circle",
        source: "pb-vehicles",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 2.2, 14, 3.4, 16, 5],
          "circle-color": ["case", ["==", ["get", "d"], 1], "#ef4444", "#38bdf8"],
          "circle-stroke-color": ["case", ["==", ["get", "d"], 1], "#fee2e2", "#0c4a6e"],
          "circle-stroke-width": ["case", ["==", ["get", "d"], 1], 1.4, 0.3],
          "circle-opacity": 0.9,
        },
      });

      // --- Thước đo: đường nối + 2 điểm đầu cuối (vẽ TRÊN lớp xe) ---
      map.addSource("pb-measure", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "pb-measure-line",
        type: "line",
        source: "pb-measure",
        paint: { "line-color": "#facc15", "line-width": 2, "line-dasharray": [2, 1.5] },
      });
      map.addLayer({
        id: "pb-measure-points",
        type: "circle",
        source: "pb-measure",
        paint: {
          "circle-radius": 6,
          // A = lime, B = cam; điểm đo nổi bật hơn xe thường.
          "circle-color": ["case", ["==", ["get", "role"], "A"], "#a3e635", "#fb923c"],
          "circle-stroke-color": "#0f172a",
          "circle-stroke-width": 2,
        },
      });

      // Click vào xe -> nếu đang bật thước đo thì chọn điểm đo, ngược lại mở popup trạng thái.
      map.on("click", "pb-vehicles-layer", (e: MapMouseEvent & { features?: MapGeoJSONFeature[] }) => {
        const feat = e.features?.[0];
        if (!feat) return;
        const idx = feat.properties?.idx as number;

        if (measureModeRef.current) {
          // Chọn A trước; chọn B sau. Nếu đã đủ cặp -> bấm tiếp bắt đầu cặp mới (A = xe vừa bấm).
          if (measureARef.current == null || measureBRef.current != null) {
            measureARef.current = idx;
            measureBRef.current = null;
          } else if (idx !== measureARef.current) {
            measureBRef.current = idx;
          }
          drawMeasureRef.current();
          return;
        }

        const d = (feat.properties?.d as number) === 1;
        popupRef.current?.remove();
        selectedIdxRef.current = idx;
        popupRef.current = new maplibre.Popup({ closeButton: true, closeOnClick: false, offset: 10, maxWidth: "240px" })
          .setLngLat(e.lngLat)
          .setHTML(buildPopupHTML(idx, d))
          .addTo(map);
        popupRef.current.on("close", () => {
          selectedIdxRef.current = null;
        });
      });
      map.on("mouseenter", "pb-vehicles-layer", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "pb-vehicles-layer", () => (map.getCanvas().style.cursor = ""));

      mapLoadedRef.current = true;

      // Zoom-out để thấy toàn khu phố giả lập.
      map.fitBounds([[REGION[0], REGION[1]], [REGION[2], REGION[3]]], { padding: 40, animate: false });

      // Nếu cube đã về trước khi map load -> render frame hiện tại ngay.
      if (cubeRef.current) renderAtRef.current(timeRef.current, false);

      lastTsRef.current = performance.now();
      lastFpsStampRef.current = performance.now();
      rafIdRef.current = requestAnimationFrame(animate);
    });

    return () => {
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
      popupRef.current?.remove();
      popupRef.current = null;
      selectedIdxRef.current = null;
      measurePopupRef.current?.remove();
      measurePopupRef.current = null;
      mapLoadedRef.current = false;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cube tới (một lần): cấp phát buffer tái dùng + render frame đầu.
  useEffect(() => {
    if (!cube) return;
    cubeRef.current = cube;
    curCoordsRef.current = new Float32Array(cube.stride);
    detectorRef.current = new ProximityDetector(cube.count, PROXIMITY_M);
    const pool = featurePoolRef.current;
    while (pool.length < cube.count) pool.push(newVehicleFeature());
    for (let i = 0; i < cube.count; i++) pool[i].properties.idx = i; // idx ổn định = vị trí xe
    if (mapLoadedRef.current) renderAtRef.current(timeRef.current, false);
  }, [cube]);

  // Tắt thước đo -> xoá đường + điểm + nhãn. Bật lại -> đóng popup thông tin đang mở cho gọn.
  useEffect(() => {
    if (!measureMode) {
      clearMeasure();
    } else {
      popupRef.current?.remove();
      popupRef.current = null;
      selectedIdxRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measureMode]);

  // Người dùng kéo slider -> tua tới mốc đó + render lại (không phát log).
  useEffect(() => {
    if (seekNonce === 0) return;
    timeRef.current = seekTimeRef.current;
    endedFiredRef.current = false;
    activePairsRef.current.clear(); // reset transition để không phát "cặp cũ" sau khi nhảy mốc
    renderAtRef.current(seekTimeRef.current, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekNonce]);

  return (
    <div style={{ flex: 1, position: "relative", height: "100vh" }}>
      <div ref={mapContainerRef} style={{ width: "100%", height: "100%" }} />
      <MapLoadingOverlay visible={isLoading} label="Đang dựng lịch sử 5.000 xe × 300 giây..." />
    </div>
  );
};

// Popup thông tin xe.
const buildPopupHTML = (idx: number, danger: boolean): string => `
  <div style="font-family:sans-serif; min-width:180px;">
    <div style="font-weight:700; font-size:14px; margin-bottom:6px; color:#0f172a;">${driverName(idx)}</div>
    <div style="display:flex; align-items:center; gap:6px; font-size:12px;">
      <span style="width:10px; height:10px; border-radius:50%; background:${danger ? "#ef4444" : "#38bdf8"};"></span>
      <strong style="color:${danger ? "#dc2626" : "#0284c7"};">${danger ? `NGUY CƠ VA CHẠM (< ${PROXIMITY_M}m)` : "An toàn"}</strong>
    </div>
  </div>`;
