// cesiumSensorFeed.ts
// Giả lập "luồng WebSocket" của kịch bản BÃO ĐỔ BỘ.
//
// Mô hình ngập theo cao độ tuyệt đối: cơn bão làm MỰC DÂNG TOÀN CỤC tăng dần theo thời gian
// (đường cong surge). Mỗi 1 giây ta phát một giá trị "rise" (m, so điểm thấp nhất khu vực); dashboard
// đặt W = minTerrain + rise rồi tự suy ra độ sâu từng hố ga từ địa hình (trạm trũng ngập sâu hơn).

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const smoothstep = (t: number) => t * t * (3 - 2 * t);

const RAMP_SECONDS = 40; // thời gian bão đạt đỉnh

export interface StormStreamOptions {
  maxRise: number; // mức dâng tối đa khi bão cực đại (m)
  onRise: (riseMeters: number, elapsedSeconds: number) => void;
  intervalMs?: number; // mặc định 1000ms theo đề bài
}

export interface StormStreamHandle {
  stop(): void;
}

// Mức dâng toàn cục tại thời điểm elapsed (giây) kể từ lúc bão bắt đầu.
const riseAt = (maxRise: number, elapsed: number): number => {
  const progress = clamp(elapsed / RAMP_SECONDS, 0, 1);
  const surge = maxRise * smoothstep(progress);
  const ripple = 0.1 * Math.sin(elapsed * 0.7) * progress; // dao động nhỏ cho sống động
  return clamp(surge + ripple, 0, maxRise);
};

export function createStormStream(opts: StormStreamOptions): StormStreamHandle {
  const { maxRise, onRise, intervalMs = 1000 } = opts;
  const startMs = performance.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const emit = () => {
    if (stopped) return;
    const elapsed = (performance.now() - startMs) / 1000;
    onRise(riseAt(maxRise, elapsed), elapsed);
  };

  emit(); // phản hồi tức thì
  timer = setInterval(emit, intervalMs);

  return {
    stop() {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
