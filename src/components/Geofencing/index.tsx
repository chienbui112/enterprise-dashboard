import React, { useState, useEffect, useRef } from "react";
import type { FeatureCollection, Polygon } from "geojson";
import { ControlPanelGeofence } from "./ControlPanelGeofence";
import { MapContainerGeofence } from "./MapContainerGeofence";
import { VEHICLE_COUNT, GEOFENCE_COUNT, INITIAL_BBOX, VIETNAM_BBOX } from "../../utils/geofenceHelpers";

// Gói render worker bắn về mỗi tick: subset xe trong viewport (typed array, transferable).
export interface GeofencePacket {
  count: number;
  coords: Float32Array; // [lng, lat] xen kẽ, độ dài count*2
  violating: Uint8Array; // 1 = đang trong vùng cấm -> tô đỏ
  idx: Uint32Array; // định danh ổn định cho popup
}

// Một dòng cảnh báo hiển thị trên panel (đã gắn seq + thời điểm bởi main thread).
export interface AlertEntry {
  seq: number;
  idx: number;
  zone: number;
  type: "enter" | "exit";
  time: string;
}

// Alert thô do worker gửi (chưa có seq/time — main thread bổ sung).
interface RawAlert {
  idx: number;
  zone: number;
  type: "enter" | "exit";
}

const MAX_ALERTS = 80; // giữ log gọn để render panel không phình

const fmtTime = (d: Date) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;

export const GeofencingDashboard: React.FC = () => {
  const [hasFirstData, setHasFirstData] = useState(false);
  const [visibleCount, setVisibleCount] = useState(0);
  const [totalViolating, setTotalViolating] = useState(0);
  const [tickCount, setTickCount] = useState(0);
  const [pipCount, setPipCount] = useState(0);
  const [enterTotal, setEnterTotal] = useState(0);
  const [exitTotal, setExitTotal] = useState(0);
  const [alerts, setAlerts] = useState<AlertEntry[]>([]);
  const [isMonitoring, setIsMonitoring] = useState(true);
  const [speedFactor, setSpeedFactor] = useState(1);
  const [isInteracting, setIsInteracting] = useState(false);
  const [geofences, setGeofences] = useState<FeatureCollection<Polygon> | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const isInteractingRef = useRef(isInteracting);
  const alertSeqRef = useRef(0);
  // Handler do MapContainer đăng ký: nhận packet thẳng vào layer (không đẩy buffer nặng vào React state).
  const renderHandlerRef = useRef<((p: GeofencePacket) => void) | null>(null);

  // Gộp batch alert của worker -> AlertEntry, cập nhật log + tổng Enter/Exit.
  const ingestAlerts = (raw: RawAlert[]) => {
    if (!raw.length) return;
    const now = fmtTime(new Date());
    const entries: AlertEntry[] = raw.map((a) => ({ ...a, seq: alertSeqRef.current++, time: now }));
    const enters = raw.reduce((n, a) => n + (a.type === "enter" ? 1 : 0), 0);
    const exits = raw.length - enters;
    if (enters) setEnterTotal((p) => p + enters);
    if (exits) setExitTotal((p) => p + exits);
    setAlerts((prev) => [...entries.reverse(), ...prev].slice(0, MAX_ALERTS));
  };

  useEffect(() => {
    isInteractingRef.current = isInteracting;
    workerRef.current?.postMessage({ type: "SET_INTERACTING", payload: { isActive: isInteracting } });
  }, [isInteracting]);

  useEffect(() => {
    workerRef.current?.postMessage({ type: "SET_STREAMING", payload: { isActive: isMonitoring } });
  }, [isMonitoring]);

  useEffect(() => {
    workerRef.current?.postMessage({ type: "SET_SPEED", payload: { factor: speedFactor } });
  }, [speedFactor]);

  // Worker init: 1 lần ở mount, terminate ở unmount.
  useEffect(() => {
    const w = new Worker(new URL("../../workers/geofence.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;

    w.onmessage = (e: MessageEvent) => {
      const data = e.data;
      switch (data?.type) {
        case "GEOFENCES_READY":
          setGeofences(data.geojson);
          break;

        case "DATA_UPDATED": {
          if (!isInteractingRef.current) {
            renderHandlerRef.current?.(data as GeofencePacket);
            setVisibleCount(data.count);
            setHasFirstData(true);
          }
          setTotalViolating(data.totalViolating);
          setPipCount(data.pipCount);
          setTickCount((p) => p + 1);
          ingestAlerts(data.alerts);
          break;
        }

        case "ALERTS_ONLY": // gửi trong lúc pan/zoom: giám sát không dừng
          setTotalViolating(data.totalViolating);
          setPipCount(data.pipCount);
          ingestAlerts(data.alerts);
          break;
      }
    };

    w.postMessage({
      type: "INIT_DATA",
      payload: { count: VEHICLE_COUNT, geofenceCount: GEOFENCE_COUNT, bbox: INITIAL_BBOX },
    });

    return () => w.terminate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMapMove = (bbox: [number, number, number, number]) => {
    workerRef.current?.postMessage({ type: "UPDATE_BBOX", payload: { bbox } });
  };

  return (
    <div style={{ display: "flex", width: "100vw", height: "100vh", overflow: "hidden" }}>
      <ControlPanelGeofence
        vehicleTotal={VEHICLE_COUNT}
        geofenceTotal={GEOFENCE_COUNT}
        visibleCount={visibleCount}
        totalViolating={totalViolating}
        tickCount={tickCount}
        pipCount={pipCount}
        enterTotal={enterTotal}
        exitTotal={exitTotal}
        alerts={alerts}
        isMonitoring={isMonitoring}
        setIsMonitoring={setIsMonitoring}
        speedFactor={speedFactor}
        setSpeedFactor={setSpeedFactor}
      />
      <MapContainerGeofence
        isLoading={!hasFirstData}
        fitBbox={VIETNAM_BBOX}
        geofences={geofences}
        renderHandlerRef={renderHandlerRef}
        onMapMove={handleMapMove}
        setIsInteracting={setIsInteracting}
      />
    </div>
  );
};
