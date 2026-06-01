import React, { useEffect, useRef, useState } from "react";
import type { Feature, Point } from "geojson";
import { ControlPanelBigData } from "./ControlPanelBigData";
import { MapContainerBigData, type BigDataPacket } from "./MapContainerBigData";

const DEFAULT_COUNT = 1_000_000;
const INITIAL_BBOX: [number, number, number, number] = [101, 7, 114, 24];
const INITIAL_ZOOM = 5;

export const BigDataDashboard: React.FC = () => {
  const [totalPoints, setTotalPoints] = useState<number>(0);
  const [viewportCount, setViewportCount] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [loadingLabel, setLoadingLabel] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState<boolean>(true);
  const [lastTickAt, setLastTickAt] = useState<number>(0);

  const workerRef = useRef<Worker | null>(null);
  // Map nhận packet trực tiếp qua ref → không qua React state (tránh re-render mỗi 3s).
  // Pattern giống MotionStream/index.tsx — handler set bởi MapContainer ở mount.
  const packetHandlerRef = useRef<((p: BigDataPacket) => void) | null>(null);

  useEffect(() => {
    const w = new Worker(new URL("../../workers/bigData.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = w;

    w.onmessage = (e: MessageEvent) => {
      const { type } = e.data;

      if (type === "DATA_UPDATED") {
        const features = e.data.features as Feature<Point>[];
        const total = e.data.total as number;
        const viewport = e.data.viewportCount as number;
        const stage = e.data.stage as string;

        setTotalPoints(total);
        setViewportCount(viewport);
        if (stage === "tick") setLastTickAt((n) => n + 1);

        // Đẩy packet thẳng cho MapContainer xử lý (reconcile pool + flush).
        packetHandlerRef.current?.({ features, viewportCount: viewport, stage });

        // Tắt overlay ngay khi nhận packet đầu (idempotent: setState same value = no-op).
        // KHÔNG dùng `if (isLoading)` vì closure capture initial false ở mount → vĩnh viễn không fire.
        setIsLoading(false);
      } else if (type === "ERROR") {
        setIsLoading(false);
        setLoadingLabel(`Lỗi: ${e.data.message}`);
      }
    };

    handleGenerateData(DEFAULT_COUNT);

    return () => {
      w.terminate();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    workerRef.current?.postMessage({
      type: "SET_STREAMING",
      payload: { isActive: isStreaming },
    });
  }, [isStreaming]);

  const handleGenerateData = (count: number) => {
    setIsLoading(true);
    setLoadingLabel(`Worker sinh ${count.toLocaleString()} điểm + build cluster index...`);
    workerRef.current?.postMessage({
      type: "INIT_DATA",
      payload: { count, bbox: INITIAL_BBOX, zoom: INITIAL_ZOOM },
    });
    setIsStreaming(true);
  };

  const handleMapMove = (bbox: [number, number, number, number], zoom: number) => {
    workerRef.current?.postMessage({
      type: "UPDATE_VIEW",
      payload: { bbox, zoom },
    });
  };

  const handleSetIsInteracting = (isActive: boolean) => {
    workerRef.current?.postMessage({
      type: "SET_INTERACTING",
      payload: { isActive },
    });
  };

  return (
    <div style={{ display: "flex", width: "100vw", height: "100vh", overflow: "hidden" }}>
      <ControlPanelBigData
        totalPoints={totalPoints}
        viewportCount={viewportCount}
        isLoading={isLoading}
        isStreaming={isStreaming}
        setIsStreaming={setIsStreaming}
        lastTickAt={lastTickAt}
        onGenerateData={handleGenerateData}
      />
      <MapContainerBigData
        packetHandlerRef={packetHandlerRef}
        isLoading={isLoading}
        loadingLabel={loadingLabel}
        onMapMove={handleMapMove}
        setIsInteracting={handleSetIsInteracting}
      />
    </div>
  );
};
