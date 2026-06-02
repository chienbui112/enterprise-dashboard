// Backend nhỏ cho Offline Sync (chế độ "Backend / đa-máy").
// Express (REST) + ws (WebSocket) trên cùng 1 HTTP server. Lưu bền qua server/store.js.
// Chạy: npm run server  (hoặc npm run dev:all để chạy kèm Vite).

import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { push, pullSince, simulate, currentSeq } from "./store.js";
import { createSensorWss } from "./sensorFeed.js";

const PORT = 3001;

const app = express();
app.use(cors()); // không cần khi đi qua Vite proxy, nhưng bật để gọi trực tiếp cũng được
app.use(express.json({ limit: "2mb" }));

const httpServer = createServer(app);

// Hai WebSocketServer ở chế độ noServer; tự định tuyến "upgrade" theo path (cách chuẩn khi
// nhiều WSS dùng chung 1 HTTP server). "/ws" = Offline Sync; "/ws-sensors" = cảm biến IoT.
const wss = new WebSocketServer({ noServer: true });
const sensorWss = createSensorWss();

httpServer.on("upgrade", (req, socket, head) => {
  let pathname = "/";
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {
    /* giữ "/" */
  }
  if (pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else if (pathname === "/ws-sensors") {
    sensorWss.handleUpgrade(req, socket, head, (ws) => sensorWss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// Báo mọi client (qua WebSocket) rằng server vừa có thay đổi -> client tự gọi /api/pull.
const broadcast = () => {
  const msg = JSON.stringify({ type: "changed", seq: currentSeq() });
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) client.send(msg);
  }
};

app.get("/api/health", (_req, res) => res.json({ ok: true, seq: currentSeq() }));

app.post("/api/push", (req, res) => {
  const result = push(req.body);
  if (result.status === "ok") broadcast(); // chỉ fan-out khi server thực sự thay đổi
  res.json(result);
});

app.get("/api/pull", (req, res) => {
  const since = Number(req.query.since ?? 0) || 0;
  res.json(pullSince(since));
});

app.post("/api/simulate", (req, res) => {
  const result = simulate(req.body?.ids ?? []);
  if (result.changed > 0) broadcast();
  res.json(result);
});

wss.on("connection", () => {
  // client mới nối -> không cần làm gì; nó sẽ tự pull(since=0) lúc khởi tạo
});

httpServer.listen(PORT, () => {
  console.log(`[server] Backend listening on :${PORT} (REST /api/*, WS /ws, IoT WS /ws-sensors)`);
});
