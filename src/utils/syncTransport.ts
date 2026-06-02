import { type IDBPDatabase } from "idb";
import { pushToServer, pullChanges, simulateServerEdit, type ServerRecord, type SyncResult } from "./offlineSyncServer";
import { type OfflineFeature } from "./indexedDbHelper";

// Lớp trừu tượng đồng bộ: index.tsx chỉ gọi qua đây, không cần biết Local hay Backend.
export type SyncMode = "local" | "backend";
export interface PullResult {
  changed: ServerRecord[];
  maxSeq: number;
}
export interface SyncTransport {
  push(item: OfflineFeature): Promise<SyncResult>;
  pull(sinceSeq: number): Promise<PullResult>;
  notifyChange(): void; // báo "tôi vừa đẩy" (Local: BroadcastChannel; Backend: server tự fan-out)
  onRemoteChange(cb: () => void): () => void; // nhận tín hiệu thay đổi -> trả hàm hủy đăng ký
  onStatus(cb: (connected: boolean) => void): () => void; // trạng thái kết nối (Backend); Local luôn true
  simulateServerEdit(ids: string[]): Promise<number>;
  close(): void;
}

// ===== Local: shared IndexedDB + BroadcastChannel (đa-tab cùng trình duyệt) =====
export const createLocalTransport = (sharedDb: IDBPDatabase): SyncTransport => {
  const bc = new BroadcastChannel("offline-sync");
  return {
    push: (item) => pushToServer(sharedDb, item),
    pull: (since) => pullChanges(sharedDb, since),
    notifyChange: () => bc.postMessage({ type: "changed" }),
    onRemoteChange: (cb) => {
      const h = () => cb();
      bc.addEventListener("message", h);
      return () => bc.removeEventListener("message", h);
    },
    onStatus: (cb) => {
      cb(true); // local luôn "kết nối"
      return () => {};
    },
    simulateServerEdit: (ids) => simulateServerEdit(sharedDb, ids),
    close: () => bc.close(),
  };
};

// ===== Backend: REST + WebSocket tới server thật (qua Vite proxy, cùng origin) =====
export const createRemoteTransport = (): SyncTransport => {
  const changeCbs = new Set<() => void>();
  const statusCbs = new Set<(c: boolean) => void>();
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let connectedOnce = false;

  const connect = () => {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      const isReconnect = connectedOnce;
      connectedOnce = true;
      retry = 0;
      statusCbs.forEach((c) => c(true));
      // Vừa NỐI LẠI (không phải lần đầu) -> pull ngay để bắt kịp thay đổi đã lỡ lúc mất kết nối.
      // (Lần đầu không cần: transport effect bên index.tsx đã pull lúc dựng.)
      if (isReconnect) changeCbs.forEach((c) => c());
    };
    ws.onmessage = () => changeCbs.forEach((c) => c()); // server báo "changed" -> client pull
    ws.onclose = () => {
      statusCbs.forEach((c) => c(false));
      if (!closed) {
        retry = Math.min(retry + 1, 6);
        setTimeout(connect, 500 * 2 ** retry); // backoff reconnect
      }
    };
    ws.onerror = () => {
      try {
        ws?.close();
      } catch {
        /* noop */
      }
    };
  };
  connect();

  const api = async (path: string, opts?: RequestInit) => {
    const res = await fetch(path, opts);
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return res.json();
  };
  const jsonPost = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    push: (item) => api("/api/push", jsonPost(item)) as Promise<SyncResult>,
    pull: (since) => api(`/api/pull?since=${since}`) as Promise<PullResult>,
    notifyChange: () => {}, // server tự broadcast cho các client khác qua WS
    onRemoteChange: (cb) => {
      changeCbs.add(cb);
      return () => changeCbs.delete(cb);
    },
    onStatus: (cb) => {
      statusCbs.add(cb);
      cb(!!ws && ws.readyState === WebSocket.OPEN);
      return () => statusCbs.delete(cb);
    },
    simulateServerEdit: async (ids) => {
      const r = await api("/api/simulate", jsonPost({ ids }));
      return r.changed as number;
    },
    close: () => {
      closed = true;
      try {
        ws?.close();
      } catch {
        /* noop */
      }
    },
  };
};
