import React, { useState, useEffect, useRef } from "react";
import { ControlPanelStream } from "./ControlPanelStream";
import { MapContainerStream } from "./MapContainerStream";

// Gói "nhỏ giọt" worker bắn về mỗi 3s: subset tài xế trong viewport (typed array, transferable).
export interface StreamPacket {
  count: number;
  coords: Float32Array; // [lng, lat] xen kẽ, độ dài count*2
  bearing: Float32Array; // hướng tức thời (chỉ dùng khi xe mới vào viewport)
  idx: Uint32Array; // định danh ổn định — KHÓA nội suy last→next theo từng xe
}

export type InterpolationMode = "smooth" | "snap";

const TOTAL_DRIVERS = 100_000;
// Bbox khởi tạo bao quanh spawn area (105.75–105.93, 20.95–21.10) + padding,
// để tick đầu của worker có viewport hợp lệ trước khi map gửi bbox thật.
const INITIAL_BBOX: [number, number, number, number] = [105.7, 20.9, 105.98, 21.15];

export const MotionStreamDashboard: React.FC = () => {
  const [isInterpolating, setIsInterpolating] = useState<boolean>(true);
  const [networkTickCount, setNetworkTickCount] = useState<number>(0);
  const [visibleCount, setVisibleCount] = useState<number>(0);
  const [fps, setFps] = useState<number>(0);
  const [hasFirstData, setHasFirstData] = useState<boolean>(false);
  const [interpolationMode, setInterpolationMode] = useState<InterpolationMode>("smooth");
  const [isInteracting, setIsInteracting] = useState<boolean>(false);

  const workerRef = useRef<Worker | null>(null);
  const isInteractingRef = useRef(isInteracting);
  // Handler do MapContainerStream đăng ký: nhận packet thẳng vào engine nội suy,
  // KHÔNG đẩy packet vào React state (tránh re-render dashboard ở 0.33Hz × 100k buffer).
  const packetHandlerRef = useRef<((p: StreamPacket) => void) | null>(null);

  useEffect(() => {
    isInteractingRef.current = isInteracting;
    workerRef.current?.postMessage({
      type: "SET_INTERACTING",
      payload: { isActive: isInteracting },
    });
  }, [isInteracting]);

  // Worker init: 1 lần ở mount, terminate ở unmount.
  useEffect(() => {
    const w = new Worker(new URL("../../workers/motionStream.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;

    w.onmessage = (e: MessageEvent) => {
      if (e.data?.type !== "DATA_UPDATED") return;
      if (isInteractingRef.current) return; // drop ticks trong pan/zoom

      const packet = e.data as StreamPacket & { type: string };

      packetHandlerRef.current?.(packet);
      setNetworkTickCount((prev) => prev + 1);
      setHasFirstData(true);
    };

    w.postMessage({ type: "INIT_DATA", payload: { count: TOTAL_DRIVERS, bbox: INITIAL_BBOX } });

    return () => w.terminate();
  }, []);

  const handleMapMove = (bbox: [number, number, number, number]) => {
    workerRef.current?.postMessage({ type: "UPDATE_BBOX", payload: { bbox } });
  };

  return (
    <div style={{ display: "flex", width: "100vw", height: "100vh", overflow: "hidden" }}>
      <ControlPanelStream
        networkTickCount={networkTickCount}
        fps={fps}
        visibleCount={visibleCount}
        interpolationMode={interpolationMode}
        isInterpolating={isInterpolating}
        setIsInterpolating={setIsInterpolating}
      />
      <MapContainerStream
        isInterpolating={isInterpolating}
        isLoading={!hasFirstData}
        packetHandlerRef={packetHandlerRef}
        onMapMove={handleMapMove}
        setIsInteracting={setIsInteracting}
        setFps={setFps}
        setVisibleCount={setVisibleCount}
        setInterpolationMode={setInterpolationMode}
      />
    </div>
  );
};
