// floodSensorFeed.ts
// Client nhận mực nước từ "trạm cảm biến IoT" qua WebSocket (/ws-sensors, đi qua Vite proxy).
// Theo đúng "auto-fallback ethos" của repo: nếu KHÔNG có backend (vd chạy `npm run dev`),
// WS không nối được -> tự chuyển sang BỘ MÔ PHỎNG phía client để demo vẫn hoạt động; khi
// backend (re)connect được thì quay lại dùng dữ liệu LIVE và tắt mô phỏng.
//
// Mẫu reconnect (proto/host/backoff 500*2^retry, cap 6, guard `closed`) sao theo
// createRemoteTransport() trong syncTransport.ts — KHÔNG refactor dùng chung vì kênh này
// không có REST và có thêm simulator (trộn vào sẽ rối hai mối quan tâm khác nhau).

export type FeedStatus = "connecting" | "live" | "simulated";

export interface FloodSensorFeedHandle {
  stop(): void;
}

export interface FloodSensorFeedOptions {
  onReading: (level: number) => void;
  onStatus: (status: FeedStatus, stationId?: string) => void;
}

const MAX_LEVEL = 5; // khớp ControlPanelFlood + server
const TICK_MS = 500;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Đường cong mô phỏng client — cùng "ý tưởng" với server (thuỷ triều + đợt dâng bão).
// Mốc thời gian theo performance.now() nên đường cong liên tục dù bật fallback giữa chừng.
const simWaterLevel = (tMs: number): number => {
  const t = tMs / 1000;
  const baseTide = 1.5;
  const tide = 0.8 * Math.sin((2 * Math.PI * t) / 60);
  const s = Math.sin((2 * Math.PI * t) / 180) * 0.5 + 0.5;
  const surge = Math.pow(s, 3) * 3.0;
  return clamp(baseTide + tide + surge, 0, MAX_LEVEL);
};

export function createFloodSensorFeed(opts: FloodSensorFeedOptions): FloodSensorFeedHandle {
  const { onReading, onStatus } = opts;

  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let simTimer: ReturnType<typeof setInterval> | null = null;
  let lastStatus: FeedStatus | null = null;

  // Chỉ phát onStatus khi THỰC SỰ đổi trạng thái (tránh spam mỗi reading).
  const setStatus = (s: FeedStatus, stationId?: string) => {
    if (s === lastStatus && !stationId) return;
    lastStatus = s;
    onStatus(s, stationId);
  };

  const startSim = () => {
    if (simTimer !== null) return; // idempotent
    simTimer = setInterval(() => onReading(simWaterLevel(performance.now())), TICK_MS);
  };
  const stopSim = () => {
    if (simTimer !== null) {
      clearInterval(simTimer);
      simTimer = null;
    }
  };

  const connect = () => {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws-sensors`);

    ws.onopen = () => {
      retry = 0;
      stopSim(); // có dữ liệu thật -> tắt mô phỏng
      setStatus("live");
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);
        if (msg && msg.type === "sensor" && typeof msg.level === "number") {
          onReading(clamp(msg.level, 0, MAX_LEVEL));
          setStatus("live", typeof msg.stationId === "string" ? msg.stationId : undefined);
        }
      } catch {
        /* bỏ qua frame hỏng */
      }
    };

    ws.onclose = () => {
      if (closed) return;
      // Mất kết nối: chạy mô phỏng ngay để hình ảnh không "đứng", đồng thời backoff reconnect.
      startSim();
      setStatus("simulated");
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 500 * 2 ** retry);
    };

    ws.onerror = () => {
      try {
        ws?.close();
      } catch {
        /* noop */
      }
    };
  };

  setStatus("connecting");
  connect();

  return {
    stop() {
      closed = true; // đặt TRƯỚC khi close để onclose không reschedule
      stopSim();
      try {
        ws?.close();
      } catch {
        /* noop */
      }
      ws = null;
    },
  };
}
