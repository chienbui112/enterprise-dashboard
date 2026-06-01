import React, { useState, useEffect, useRef } from "react";
import { type Map } from "maplibre-gl";
import { type IDBPDatabase } from "idb";
import { ControlPanelOffline } from "./ControlPanelOffline";
import { MapContainerOffline, type DrawMode } from "./MapContainerOffline";
import { MapLoadingOverlay } from "../MapLoadingOverlay";
import {
  openLocalDb,
  openSharedDb,
  getClientId,
  saveFeatureOffline,
  getAllFeatures,
  getFeature,
  getUnsyncedFeatures,
  upsertLocal,
  markAsSynced,
  markConflict,
  updateNote,
  markDeleted,
  resolveConflict,
  countCachedTiles,
  type OfflineFeature,
  type OfflineGeometry,
} from "../../utils/indexedDbHelper";
import { setTileDb, registerOfflineTileProtocol, unregisterOfflineTileProtocol, prefetchViewport, netState } from "../../utils/tileCacheHelper";
import { type ServerRecord } from "../../utils/offlineSyncServer";
import { createLocalTransport, createRemoteTransport, type SyncTransport, type SyncMode } from "../../utils/syncTransport";

const defaultNote = (kind: "point" | "polygon") => (kind === "point" ? "Điểm khảo sát" : "Vùng khảo sát");

const serverRecToFeature = (rec: ServerRecord): OfflineFeature => ({
  type: "Feature",
  id: rec.id,
  geometry: rec.geometry,
  properties: {
    id: rec.id,
    clientId: rec.clientId,
    kind: rec.kind,
    note: rec.note,
    createdAt: rec.updatedAt,
    updatedAt: rec.updatedAt,
    deleted: rec.deleted,
    synced: true,
    baseVersion: rec.version,
    seq: rec.seq,
    conflict: false,
  },
});

const mergeServerIntoLocal = (local: OfflineFeature, rec: ServerRecord): OfflineFeature => ({
  ...local,
  geometry: rec.geometry,
  properties: {
    ...local.properties,
    note: rec.note,
    deleted: rec.deleted,
    updatedAt: rec.updatedAt,
    synced: true,
    baseVersion: rec.version,
    seq: rec.seq,
    conflict: false,
    serverVersion: undefined,
    serverNote: undefined,
  },
});

