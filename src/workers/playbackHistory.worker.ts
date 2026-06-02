import { generateTrajectoryCube } from "../utils/playbackHelpers";

// ============================================================================
// Worker sinh lịch sử di chuyển (space-time cube) cho dashboard History Playback.
//
// Khác các worker khác: worker này KHÔNG stateful, KHÔNG setInterval. Nó chỉ
// sinh MỘT LẦN toàn bộ khối không-thời gian (việc nặng: 5.000 xe × 301 frame)
// rồi Transfer buffer về main thread — giữ cost sinh dữ liệu khỏi block UI.
// Phần tua lại + phát hiện va chạm chạy trên main thread (tương tác 60 FPS).
//
// Hợp đồng message:
//   main->worker: GENERATE { count, frames }
//   worker->main: GENERATED { cube, count, frames, stride } (cube.buffer transferable)
// ============================================================================

const post = self.postMessage as (message: unknown, transfer?: Transferable[]) => void;

self.onmessage = (event: MessageEvent) => {
  const { type, payload } = event.data;

  if (type === "GENERATE") {
    const t0 = performance.now();
    const { cube, count, frames, stride } = generateTrajectoryCube(payload.count, payload.frames);
    const genMs = Math.round(performance.now() - t0);

    // Transfer quyền sở hữu buffer (zero-copy) thay vì structured-clone 12MB.
    post({ type: "GENERATED", cube, count, frames, stride, genMs }, [cube.buffer]);
  }
};
