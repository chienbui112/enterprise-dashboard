# Enterprise Live Tracking Dashboard

A big-data WebGIS demo with **five dashboards** switchable from a top menu:
- **2D Fleet Tracking** — real-time tracking of **100,000 delivery drivers**, positions updated every **5 seconds**.
- **3D Buildings** — heavy GeoJSON parsing + viewport-filtered **fill-extrusion** of up to **100,000 buildings**.
- **Spatial Analysis** — real-time **Radius Scan** & **Find Nearest** queries against the moving 100k fleet using a `kdbush` index rebuilt every tick in the worker.
- **MotionStream Fleet** — Grab/Uber-style **motion interpolation**: the worker "drips" positions only every **3 seconds**, the main thread tweens each car to **60fps** via `requestAnimationFrame`.
- **Offline Sync** — field-survey **offline-first**: draw points/polygons + notes with no internet, cache the basemap in **IndexedDB**, auto-sync a **queue** on reconnect with **version-based conflict resolution**.

> React 19 · TypeScript · MapLibre GL · Web Worker · kdbush + geokdbush · idb (IndexedDB) · Vite

**Languages:** [English](#english) · [Tiếng Việt](#tiếng-việt)

---

# English

## 1. The Problem

Build a live-tracking dashboard for a large fleet that hits four conflicting goals at once:

| Goal | Challenge |
|------|-----------|
| **Big data** | 100k points on the map without freezing the browser |
| **Real-time** | All 100k positions change every 5 seconds |
| **Cloud cost savings** | No redundant data pulled/pushed over the network |
| **No memory leaks** | Runs for hours without memory growth or GC-induced jank |

**Why it's hard:** the naive approach — recreating 100k GeoJSON objects every tick, deep-cloning them across thread boundaries, then loading everything into the map — overloads the GC (periodic stutter), blocks the main thread on serialization, and overwhelms the GPU.

## 2. Architecture Overview

```
                 Main Thread (UI / React)                         Web Worker
 ┌───────────────────────────────────────────┐        ┌──────────────────────────────┐
 │ ControlPanel  ── toggle filter / stream ──►│        │  Master state (Struct-of-     │
 │                                            │  msg   │  Arrays): Float64Array coords │
 │ MapDashboard  ◄── DATA_UPDATED (Transfer) ─┼────────┤  + Uint8Array status          │
 │   │  build GeoJSON into an object pool     │        │                               │
 │   ▼                                        │  bbox  │  - setInterval 5s: mutate     │
 │ MapContainer ── source.setData() ──► Map   │───────►│    IN PLACE (0 allocations)   │
 │   (MapLibre clusters in its own worker)    │        │  - filter by viewport (bbox)  │
 └───────────────────────────────────────────┘        └──────────────────────────────┘
```

- The **Web Worker** holds the entire "source of truth" of 100k drivers and does all heavy work (data generation, position updates, viewport filtering) — the UI thread stays free to render smoothly.
- The **main thread** only receives the filtered data for the current viewport and pushes it into MapLibre.

## 3. Core Optimization Techniques

### 3.1. Struct-of-Arrays + in-place mutation → eliminate GC churn
Instead of an array of 100k GeoJSON objects, the master state is **flat typed arrays** (`Float64Array` for lng/lat, `Uint8Array` for status). Each 5s tick only adds to coordinates **inside the existing arrays**, with **no new object allocation** → no periodic garbage collection causing jank.

> [`src/utils/geoHelpers.ts`](src/utils/geoHelpers.ts) · [`src/workers/dataParser.worker.ts`](src/workers/dataParser.worker.ts)

### 3.2. Transferable (zero-copy) → no deep-clone across the thread boundary
The worker packs filtered results into `Float32Array`/`Uint8Array`/`Uint32Array` and **transfers ownership of the `ArrayBuffer`** to the main thread. No structured-clone deep copy → no memory doubling, no thread stalls. Coordinates use `Float32` (precise to ~1.4m at city scale) to halve transfer volume.

**Two-pass count-then-pack:** `processAndSend()` walks the 100k drivers **twice** — pass 1 counts how many pass the bbox filter, pass 2 allocates the typed arrays at the **exact size** and packs into them. This is intentionally not `array.push()` + later conversion: a dynamic array would realloc several times and then need an extra copy into a typed array — defeating the transferable. Two tight loops over typed arrays are cheaper than one loop growing a dynamic buffer.

### 3.3. Object pool on the main thread → near-zero allocation per tick
The main thread builds the GeoJSON object set **once**, then **mutates it in place** on subsequent ticks, creating only a new reference array (`slice`) so React/MapLibre detect the change. `id`/`name` (which are never rendered) are replaced by `idx: number`, with strings derived only when actually needed (popup) → avoids creating 100k strings per tick.

> [`src/components/MapContainer/index.tsx`](src/components/MapContainer/index.tsx)

### 3.4. Bbox viewport filter → Cloud cost savings
The worker only sends back points **within the current viewport** (expanded by 20% to prefetch and avoid "pop-in" when panning). In a real system, this is the basis for the backend to push data per viewport instead of the whole fleet → drastically cutting bandwidth and Cloud cost.

### 3.5. Interaction lock (pan/zoom) → free up CPU at the right time
While the user is panning/zooming, the main thread sends `SET_INTERACTING` to the worker; the worker **pauses filtering + data sending** to dedicate CPU to smooth motion, and **flushes immediately** when the user releases.

### 3.6. Clustering → control the number of rendered objects on the GPU
MapLibre clusters up to `clusterMaxZoom: 14`; at low/medium zoom it draws only a few clusters instead of tens of thousands of individual points.

> [`src/components/MapContainer/MapContainer.tsx`](src/components/MapContainer/MapContainer.tsx)

### 3.7. Leak prevention on unmount
`MapContainer` removes all event listeners, closes the popup, and calls `map.remove()`; `MapDashboard` calls `worker.terminate()` on teardown.

### 3.8. Heading + delivery info (ETA)
- Each driver moves toward its **destination**; the worker computes `bearing` (azimuth) every tick and sends it with the data. On the map, drivers are shown as **SDF arrows** rotated by `bearing` (`icon-rotate`) and colored by status (`icon-color`). When a driver reaches its destination (within `ARRIVED_DEG`), the worker assigns it a **fresh random destination** so the fleet stays in continuous motion.
- **Clicking a driver** opens a popup: name, status, position, destination, distance (haversine) and **ETA** (estimated from `AVG_SPEED_KMH`) plus estimated delivery time. A connecting line to the destination is also drawn.
- The popup and connecting line **follow the driver in real time**: on every data tick (or filter change) the selected driver's position, line, and ETA are recomputed. If the selected driver leaves the visible set (panned away / filtered out), the popup is closed automatically.
- Destinations are **static data**, sent **once** by the worker (`INIT_DESTINATIONS`, transferable) so the per-tick payload doesn't bloat; ETA is computed **synchronously on the client** without a worker round-trip.
- **Clicking a cluster** zooms in to break it apart (`getClusterExpansionZoom`).
- The popup uses `closeOnClick: false` (close via the **X** button) so the opening click doesn't immediately close it — preventing the "line flashes then disappears" bug. Closing the popup / selecting another driver cleans up the old line.

## 4. Main ↔ Worker Message Contract

| Direction | Type | Payload |
|-----------|------|---------|
| → Worker | `INIT_DATA` | `{ count, bbox, isBboxFilterActive }` — worker generates the data itself |
| → Worker | `UPDATE_BBOX` | `{ bbox }` — new viewport |
| → Worker | `TOGGLE_FILTER` | `{ isActive }` — toggle viewport filtering |
| → Worker | `SET_STREAMING` | `{ isActive }` — toggle the 5s update stream |
| → Worker | `SET_INTERACTING` | `{ isActive }` — whether panning/zooming |
| Worker → | `INIT_DESTINATIONS` | `{ destCoords }` — static destination coords, sent **once** (transferable) |
| Worker → | `DATA_UPDATED` | `{ count, coords, bearing, status, idx }` (typed arrays, **transferable**) |

## 5. Project Structure

```
src/
├── App.tsx                # Top-level menu switching between the 2D, 3D and Spatial dashboards
├── components/
│   ├── MapLoadingOverlay.tsx     # Shared overlay (pointerEvents:none): 2D uses hasFirstData, 3D/Spatial use isProcessing/hasFirstData
│   ├── MapContainer/             # === 2D Fleet Tracking ===
│   │   ├── index.tsx             # MapDashboard: state, worker orchestration, object pool
│   │   ├── MapContainer.tsx      # MapLibre init, cluster/arrow layers, click → ETA popup
│   │   └── ControlPanel.tsx      # Filter/stream toggles + metrics panel
│   ├── MapDashboard3d/           # === 3D Buildings ===
│   │   ├── index.tsx             # State, worker orchestration, bbox dispatch
│   │   ├── MapContainer3d.tsx    # MapLibre init, fill-extrusion layer, moveend → bbox
│   │   └── ControlPanel3d.tsx    # Load buttons + parse/total/viewport metrics
│   ├── SpatialAnalysis/          # === Spatial Analysis (Radius / Nearest) ===
│   │   ├── index.tsx             # SpatialAnalysisDashboard: worker + kdbush rehydrate + memoized query
│   │   ├── MapContainerSpatial.tsx # MapLibre init, all-drivers + buffer + center + matched layers, popup follow
│   │   └── ControlPanelSpatial.tsx # Mode toggle, R/K sliders, top matches list
│   ├── MotionStream/             # === MotionStream Fleet (RAF interpolation) ===
│   │   ├── index.tsx             # MotionStreamDashboard: worker owner, packetHandlerRef (no React state per tick)
│   │   ├── MapContainerStream.tsx # MapLibre init, idx-keyed Entry pool, RAF lerp loop, per-frame cap + FPS meter
│   │   └── ControlPanelStream.tsx # Interpolation toggle, real FPS, viewport count, over-cap notice
│   └── OfflineSync/              # === Offline Sync (IndexedDB offline-first) ===
│       ├── index.tsx             # OfflineSyncDashboard: db + protocol setup, sync queue, conflict flow, prefetch
│       ├── MapContainerOffline.tsx # Raster style via offline:// protocol, draw point/polygon, status-colored layers
│       └── ControlPanelOffline.tsx # Network toggle, draw mode + note, prefetch, queue/conflict UI
├── workers/
│   ├── dataParser.worker.ts          # 2D: SoA master state, move-toward-destination + bearing, bbox filter, transfer
│   ├── dataParser3d.worker.ts        # 3D: generate + parse master buildings, viewport (bbox) filtering
│   ├── spatialAnalysis.worker.ts     # Spatial: SoA master + per-tick kdbush rebuild + dual-channel broadcast
│   └── motionStream.worker.ts        # MotionStream: SoA master, 3s "drip" tick, viewport subset { coords, bearing, idx }
│   (Offline Sync has no worker — IndexedDB + tile protocol run on the main thread)
└── utils/
    ├── geoHelpers.ts             # 2D types, SoA generation, haversine/bearing, id/name/ETA helpers
    ├── geoHelpers3d.ts           # 3D building types + large-JSON generator
    ├── spatialHelpers.ts         # Hand-rolled buffer circle, kdbush rehydration, around()/distance() wrappers
    ├── interpolationHelper.ts    # lerpCoordinate + computeBearing (used by MotionStream RAF loop)
    ├── indexedDbHelper.ts        # idb: clientId + per-tab local DB & shared DB, OfflineFeature CRUD, tile-cache ops
    ├── tileCacheHelper.ts        # offline:// tile protocol (cache-on-browse) + viewport prefetch + fallback tile
    ├── offlineSyncServer.ts      # Local mode "server": version CAS over the shared IndexedDB DB
    └── syncTransport.ts          # SyncTransport interface + LocalTransport (BroadcastChannel) + RemoteTransport (REST/WS)

server/                          # === Offline Sync "Backend" mode (standalone Node, not bundled) ===
├── index.js                     # Express + ws: /api/push, /api/pull, /api/simulate, WS /ws
└── store.js                     # version store + CAS + seq, persisted to data.json
```

## 6. Running the Project

```bash
npm install
npm run dev      # development (HMR)
npm run build    # production build (tsc -b && vite build)
npm run preview  # preview the build
npm run server   # Offline Sync backend (Express + ws, :3001) — only for the "Backend" sync mode
npm run dev:all  # Vite + backend together (concurrently)
```

In the UI: enable **Real-time SSE Stream** to simulate 5s updates; pan/zoom to watch "Rendered on Screen" and "Network API Hits" change with the viewport.

## 7. Future Work (real production)

- **Backend pushing deltas per viewport** over WebSocket/SSE (instead of the client-side simulation) — sending only changed vehicles, using `source.updateData()` (diff) instead of a full `setData`.
- ETA using actual routing (routing/OSRM) instead of great-circle distance × average speed.
- Lazy-load the `maplibre` chunk if first-load time needs optimizing.

## 8. 3D Buildings Module

A second dashboard ([`src/components/MapDashboard3d/`](src/components/MapDashboard3d/)) demonstrating the same philosophy applied to heavy 3D geometry. Switch to it via the top-center menu.

- **Generation + parse fully in the worker.** Clicking "Load" sends only a `count`; the worker generates a large JSON string (simulating an API payload of up to 100k buildings), `JSON.parse`s it (the heaviest step), and measures the **real** parse time. The main thread stays free → the UI never freezes and the "Parsing…" indicator is accurate. The worker keeps the parsed buildings as its master dataset.
- **Viewport filtering (bbox).** The worker holds all 100k buildings but only sends back those **inside the current viewport** (expanded by 20%) on every `moveend`. So `fill-extrusion` only ever renders the visible subset instead of all 100k extrusions → far lighter on the GPU. Metrics show **Total in Memory** vs **Rendered in Viewport**.
- **Switching modes is leak-safe:** changing dashboards unmounts the other one, which terminates its worker and calls `map.remove()`.

Message contract: `GENERATE_AND_PARSE { count }` and `UPDATE_BBOX { bbox }` → worker replies `GENERATE_DONE { total, parseMs }` and `VISIBLE_DATA { payload }`.

> Note: at very low zoom the viewport may contain most of the dataset, so `fill-extrusion` of ~100k boxes is still inherently GPU-heavy; viewport filtering helps most at normal/close zoom.

## 9. Spatial Analysis Module

A third dashboard ([`src/components/SpatialAnalysis/`](src/components/SpatialAnalysis/)) applies the same worker-owned philosophy to **real-time geospatial queries** at 100k scale. Click anywhere on the map to drop a center point, then pick between two analysis modes:

- **Radius Scan** — every driver within R km of the center (slider 0.5–5 km, step 0.1). A semi-transparent buffer polygon is drawn as visual aid; top-5 nearest matches listed in the side panel.
- **Find Nearest** — the K nearest drivers to the center (slider 1–20). No buffer; full top-K listed.

Matched drivers are highlighted in green over a grey "all drivers" base layer. Click a matched driver to open a popup with its name, status, and live distance — the popup **follows the driver** as it moves and **closes automatically** if the driver falls out of the matched set (e.g. user shrinks the radius slider).

### 9.1. Per-tick kdbush index, rebuilt in the worker
The spatial index ([`kdbush`](https://github.com/mourner/kdbush)) MUST be rebuilt on every 5s tick because every driver moves — a stale tree gives wrong neighbors. Build cost (~30–50 ms for 100k points) runs in the **worker**, and the index's underlying `ArrayBuffer` (`kd.data`) is **transferred zero-copy** to the main thread. The main reconstructs the tree with `KDBush.from(buffer)` in O(1). Queries use [`geokdbush`](https://github.com/mourner/geokdbush)'s `around()` for haversine-correct radius + K-nearest in one API.

### 9.2. Dual-channel broadcast: viewport subset + FULL positions
Unlike 2D, the worker sends **two coordinate channels** per tick:
1. **Viewport-filtered subset** (`coords`/`bearing`/`status`/`idx`) — for rendering the visible dots.
2. **FULL `Float32` positions** of all 100k drivers (`fullLngs`/`fullLats`) — needed to compute distances for matches that lie **outside the current viewport**.

Why both? The kdbush is built over all 100k drivers (so a "Find Nearest" near a viewport edge can return drivers from anywhere), but the rendering only cares about the visible subset. All 7 buffers (`coords`, `bearing`, `status`, `idx`, `fullLngs`, `fullLats`, `kd.data`) are transferred in a **single `postMessage`** call — still zero-copy.

### 9.3. Hand-rolled buffer circle (no Turf)
[`createBufferCircle`](src/utils/spatialHelpers.ts) generates a 64-step polygon using an equirectangular approximation (`dLat = R/111`, `dLng = R/(111·cos(lat))`). At radii of a few km, the error vs. a true geodesic circle is sub-meter — far cheaper than pulling in Turf. (`@turf/turf` is in `package.json` from an earlier iteration but is **not imported anywhere** in `src/` — safe to remove.)

### 9.4. Popup follow + auto-close
`MapContainerSpatial` mirrors the 2D dashboard's `refreshSelection` pattern: a `selectedIdxRef` tracks which matched driver owns the popup, and a `useEffect` keyed on `[matched, driverIndex]` re-positions the popup and recomputes distance on every tick. If the selected driver no longer appears in `matched` (radius shrank, mode toggled, driver moved out), `popup.remove()` is called — its `close` listener resets the selection refs.

Message contract: main→worker `INIT_DATA { count, bbox }`, `UPDATE_BBOX { bbox }`, `SET_STREAMING { isActive }`, `SET_INTERACTING { isActive }`; worker→main `INIT_DESTINATIONS { destCoords }` (sent once, transferable), `DATA_UPDATED { count, coords, bearing, status, idx, fullLngs, fullLats, kdData }` (all 7 buffers transferable). No `TOGGLE_FILTER` — bbox filtering is unconditional for the rendering channel; full-positions are always sent.

## 10. MotionStream Fleet Module (RAF Interpolation)

A fourth dashboard ([`src/components/MotionStream/`](src/components/MotionStream/)) demonstrates how apps like Grab/Uber keep the map silky at 60fps while only receiving driver positions every ~3 seconds (to save bandwidth/Cloud cost). The worker "drips" the viewport subset every **3s**; the main thread **interpolates** each car to fill the ~180 in-between frames.

### 10.1. The drip-vs-render mismatch
The network channel is deliberately slow (1 packet / 3s), but screens refresh at 60Hz. Without interpolation a car would freeze for 3s then teleport. The fix: a `requestAnimationFrame` loop computes `ratio = elapsed / 3000` (0→1) and **lerps** each car from its `last` to its `next` position every frame. Toggle interpolation **off** in the panel to see the raw "0.33 FPS laggy" teleporting behavior for contrast.

### 10.2. idx-keyed interpolation state (the hard part)
The visible subset changes every tick as cars enter/leave the viewport (identified by stable `idx`). The main thread keeps a `Map<idx, Entry>` of **pooled** `Entry` objects (`last`, `next`, cached `bearing`, `seen` tick-stamp, a reused GeoJSON feature). Each 3s tick:
- a car visible last tick → `last` is re-anchored to its **current interpolated position** (NOT the old target — that would make it jump backward), `next` = the new packet position;
- a car newly entering the viewport → **snaps** (`last = next`, stationary one tick) to avoid a wild lerp from a stale origin;
- cars that left → mark-and-swept into a free-list (no GC churn on pan).

Bearing is computed **once per tick** per car (it's constant along a straight lerp segment) and cached — never recomputed in the 60fps loop.

### 10.3. Per-frame `setData` and the cap
Interpolation needs `setData` **every frame** — the opposite of the 2D dashboard's once-per-5s `setData`. Redrawing tens of thousands of rotating symbols per frame janks, so above **8,000** visible cars the dashboard falls back to **snap** (one `setData` per 3s tick, no tween) with hysteresis (re-enables smooth below 7,000) and shows a notice. The RAF loop never stops — it also **measures real FPS** (frame counter published ≤2Hz, replacing the old hard-coded "60"). The symbol layer keeps `icon-allow-overlap`/`icon-ignore-placement: true` (collision off) so the per-frame redraw stays cheap; **no clustering** (smooth individual icons are the whole point). Default zoom ~14 keeps the visible count bounded.

### 10.4. Reuse & wiring
The worker is a 3s-cadence variant of `dataParser.worker.ts` (reuses `generateDriversSoA`, `bearingDeg`, the two-pass count-then-pack and transferables); the RAF loop reuses `lerpCoordinate`/`computeBearing` from [`interpolationHelper.ts`](src/utils/interpolationHelper.ts). The dashboard owns the worker (like the 2D one) and feeds packets to the map via a `packetHandlerRef` callback rather than React state, so the 0.33Hz stream never re-renders the React tree. Map init runs **once** (`[]` deps) and reads `isInterpolating` via a ref — toggling no longer rebuilds the map.

Message contract: main→worker `INIT_DATA { count, bbox }`, `UPDATE_BBOX { bbox }`, `SET_STREAMING { isActive }`, `SET_INTERACTING { isActive }`; worker→main `DATA_UPDATED { count, coords, bearing, idx }` (transferable). Tick = 3000ms (must match the main-thread lerp window); streaming starts on `INIT_DATA`; `idx` is the interpolation key.

## 11. Offline Sync Module (IndexedDB offline-first)

A fifth dashboard ([`src/components/OfflineSync/`](src/components/OfflineSync/)) targets field apps — geological surveyors, forest rangers, disaster rescue, logistics in basements/warehouses — that **lose connectivity entirely**. It must keep the map viewable offline, let users draw/annotate offline, then **auto-sync a queue** with **conflict resolution** when the network returns. This is the only dashboard with **no Web Worker**: the "heavy lifting" is IndexedDB + a custom tile protocol on the main thread.

### 11.1. IndexedDB as a local database (`idb`)
[`indexedDbHelper.ts`](src/utils/indexedDbHelper.ts) opens **two** databases: a **per-tab local DB** `WebGIS_Local_<clientId>` (stores `offline-features` + `tile-cache`) and a **shared DB** `WebGIS_Shared` (stores `server-records` + `meta`). `clientId` is generated per browser tab via `sessionStorage` (`getClientId()`), so **each tab acts as a separate "machine"** (survives reload, dies on tab close). Feature ids use `crypto.randomUUID()` (globally unique, not `Date.now()`), and each feature carries `clientId`, `deleted` (tombstone), `baseVersion`, and `seq`. Every feature is saved **offline-first** with `synced:false` — the local DB is the source of truth, the server is eventually-consistent.

> **Multi-tab sync is live:** the "server" lives in the shared `WebGIS_Shared` DB and tabs notify each other via `BroadcastChannel` — drawing/editing in one tab appears in another, with **genuine** cross-tab conflicts. See §11.6.

### 11.2. Offline map caching (cache-on-browse + prefetch)
The map uses a **raster** style whose tiles route through a custom `offline://` protocol ([`tileCacheHelper.ts`](src/utils/tileCacheHelper.ts) `registerOfflineTileProtocol`). The handler: (1) serves from the IndexedDB `tile-cache` if present; (2) when **online**, fetches the real tile and stores it (**cache-on-browse** — areas you pan over while online are kept); (3) when **offline & uncached**, returns a gray fallback tile. A **"Tải vùng này"** button additionally **prefetches** the whole viewport (current zoom + 1) via slippy-tile math, so a surveyor can pre-load an area before going into the field. (Vector tiles can't be cached this way — the raster style is a requirement.)

### 11.3. Auto-sync queue (pull-then-push) + cross-tab propagation
A `window` `online`/`offline` listener (plus a manual **Go Offline / Go Online** toggle) drives sync. `triggerSync` is **pull-then-push**: it first `pullChanges` from the shared `WebGIS_Shared` "server" (picking up other tabs' changes), then pushes each unsynced local feature ([`offlineSyncServer.ts`](src/utils/offlineSyncServer.ts), 400ms latency), refreshing the UI after each item so "Pending" visibly drains. `pushToServer` runs an atomic version-check **inside one IndexedDB readwrite transaction** (serialized across tabs) and bumps a global `seq`. After pushing, the tab posts on a `BroadcastChannel("offline-sync")`; every other tab pulls `server-records` with `seq > lastSeq` and merges into its local DB — so a point drawn in tab A shows up in tab B. `pullFromServer` is gated on the (simulated) online state — an offline tab can't reach the server even though the shared DB is local. Points are orange while pending, green once synced, red on conflict.

### 11.4. Version-based conflict resolution
Each feature carries a `baseVersion` (the server version it was last based on). The server accepts a push only if its current version equals `baseVersion`; otherwise it returns **conflict** with the server's version + note. Conflicts surface two ways: on push (server moved ahead) **and** on pull (a pulled record's version exceeds a feature you have a pending local edit on). The conflicting feature is flagged `conflict:true` (excluded from the auto-queue), and the panel lets the user **keep mine** (rebase onto the server version, then re-push — overwrites server) or **take server** (adopt the server note). With two tabs you can now produce a **real** conflict: both Go Offline, both edit the same feature, then Go Online one after the other. The **"🧪 simulate a colleague editing"** button (writes the shared server + broadcasts) remains handy for a single-tab conflict demo.

### 11.5. Reuse & wiring
The tile protocol is registered **once** in the dashboard's setup (after opening both IndexedDB databases, before the map mounts — gated on a `ready` state) and removed on unmount; it reads `tileCacheHelper.netState.online` (mirrored from React state) and caches into the **per-tab local DB** so the simulated offline toggle actually blocks tile fetches. Drawing is hand-rolled (no draw library): click to drop points, click vertices then click the first vertex to close a polygon. The shared [`MapLoadingOverlay`](src/components/MapLoadingOverlay.tsx) covers the IndexedDB-open delay.

### 11.6. Multi-machine roadmap
- **Step 0 (done):** foundations — per-tab `clientId` (sessionStorage), `WebGIS_Local_<clientId>` vs `WebGIS_Shared` split, UUID ids, tombstones.
- **Step 1 (done):** real multi-tab sync **without a backend** — server in the shared `WebGIS_Shared` DB (atomic version-check CAS via an IndexedDB readwrite transaction), tabs notified via **`BroadcastChannel`**. Scope: same-origin, same-browser.
- **Step 2 (done):** **Backend mode** (§11.7) — a small Node server makes sync work **across browsers / incognito / machines** on the network, selectable at runtime alongside Local.
- **Step 3 (future):** auth/user identity, production deploy, WebSocket carrying full payloads (instead of "changed" + pull), CRDT (Yjs/Automerge) for true concurrent collaboration.

### 11.7. Backend mode (cross-browser / cross-device)
Both sync modes sit behind a `SyncTransport` interface ([`syncTransport.ts`](src/utils/syncTransport.ts)) — `index.tsx` calls `push`/`pull`/`notifyChange`/`onRemoteChange`, so the version/conflict/merge logic is **identical** regardless of mode; a panel toggle switches **Local (multi-tab)** ↔ **Backend (multi-device)**.
- **`LocalTransport`** wraps the shared-IndexedDB server + `BroadcastChannel` (§11.1–11.5).
- **`RemoteTransport`** talks to a small Node backend in [`server/`](server/) — **Express + `ws`**, version-CAS in [`store.js`](server/store.js), persisted to `server/data.json`. `push`/`pull` are `fetch("/api/...")`; remote changes arrive over a **WebSocket** at `/ws` (the server broadcasts `{type:"changed"}` after every accepted write, and each client then pulls). [`vite.config.ts`](vite.config.ts) proxies `/api` + `/ws` to `localhost:3001` so it's same-origin (no CORS).
- **Run it:** `npm run server` (or `npm run dev:all` for Vite + backend together), then pick **Backend** in the panel. Now Chrome, Firefox, an incognito tab, or another machine on the network all sync against the same server, with the **same** version-based conflict resolution. If the backend is down, the dashboard shows 🔴 and **auto-falls back to Local**.
- **Verified:** opening **two different browsers** in Backend mode syncs drawings/edits between them in real time (WebSocket → pull).
- **Caveats:** dev-time only (relies on the Vite proxy; production would host the server separately). Local and Backend are **separate servers** (shared IndexedDB vs JSON file) — data isn't auto-migrated between modes, so pick a mode up front.

---

# Tiếng Việt

Demo WebGIS dữ liệu lớn gồm **năm dashboard**, chuyển đổi bằng menu trên cùng:
- **2D Fleet Tracking** — theo dõi real-time **100.000 tài xế giao hàng**, vị trí cập nhật mỗi **5 giây**.
- **3D Buildings** — parse GeoJSON nặng + dựng khối **fill-extrusion** lọc theo viewport, tới **100.000 toà nhà**.
- **Spatial Analysis** — truy vấn **Radius Scan** & **Find Nearest** real-time trên đội xe 100k đang chuyển động, dùng `kdbush` index rebuild trong worker mỗi tick.
- **MotionStream Fleet** — **nội suy chuyển động** kiểu Grab/Uber: worker chỉ "nhỏ giọt" tọa độ mỗi **3 giây**, main thread tween từng xe lên **60fps** bằng `requestAnimationFrame`.
- **Offline Sync** — **offline-first** cho khảo sát hiện trường: vẽ điểm/vùng + ghi chú khi mất mạng, cache bản đồ nền vào **IndexedDB**, có mạng lại thì tự đồng bộ **hàng đợi** với **xử lý xung đột theo version**.

## 1. Bài toán

Xây dựng dashboard live-tracking cho đội xe quy mô lớn, đạt đồng thời 4 mục tiêu mâu thuẫn nhau:

| Mục tiêu | Thách thức |
|----------|-----------|
| **Dữ liệu lớn** | 100k điểm trên bản đồ, không được làm đơ trình duyệt |
| **Real-time** | Toàn bộ 100k vị trí đổi mỗi 5 giây |
| **Tiết kiệm chi phí Cloud** | Không kéo/đẩy dữ liệu thừa qua mạng |
| **Không memory leak** | Chạy nhiều giờ liên tục mà bộ nhớ không phình, không giật do GC |

**Vì sao khó:** cách làm ngây thơ — mỗi tick tạo lại 100k object GeoJSON, gửi qua lại giữa các luồng bằng deep-clone, rồi nạp toàn bộ vào bản đồ — sẽ gây quá tải GC (giật định kỳ), nghẽn luồng chính khi serialize, và GPU không kịp vẽ.

## 2. Kiến trúc tổng thể

```
                 Main Thread (UI / React)                         Web Worker
 ┌───────────────────────────────────────────┐        ┌──────────────────────────────┐
 │ ControlPanel  ── toggle filter / stream ──►│        │  Master state (Struct-of-     │
 │                                            │  msg   │  Arrays): Float64Array tọa độ │
 │ MapDashboard  ◄── DATA_UPDATED (Transfer) ─┼────────┤  + Uint8Array status          │
 │   │  dựng GeoJSON vào object pool          │        │                               │
 │   ▼                                        │  bbox  │  - setInterval 5s: mutate     │
 │ MapContainer ── source.setData() ──► Map   │───────►│    TẠI CHỖ (0 cấp phát)       │
 │   (MapLibre clustering trong worker nội bộ)│        │  - lọc theo viewport (bbox)   │
 └───────────────────────────────────────────┘        └──────────────────────────────┘
```

- **Web Worker** giữ toàn bộ "nguồn sự thật" 100k tài xế và xử lý mọi việc nặng (sinh dữ liệu, cập nhật vị trí, lọc theo viewport) — luồng UI luôn rảnh để render mượt.
- **Main thread** chỉ nhận dữ liệu đã lọc của vùng đang nhìn và đẩy vào MapLibre.

## 3. Các kỹ thuật tối ưu cốt lõi

### 3.1. Struct-of-Arrays + mutate tại chỗ → triệt tiêu GC churn
Thay vì mảng 100k object GeoJSON, master state là các **typed array phẳng** (`Float64Array` cho lng/lat, `Uint8Array` cho status). Mỗi tick 5s chỉ cộng dồn tọa độ **ngay trong mảng có sẵn**, **không cấp phát object mới** → không có đợt thu gom rác (GC) định kỳ gây giật.

> [`src/utils/geoHelpers.ts`](src/utils/geoHelpers.ts) · [`src/workers/dataParser.worker.ts`](src/workers/dataParser.worker.ts)

### 3.2. Transferable (zero-copy) → không deep-clone qua biên luồng
Worker đóng gói kết quả lọc vào `Float32Array`/`Uint8Array`/`Uint32Array` rồi **transfer quyền sở hữu `ArrayBuffer`** sang main thread. Không có structured-clone deep-copy → không nhân đôi bộ nhớ, không nghẽn luồng. Tọa độ dùng `Float32` (đủ chính xác ~1.4m ở quy mô thành phố) để giảm một nửa lưu lượng transfer.

**Two-pass count-then-pack:** `processAndSend()` duyệt 100k tài xế **hai lần** — pass 1 đếm số điểm lọt qua bbox, pass 2 cấp phát typed array đúng **kích thước chính xác** rồi pack vào. Cố ý **không** dùng `array.push()` rồi convert sau: mảng động sẽ phải realloc nhiều lần và còn cần copy thêm một lần nữa vào typed array — phá hỏng lợi thế transferable. Hai vòng lặp gọn trên typed array rẻ hơn một vòng tăng trưởng mảng động.

### 3.3. Object pool ở main thread → gần như 0 cấp phát mỗi tick
Main thread dựng tập object GeoJSON **một lần** rồi **mutate tại chỗ** ở các tick sau, chỉ tạo một mảng tham chiếu mới (`slice`) để React/MapLibre nhận biết dữ liệu đổi. `id`/`name` (vốn không được render) được thay bằng `idx: number` và chỉ suy ra chuỗi khi thực sự cần (popup) → tránh tạo 100k chuỗi mỗi tick.

> [`src/components/MapContainer/index.tsx`](src/components/MapContainer/index.tsx)

### 3.4. Bbox viewport filter → tiết kiệm chi phí Cloud
Worker chỉ gửi về các điểm **nằm trong khung nhìn hiện tại** (nới thêm 20% để prefetch, tránh "pop-in" khi pan). Trong hệ thống thật, đây là cơ sở để backend chỉ đẩy dữ liệu theo viewport thay vì toàn bộ đội xe → giảm mạnh băng thông và chi phí Cloud.

### 3.5. Khóa tương tác (pan/zoom) → giải phóng CPU đúng lúc
Khi người dùng đang kéo/zoom, main thread báo `SET_INTERACTING` xuống worker; worker **tạm dừng lọc + gửi dữ liệu** để dành CPU cho hiệu ứng mượt, và **flush ngay** khi thả chuột.

### 3.6. Clustering → kiểm soát số lượng vẽ trên GPU
MapLibre gom cụm tới `clusterMaxZoom: 14`; ở zoom thấp/trung chỉ vẽ vài cụm thay vì hàng chục nghìn điểm rời.

> [`src/components/MapContainer/MapContainer.tsx`](src/components/MapContainer/MapContainer.tsx)

### 3.7. Chống memory leak khi unmount
`MapContainer` gỡ toàn bộ event listener, đóng popup và gọi `map.remove()`; `MapDashboard` gọi `worker.terminate()` khi tháo dỡ.

### 3.8. Hướng di chuyển + thông tin giao hàng (ETA)
- Mỗi tài xế tiến dần về **điểm đến** của mình; worker tính `bearing` (góc phương vị) mỗi tick và gửi kèm dữ liệu. Trên bản đồ, tài xế hiển thị bằng **mũi tên SDF** xoay theo `bearing` (`icon-rotate`) và tô màu theo trạng thái (`icon-color`). Khi một tài xế chạm điểm đến (trong ngưỡng `ARRIVED_DEG`), worker tự cấp **điểm đến mới ngẫu nhiên** để đội xe luôn chuyển động liên tục.
- **Click vào tài xế** mở popup: tên, trạng thái, vị trí, điểm đến, khoảng cách (haversine) và **ETA** (ước tính theo tốc độ trung bình `AVG_SPEED_KMH`) + giờ giao dự kiến. Đồng thời vẽ đường nối tới điểm đến.
- Popup và đường nối **bám theo tài xế real-time**: mỗi tick dữ liệu (hoặc khi đổi filter), vị trí, đường nối và ETA của tài xế đang chọn được tính lại. Nếu tài xế ra khỏi vùng hiển thị (pan đi / bị lọc) thì popup tự đóng.
- Điểm đến là **dữ liệu tĩnh**, worker gửi **một lần** (`INIT_DESTINATIONS`, transferable) nên không làm phình payload mỗi tick; ETA tính **đồng bộ ở client** lúc click, không cần round-trip worker.
- **Click vào cụm** sẽ zoom vào để tách cụm (`getClusterExpansionZoom`).
- Popup dùng `closeOnClick: false` (đóng bằng nút **X**) để chính cú click mở popup không tự đóng nó — tránh lỗi đường nối "lóe lên rồi biến mất". Đóng popup / chọn tài xế khác sẽ tự dọn đường nối cũ.

## 4. Hợp đồng message giữa Main ↔ Worker

| Hướng | Type | Payload |
|-------|------|---------|
| → Worker | `INIT_DATA` | `{ count, bbox, isBboxFilterActive }` — worker tự sinh dữ liệu |
| → Worker | `UPDATE_BBOX` | `{ bbox }` — viewport mới |
| → Worker | `TOGGLE_FILTER` | `{ isActive }` — bật/tắt lọc theo viewport |
| → Worker | `SET_STREAMING` | `{ isActive }` — bật/tắt luồng cập nhật 5s |
| → Worker | `SET_INTERACTING` | `{ isActive }` — đang pan/zoom hay không |
| Worker → | `INIT_DESTINATIONS` | `{ destCoords }` — tọa độ điểm đến tĩnh, gửi **một lần** (transferable) |
| Worker → | `DATA_UPDATED` | `{ count, coords, bearing, status, idx }` (typed array, **transferable**) |

## 5. Cấu trúc thư mục

```
src/
├── App.tsx                # Menu trên cùng chuyển đổi giữa 5 dashboard
├── components/
│   ├── MapLoadingOverlay.tsx     # Overlay loading dùng chung (pointerEvents:none): 2D/Spatial dùng hasFirstData, 3D dùng isProcessing
│   ├── MapContainer/             # === 2D Fleet Tracking ===
│   │   ├── index.tsx             # MapDashboard: quản lý state, điều phối worker, object pool
│   │   ├── MapContainer.tsx      # Khởi tạo MapLibre, layer cluster/mũi tên, click → popup ETA
│   │   └── ControlPanel.tsx      # Toggle filter/stream + bảng metrics
│   ├── MapDashboard3d/           # === 3D Buildings ===
│   │   ├── index.tsx             # Quản lý state, điều phối worker, gửi bbox
│   │   ├── MapContainer3d.tsx    # Khởi tạo MapLibre, layer fill-extrusion, moveend → bbox
│   │   └── ControlPanel3d.tsx    # Nút load + chỉ số parse/tổng/viewport
│   ├── SpatialAnalysis/          # === Spatial Analysis (Radius / Nearest) ===
│   │   ├── index.tsx             # SpatialAnalysisDashboard: worker + rehydrate kdbush + truy vấn memoized
│   │   ├── MapContainerSpatial.tsx # Khởi tạo MapLibre, các layer all-drivers + buffer + center + matched, popup bám driver
│   │   └── ControlPanelSpatial.tsx # Toggle mode, slider R/K, danh sách top kết quả
│   ├── MotionStream/             # === MotionStream Fleet (nội suy RAF) ===
│   │   ├── index.tsx             # MotionStreamDashboard: sở hữu worker, packetHandlerRef (không qua React state mỗi tick)
│   │   ├── MapContainerStream.tsx # Khởi tạo MapLibre, pool Entry theo idx, vòng lặp RAF lerp, cap mỗi frame + đo FPS
│   │   └── ControlPanelStream.tsx # Toggle nội suy, FPS thật, số xe trong viewport, cảnh báo vượt cap
│   └── OfflineSync/              # === Offline Sync (IndexedDB offline-first) ===
│       ├── index.tsx             # OfflineSyncDashboard: setup db + protocol, hàng đợi sync, luồng conflict, prefetch
│       ├── MapContainerOffline.tsx # Style raster qua protocol offline://, vẽ điểm/polygon, layer tô màu theo trạng thái
│       └── ControlPanelOffline.tsx # Toggle mạng, draw mode + ghi chú, prefetch, UI hàng đợi/conflict
├── workers/
│   ├── dataParser.worker.ts          # 2D: master SoA, di chuyển về đích + bearing, lọc bbox, transfer
│   ├── dataParser3d.worker.ts        # 3D: generate + parse master toà nhà, lọc theo viewport (bbox)
│   ├── spatialAnalysis.worker.ts     # Spatial: SoA master + rebuild kdbush mỗi tick + broadcast 2 channel
│   └── motionStream.worker.ts        # MotionStream: master SoA, tick "nhỏ giọt" 3s, subset viewport { coords, bearing, idx }
│   (Offline Sync không có worker — IndexedDB + tile protocol chạy ở main thread)
└── utils/
    ├── geoHelpers.ts             # Kiểu dữ liệu 2D, sinh SoA, haversine/bearing, helper id/name/ETA
    ├── geoHelpers3d.ts           # Kiểu dữ liệu toà nhà 3D + bộ sinh JSON lớn
    ├── spatialHelpers.ts         # Buffer circle tự viết, rehydrate kdbush, wrapper around()/distance()
    ├── interpolationHelper.ts    # lerpCoordinate + computeBearing (vòng lặp RAF của MotionStream dùng)
    ├── indexedDbHelper.ts        # idb: clientId + local DB per-tab & shared DB, CRUD OfflineFeature, thao tác tile-cache
    ├── tileCacheHelper.ts        # Protocol tile offline:// (cache-on-browse) + prefetch viewport + tile fallback
    ├── offlineSyncServer.ts      # "Server" chế độ Local: version CAS trên shared IndexedDB
    └── syncTransport.ts          # Interface SyncTransport + LocalTransport (BroadcastChannel) + RemoteTransport (REST/WS)

server/                          # === Offline Sync chế độ "Backend" (Node độc lập, không bundle) ===
├── index.js                     # Express + ws: /api/push, /api/pull, /api/simulate, WS /ws
└── store.js                     # kho version + CAS + seq, lưu bền ra data.json
```

## 6. Chạy dự án

```bash
npm install
npm run dev      # phát triển (HMR)
npm run build    # build production (tsc -b && vite build)
npm run preview  # xem thử bản build
npm run server   # backend Offline Sync (Express + ws, :3001) — chỉ cho chế độ "Backend"
npm run dev:all  # chạy Vite + backend cùng lúc (concurrently)
```

Trên giao diện: bật **Real-time SSE Stream** để mô phỏng cập nhật 5s; pan/zoom để thấy "Rendered on Screen" và "Network API Hits" đổi theo viewport.

## 7. Hướng phát triển tiếp (production thật)

- **Backend đẩy delta theo viewport** qua WebSocket/SSE (thay cho mô phỏng client-side) — chỉ gửi xe thay đổi, dùng `source.updateData()` (diff) thay cho `setData` toàn phần.
- ETA dùng đường đi thực tế (routing/OSRM) thay cho khoảng cách đường chim bay × tốc độ trung bình.
- Lazy-load chunk `maplibre` nếu cần tối ưu thời gian tải lần đầu.

## 8. Module 3D Buildings

Dashboard thứ hai ([`src/components/MapDashboard3d/`](src/components/MapDashboard3d/)) áp dụng cùng triết lý cho hình học 3D nặng. Chuyển qua lại bằng menu ở giữa trên cùng.

- **Generate + parse hoàn toàn trong worker.** Bấm "Load" chỉ gửi `count`; worker sinh chuỗi JSON lớn (mô phỏng payload API tới 100k toà nhà), `JSON.parse` (bước nặng nhất) và đo **thời gian parse thật**. Main thread rảnh hoàn toàn → UI không bao giờ đơ, chỉ số "Parsing…" hiển thị đúng. Worker giữ lại dữ liệu đã parse làm master.
- **Lọc theo viewport (bbox).** Worker giữ toàn bộ 100k toà nhà nhưng mỗi lần `moveend` chỉ gửi về phần **nằm trong khung nhìn** (nới 20%). Nhờ vậy `fill-extrusion` chỉ vẽ phần đang nhìn thay vì cả 100k khối → nhẹ GPU hơn nhiều. Chỉ số hiển thị **Total in Memory** so với **Rendered in Viewport**.
- **Chuyển mode an toàn (không leak):** đổi dashboard sẽ unmount cái còn lại, kéo theo `worker.terminate()` + `map.remove()`.

Hợp đồng message: `GENERATE_AND_PARSE { count }` và `UPDATE_BBOX { bbox }` → worker trả `GENERATE_DONE { total, parseMs }` và `VISIBLE_DATA { payload }`.

> Lưu ý: ở mức zoom rất xa, viewport có thể chứa gần hết dataset nên `fill-extrusion` ~100k khối vẫn nặng GPU cố hữu; lọc theo viewport phát huy tác dụng nhất ở zoom trung bình/gần.

## 9. Module Spatial Analysis

Dashboard thứ ba ([`src/components/SpatialAnalysis/`](src/components/SpatialAnalysis/)) áp dụng cùng triết lý "worker giữ master state" cho **truy vấn không gian real-time** quy mô 100k. Click bất kỳ vị trí nào trên bản đồ để đặt điểm trung tâm, sau đó chọn 1 trong 2 chế độ phân tích:

- **Radius Scan** — mọi tài xế nằm trong bán kính R km quanh tâm (slider 0.5–5 km, bước 0.1). Vẽ đa giác buffer nửa trong suốt làm vùng tham chiếu; liệt kê top-5 tài xế gần nhất ở panel bên cạnh.
- **Find Nearest** — K tài xế gần điểm trung tâm nhất (slider 1–20). Không vẽ buffer; liệt kê toàn bộ top-K.

Tài xế "matched" được tô màu xanh lá nổi bật trên nền lớp "all drivers" xám. Click vào một driver matched mở popup hiển thị tên, trạng thái, khoảng cách live — popup **bám theo driver** khi nó di chuyển và **tự đóng** nếu driver rơi khỏi tập matched (vd: user giảm slider bán kính).

### 9.1. Index kdbush rebuild mỗi tick trong worker
Spatial index ([`kdbush`](https://github.com/mourner/kdbush)) **bắt buộc** phải rebuild mỗi tick 5s vì mọi driver đã chuyển vị trí — cây cũ stale sẽ trả láng giềng sai. Chi phí build (~30–50 ms cho 100k điểm) chạy trong **worker**, và `ArrayBuffer` của index (`kd.data`) được **transfer zero-copy** sang main thread. Main rehydrate bằng `KDBush.from(buffer)` với độ phức tạp O(1). Truy vấn dùng `around()` của [`geokdbush`](https://github.com/mourner/geokdbush) — chuẩn haversine, dùng chung cho cả Radius và K-nearest trong 1 API.

### 9.2. Broadcast 2 kênh: viewport subset + FULL positions
Khác với 2D, worker gửi **hai kênh tọa độ** mỗi tick:
1. **Subset đã lọc theo viewport** (`coords`/`bearing`/`status`/`idx`) — để render các điểm đang nhìn.
2. **Tọa độ FULL `Float32`** của toàn bộ 100k driver (`fullLngs`/`fullLats`) — cần để tính khoảng cách cho các match **nằm ngoài viewport hiện tại**.

Tại sao cần cả hai? Kdbush dựng trên toàn bộ 100k driver (nên "Find Nearest" gần rìa viewport có thể trả về driver bất kỳ đâu), nhưng việc render chỉ quan tâm subset đang nhìn. Cả 7 buffer (`coords`, `bearing`, `status`, `idx`, `fullLngs`, `fullLats`, `kd.data`) được transfer trong **một `postMessage` duy nhất** — vẫn zero-copy.

### 9.3. Buffer circle tự viết (không dùng Turf)
[`createBufferCircle`](src/utils/spatialHelpers.ts) sinh polygon 64 đỉnh bằng xấp xỉ equirectangular (`dLat = R/111`, `dLng = R/(111·cos(lat))`). Ở bán kính vài km, sai số so với hình tròn geodesic chính xác chỉ ở mức **dưới mét** — rẻ hơn nhiều so với nhập Turf. (`@turf/turf` có trong `package.json` từ phiên bản trước nhưng **không được import ở đâu** trong `src/` — có thể gỡ.)

### 9.4. Popup bám driver + tự đóng
`MapContainerSpatial` áp dụng đúng pattern `refreshSelection` của dashboard 2D: một `selectedIdxRef` theo dõi driver matched nào đang sở hữu popup, và `useEffect` key trên `[matched, driverIndex]` re-position popup + cập nhật distance mỗi tick. Nếu driver đang chọn không còn xuất hiện trong `matched` (radius co lại, đổi mode, driver di chuyển ra), gọi `popup.remove()` — listener `close` sẽ reset các ref selection.

Hợp đồng message: main→worker `INIT_DATA { count, bbox }`, `UPDATE_BBOX { bbox }`, `SET_STREAMING { isActive }`, `SET_INTERACTING { isActive }`; worker→main `INIT_DESTINATIONS { destCoords }` (gửi 1 lần, transferable), `DATA_UPDATED { count, coords, bearing, status, idx, fullLngs, fullLats, kdData }` (cả 7 buffer transferable). Không có `TOGGLE_FILTER` — lọc bbox luôn bật cho kênh render; kênh full-positions gửi vô điều kiện.

## 10. Module MotionStream Fleet (Nội suy RAF)

Dashboard thứ tư ([`src/components/MotionStream/`](src/components/MotionStream/)) minh hoạ cách các app như Grab/Uber giữ bản đồ mượt 60fps trong khi chỉ nhận tọa độ tài xế mỗi ~3 giây (tiết kiệm băng thông/chi phí Cloud). Worker "nhỏ giọt" subset trong viewport mỗi **3s**; main thread **nội suy** từng xe để bù ~180 khung hình ở giữa.

### 10.1. Lệch nhịp giữa "nhỏ giọt" và render
Kênh mạng cố ý chậm (1 gói / 3s), nhưng màn hình quét 60Hz. Không nội suy thì xe đứng yên 3s rồi nhảy vọt. Cách xử lý: vòng lặp `requestAnimationFrame` tính `ratio = elapsed / 3000` (0→1) và **lerp** từng xe từ `last` tới `next` mỗi frame. Tắt toggle nội suy trên panel để thấy hành vi thô "0.33 FPS giật cục" nhảy vọt, đối chứng.

### 10.2. State nội suy theo idx (phần khó nhất)
Subset hiển thị đổi mỗi tick khi xe vào/ra viewport (định danh bằng `idx` ổn định). Main giữ `Map<idx, Entry>` các `Entry` **pooled** (`last`, `next`, `bearing` cache, tick-stamp `seen`, feature GeoJSON tái dùng). Mỗi tick 3s:
- xe đã hiển thị tick trước → `last` re-anchor về **vị trí lerp hiện tại** (KHÔNG phải target cũ — sẽ giật lùi), `next` = vị trí gói mới;
- xe mới vào viewport → **snap** (`last = next`, đứng yên 1 tick) để tránh lerp loạn từ origin cũ;
- xe rời đi → mark-and-sweep vào free-list (không GC churn khi pan).

Bearing tính **1 lần/tick** mỗi xe (const theo đoạn lerp thẳng) và cache — không recompute trong vòng 60fps.

### 10.3. `setData` mỗi frame và cap
Nội suy cần `setData` **mỗi frame** — ngược với 2D dashboard chỉ `setData` mỗi 5s. Vẽ lại hàng chục nghìn symbol xoay mỗi frame sẽ giật, nên vượt **8.000** xe trong viewport thì dashboard fallback **snap** (1 `setData` mỗi tick 3s, không tween) với hysteresis (bật lại mượt dưới 7.000) và hiện cảnh báo. Vòng lặp RAF không bao giờ dừng — nó còn **đo FPS thật** (đếm frame publish ≤2Hz, thay cho số "60" cứng cũ). Layer symbol giữ `icon-allow-overlap`/`icon-ignore-placement: true` (tắt collision) để vẽ lại mỗi frame còn rẻ; **không clustering** (icon mượt riêng lẻ là mục đích chính). Zoom mặc định ~14 giữ visible count bị giới hạn.

### 10.4. Tái sử dụng & wiring
Worker là biến thể cadence-3s của `dataParser.worker.ts` (reuse `generateDriversSoA`, `bearingDeg`, two-pass count-then-pack, transferable); vòng lặp RAF reuse `lerpCoordinate`/`computeBearing` từ [`interpolationHelper.ts`](src/utils/interpolationHelper.ts). Dashboard sở hữu worker (như bản 2D) và đẩy packet vào map qua callback `packetHandlerRef` thay vì React state, nên luồng 0.33Hz không bao giờ re-render cây React. Map init chạy **1 lần** (`[]` deps) và đọc `isInterpolating` qua ref — toggle không còn rebuild map.

Hợp đồng message: main→worker `INIT_DATA { count, bbox }`, `UPDATE_BBOX { bbox }`, `SET_STREAMING { isActive }`, `SET_INTERACTING { isActive }`; worker→main `DATA_UPDATED { count, coords, bearing, idx }` (transferable). Tick = 3000ms (phải khớp lerp window bên main); stream bật từ `INIT_DATA`; `idx` là khóa nội suy.

## 11. Module Offline Sync (IndexedDB offline-first)

Dashboard thứ năm ([`src/components/OfflineSync/`](src/components/OfflineSync/)) hướng tới ứng dụng hiện trường — kỹ sư khảo sát địa chất, kiểm lâm đi rừng, cứu hộ thiên tai, logistics trong tầng hầm/kho — nơi **mất hoàn toàn kết nối**. Yêu cầu: vẫn xem được bản đồ offline, vẽ/ghi chú offline, rồi khi có mạng lại **tự đồng bộ hàng đợi** kèm **xử lý xung đột**. Đây là dashboard duy nhất **không có Web Worker**: phần nặng là IndexedDB + custom tile protocol chạy ở main thread.

### 11.1. IndexedDB làm Local Database (`idb`)
[`indexedDbHelper.ts`](src/utils/indexedDbHelper.ts) mở **hai** database: **local DB per-tab** `WebGIS_Local_<clientId>` (store `offline-features` + `tile-cache`) và **shared DB** `WebGIS_Shared` (store `server-records` + `meta`). `clientId` sinh per-tab qua `sessionStorage` (`getClientId()`), nên **mỗi tab là một "máy" riêng** (sống qua reload, mất khi đóng tab). Id feature dùng `crypto.randomUUID()` (toàn cục, không phải `Date.now()`); mỗi feature mang `clientId`, `deleted` (tombstone), `baseVersion`, `seq`. Mọi feature lưu **offline-first** với `synced:false` — local DB là nguồn sự thật, server là eventually-consistent.

> **Đồng bộ đa-tab đã chạy:** "server" nằm trong shared DB `WebGIS_Shared`, các tab báo nhau qua `BroadcastChannel` — vẽ/sửa ở tab này hiện ở tab kia, có conflict cross-tab **thật**. Xem §11.6.

### 11.2. Cache bản đồ offline (cache-on-browse + prefetch)
Map dùng style **raster**, tile đi qua custom protocol `offline://` ([`tileCacheHelper.ts`](src/utils/tileCacheHelper.ts) `registerOfflineTileProtocol`). Handler: (1) có trong `tile-cache` thì serve ngay; (2) đang **online** thì fetch tile thật + lưu lại (**cache-on-browse** — vùng nào pan qua lúc online được giữ); (3) **offline & chưa cache** thì trả tile xám fallback. Nút **"Tải vùng này"** còn **prefetch** cả viewport (zoom hiện tại + 1) bằng slippy-tile math, để khảo sát viên tải sẵn vùng trước khi vào rừng. (Vector tile không cache kiểu này được — style raster là bắt buộc.)

### 11.3. Hàng đợi tự đồng bộ (pull-trước-push) + lan truyền cross-tab
Lắng nghe `online`/`offline` của `window` (kèm toggle **Go Offline / Go Online**) điều khiển sync. `triggerSync` theo thứ tự **pull-trước-push**: `pullChanges` từ "server" trong shared DB `WebGIS_Shared` (nhận thay đổi của tab khác) rồi đẩy từng feature chưa sync ([`offlineSyncServer.ts`](src/utils/offlineSyncServer.ts), trễ 400ms), refresh UI sau mỗi item nên "Pending" giảm dần. `pushToServer` kiểm version nguyên tử **trong 1 readwrite transaction của IndexedDB** (serialize giữa các tab) và tăng `seq` toàn cục. Sau khi push, tab phát `BroadcastChannel("offline-sync")`; mọi tab khác pull `server-records` có `seq > lastSeq` và merge vào local DB — nên điểm vẽ ở tab A hiện ở tab B. `pullFromServer` bị gate theo trạng thái online (giả lập) — tab offline không "với" tới server dù shared DB nằm local. Điểm cam khi chờ, xanh khi đã sync, đỏ khi conflict.

### 11.4. Xử lý xung đột theo version
Mỗi feature mang `baseVersion` (version server mà bản local dựa trên). Server chỉ chấp nhận push nếu version hiện tại bằng `baseVersion`; ngược lại trả **conflict** kèm version + note phía server. Conflict phát hiện ở 2 chỗ: lúc push (server đã đi trước) **và** lúc pull (record kéo về có version vượt một feature đang sửa-dở của bạn). Feature bị đánh dấu `conflict:true` (loại khỏi hàng đợi), panel cho **Giữ bản của tôi** (rebase rồi đẩy lại — ghi đè server) hoặc **Lấy bản server** (nhận note server). Với 2 tab giờ tạo được conflict **thật**: cả 2 Go Offline, cùng sửa 1 feature, rồi Go Online lần lượt. Nút **"🧪 Giả lập đồng nghiệp sửa"** (ghi vào shared server + broadcast) vẫn tiện cho demo conflict 1-tab.

### 11.5. Tái sử dụng & wiring
Tile protocol đăng ký **1 lần** trong setup của dashboard (sau khi mở cả 2 IndexedDB, trước khi map mount — gate bằng state `ready`) và gỡ khi unmount; nó đọc `tileCacheHelper.netState.online` (mirror từ React state) và cache vào **local DB per-tab** nên toggle offline giả lập thực sự chặn fetch tile. Vẽ là hand-rolled (không thêm thư viện draw): click để chấm điểm; click các đỉnh rồi click lại đỉnh đầu để đóng polygon. [`MapLoadingOverlay`](src/components/MapLoadingOverlay.tsx) dùng chung che lúc đang mở IndexedDB.

### 11.6. Lộ trình đa-máy
- **Bước 0 (xong):** nền tảng — `clientId` per-tab (sessionStorage), tách `WebGIS_Local_<clientId>` vs `WebGIS_Shared`, id UUID, tombstone.
- **Bước 1 (xong):** đồng bộ đa-tab **không cần backend** — server trong shared DB `WebGIS_Shared` (CAS kiểm version nguyên tử bằng 1 readwrite transaction) + báo qua **`BroadcastChannel`**. Phạm vi: same-origin, same-browser.
- **Bước 2 (xong):** **chế độ Backend** (§11.7) — một Node server nhỏ giúp sync **xuyên trình duyệt / ẩn danh / đa máy** qua mạng, chọn được lúc chạy song song với Local.
- **Bước 3 (tương lai):** auth/định danh người dùng, deploy production, WebSocket gửi nguyên payload (thay vì "changed" rồi pull), CRDT (Yjs/Automerge) cho cộng tác đồng thời.

### 11.7. Chế độ Backend (xuyên trình duyệt / đa máy)
Cả 2 chế độ nằm sau interface `SyncTransport` ([`syncTransport.ts`](src/utils/syncTransport.ts)) — `index.tsx` chỉ gọi `push`/`pull`/`notifyChange`/`onRemoteChange`, nên logic version/conflict/merge **y hệt** ở cả 2 chế độ; toggle trên panel đổi **Local (đa-tab)** ↔ **Backend (đa-máy)**.
- **`LocalTransport`** bọc server-IndexedDB-chung + `BroadcastChannel` (§11.1–11.5).
- **`RemoteTransport`** nói chuyện với Node backend nhỏ trong [`server/`](server/) — **Express + `ws`**, version-CAS trong [`store.js`](server/store.js), lưu bền ra `server/data.json`. `push`/`pull` là `fetch("/api/...")`; thay đổi từ máy khác về qua **WebSocket** `/ws` (server broadcast `{type:"changed"}` sau mỗi ghi, client tự pull). [`vite.config.ts`](vite.config.ts) proxy `/api` + `/ws` sang `localhost:3001` (cùng origin, không CORS).
- **Chạy:** `npm run server` (hoặc `npm run dev:all` để chạy kèm Vite), rồi chọn **Backend** trên panel. Lúc này Chrome, Firefox, tab ẩn danh, hay máy khác trong mạng đều sync chung một server, với **cùng** cơ chế conflict theo version. Backend chết → panel báo 🔴 và **tự fallback về Local**.
- **Đã kiểm chứng:** mở **2 trình duyệt khác nhau** ở chế độ Backend → vẽ/sửa ở bên này hiện sang bên kia theo thời gian thực (WebSocket → pull).
- **Lưu ý:** chỉ chạy ở môi trường dev (dựa vào Vite proxy; production phải host server riêng). Local và Backend là **2 server tách biệt** (IndexedDB chung vs file JSON) — không tự migrate dữ liệu, nên chọn chế độ từ đầu.