export const OfflineSyncDashboard: React.FC = () => {
  const [ready, setReady] = useState<boolean>(false);
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const [mode, setMode] = useState<SyncMode>("local");
  const [backendConnected, setBackendConnected] = useState<boolean>(false);
  const [clientId, setClientId] = useState<string>("");
  const [features, setFeatures] = useState<OfflineFeature[]>([]);
  const [drawMode, setDrawMode] = useState<DrawMode>("point");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState<string>("");
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [cachedTiles, setCachedTiles] = useState<number>(0);
  const [prefetch, setPrefetch] = useState<{ done: number; total: number } | null>(null);
  const [hint, setHint] = useState<string>("");

  const localDbRef = useRef<IDBPDatabase | null>(null);
  const sharedDbRef = useRef<IDBPDatabase | null>(null);
  const clientIdRef = useRef<string>("");
  const mapApiRef = useRef<Map | null>(null);
  const syncingRef = useRef<boolean>(false);
  const lastSeqRef = useRef<number>(0);
  const transportRef = useRef<SyncTransport | null>(null);
  const pullRef = useRef<(() => Promise<void>) | null>(null);
  const triggerRef = useRef<(() => Promise<void>) | null>(null);

  const refresh = async () => {
    const db = localDbRef.current;
    if (db) setFeatures(await getAllFeatures(db));
  };

  // Backend lỗi -> tự fallback về Local (vẫn dùng được, chỉ trong 1 trình duyệt).
  const fallbackToLocal = () => {
    setHint("⚠️ Backend mất kết nối — tạm chuyển về chế độ Local.");
    setMode("local");
  };

  // Pull thay đổi từ "server" (qua transport) -> merge vào local DB.
  const pullFromServer = async () => {
    const localDb = localDbRef.current;
    const t = transportRef.current;
    if (!localDb || !t || !netState.online) return;

    let res;
    try {
      res = await t.pull(lastSeqRef.current);
    } catch {
      if (mode === "backend") fallbackToLocal();
      return;
    }
    const { changed, maxSeq } = res;
    if (changed.length) {
      let fromOther = false;
      for (const rec of changed) {
        const local = await getFeature(localDb, rec.id);
        if (!local) {
          await upsertLocal(localDb, serverRecToFeature(rec));
          if (rec.clientId !== clientIdRef.current) fromOther = true;
        } else if (!local.properties.synced && rec.version > local.properties.baseVersion) {
          await markConflict(localDb, rec.id, rec.version, rec.note);
          fromOther = true;
        } else if (local.properties.synced) {
          await upsertLocal(localDb, mergeServerIntoLocal(local, rec));
          if (rec.clientId !== clientIdRef.current) fromOther = true;
        }
      }
      await refresh();
      if (fromOther) setHint("↻ Vừa nhận cập nhật từ máy khác.");
    }
    lastSeqRef.current = Math.max(lastSeqRef.current, maxSeq);
  };
  pullRef.current = pullFromServer;

  // Đồng bộ: PULL trước rồi PUSH hàng đợi; xong thì pull lại (chốt seq) + notify.
  const triggerSync = async () => {
    const localDb = localDbRef.current;
    const t = transportRef.current;
    if (!localDb || !t || !netState.online || syncingRef.current) return;
    syncingRef.current = true;
    setIsSyncing(true);
    try {
      await pullFromServer();
      const queue = await getUnsyncedFeatures(localDb);
      let pushed = false;
      for (const item of queue) {
        let res;
        try {
          res = await t.push(item);
        } catch {
          if (mode === "backend") fallbackToLocal();
          break;
        }
        if (res.status === "ok") {
          await markAsSynced(localDb, item.id, res.version, res.seq);
          pushed = true;
        } else {
          await markConflict(localDb, item.id, res.serverVersion, res.serverNote);
        }
        await refresh();
      }
      if (pushed) {
        await pullFromServer(); // chốt lastSeq + áp lại bản mình vừa đẩy (idempotent)
        t.notifyChange(); // báo các client khác
      }
    } finally {
      syncingRef.current = false;
      setIsSyncing(false);
    }
  };
  triggerRef.current = triggerSync;

  // Setup: clientId per-tab, mở 2 DB, tile-cache vào local DB, protocol offline.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cid = getClientId();
      clientIdRef.current = cid;
      setClientId(cid);
      const localDb = await openLocalDb(cid);
      const sharedDb = await openSharedDb();
      if (cancelled) return;
      localDbRef.current = localDb;
      sharedDbRef.current = sharedDb;
      setTileDb(localDb);
      await registerOfflineTileProtocol();
      setFeatures(await getAllFeatures(localDb));
      setCachedTiles(await countCachedTiles(localDb));
      setReady(true);
    })();

    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    const countTimer = setInterval(async () => {
      const db = localDbRef.current;
      if (db) setCachedTiles(await countCachedTiles(db));
    }, 2000);

    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      clearInterval(countTimer);
      unregisterOfflineTileProtocol();
    };
  }, []);

  // Dựng transport theo mode; đổi mode -> đóng cũ, mở mới, hydrate từ "server" mới.
  useEffect(() => {
    if (!ready) return;
    const sharedDb = sharedDbRef.current;
    if (mode === "local" && !sharedDb) return;

    const t = mode === "local" ? createLocalTransport(sharedDb!) : createRemoteTransport();
    transportRef.current = t;
    const offChange = t.onRemoteChange(() => pullRef.current?.());
    const offStatus = t.onStatus((c) => setBackendConnected(c));

    lastSeqRef.current = 0; // server mới -> pull lại từ đầu
    (async () => {
      await pullRef.current?.();
      if (netState.online) await triggerRef.current?.();
    })();

    return () => {
      offChange();
      offStatus();
      t.close();
      transportRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, mode]);

  // Mạng Online -> pull + push.
  useEffect(() => {
    netState.online = isOnline;
    if (isOnline) triggerRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

  const addFeature = async (geometry: OfflineGeometry, kind: "point" | "polygon") => {
    const db = localDbRef.current;
    if (!db) return;
    const id = crypto.randomUUID();
    const now = Date.now();
    const f: OfflineFeature = {
      type: "Feature",
      id,
      geometry,
      properties: {
        id,
        clientId: clientIdRef.current,
        kind,
        note: draftNote.trim() || defaultNote(kind),
        createdAt: now,
        updatedAt: now,
        deleted: false,
        synced: false,
        baseVersion: 0,
        seq: 0,
        conflict: false,
      },
    };
    await saveFeatureOffline(db, f);
    await refresh();
    setSelectedId(id);
    if (netState.online) triggerSync();
  };

  const handleCreatePoint = (coords: [number, number]) => addFeature({ type: "Point", coordinates: coords }, "point");
  const handleCreatePolygon = (ring: [number, number][]) => addFeature({ type: "Polygon", coordinates: [ring] }, "polygon");

  const handleSaveNote = async (note: string) => {
    const db = localDbRef.current;
    if (!db || !selectedId) return;
    await updateNote(db, selectedId, note);
    await refresh();
    if (netState.online) triggerSync();
  };

  const handleDelete = async () => {
    const db = localDbRef.current;
    if (!db || !selectedId) return;
    await markDeleted(db, selectedId);
    setSelectedId(null);
    await refresh();
    if (netState.online) triggerSync();
  };

  const handleResolve = async (id: string, choice: "local" | "server") => {
    const db = localDbRef.current;
    if (!db) return;
    await resolveConflict(db, id, choice);
    await refresh();
    if (netState.online) triggerSync();
  };

  const handleSimulateServerEdit = async () => {
    const t = transportRef.current;
    if (!t) return;
    const ids = features.filter((f) => f.properties.synced && !f.properties.deleted).map((f) => f.id);
    const n = await t.simulateServerEdit(ids);
    if (n > 0) t.notifyChange();
    setHint(
      n > 0
        ? `🧪 Server vừa đổi ${n} bản ghi. Sửa ghi chú một điểm đã sync rồi Sync để thấy CONFLICT (hoặc client khác sẽ tự nhận bản mới).`
        : "Chưa có bản ghi đã sync nào để giả lập server sửa.",
    );
  };

  const handlePrefetch = async () => {
    const map = mapApiRef.current;
    const db = localDbRef.current;
    if (!map || !db) return;
    setPrefetch({ done: 0, total: 0 });
    const { total } = await prefetchViewport(map, (done, t) => setPrefetch({ done, total: t }));
    setCachedTiles(await countCachedTiles(db));
    setHint(`📥 Đã tải sẵn ${total} tile của vùng này. Giờ có thể Go Offline và vẫn xem được khu vực này.`);
    setTimeout(() => setPrefetch(null), 1200);
  };

  const visible = features.filter((f) => !f.properties.deleted);
  const pending = visible.filter((f) => !f.properties.synced && !f.properties.conflict);
  const conflicts = visible.filter((f) => f.properties.conflict);
  const syncedCount = visible.filter((f) => f.properties.synced).length;
  const selected = visible.find((f) => f.id === selectedId) ?? null;

  return (
    <div style={{ display: "flex", width: "100vw", height: "100vh", overflow: "hidden" }}>
      <ControlPanelOffline
        clientId={clientId}
        mode={mode}
        setMode={setMode}
        backendConnected={backendConnected}
        isOnline={isOnline}
        toggleNetwork={() => setIsOnline((p) => !p)}
        drawMode={drawMode}
        setDrawMode={setDrawMode}
        draftNote={draftNote}
        setDraftNote={setDraftNote}
        queueCount={pending.length}
        syncedCount={syncedCount}
        cachedTiles={cachedTiles}
        isSyncing={isSyncing}
        prefetch={prefetch}
        conflicts={conflicts}
        selected={selected}
        hint={hint}
        onForceSync={triggerSync}
        onPrefetch={handlePrefetch}
        onSimulateServerEdit={handleSimulateServerEdit}
        onSaveNote={handleSaveNote}
        onDelete={handleDelete}
        onResolve={handleResolve}
        onClearSelection={() => setSelectedId(null)}
      />
      <div style={{ flex: 1, position: "relative", height: "100vh" }}>
        {ready ? (
          <MapContainerOffline
            features={visible}
            drawMode={drawMode}
            selectedId={selectedId}
            onCreatePoint={handleCreatePoint}
            onCreatePolygon={handleCreatePolygon}
            onSelectFeature={setSelectedId}
            mapApiRef={mapApiRef}
          />
        ) : (
          <MapLoadingOverlay visible label="Mở Local Database (IndexedDB)..." />
        )}
      </div>
    </div>
  );
};
