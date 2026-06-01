import React, { useEffect, useRef } from "react";
import maplibre, { Map, Popup, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Feature, Point } from "geojson";
import { MapLoadingOverlay } from "../MapLoadingOverlay";
import { lerpCoordinate, computeBearing } from "../../utils/interpolationHelper";

export interface BigDataPacket {
  features: Feature<Point>[];
  viewportCount: number;
  stage: string;
}

interface MapContainerBigDataProps {
  packetHandlerRef: React.RefObject<((p: BigDataPacket) => void) | null>;
  isLoading: boolean;
  loadingLabel: string;
  onMapMove: (bbox: [number, number, number, number], zoom: number) => void;
  setIsInteracting: (active: boolean) => void;
}

const ZOOM_BREAKPOINT = 10;
const TICK_MS = 3000;
const CAP_ENTER = 8000;
const CAP_EXIT = 7000;

// Pooled feature cho raw mode — mutate coordinates + bearing tại chỗ mỗi frame.
type RawPointFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { idx: number; intensity: number; bearing: number };
};

interface Entry {
  lastLng: number;
  lastLat: number;
  nextLng: number;
  nextLat: number;
  bearing: number;
  seen: number;
  feature: RawPointFeature;
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
    properties: { idx: 0, intensity: 0, bearing: 0 },
  },
});

// Icon mũi tên SDF tự vẽ (tái dùng từ MotionStream pattern) — không phụ thuộc sprite basemap.
const createCarImage = (): ImageData => {
  const size = 24;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.moveTo(size / 2, 2);
  ctx.lineTo(size - 4, size - 3);
  ctx.lineTo(size / 2, size * 0.68);
  ctx.lineTo(4, size - 3);
  ctx.closePath();
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
};

