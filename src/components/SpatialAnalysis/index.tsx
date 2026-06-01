import React, { useEffect, useMemo, useRef, useState } from "react";
import { ControlPanelSpatial } from "./ControlPanelSpatial";
import { MapContainerSpatial } from "./MapContainerSpatial";
import { STATUSES, type DriverFeature, type DriverStatus } from "../../utils/geoHelpers";
import {
  createBufferCircle,
  findDriversInRadius,
  findNearestDrivers,
  rehydrateDriverIndex,
  type DriverIndex,
} from "../../utils/spatialHelpers";

export type AnalysisMode = "radius" | "nearest";

const TOP_N_RADIUS = 5;
const DRIVER_COUNT = 100_000;
// Bbox khởi tạo bao quanh spawn area (105.75–105.93, 20.95–21.10) + padding,
// để tick đầu tiên của worker có viewport hợp lệ trước khi map mount xong.
const INITIAL_BBOX: [number, number, number, number] = [105.7, 20.9, 105.98, 21.15];

export const SpatialAnalysisDashboard: React.FC = () => {
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>("radius");
  const [centerCoords, setCenterCoords] = useState<[number, number] | null>(null);
  const [radiusKm, setRadiusKm] = useState<number>(1.5);
  const [nearestK, setNearestK] = useState<number>(5);

  // Snapshot từ worker — đổi mỗi tick (~5s)
  const [visibleFeatures, setVisibleFeatures] = useState<DriverFeature[]>([]);
  const [driverIndex, setDriverIndex] = useState<DriverIndex | null>(null);
  const [hasFirstData, setHasFirstData] = useState<boolean>(false);

  const destinationsRef = useRef<Float32Array | null>(null);
  const [isInteracting, setIsInteracting] = useState<boolean>(false);
  const isInteractingRef = useRef(isInteracting);
  const workerRef = useRef<Worker | null>(null);
  // Object pool tái dùng feature objects → tránh alloc 100k mỗi tick (GC churn).
  const featurePoolRef = useRef<DriverFeature[]>([]);

  useEffect(() => {
    isInteractingRef.current = isInteracting;
    workerRef.current?.postMessage({
      type: "SET_INTERACTING",
      payload: { isActive: isInteracting },
    });
  }, [isInteracting]);

  // Worker init: 1 lần ở mount, terminate ở unmount.
  useEffect(() => {
    const w = new Worker(
      new URL("../../workers/spatialAnalysis.worker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = w;

    w.onmessage = (e: MessageEvent) => {
      const { type } = e.data;

      if (type === "INIT_DESTINATIONS") {
        destinationsRef.current = e.data.destCoords as Float32Array;
        return;
      }

      if (type !== "DATA_UPDATED") return;
      if (isInteractingRef.current) return; // drop ticks trong pan/zoom

      const { count, coords, bearing, status, idx, fullLngs, fullLats, kdData } = e.data as {
        count: number;
        coords: Float32Array;
        bearing: Float32Array;
        status: Uint8Array;
        idx: Uint32Array;
        fullLngs: Float32Array;
        fullLats: Float32Array;
        kdData: ArrayBuffer;
      };

      // Object pool: mutate sẵn object thay vì alloc N Feature mới mỗi tick.
      const pool = featurePoolRef.current;
      for (let i = 0; i < count; i++) {
        let f = pool[i];
        if (!f) {
          f = pool[i] = {
            type: "Feature",
            geometry: { type: "Point", coordinates: [0, 0] },
            properties: { idx: 0, status: "active", bearing: 0 },
          };
        }
        f.geometry.coordinates[0] = coords[i * 2];
        f.geometry.coordinates[1] = coords[i * 2 + 1];
        f.properties.idx = idx[i];
        f.properties.status = STATUSES[status[i]] as DriverStatus;
        f.properties.bearing = bearing[i];
      }

      // Rehydrate kdbush từ buffer transferred (zero-copy).
      const newIndex = rehydrateDriverIndex(kdData, fullLngs, fullLats);

      // slice tạo ref mới để React nhận biết, vẫn tái dùng object bên trong.
      setVisibleFeatures(pool.slice(0, count));
      setDriverIndex(newIndex);
      setHasFirstData(true);
    };

    w.postMessage({
      type: "INIT_DATA",
      payload: { count: DRIVER_COUNT, bbox: INITIAL_BBOX },
    });
    w.postMessage({ type: "SET_STREAMING", payload: { isActive: true } });

    return () => w.terminate();
  }, []);

  // Re-query khi snapshot (driverIndex), center, hoặc params thay đổi.
  // Mỗi tick worker → driverIndex ref mới → matched tự refresh không cần listener riêng.
  const { matched, matchedIdxs, bufferGeometry } = useMemo(() => {
    if (!centerCoords || !driverIndex) {
      return { matched: [], matchedIdxs: [] as number[], bufferGeometry: null };
    }
    if (analysisMode === "radius") {
      const found = findDriversInRadius(driverIndex, centerCoords, radiusKm);
      return {
        matched: found,
        matchedIdxs: found.map((m) => m.idx),
        bufferGeometry: createBufferCircle(centerCoords, radiusKm),
      };
    }
    const found = findNearestDrivers(driverIndex, centerCoords, nearestK);
    return {
      matched: found,
      matchedIdxs: found.map((m) => m.idx),
      bufferGeometry: null,
    };
  }, [analysisMode, driverIndex, centerCoords, radiusKm, nearestK]);

  const topMatches =
    analysisMode === "nearest" ? matched : matched.slice(0, TOP_N_RADIUS);

  const handleClear = () => setCenterCoords(null);

  const handleMapMove = (bbox: [number, number, number, number]) => {
    workerRef.current?.postMessage({ type: "UPDATE_BBOX", payload: { bbox } });
  };

  return (
    <div style={{ display: "flex", width: "100vw", height: "100vh", overflow: "hidden" }}>
      <ControlPanelSpatial
        mode={analysisMode}
        setMode={setAnalysisMode}
        radiusKm={radiusKm}
        setRadiusKm={setRadiusKm}
        nearestK={nearestK}
        setNearestK={setNearestK}
        foundCount={matched.length}
        selectedCenter={centerCoords}
        topMatches={topMatches}
        onClear={handleClear}
      />
      <MapContainerSpatial
        visibleFeatures={visibleFeatures}
        driverIndex={driverIndex}
        matchedIdxs={matchedIdxs}
        matched={matched}
        bufferGeometry={bufferGeometry}
        centerCoords={centerCoords}
        analysisMode={analysisMode}
        isLoading={!hasFirstData}
        onMapClick={setCenterCoords}
        onMapMove={handleMapMove}
        setIsInteracting={setIsInteracting}
      />
    </div>
  );
};
