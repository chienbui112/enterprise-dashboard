// Kênh cảm biến IoT mực nước cho dashboard FloodSim (3D Digital Twin · Ngập lụt).
// Tạo một WebSocketServer ở chế độ `noServer` — server/index.js tự định tuyến sự kiện
// "upgrade" theo path ("/ws-sensors") và gọi handleUpgrade. Đây là cách CHUẨN khi có
// NHIỀU WebSocketServer trên cùng 1 HTTP server (nếu để mỗi WSS tự gắn { server, path }
// thì chúng tranh nhau sự kiện upgrade -> hỏng handshake). Hoàn toàn tách khỏi "/ws" của
// Offline Sync, nên client offline-sync không bao giờ nhận nhầm message sensor là "changed".
//
// Mô phỏng trạm đo: phát bản tin { type:"sensor", stationId, level, ts } mỗi ~500ms.
// Đường cong = thuỷ triều (sine 60s) + đợt dâng do bão (sine chu kỳ dài), kẹp trong [0, 5] m.

import { WebSocketServer } from "ws";

const TICK_MS = 500;
const MAX_LEVEL = 5; // khớp MAX_LEVEL của ControlPanelFlood
const STATION_ID = "ST-01";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Mực nước theo thời gian (ms). Dùng chung "ý tưởng" với simulator phía client.
const waterLevelAt = (tMs) => {
  const t = tMs / 1000; // giây
  const baseTide = 1.5;
  const tide = 0.8 * Math.sin((2 * Math.PI * t) / 60); // thuỷ triều chu kỳ 60s
  // Đợt dâng do bão: sine chu kỳ ~180s, luỹ thừa cho "nhọn", thỉnh thoảng đẩy tới 4–5m.
  const s = Math.sin((2 * Math.PI * t) / 180) * 0.5 + 0.5; // 0..1
  const surge = Math.pow(s, 3) * 3.0;
  return clamp(baseTide + tide + surge, 0, MAX_LEVEL);
};

const reading = () => ({
  type: "sensor",
  stationId: STATION_ID,
  level: Math.round(waterLevelAt(Date.now()) * 100) / 100,
  ts: Date.now(),
});

// Trả về WebSocketServer (noServer). server/index.js định tuyến upgrade "/ws-sensors" tới đây.
export function createSensorWss() {
  const wss = new WebSocketServer({ noServer: true });

  // Phát cho mọi client đang mở.
  const broadcast = () => {
    const msg = JSON.stringify(reading());
    for (const client of wss.clients) {
      if (client.readyState === 1 /* OPEN */) client.send(msg);
    }
  };

  // Client mới nối -> gửi ngay 1 bản tin để không phải đợi nguyên 1 tick.
  wss.on("connection", (socket) => {
    try {
      socket.send(JSON.stringify(reading()));
    } catch {
      /* noop */
    }
  });

  const timer = setInterval(broadcast, TICK_MS);
  // Không giữ tiến trình sống chỉ vì timer này (cho phép server thoát sạch nếu cần).
  if (typeof timer.unref === "function") timer.unref();

  return wss;
}