export const MapContainerBigData: React.FC<MapContainerBigDataProps> = ({
  packetHandlerRef,
  isLoading,
  loadingLabel,
  onMapMove,
  setIsInteracting,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const popupRef = useRef<Popup | null>(null);

  const onMapMoveRef = useRef(onMapMove);
  onMapMoveRef.current = onMapMove;
  const setIsInteractingRef = useRef(setIsInteracting);
  setIsInteractingRef.current = setIsInteracting;

  // --- Engine nội suy raw mode (toàn ref, không trigger render) ---
  const entriesRef = useRef<globalThis.Map<number, Entry>>(new globalThis.Map());
  const activeFeaturesRef = useRef<RawPointFeature[]>([]);
  const freeListRef = useRef<Entry[]>([]);
  const tickStampRef = useRef<number>(0);
  const segmentStartRef = useRef<number>(0);
  // idx của driver đang được popup theo dõi. Khi != null + popup tồn tại,
  // RAF mỗi frame sẽ setLngLat theo vị trí lerp hiện tại của entry tương ứng.
  const selectedIdxRef = useRef<number | null>(null);
  const rafIdRef = useRef<number>(0);
  // "raw" = lerp + RAF flush mỗi frame. "cluster" = setData(fc) một lần.
  // "snap" = raw nhưng >CAP_ENTER, fallback flush mỗi tick không lerp.
  const modeRef = useRef<"cluster" | "raw" | "snap" | "empty">("empty");

  // Push current pool → source. Chỉ gọi khi raw/snap mode.
  const flushPool = () => {
    const src = mapRef.current?.getSource("mega-source") as GeoJSONSource | undefined;
    if (!src) return;
    src.setData({ type: "FeatureCollection", features: activeFeaturesRef.current });
  };

  useEffect(() => {
    if (!mapContainerRef.current) return;

    const map = new maplibre.Map({
      container: mapContainerRef.current,
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      center: [107.5, 16.0],
      zoom: 5,
    });
    mapRef.current = map;

    const paddedBbox = (): [number, number, number, number] => {
      const b = map.getBounds();
      const w = b.getWest();
      const s = b.getSouth();
      const e = b.getEast();
      const n = b.getNorth();
      const padX = (e - w) * 0.2;
      const padY = (n - s) * 0.2;
      return [w - padX, s - padY, e + padX, n + padY];
    };

    const handleMoveStart = () => setIsInteractingRef.current(true);
    const handleMoveEnd = () => {
      setIsInteractingRef.current(false);
      onMapMoveRef.current(paddedBbox(), map.getZoom());
    };
    map.on("movestart", handleMoveStart);
    map.on("zoomstart", handleMoveStart);
    map.on("moveend", handleMoveEnd);
    map.on("zoomend", handleMoveEnd);

    // --- Reconcile mỗi packet từ worker (mỗi 3s tick HOẶC mỗi pan/zoom) ---
    const reconcile = (packet: BigDataPacket) => {
      const features = packet.features;
      // Detect mode bằng feature đầu: có `cluster: true` → cluster mode; else raw.
      const isRaw =
        features.length > 0 && !(features[0].properties as Record<string, unknown>)?.cluster;
      const isEmpty = features.length === 0;

      if (isEmpty) {
        modeRef.current = "empty";
        const src = mapRef.current?.getSource("mega-source") as GeoJSONSource | undefined;
        src?.setData({ type: "FeatureCollection", features: [] });
        entriesRef.current.clear();
        activeFeaturesRef.current.length = 0;
        // Driver được popup theo dõi đã biến mất → đóng popup.
        popupRef.current?.remove();
        return;
      }

      if (!isRaw) {
        // CLUSTER MODE: setData trực tiếp, không qua pool.
        if (modeRef.current === "raw" || modeRef.current === "snap") {
          entriesRef.current.clear();
          activeFeaturesRef.current.length = 0;
        }
        modeRef.current = "cluster";
        const src = mapRef.current?.getSource("mega-source") as GeoJSONSource | undefined;
        src?.setData({ type: "FeatureCollection", features });
        // Cluster mode không có raw popup → đóng nếu có.
        popupRef.current?.remove();
        return;
      }

      // RAW MODE: pool reconcile.
      // Mode + hysteresis dựa trên feature count.
      if (packet.viewportCount > CAP_ENTER) modeRef.current = "snap";
      else if (packet.viewportCount < CAP_EXIT) modeRef.current = "raw";
      // Mode chuyển từ cluster → raw: clear pool (sẽ rebuild từ packet).
      const wasCluster = false;
      void wasCluster;

      const smooth = modeRef.current === "raw";

      // Tỉ lệ tại thời điểm tick — re-anchor xe đang lerp dở từ VỊ TRÍ HIỆN TẠI.
      const liveRatio = Math.min(
        (performance.now() - segmentStartRef.current) / TICK_MS,
        1,
      );

      const entries = entriesRef.current;
      const stamp = ++tickStampRef.current;
      const activeFeats = activeFeaturesRef.current;
      activeFeats.length = 0;

      for (const feat of features) {
        const props = feat.properties as { idx: number; intensity: number };
        const id = props.idx;
        const nLng = (feat.geometry as Point).coordinates[0];
        const nLat = (feat.geometry as Point).coordinates[1];
        let e = entries.get(id);

        if (e) {
          // Re-anchor last theo vị trí lerp hiện tại (không phải target cũ — tránh giật lùi).
          if (smooth) {
            const cur = lerpCoordinate(
              [e.lastLng, e.lastLat],
              [e.nextLng, e.nextLat],
              liveRatio,
            );
            e.lastLng = cur[0];
            e.lastLat = cur[1];
          } else {
            e.lastLng = e.nextLng;
            e.lastLat = e.nextLat;
          }
          e.nextLng = nLng;
          e.nextLat = nLat;
          e.bearing = computeBearing([e.lastLng, e.lastLat], [e.nextLng, e.nextLat]);
        } else {
          // Mới vào viewport: SNAP last=next, đứng yên 1 tick → tránh lerp loạn từ origin cũ.
          e = freeListRef.current.pop() ?? newEntry();
          e.lastLng = nLng;
          e.lastLat = nLat;
          e.nextLng = nLng;
          e.nextLat = nLat;
          e.bearing = 0; // hướng Bắc — sau 1 tick sẽ tính từ vector last→next.
          entries.set(id, e);
        }
        e.feature.properties.idx = id;
        e.feature.properties.intensity = props.intensity;
        e.seen = stamp;
        activeFeats.push(e.feature);
      }

      // Sweep: entry không có trong packet → recycle.
      for (const [id, e] of entries) {
        if (e.seen !== stamp) {
          freeListRef.current.push(e);
          entries.delete(id);
        }
      }

      // Driver được popup theo dõi đã rời viewport/matched → đóng popup.
      // popup.on("close") sẽ clear selectedIdxRef.
      const sel = selectedIdxRef.current;
      if (sel != null && !entries.has(sel)) {
        popupRef.current?.remove();
      }

      segmentStartRef.current = performance.now();

      // Snap mode: ghi thẳng next vào feature + flush 1 lần (KHÔNG có RAF lerp).
      if (!smooth) {
        for (const feat of activeFeats) {
          const e = entries.get(feat.properties.idx);
          if (e) {
            feat.geometry.coordinates[0] = e.nextLng;
            feat.geometry.coordinates[1] = e.nextLat;
            feat.properties.bearing = e.bearing;
          }
        }
        flushPool();
      }
    };
    packetHandlerRef.current = reconcile;

    // --- RAF 60fps: chạy luôn, chỉ active khi raw mode ---
    const animate = () => {
      if (!mapRef.current) return;
      if (modeRef.current === "raw") {
        const ratio = Math.min(
          (performance.now() - segmentStartRef.current) / TICK_MS,
          1,
        );
        const feats = activeFeaturesRef.current;
        const entries = entriesRef.current;
        for (let i = 0; i < feats.length; i++) {
          const feat = feats[i];
          const e = entries.get(feat.properties.idx);
          if (!e) continue;
          feat.geometry.coordinates[0] = e.lastLng + (e.nextLng - e.lastLng) * ratio;
          feat.geometry.coordinates[1] = e.lastLat + (e.nextLat - e.lastLat) * ratio;
          feat.properties.bearing = e.bearing;
        }
        flushPool();

        // Popup bám driver: setLngLat theo vị trí lerp hiện tại mỗi frame.
        // Chỉ 1 popup, cost gần như 0. Hỗ trợ cả snap & cluster mode (đã đóng popup ở reconcile).
        const sel = selectedIdxRef.current;
        if (sel != null && popupRef.current) {
          const e = entries.get(sel);
          if (e) popupRef.current.setLngLat(e.feature.geometry.coordinates);
        }
      }
      rafIdRef.current = requestAnimationFrame(animate);
    };

    map.on("load", () => {
      map.addImage("car-arrow", createCarImage(), { sdf: true });

      // Single source. Cluster mode: features = clusters từ worker. Raw mode: features = pool.
      map.addSource("mega-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        buffer: 32,
        maxzoom: 16,
      });

      // 🌋 HEATMAP — zoom < 10
      map.addLayer({
        id: "layer-heatmap",
        type: "heatmap",
        source: "mega-source",
        maxzoom: ZOOM_BREAKPOINT,
        paint: {
          "heatmap-weight": [
            "interpolate",
            ["linear"],
            [
              "case",
              ["has", "point_count"],
              ["/", ["ln", ["+", 1, ["get", "intensity_sum"]]], 10],
              ["/", ["get", "intensity"], 10],
            ],
            0,
            0,
            1.5,
            1,
          ],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 5, 5, 18, 9, 40],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 1, 9, 3],
          "heatmap-color": [
            "interpolate",
            ["linear"],
            ["heatmap-density"],
            0,
            "rgba(33,102,172,0)",
            0.2,
            "rgb(103,169,207)",
            0.4,
            "rgb(209,229,240)",
            0.6,
            "rgb(253,219,199)",
            0.8,
            "rgb(239,138,98)",
            1,
            "rgb(178,24,43)",
          ],
          "heatmap-opacity": 0.85,
        },
      });

      // 🤖 CLUSTER CIRCLES
      map.addLayer({
        id: "layer-cluster-circles",
        type: "circle",
        source: "mega-source",
        minzoom: ZOOM_BREAKPOINT,
        filter: ["has", "point_count"],
        paint: {
          "circle-color": [
            "step",
            ["get", "point_count"],
            "#51bbd6",
            100,
            "#f1f075",
            750,
            "#f28cb1",
          ],
          "circle-radius": ["step", ["get", "point_count"], 20, 100, 30, 750, 40],
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#fff",
        },
      });

      map.addLayer({
        id: "layer-cluster-counts",
        type: "symbol",
        source: "mega-source",
        minzoom: ZOOM_BREAKPOINT,
        filter: ["has", "point_count"],
        layout: {
          "text-field": "{point_count_abbreviated}",
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-size": 12,
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: { "text-color": "#0f172a" },
      });

      // 📍 RAW POINTS — symbol layer với icon car-arrow + bearing.
      // allow-overlap + ignore-placement: tắt collision detection → 60fps setData khả thi.
      map.addLayer({
        id: "layer-unclustered-points",
        type: "symbol",
        source: "mega-source",
        minzoom: ZOOM_BREAKPOINT,
        filter: ["!", ["has", "point_count"]],
        layout: {
          "icon-image": "car-arrow",
          "icon-size": 0.9,
          "icon-rotate": ["get", "bearing"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: {
          "icon-color": "#11b4da",
        },
      });

      // Click cluster → easeTo expansion_zoom
      map.on("click", "layer-cluster-circles", (e) => {
        const features = map.queryRenderedFeatures(e.point, {
          layers: ["layer-cluster-circles"],
        });
        if (features.length === 0) return;
        const feat = features[0];
        const expansionZoom = feat.properties?.expansion_zoom as number | undefined;
        if (expansionZoom == null || feat.geometry.type !== "Point") return;
        map.easeTo({
          center: feat.geometry.coordinates as [number, number],
          zoom: expansionZoom,
          duration: 600,
        });
      });

      // Click raw point (zoom ≥ 14) → popup. Bám driver qua selectedIdxRef + RAF.
      map.on("click", "layer-unclustered-points", (e) => {
        const features = map.queryRenderedFeatures(e.point, {
          layers: ["layer-unclustered-points"],
        });
        if (features.length === 0) return;
        const feat = features[0];
        if (feat.geometry.type !== "Point") return;
        const [lng, lat] = feat.geometry.coordinates as [number, number];
        const idx = (feat.properties?.idx ?? -1) as number;
        const intensity = feat.properties?.intensity ?? "?";
        const bearing = feat.properties?.bearing ?? 0;

        popupRef.current?.remove();
        selectedIdxRef.current = idx;
        popupRef.current = new maplibre.Popup({ closeOnClick: false, offset: 10 })
          .setLngLat([lng, lat])
          .setHTML(
            `<div style="font-family:sans-serif;font-size:0.85rem;color:#0f172a;min-width:160px">
               <strong>Node #${idx}</strong><br/>
               Intensity: <strong>${intensity}</strong><br/>
               Bearing: ${Math.round(bearing)}°<br/>
               Lng: ${lng.toFixed(5)}<br/>
               Lat: ${lat.toFixed(5)}
             </div>`,
          )
          .addTo(map);
        // Clear selectedIdxRef khi popup đóng (user bấm X hoặc reconcile gọi remove()).
        popupRef.current.on("close", () => {
          selectedIdxRef.current = null;
          popupRef.current = null;
        });
      });

      const setPointer = () => (map.getCanvas().style.cursor = "pointer");
      const resetCursor = () => (map.getCanvas().style.cursor = "");
      map.on("mouseenter", "layer-cluster-circles", setPointer);
      map.on("mouseleave", "layer-cluster-circles", resetCursor);
      map.on("mouseenter", "layer-unclustered-points", setPointer);
      map.on("mouseleave", "layer-unclustered-points", resetCursor);

      // Push initial bbox+zoom về parent → worker biết view để query supercluster lần đầu.
      onMapMoveRef.current(paddedBbox(), map.getZoom());

      // Kick off RAF loop (chạy luôn, idle khi không phải raw mode).
      rafIdRef.current = requestAnimationFrame(animate);
    });

    return () => {
      cancelAnimationFrame(rafIdRef.current);
      popupRef.current?.remove();
      popupRef.current = null;
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

  return (
    <div style={{ flex: 1, position: "relative", height: "100vh" }}>
      <div ref={mapContainerRef} style={{ width: "100%", height: "100%" }} />
      <MapLoadingOverlay visible={isLoading} label={loadingLabel} />
    </div>
  );
};
