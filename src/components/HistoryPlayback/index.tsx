import React, { useState, useEffect, useRef } from "react";
import { ControlPanelPlayback } from "./ControlPanelPlayback";
import { MapContainerPlayback } from "./MapContainerPlayback";
import {
  VEHICLE_COUNT,
  FRAME_COUNT,
  DURATION_SEC,
  type SpaceTimeCube,
} from "../../utils/playbackHelpers";

// Va chạm thô do MapContainer phát ra khi một cặp xe MỚI lại gần < ngưỡng (transition).
export interface RawCollision {
  i: number;
  j: number;
  dist: number;
  sec: number;
}

// Một dòng cảnh báo hiển thị trên panel (đã gắn seq + thời điểm thực bởi main thread).
export interface CollisionAlert extends RawCollision {
  seq: number;
  time: string;
}

// Kết quả thước đo: 2 xe đang chọn + khoảng cách (mét).
export interface MeasureInfo {
  a: number;
  b: number;
  dist: number;
}

const MAX_ALERTS = 60; // giữ log gọn để panel không phình

const fmtClock = (d: Date) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;

export const HistoryPlaybackDashboard: React.FC = () => {
  const [cube, setCube] = useState<SpaceTimeCube | null>(null);
  const [genMs, setGenMs] = useState(0);

  // Điều khiển playback.
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(10); // giây-giả-lập / giây-thực (mặc định 10× cho demo gọn)
  const [currentTime, setCurrentTime] = useState(0); // vị trí timeline (giây, có thể lẻ)

  // Mỗi lần người dùng kéo slider -> bump nonce để MapContainer "seek" tới mốc đó.
  const [seek, setSeek] = useState<{ t: number; nonce: number }>({ t: 0, nonce: 0 });

  // Chỉ số live (throttle bởi MapContainer).
  const [collisionCount, setCollisionCount] = useState(0);
  const [checkCount, setCheckCount] = useState(0);
  const [fps, setFps] = useState(0);
  const [alerts, setAlerts] = useState<CollisionAlert[]>([]);
  const [totalEvents, setTotalEvents] = useState(0);

  // Thước đo (chỉ dùng ý nghĩa khi Pause): bật -> bấm 2 xe để đo khoảng cách.
  const [measureMode, setMeasureMode] = useState(false);
  const [measureInfo, setMeasureInfo] = useState<MeasureInfo | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const alertSeqRef = useRef(0);

  // MapContainer publish thời gian hiện tại (RAF-driven) qua ref-callback này.
  const handleTimeChange = (t: number) => setCurrentTime(t);
  const handleStats = (collisions: number, checks: number) => {
    setCollisionCount(collisions);
    setCheckCount(checks);
  };

  // Gộp batch va chạm mới -> CollisionAlert, cập nhật log + tổng sự kiện.
  const ingestCollisions = (raw: RawCollision[]) => {
    if (!raw.length) return;
    const now = fmtClock(new Date());
    const entries: CollisionAlert[] = raw.map((c) => ({ ...c, seq: alertSeqRef.current++, time: now }));
    setTotalEvents((p) => p + raw.length);
    setAlerts((prev) => [...entries.reverse(), ...prev].slice(0, MAX_ALERTS));
  };

  // Sinh cube 1 lần ở mount qua worker; terminate ở unmount.
  useEffect(() => {
    const w = new Worker(new URL("../../workers/playbackHistory.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;

    w.onmessage = (e: MessageEvent) => {
      if (e.data?.type === "GENERATED") {
        const { cube: buf, count, frames, stride, genMs: ms } = e.data;
        setCube({ cube: buf, count, frames, stride });
        setGenMs(ms);
      }
    };

    w.postMessage({ type: "GENERATE", payload: { count: VEHICLE_COUNT, frames: FRAME_COUNT } });

    return () => w.terminate();
  }, []);

  // Kéo slider: cập nhật vị trí + phát yêu cầu seek. Khi đang chạy mà tua thì vẫn tiếp tục chạy từ mốc mới.
  const handleScrub = (t: number) => {
    setCurrentTime(t);
    setSeek({ t, nonce: seek.nonce + 1 });
  };

  // Tới cuối timeline -> tự dừng (MapContainer gọi).
  const handleEnded = () => setIsPlaying(false);

  const togglePlay = () => {
    // Nếu đang ở cuối mà bấm Play -> tua về đầu.
    if (!isPlaying && currentTime >= DURATION_SEC - 0.001) {
      handleScrub(0);
    }
    setIsPlaying((p) => !p);
  };

  // Bật thước đo -> tự dừng playback (đo khi xe đứng yên cho chính xác).
  const toggleMeasure = () => {
    setMeasureMode((m) => {
      const next = !m;
      if (next) setIsPlaying(false);
      else setMeasureInfo(null);
      return next;
    });
  };

  return (
    <div style={{ display: "flex", width: "100vw", height: "100vh", overflow: "hidden" }}>
      <ControlPanelPlayback
        vehicleTotal={VEHICLE_COUNT}
        durationSec={DURATION_SEC}
        genMs={genMs}
        isReady={cube != null}
        isPlaying={isPlaying}
        togglePlay={togglePlay}
        currentTime={currentTime}
        onScrub={handleScrub}
        speed={speed}
        setSpeed={setSpeed}
        collisionCount={collisionCount}
        checkCount={checkCount}
        fps={fps}
        totalEvents={totalEvents}
        alerts={alerts}
        measureMode={measureMode}
        toggleMeasure={toggleMeasure}
        measureInfo={measureInfo}
      />
      <MapContainerPlayback
        cube={cube}
        isLoading={cube == null}
        isPlaying={isPlaying}
        speed={speed}
        seekNonce={seek.nonce}
        seekTime={seek.t}
        onTimeChange={handleTimeChange}
        onStats={handleStats}
        onFps={setFps}
        onCollisions={ingestCollisions}
        onEnded={handleEnded}
        measureMode={measureMode}
        onMeasure={setMeasureInfo}
      />
    </div>
  );
};
