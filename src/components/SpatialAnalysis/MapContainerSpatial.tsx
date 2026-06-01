import React, { useEffect, useRef } from "react";
import maplibre, {
  Map,
  NavigationControl,
  Popup,
  type FilterSpecification,
  type GeoJSONSource,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { driverName, type DriverFeature, type DriverStatus } from "../../utils/geoHelpers";
import { type BufferGeometry, type DriverIndex, type MatchedDriver } from "../../utils/spatialHelpers";
import { MapLoadingOverlay } from "../MapLoadingOverlay";
import { type AnalysisMode } from "./index";

interface MapContainerSpatialProps {
  visibleFeatures: DriverFeature[];
  driverIndex: DriverIndex | null;
  matchedIdxs: number[];
  matched: MatchedDriver[];
  bufferGeometry: BufferGeometry | null;
  centerCoords: [number, number] | null;
  analysisMode: AnalysisMode;
  isLoading: boolean;
  onMapClick: (coords: [number, number]) => void;
  onMapMove: (bbox: [number, number, number, number]) => void;
  setIsInteracting: (active: boolean) => void;
}

const EMPTY_FC = { type: "FeatureCollection" as const, features: [] };
const FILTER_NONE: FilterSpecification = ["==", ["literal", "no"], ["literal", "match"]];

const buildPopupHTML = (idx: number, status: DriverStatus | null, distanceKm: number) => `
  <div style="font-family:sans-serif;font-size:0.85rem;color:#0f172a;min-width:140px">
    <strong>${driverName(idx)}</strong><br/>
    Status: ${status ?? "?"}<br/>
    Distance: <strong>${distanceKm.toFixed(2)} km</strong>
  </div>
`;

// Bbox với padding 20% mỗi chiều → prefetch điểm sát rìa, pan nhẹ không pop-in.
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

export const MapContainerSpatial: React.FC<MapContainerSpatialProps> = ({
  visibleFeatures,
  driverIndex,
  matchedIdxs,
  matched,
  bufferGeometry,
  centerCoords,
  analysisMode,
  isLoading,
  onMapClick,
  onMapMove,
  setIsInteracting,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const popupRef = useRef<Popup | null>(null);
  // Track driver đang được popup theo dõi → refreshSelection mỗi tick.
  const selectedIdxRef = useRef<number | null>(null);
  // Cache status tại click time — status không đổi giữa các tick nên không cần lookup lại.
  const selectedStatusRef = useRef<DriverStatus | null>(null);

  // Ref-for-prop: listener gắn 1 lần, đọc prop mới nhất qua ref.
  const onMapClickRef = useRef(onMapClick);
  onMapClickRef.current = onMapClick;
  const onMapMoveRef = useRef(onMapMove);
  onMapMoveRef.current = onMapMove;
  const setIsInteractingRef = useRef(setIsInteracting);
  setIsInteractingRef.current = setIsInteracting;
  const matchedRef = useRef(matched);
  matchedRef.current = matched;
  const driverIndexRef = useRef(driverIndex);
  driverIndexRef.current = driverIndex;

  // Đóng popup khi user toggle mode.
  useEffect(() => {
    popupRef.current?.remove();
    popupRef.current = null;
    selectedIdxRef.current = null;
    selectedStatusRef.current = null;
  }, [analysisMode]);

  // Cập nhật filter matched layer.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer("matched-drivers-layer")) return;
    const filter: FilterSpecification =
      matchedIdxs.length > 0 ? ["in", ["get", "idx"], ["literal", matchedIdxs]] : FILTER_NONE;
    map.setFilter("matched-drivers-layer", filter);
  }, [matchedIdxs]);

  // Cập nhật buffer polygon.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const source = map.getSource("buffer-source") as GeoJSONSource | undefined;
    if (source) source.setData(bufferGeometry ?? EMPTY_FC);
  }, [bufferGeometry]);

  // Cập nhật center marker; đóng popup khi clear center.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const source = map.getSource("center-source") as GeoJSONSource | undefined;
    if (source) {
      source.setData(
        centerCoords
          ? {
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  geometry: { type: "Point", coordinates: centerCoords },
                  properties: {},
                },
              ],
            }
          : EMPTY_FC,
      );
    }
    if (!centerCoords) {
      popupRef.current?.remove();
      popupRef.current = null;
    }
  }, [centerCoords]);

  // setData all-drivers-source mỗi khi visibleFeatures đổi (mỗi tick worker).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const source = map.getSource("all-drivers-source") as GeoJSONSource | undefined;
    if (source) {
      source.setData({ type: "FeatureCollection", features: visibleFeatures });
    }
  }, [visibleFeatures]);

  // Popup follow logic — mượn pattern refreshSelection từ MapContainer.tsx.
  // Chạy mỗi khi matched đổi (slider drag) HOẶC driverIndex đổi (worker tick mới):
  //   - Nếu driver đang select đã rời matched → đóng popup.
  //   - Ngược lại → re-position popup + cập nhật distance.
  useEffect(() => {
    const idx = selectedIdxRef.current;
    if (idx == null || !popupRef.current) return;

    const m = matched.find((mm) => mm.idx === idx);
    if (!m) {
      popupRef.current.remove();   // → trigger "close" listener → clear selectedIdxRef
      return;
    }

    if (!driverIndex) return;
    const lng = driverIndex.lngs[idx];
    const lat = driverIndex.lats[idx];
    popupRef.current.setLngLat([lng, lat]);
    popupRef.current.setHTML(buildPopupHTML(idx, selectedStatusRef.current, m.distanceKm));
  }, [matched, driverIndex]);

  useEffect(() => {
    if (!mapContainerRef.current) return;

    const map = new maplibre.Map({
      container: mapContainerRef.current,
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      center: [105.8342, 21.0278],
      zoom: 13,
    });

    map.addControl(new NavigationControl(), "top-right");
    map.getCanvas().style.cursor = "crosshair";
    mapRef.current = map;

    // Pan/zoom interaction lock + bbox update (mượn từ MapContainer 2D).
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
      // all-drivers-source: SEED rỗng, sẽ được setData mỗi tick từ effect.
      map.addSource("all-drivers-source", { type: "geojson", data: EMPTY_FC });
      map.addLayer({
        id: "all-drivers-layer",
        type: "circle",
        source: "all-drivers-source",
        paint: {
          "circle-color": "#475569",
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 1.2, 13, 2.4, 16, 5],
          "circle-opacity": 0.45,
        },
      });

      // Buffer polygon
      map.addSource("buffer-source", { type: "geojson", data: EMPTY_FC });
      map.addLayer({
        id: "buffer-layer-fill",
        type: "fill",
        source: "buffer-source",
        paint: { "fill-color": "#a855f7", "fill-opacity": 0.15 },
      });
      map.addLayer({
        id: "buffer-layer-outline",
        type: "line",
        source: "buffer-source",
        paint: { "line-color": "#c084fc", "line-width": 2, "line-dasharray": [2, 2] },
      });

      // Center marker
      map.addSource("center-source", { type: "geojson", data: EMPTY_FC });
      map.addLayer({
        id: "center-layer",
        type: "circle",
        source: "center-source",
        paint: {
          "circle-color": "#e11d48",
          "circle-radius": 8,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fff",
        },
      });

      // Matched layer
      map.addLayer({
        id: "matched-drivers-layer",
        type: "circle",
        source: "all-drivers-source",
        filter: FILTER_NONE,
        paint: {
          "circle-color": "#4ade80",
          "circle-radius": 6,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#fff",
        },
      });

      // Gửi bbox đầu tiên về parent → worker sync viewport thực.
      onMapMoveRef.current(paddedBbox(map));
    });

    // Click: trúng matched driver → popup; không → đặt center mới.
    map.on("click", (e) => {
      if (map.getLayer("matched-drivers-layer")) {
        const feats = map.queryRenderedFeatures(e.point, { layers: ["matched-drivers-layer"] });
        if (feats.length > 0) {
          const feat = feats[0];
          const idx = feat.properties?.idx as number | undefined;
          const status = feat.properties?.status as DriverStatus | undefined;
          const found =
            typeof idx === "number" ? matchedRef.current.find((mm) => mm.idx === idx) : undefined;
          if (found && feat.geometry.type === "Point") {
            popupRef.current?.remove();
            const [lng, lat] = feat.geometry.coordinates as [number, number];
            selectedIdxRef.current = idx as number;
            selectedStatusRef.current = status ?? null;
            popupRef.current = new maplibre.Popup({ closeOnClick: false, offset: 10 })
              .setLngLat([lng, lat])
              .setHTML(buildPopupHTML(idx as number, status ?? null, found.distanceKm))
              .addTo(map);
            popupRef.current.on("close", () => {
              selectedIdxRef.current = null;
              selectedStatusRef.current = null;
            });
            return;
          }
        }
      }
      // Click ngoài driver matched → đóng popup + đặt center mới.
      popupRef.current?.remove();
      popupRef.current = null;
      onMapClickRef.current([e.lngLat.lng, e.lngLat.lat]);
    });

    map.on("mouseenter", "matched-drivers-layer", () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "matched-drivers-layer", () => {
      map.getCanvas().style.cursor = "crosshair";
    });

    return () => {
      popupRef.current?.remove();
      popupRef.current = null;
      selectedIdxRef.current = null;
      selectedStatusRef.current = null;
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
      <MapLoadingOverlay visible={isLoading} label="Generating fleet (100k drivers)..." />
    </div>
  );
};
