# Enterprise Live Tracking Dashboard

A big-data WebGIS demo with **nine dashboards** switchable from a top menu:
- **2D Fleet Tracking** — real-time tracking of **100,000 delivery drivers**, positions updated every **5 seconds**.
- **3D Buildings** — heavy GeoJSON parsing + viewport-filtered **fill-extrusion** of up to **100,000 buildings**.
- **Spatial Analysis** — real-time **Radius Scan** & **Find Nearest** queries against the moving 100k fleet using a `kdbush` index rebuilt every tick in the worker.
- **MotionStream Fleet** — Grab/Uber-style **motion interpolation**: the worker "drips" positions only every **3 seconds**, the main thread tweens each car to **60fps** via `requestAnimationFrame`.
- **Offline Sync** — field-survey **offline-first**: draw points/polygons + notes with no internet, cache the basemap in **IndexedDB**, auto-sync a **queue** on reconnect with **version-based conflict resolution**.
- **Route Optimizer** — Traveling-Salesman delivery routing for 20 points: **OSRM** road-distance matrix + real road geometry, solved in a Worker via **Nearest Neighbor → 2-opt → Held-Karp** (provably optimal), drawn as **multi-modal** GPU line layers.
- **Geofence Monitor** — real-time **geofencing** of **50,000 vehicles** against **1,000 arbitrary polygons** nationwide (Vietnam): a **spatial-grid → bbox → Turf point-in-polygon** filter pipeline in a Worker, firing **Enter/Exit** alerts only on a state change (no log storm).
- **History Playback** — **time-travel** replay of **5,000 vehicles** over a 5-minute (**300s**) window: the whole history is one flat **space-time cube** (`Float32Array`, O(1) seek), scrubbed at 60fps with **RAF interpolation**, while a **spatial-hash grid** flags every pair of vehicles closer than **5 m** (collision risk) each frame. Includes a **ruler tool** to measure the distance between two vehicles while paused.
- **3D Flood Digital Twin** — a flood digital twin driven by a **custom WebGL/GLSL shader**: a rising water level (from an **IoT WebSocket** feed or a slider, pushed straight into a GPU uniform without re-rendering React) submerges a 3D city. Choose the city source — synthetic buildings, **MapTiler** real OpenMapTiles 3D buildings, or **Google Photorealistic 3D Tiles** (deck.gl) — with optional **DEM terrain**, plus trees/barriers via **instanced rendering**.

> React 19 · TypeScript · MapLibre GL · Web Worker · kdbush + geokdbush · Turf.js · idb (IndexedDB) · OSRM (routing) · deck.gl + loaders.gl (3D Tiles) · custom WebGL/GLSL · Vite

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
│   ├── OfflineSync/              # === Offline Sync (IndexedDB offline-first) ===
│   │   ├── index.tsx             # OfflineSyncDashboard: db + protocol setup, sync queue, conflict flow, prefetch
│   │   ├── MapContainerOffline.tsx # Raster style via offline:// protocol, draw point/polygon, status-colored layers
│   │   └── ControlPanelOffline.tsx # Network toggle, draw mode + note, prefetch, queue/conflict UI
│   ├── RouteOptimizer/           # === Route Optimizer (TSP / delivery routing) ===
│   │   ├── index.tsx             # RouteOptimizerDashboard: /table → Worker(matrix) → /route → draw, refs + fallback
│   │   ├── MapContainerTsp.tsx   # MapLibre init, points + 2 multi-modal line layers + NN compare overlay (imperative refs)
│   │   └── ControlPanelTsp.tsx   # Optimize/regenerate, distance+time, NN→2-opt→Held-Karp chain, legend, source
│   ├── Geofencing/               # === Geofence Monitor (50k vehicles vs 1000 polygons) ===
│   │   ├── index.tsx             # GeofencingDashboard: worker owner, renderHandlerRef (no buffer in state), alert log
│   │   ├── MapContainerGeofence.tsx # MapLibre init, fitBounds, GPU circle layer (data-driven red), polygon fill/outline
│   │   └── ControlPanelGeofence.tsx # Monitoring + speed slider, stats, grid-efficiency box, live Enter/Exit alert log
│   ├── HistoryPlayback/          # === History Playback (5k vehicles × 300s replay) ===
│   │   ├── index.tsx             # HistoryPlaybackDashboard: cube via worker, play/seek state, alert + measure wiring
│   │   ├── MapContainerPlayback.tsx # MapLibre init, RAF interpolation loop, per-frame proximity grid, warning + ruler layers
│   │   └── ControlPanelPlayback.tsx # Timeline slider + play/speed, live stats (ⓘ tooltips), ruler tool, collision log
│   └── FloodSim/                 # === 3D Flood Digital Twin (custom WebGL shader + DEM + 3D Tiles) ===
│       ├── index.tsx             # FloodSimDashboard: scene worker, waterRef (uniform bypass), scene-source/terrain/basemap state
│       ├── MapContainerFlood.tsx # MapLibre init, custom water + instanced layers, DEM setTerrain, deck.gl overlay, basemap setStyle
│       └── ControlPanelFlood.tsx # Scene-source + basemap toggles, DEM, water slider/storm, IoT mode + chips, scene metrics
├── workers/
│   ├── dataParser.worker.ts          # 2D: SoA master state, move-toward-destination + bearing, bbox filter, transfer
│   ├── dataParser3d.worker.ts        # 3D: generate + parse master buildings, viewport (bbox) filtering
│   ├── spatialAnalysis.worker.ts     # Spatial: SoA master + per-tick kdbush rebuild + dual-channel broadcast
│   ├── motionStream.worker.ts        # MotionStream: SoA master, 3s "drip" tick, viewport subset { coords, bearing, idx }
│   ├── tspSolver.worker.ts           # Route Optimizer: pure matrix solver — Nearest Neighbor → 2-opt → Held-Karp (exact)
│   ├── geofence.worker.ts            # Geofence Monitor: 50k SoA + 1000 polygons, spatial grid + bbox + Turf PiP, state cache
│   ├── playbackHistory.worker.ts     # History Playback: one-shot generator of the 5k×301 space-time cube (transferable)
│   └── floodSim.worker.ts            # Flood Twin: one-shot generator of synthetic buildings (JSON) + tree/barrier instance arrays
│   (Offline Sync has no worker — IndexedDB + tile protocol run on the main thread)
└── utils/
    ├── geoHelpers.ts             # 2D types, SoA generation, haversine/bearing, id/name/ETA helpers
    ├── floodHelpers.ts          # Flood Twin: GLSL water/props shaders, mesh + scene generators, GL program helpers
    ├── floodLayers.ts           # Flood Twin: FloodWaterLayer + InstancedPropsLayer (CustomLayerInterface)
    ├── floodSensorFeed.ts       # Flood Twin: IoT water-level WebSocket client + backoff + client-side simulator fallback
    ├── google3dTiles.ts         # Flood Twin: deck.gl Tile3DLayer + MapboxOverlay for Google Photorealistic 3D Tiles
    ├── geofenceHelpers.ts       # Geofence: clustered vehicle/polygon generation + buildSpatialGrid (uniform grid index)
    ├── geoHelpers3d.ts           # 3D building types + large-JSON generator
    ├── spatialHelpers.ts         # Hand-rolled buffer circle, kdbush rehydration, around()/distance() wrappers
    ├── interpolationHelper.ts    # lerpCoordinate + computeBearing (used by MotionStream RAF loop)
    ├── indexedDbHelper.ts        # idb: clientId + per-tab local DB & shared DB, OfflineFeature CRUD, tile-cache ops
    ├── tileCacheHelper.ts        # offline:// tile protocol (cache-on-browse) + viewport prefetch + fallback tile
    ├── offlineSyncServer.ts      # Local mode "server": version CAS over the shared IndexedDB DB
    ├── syncTransport.ts          # SyncTransport interface + LocalTransport (BroadcastChannel) + RemoteTransport (REST/WS)
    ├── osrmHelper.ts             # Route Optimizer: OSRM /table + /route wrappers, haversine fallback matrix, mode assign
    ├── routeApiHelper.ts         # Route Optimizer: delivery-point generator + synthetic per-leg polyline (fallback)
    └── playbackHelpers.ts        # History Playback: space-time cube generator + O(1) frame index + ProximityDetector (hash grid)

server/                          # === Standalone Node backend (not bundled): Offline Sync + Flood IoT ===
├── index.js                     # Express + ws: /api/push, /api/pull, /api/simulate; routes WS /ws (sync) + /ws-sensors (IoT)
├── store.js                     # Offline Sync: version store + CAS + seq, persisted to data.json
└── sensorFeed.js                # Flood Twin: /ws-sensors WebSocketServer broadcasting water-level readings (~500ms)
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
- ETA using actual routing (routing/OSRM) instead of great-circle distance × average speed — now realized in the **Route Optimizer** dashboard (§12).
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
- **Resilient WebSocket:** auto-reconnects with exponential backoff (1s→2s→…→32s cap, retries forever until the transport is closed); on **reconnect** it immediately triggers a `pull` so changes missed while disconnected are caught up at once (idempotent via the `seq` cursor). While down, the panel shows 🔴.
- **Verified:** opening **two different browsers** in Backend mode syncs drawings/edits between them in real time (WebSocket → pull).
- **Caveats:** dev-time only (relies on the Vite proxy; production would host the server separately). Local and Backend are **separate servers** (shared IndexedDB vs JSON file) — data isn't auto-migrated between modes, so pick a mode up front.

## 12. Route Optimizer Module (TSP / delivery routing)

A sixth dashboard ([`src/components/RouteOptimizer/`](src/components/RouteOptimizer/)) solves the **Traveling Salesman Problem** for 20 random delivery points around Hanoi: find the visiting order that minimizes total travel. It reuses the worker-owned, imperative-bridge philosophy — the algorithm runs in a Web Worker, all geometry lives in `useRef`, and only the final ordered result reaches React state.

### 12.1. Real road routing (OSRM), not great-circle
Earlier iterations faked both the cost (haversine) and the drawn line (a sine-bent polyline) — so the route ignored the actual street network. Now two OSRM calls (public demo server `router.project-osrm.org`, `driving` profile) make it real:
- **`/table`** returns the N×N **road** distance + duration matrix in milliseconds (Contraction Hierarchies). This is what the TSP optimizes on — not straight-line distance.
- **`/route`** (`geometries=geojson`, `steps=true`) returns the detailed road geometry of the optimized order in **one** request; per-leg geometry is rebuilt by concatenating each leg's step geometries.

Both calls go straight from the browser (no backend needed) and **fall back gracefully** — if OSRM is unreachable/rate-limited the dashboard rebuilds a haversine matrix and a synthetic polyline, mirroring the project's auto-fallback ethos (Offline Sync → Local, tiles → gray). The panel reports which source was used.

> [`src/utils/osrmHelper.ts`](src/utils/osrmHelper.ts) · [`src/utils/routeApiHelper.ts`](src/utils/routeApiHelper.ts)

### 12.2. Three TSP algorithms, run in sequence (each ≤ the previous)
The worker is a **pure matrix solver**: the main thread hands it the cost matrix; it never sees coordinates.
- **Nearest Neighbor** (greedy, O(N²)): from the depot, always hop to the nearest unvisited point. <1ms, ~25% above optimal — used as a starting tour.
- **2-opt** (local search, O(N²)/pass): removes crossing edges by reversing the segment between two edges; accepts a swap when `D(a,c)+D(b,d) − D(a,b) − D(c,d) < 0`. A few ms, ~2–5% above optimal (a *local* minimum).
- **Held-Karp** (dynamic programming, O(N²·2ᴺ)) when N ≤ 20: `dp[mask][j]` = min cost from the depot visiting exactly set `mask`, ending at `j`. **Provably optimal**. At N=20 the table is a `Float32Array` of ~84MB and takes ~1–2s — affordable in the worker (off the UI thread). N>20 skips it and keeps the 2-opt result.

So `nnKm ≥ twoOptKm ≥ exactKm`, shown as an improvement chain on the panel with a "✓ optimal" badge. Because Held-Karp is tractable at N=20, a Genetic Algorithm is unnecessary at this scale (it pays off only at larger N or with extra constraints → VRP).

> [`src/workers/tspSolver.worker.ts`](src/workers/tspSolver.worker.ts)

### 12.3. Multi-modal rendering + NN comparison overlay
The route source is a `FeatureCollection` of per-leg `LineString`s, each tagged with a `mode`. Two line layers render it because **`line-dasharray` is not data-driven in MapLibre** — you can't vary the dash per-feature via an expression. So a solid green layer (`mode == "ride"`, motorbike) and a dashed blue layer (`mode == "walk"`, short "into the alley" legs) are filtered by the property. (The OSRM demo only has a car profile, so the mode split is **illustrative** — geometry is always the driving route.)

Ticking **"overlay Nearest Neighbor"** draws the raw NN tour as **straight** dashed-red lines connecting the points in NN order. Straight (not road-snapped) on purpose: 2-opt/Held-Karp exist to untie *crossing* edges, and straight segments make those crossings visible against the optimal route below.

> [`src/components/RouteOptimizer/MapContainerTsp.tsx`](src/components/RouteOptimizer/MapContainerTsp.tsx) · [`ControlPanelTsp.tsx`](src/components/RouteOptimizer/ControlPanelTsp.tsx) · [`index.tsx`](src/components/RouteOptimizer/index.tsx)

Flow: **`/table` → Worker(matrix) → `/route` → draw**. The orchestrator keeps the matrices, leg geometry, and NN overlay coords in refs; only the final ordered list + total distance/time goes to React state.

## 13. Geofence Monitor Module (real-time geofencing at scale)

A seventh dashboard ([`src/components/Geofencing/`](src/components/Geofencing/)) monitors **50,000 vehicles** moving across **all of Vietnam** and raises an instant alert whenever a vehicle **enters** or **exits** any of **1,000 arbitrarily-shaped restricted zones (polygons)**. The worker owns the entire dataset and runs the whole detection pipeline; the main thread only renders the viewport subset as a GPU circle layer.

### 13.1. Why a naive check explodes — and the spatial grid that fixes it
The obvious approach — test every vehicle against every polygon every tick — is `50,000 × 1,000 = 50,000,000` point-in-polygon checks per tick. That melts the worker. The fix is a **three-layer filter pipeline** ([`geofence.worker.ts`](src/workers/geofence.worker.ts), [`geofenceHelpers.ts`](src/utils/geofenceHelpers.ts)):

- **Layer 0 — Spatial grid index.** `buildSpatialGrid` lays a uniform grid (~0.3° cells) over the country bbox and hashes each polygon into **every cell its bbox touches**. At query time a vehicle maps to exactly **one** cell and only considers the handful of polygons registered there → complexity drops from `O(vehicles × allZones)` to `O(vehicles × zonesPerCell)`. **This is the change that makes the larger area tractable.**
- **Layer 1 — Bounding box (algebra).** For each candidate polygon, a cheap `xmin ≤ x ≤ xmax && ymin ≤ y ≤ ymax` test (precomputed `zoneBboxFlat`). Still needed because a polygon's bbox can spill into a neighbouring grid cell.
- **Layer 2 — Turf `booleanPointInPolygon`.** Only the survivors of Layers 0+1 hit the exact geometry test ([Turf.js](https://turfjs.org/)); the coordinate is passed as a raw `[lng, lat]` array (no per-call object allocation).

### 13.2. State cache — alert on the *transition*, not the *condition*
A raw typed array `Int16Array zoneOf` (one slot per vehicle, value = current zone id, `-1` = outside everything) is the **previous-state cache** — deliberately **not** React state. Each tick the worker compares the freshly-computed zone against `zoneOf[i]`: an **Enter** fires only on `outside → inside`, an **Exit** only on `inside → outside`. A vehicle sitting still *inside* a zone for a thousand ticks produces **zero** repeat alerts. A `primed` flag makes tick 0 a silent baseline so vehicles that spawn already inside a zone don't all fire a false "enter".

### 13.3. Rendering, clustering of motion, and the speed control
Vehicles are spawned in **clusters around 12 Vietnam city anchors** (weighted by size) and each roams within `ROAM_RADIUS` of its "home", so the fleet stays on land and keeps crossing zones (instead of drifting uniformly into the sea). They render as a **GPU `circle` layer** with **data-driven color** — `["case", ["==", ["get","v"], 1], red, blue]` — so violators turn red without per-feature JS. The render channel reuses the project's viewport-filtered **two-pass count-then-pack** + transferables, plus a `Uint8Array violating` flag. A **speed slider** sends `SET_SPEED { factor }` to scale movement live (drag to **0** to freeze — detection keeps running but no new transitions occur). On load the map `fitBounds` to the country bbox.

### 13.4. Panel metrics — what each value means
The control panel ([`ControlPanelGeofence.tsx`](src/components/Geofencing/ControlPanelGeofence.tsx)) shows:

| Metric | Meaning |
|--------|---------|
| **Xe đang vi phạm** (Vehicles violating) | **Instantaneous** count of vehicles currently inside any zone (`zoneOf[i] !== -1`), over the *whole* fleet — not just the viewport. Goes up and down. |
| **Xe trong viewport** (Vehicles in viewport) | How many vehicles fall inside the current map view — i.e. how many dots are actually drawn this tick (the bbox-filtered render subset). |
| **Tổng lượt VÀO (Enter)** | **Running total** (only ever increases) of `outside → inside` transitions since monitoring started. A *flow* counter — how many border-crossings into zones have happened, not how many vehicles are inside now. |
| **Tổng lượt RA (Exit)** | Same, for `inside → outside` transitions. Tracks Enter closely over time (every entry is eventually followed by an exit); Enter usually leads slightly because some vehicles are still inside. |
| **Turf PiP checks/tick** | Number of `booleanPointInPolygon` calls executed in the **most recent tick** — i.e. how many vehicles survived Layers 0+1 and needed the exact test. This is the **performance proof**: it's typically a few thousand, vs. the 50,000,000 a brute-force scan would do. Fluctuates per tick with how many vehicles are near zones. |
| **Simulation ticks** | How many worker ticks have run. Each tick is **250 ms** (4 Hz), so `ticks × 0.25 s` ≈ elapsed monitoring time. Stops incrementing if you pause monitoring. |
| **Cảnh báo trực tiếp** header | `(N events · showing 80 latest)` — `N` is the true running total (`Enter + Exit`); the scrollable list is capped at the **80 most recent** rows so the panel stays light. The list length sitting at 80 is the cap, not the event count. |

Message contract: main→worker `INIT_DATA { count, geofenceCount, bbox }`, `UPDATE_BBOX { bbox }`, `SET_STREAMING { isActive }`, `SET_INTERACTING { isActive }`, `SET_SPEED { factor }`; worker→main `GEOFENCES_READY { geojson }` (polygons, sent once), `DATA_UPDATED { count, coords, violating, idx, totalViolating, pipCount, alerts }` (typed arrays transferable; `alerts` = transitions only), and `ALERTS_ONLY { alerts, totalViolating, pipCount }` (emitted **during** pan/zoom so monitoring never pauses). Detection runs over all vehicles regardless of viewport; only the render channel is bbox-filtered.

## 14. History Playback Module (time-series replay + proximity detection)

An eighth dashboard ([`src/components/HistoryPlayback/`](src/components/HistoryPlayback/)) leaves the live-streaming theme behind and tackles **historical replay**: scrub back and forth through the recorded movement of **5,000 vehicles** over a **300-second** window, and automatically surface every pair of vehicles that came **closer than 5 m** (collision risk) at any instant. The heavy data generation runs in a worker; the interactive replay + detection run on the main thread at 60fps.

### 14.1. Space-time data structure (RAM-optimal, O(1) seek)
A naive `Vehicle[][]` (one array of objects per second) would be **millions of objects** — RAM blowup and constant GC. Instead the entire history is **one flat `Float32Array` "space-time cube"** ([`playbackHelpers.ts`](src/utils/playbackHelpers.ts)) laid out `[frame][vehicle][lng,lat]` with `offset(t,i) = t*stride + i*2` (`stride = count*2`):
- the vehicle id **is** its array index `i` (stable across every frame) → no id is stored;
- the frame for second `t` is a **zero-copy `subarray` view** onto the same buffer, so the required `Map<timestamp, frame>` ([`buildFrameIndex`](src/utils/playbackHelpers.ts)) gives **O(1)** seek with **zero extra allocation**;
- total footprint: 5k × 301 × 2 × 4 B ≈ **12 MB** for the whole history, generated once in [`playbackHistory.worker.ts`](src/workers/playbackHistory.worker.ts) and **transferred zero-copy** (not structured-cloned).

Each vehicle is generated as a flowing "traffic" trajectory (heading + speed, small per-second steering, reflecting off the region bounds) inside a compact ~3.5 km × 2.8 km neighbourhood so density is high enough that pairs genuinely pass within 5 m — the near-misses are emergent, not scripted.

### 14.2. Playback controller (60fps RAF interpolation)
The timeline runs 0→300 s. A `requestAnimationFrame` loop ([`MapContainerPlayback.tsx`](src/components/HistoryPlayback/MapContainerPlayback.tsx)) advances `time += dt × speed` and **linearly interpolates** each vehicle between the two adjacent integer-second frames, pushing to MapLibre via `source.setData()` — so motion stays smooth at 60fps regardless of playback speed (1×–60×). The slider is two-way: the RAF loop publishes the current time back to React **throttled** (~16 Hz) so the dashboard never re-renders per frame; dragging the slider uses a **`seekNonce` token** so RAF-driven updates don't trigger a re-seek loop (the project's ref-for-prop pattern). Vehicles render as a GPU `circle` layer with data-driven colour — red when a vehicle is in a near-collision, cyan otherwise — via an object pool (no per-frame allocation).

### 14.3. Proximity detection — spatial hash grid (no O(N²))
Comparing all pairs is `5000 × 4999 / 2 ≈ 12.5 M` checks **per frame** — impossible at 60fps. [`ProximityDetector`](src/utils/playbackHelpers.ts) instead hashes vehicles into a **uniform grid whose cell size equals the 5 m threshold**: two vehicles can only be within 5 m if they share a cell or a neighbouring one, so each vehicle is compared only against the **9 surrounding cells** (and only `j > i` to avoid double-counting). This collapses to ~O(N) at even density. Bucket arrays are recycled via a free-list and the per-vehicle `cellIdx` is reused, so after warm-up the detector allocates **almost nothing per frame**. The detector runs **every frame on the interpolated positions**, so the warning circles track exactly what's drawn. A near-collision is logged only when a pair **newly** comes within range (a transition, like the geofence Enter cache) so the list doesn't flood; each hit also draws an **amber-halo + red-core** warning circle at the pair's midpoint.

### 14.4. Ruler tool (measure distance while paused)
Toggling **📏 Thước đo** pauses playback (so vehicles are frozen for an accurate read) and turns clicks into a measurement: click two vehicles to draw a dashed-yellow line between them (lime endpoint A, orange endpoint B) with a live distance label (`haversine`, shown in m or km) both on the map and in the panel. Clicking a third vehicle starts a new pair. The measurement also re-draws while you scrub the slider, so you can compare the same pair's distance at different moments. (The selected pair is tracked in refs; nothing per-frame reaches React state while playing.)

### 14.5. Panel metrics — what each value means
The control panel ([`ControlPanelPlayback.tsx`](src/components/HistoryPlayback/ControlPanelPlayback.tsx)) shows (hover the ⓘ for an inline tooltip):

| Value | Meaning |
|-------|---------|
| **Timeline `mm:ss / mm:ss`** + **speed (1×–60×)** | Current position within the 300 s window / total. Speed = **history-seconds played per real-second** (10× ⇒ the full 300 s plays in 30 s). Dragging the slider seeks to any second in **O(1)** (zero-copy view into the cube). |
| **Cặp đang va chạm gần** (Pairs in near-collision) | **Instantaneous** count of vehicle pairs currently within 5 m **at the exact displayed frame**. Rises and falls as you play; `0` means no collision risk at that moment. |
| **Tổng sự kiện đã ghi** (Total events logged) | **Running total** (only increases) of times a **new** pair came within range — counted on the *onset* of proximity, not re-counted every frame the pair stays close. Only grows while playing; scrubbing by hand emits nothing. |
| **Phép so cặp / frame** (Pair comparisons / frame) | The number of distance comparisons the spatial grid **actually** ran this frame (only vehicles in the same or neighbouring cells). This is the **performance proof**: typically a few thousand vs. the ~12.5 M an O(N²) sweep would do. |
| **FPS** | Real measured framerate of the RAF loop (published ~2 Hz). Target 60 — it measures interpolation **+** per-frame proximity detection **+** `setData`, all together. |
| **Thời gian dựng cube** (Cube build time) | How long the Worker took to generate the entire space-time cube (5,000 × 301 frames) **once** on open, before transferring it zero-copy. After that, scrubbing costs no further generation. |
| **Spatial grid** box | Restates *pair comparisons/frame* against the brute-force `N²/2` figure — the live efficiency ratio of the grid. |
| **Thước đo** readout | When the ruler is on: the two selected vehicles + their distance (m/km). Shown only while paused. |

Message contract: main→worker `GENERATE { count, frames }`; worker→main `GENERATED { cube, count, frames, stride, genMs }` (the `cube` `ArrayBuffer` is **transferable**). Unlike the other workers this one is **stateless and one-shot** — no `setInterval`, no bbox, no fetching: it generates the cube once and the main thread owns playback + detection thereafter (closest in spirit to Offline Sync's main-thread work, but with a worker for the heavy generation step).

## 15. 3D Flood Digital Twin Module (custom WebGL shader + DEM + 3D Tiles)

A ninth dashboard ([`src/components/FloodSim/`](src/components/FloodSim/)) is a flood **digital twin**: a 3D city whose streets and building bases are submerged by a rising water level driven in real time from IoT sensors. Unlike every other dashboard it drops **below MapLibre's style API into raw GLSL**, via two `CustomLayerInterface` layers sharing the map's GL context.

### 15.1. The custom water shader (the centerpiece)
[`FloodWaterLayer`](src/utils/floodLayers.ts) is a **flat translucent plane** held at `u_levelZ` (water altitude, metres → mercator). The wave look is done **entirely in the fragment shader** (sum-of-sines colour + moving specular), computed from **real-world metres** (`v_local = (a_pos − u_origin) / u_meter`) so the wavelength is fixed in world space and looks identical at every zoom. The plane is a single large quad covering the view; it's drawn last with `depthMask(false)` + alpha blend so it reads the building/terrain depth and submerges anything below the level, with `gl.POLYGON_OFFSET_FILL(0, −4)` (**constant bias only**, slope factor 0) to win the far-field z-fight against the ground without climbing walls at oblique pitch. Buildings render fully opaque so the depth is clean. See [§ the GLSL in `floodHelpers.ts`](src/utils/floodHelpers.ts).

### 15.2. The slider bypasses React (uniform-driven)
Water level lives in a `useRef<{ meters }>` **shared object** handed to both WebGL layers at construction. The uncontrolled `<input type=range>`'s `onChange` mutates `waterRef.current.meters` and updates the thumb + numeric label via **DOM refs** — never React state — so dragging pushes the value straight into the GPU uniform **without re-rendering the map**. A real 0–5 m flood against 100 m towers is an imperceptibly thin sheet, so the water-plane altitude (and the props' underwater-tint threshold) are multiplied by `FLOOD_VIS_SCALE` (×4, **vertical exaggeration** — the slider still reads real metres).

### 15.3. Instanced rendering (trees + rescue barriers)
[`InstancedPropsLayer`](src/utils/floodLayers.ts) draws thousands of trees (trunk box + 2 cones) and barriers (box + reflective stripe) via **`drawArraysInstanced`** (WebGL2) / `ANGLE_instanced_arrays` (WebGL1 fallback): one shared base-mesh VBO + a small per-instance VBO (`[mercX, mercY, scale, rot]`, 16 B/instance), so VRAM stays flat regardless of count. Parts of a prop below the water level are tinted blue ("underwater").

### 15.4. Three scene sources (toggle on the panel)
- **🏙️ Synthetic** — buildings (`fill-extrusion`) + instanced props generated one-shot in [`floodSim.worker.ts`](src/workers/floodSim.worker.ts).
- **🗼 MapTiler** — **real** 3D buildings from MapTiler **OpenMapTiles vector** tiles via native MapLibre `fill-extrusion` on the `building` layer (`render_height`/`render_min_height`) — *not* deck.gl/3D-Tiles (`v3-openmaptiles/tiles.json` is a vector tileset). Needs a MapTiler key; the key is **origin-restricted**, so a 403 means the origin isn't allowlisted at cloud.maptiler.com.
- **🌍 Google** — **OGC Photorealistic 3D Tiles** via deck.gl `Tile3DLayer` + `@deck.gl/mapbox` `MapboxOverlay({ interleaved: true })` ([`google3dTiles.ts`](src/utils/google3dTiles.ts)), sharing the depth buffer so the water still floods by real elevation. Needs the **Map Tiles API enabled** on the Google Cloud project or the tileset 403s. deck.gl + loaders.gl are isolated in a lazy `deckgl` vendor chunk.

Both real-world sources hide the synthetic buildings/props. Keys are overridable via `VITE_MAPTILER_KEY` / `VITE_GOOGLE_3D_TILES_KEY`.

### 15.5. DEM terrain + IoT WebSocket feed
- **DEM** — a `raster-dem` Terrarium source (public, no key) + `map.setTerrain` so the flood follows real ground elevation; applies to **Synthetic & MapTiler** (Google supplies its own terrain).
- **IoT feed** — in "📡 Cảm biến IoT" mode a WebSocket ([`floodSensorFeed.ts`](src/utils/floodSensorFeed.ts) → `/ws-sensors`, served by [`server/sensorFeed.js`](server/sensorFeed.js)) streams water-level readings every ~500 ms into the same uniform path; it reconnects with backoff and **auto-falls back to a client-side simulator** when the backend is down (so `npm run dev` still works). A **separate** `/ws-sensors` path (its own `WebSocketServer`) keeps it from colliding with Offline Sync's `/ws`.

### 15.6. Panel values — what each control/metric means
The control panel ([`ControlPanelFlood.tsx`](src/components/FloodSim/ControlPanelFlood.tsx)):

| Control / value | Meaning |
|-----------------|---------|
| **Nguồn cảnh 3D** (Scene source) — 🏙️ Synthetic / 🗼 MapTiler / 🌍 Google | Picks what renders the 3D city: generated boxes, real MapTiler vector buildings, or Google photorealistic 3D Tiles (§15.4). Switching hides/shows the relevant layers. |
| **Địa hình DEM thật** checkbox (Synthetic/MapTiler) | Toggles real terrain (`raster-dem`); when on, the flood waterline follows ground elevation instead of a flat z=0. |
| **Phóng đại** ×N (terrain) | Vertical exaggeration of the DEM terrain mesh (Hanoi is flat, so this makes relief visible). Pure display scale. |
| **3D Tiles status chip** (Google) | `Sẵn sàng` (idle) → `Đang tải…` (loading) → `đã tải` (ready) / `Lỗi tải tiles` (error — usually the Map Tiles API isn't enabled). |
| **Bản đồ nền** (Basemap) — 🌑 Tối / ☀️ Sáng / 🗺️ Voyager | Switches the Carto base style (dark / light / streets). Triggers `map.setStyle()`, after which all custom layers/terrain/overlay are rebuilt automatically. |
| **Nguồn mực nước** (Water source) — 📡 IoT / ✋ Thủ công | IoT = the WebSocket sensor feed drives the level (slider read-only); Manual = you control the slider + storm. |
| **Feed status chip** (IoT mode) | `LIVE` (green, real sensor) / `SIMULATED` (amber, no backend → client simulator) / `CONNECTING`, plus the station id. |
| **Mức độ ngập lụt: X.X m** + slider (0–5 m) | The flood water level in **real metres** — pushed straight into the `u_water_level` GPU uniform (no React re-render). Rendered altitude is ×4 (visual exaggeration) so the rise is visible; the number is the true metres. |
| **🌊 Mô phỏng bão về (0 → 5m)** button | A scripted "storm": ramps the level slowly 0→5 m (Manual mode only). |
| **Toà nhà (fill-extrusion)** | Count of synthetic buildings in the scene (the generated GeoJSON feature count). |
| **Cây xanh (instanced)** | Count of tree instances drawn by the instanced layer (one shared mesh). |
| **Rào chắn (instanced)** | Count of rescue-barrier instances drawn by the instanced layer. |
| **Worker sinh cảnh** | Time (ms) the worker took to generate the whole synthetic scene **once** (building JSON + prop arrays), before transferring it. |
| **Tổng vật thể props** | trees + barriers — the total instance count fed to the GPU from a single mesh upload (the "instancing" headline figure). |
| **↻ Sinh lại bản sao số đô thị** button | Regenerates the synthetic scene (new random buildings/props). |

Message contracts: **IoT** server→client on a **separate** `/ws-sensors` path — `{ type:"sensor", stationId, level, ts }` every ~500 ms (`level` 0–5 m). **Scene worker** ([`floodSim.worker.ts`](src/workers/floodSim.worker.ts)) main→worker `GENERATE { buildingCount, treeCount, barrierCount }`; worker→main `SCENE_READY { buildings, trees, barriers, genMs }` (`buildings` structured-cloned, `trees`/`barriers` transferable). A deep architecture analysis (3D Tiles/HLOD trade-offs, DEM, instancing at scale) lives in [`docs/flood-architecture.md`](docs/flood-architecture.md).

---

# Tiếng Việt

Demo WebGIS dữ liệu lớn gồm **chín dashboard**, chuyển đổi bằng menu trên cùng:
- **2D Fleet Tracking** — theo dõi real-time **100.000 tài xế giao hàng**, vị trí cập nhật mỗi **5 giây**.
- **3D Buildings** — parse GeoJSON nặng + dựng khối **fill-extrusion** lọc theo viewport, tới **100.000 toà nhà**.
- **Spatial Analysis** — truy vấn **Radius Scan** & **Find Nearest** real-time trên đội xe 100k đang chuyển động, dùng `kdbush` index rebuild trong worker mỗi tick.
- **MotionStream Fleet** — **nội suy chuyển động** kiểu Grab/Uber: worker chỉ "nhỏ giọt" tọa độ mỗi **3 giây**, main thread tween từng xe lên **60fps** bằng `requestAnimationFrame`.
- **Offline Sync** — **offline-first** cho khảo sát hiện trường: vẽ điểm/vùng + ghi chú khi mất mạng, cache bản đồ nền vào **IndexedDB**, có mạng lại thì tự đồng bộ **hàng đợi** với **xử lý xung đột theo version**.
- **Route Optimizer** — định tuyến giao hàng theo bài toán Người bán hàng (TSP) cho 20 điểm: ma trận khoảng cách **đường thật từ OSRM** + hình học đường thật, giải trong Worker bằng **Nearest Neighbor → 2-opt → Held-Karp** (tối ưu tuyệt đối), vẽ bằng **line layer đa phương thức** trên GPU.
- **Geofence Monitor** — **giám sát vùng cấm** real-time cho **50.000 xe** trên **toàn Việt Nam** với **1.000 polygon hình thù bất kỳ**: pipeline lọc **spatial-grid → bbox → Turf point-in-polygon** trong Worker, chỉ phát cảnh báo **Enter/Exit** khi trạng thái đổi (không bão log).
- **History Playback** — **tua lại lịch sử** di chuyển của **5.000 xe** trong cửa sổ 5 phút (**300s**): toàn bộ lịch sử là một **khối không-thời gian** phẳng (`Float32Array`, truy xuất O(1)), tua mượt 60fps bằng **nội suy RAF**, đồng thời mỗi frame một **spatial-hash grid** đánh dấu mọi cặp xe cách nhau dưới **5 m** (nguy cơ va chạm). Kèm **thước đo** khoảng cách giữa 2 xe khi tạm dừng.
- **3D Flood Digital Twin** — bản sao số mô phỏng ngập lụt bằng **custom WebGL/GLSL shader**: mực nước dâng (từ feed **IoT qua WebSocket** hoặc slider, bơm thẳng vào uniform GPU mà không re-render React) nhấn chìm thành phố 3D. Chọn nguồn cảnh: nhà giả lập, **MapTiler** (nhà OpenMapTiles thật), hoặc **Google Photorealistic 3D Tiles** (deck.gl) — kèm **địa hình DEM** tuỳ chọn, cây/rào dùng **Instanced Rendering**.

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
├── App.tsx                # Menu trên cùng chuyển đổi giữa 6 dashboard
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
│   ├── OfflineSync/              # === Offline Sync (IndexedDB offline-first) ===
│   │   ├── index.tsx             # OfflineSyncDashboard: setup db + protocol, hàng đợi sync, luồng conflict, prefetch
│   │   ├── MapContainerOffline.tsx # Style raster qua protocol offline://, vẽ điểm/polygon, layer tô màu theo trạng thái
│   │   └── ControlPanelOffline.tsx # Toggle mạng, draw mode + ghi chú, prefetch, UI hàng đợi/conflict
│   ├── RouteOptimizer/           # === Route Optimizer (TSP / định tuyến giao hàng) ===
│   │   ├── index.tsx             # RouteOptimizerDashboard: /table → Worker(matrix) → /route → vẽ, refs + fallback
│   │   ├── MapContainerTsp.tsx   # Khởi tạo MapLibre, điểm + 2 line layer đa phương thức + overlay so sánh NN (refs imperative)
│   │   └── ControlPanelTsp.tsx   # Nút tối ưu/tạo điểm, quãng đường+thời gian, chuỗi NN→2-opt→Held-Karp, chú giải, nguồn
│   ├── Geofencing/               # === Geofence Monitor (50k xe vs 1000 polygon) ===
│   │   ├── index.tsx             # GeofencingDashboard: sở hữu worker, renderHandlerRef (không đẩy buffer vào state), log alert
│   │   ├── MapContainerGeofence.tsx # Khởi tạo MapLibre, fitBounds, layer circle GPU (đỏ data-driven), fill/outline polygon
│   │   └── ControlPanelGeofence.tsx # Toggle giám sát + thanh tốc độ, chỉ số, ô hiệu quả grid, log cảnh báo Enter/Exit live
│   ├── HistoryPlayback/          # === History Playback (tua lại 5k xe × 300s) ===
│   │   ├── index.tsx             # HistoryPlaybackDashboard: cube qua worker, state play/seek, wiring alert + thước đo
│   │   ├── MapContainerPlayback.tsx # Khởi tạo MapLibre, vòng RAF nội suy, spatial grid dò va chạm mỗi frame, layer cảnh báo + thước đo
│   │   └── ControlPanelPlayback.tsx # Slider timeline + play/tốc độ, chỉ số live (tooltip ⓘ), thước đo, log va chạm
│   └── FloodSim/                 # === 3D Flood Digital Twin (custom WebGL shader + DEM + 3D Tiles) ===
│       ├── index.tsx             # FloodSimDashboard: worker sinh cảnh, waterRef (bypass uniform), state nguồn cảnh/terrain/basemap
│       ├── MapContainerFlood.tsx # Khởi tạo MapLibre, custom layer nước + props instanced, DEM setTerrain, overlay deck.gl, đổi basemap setStyle
│       └── ControlPanelFlood.tsx # Toggle nguồn cảnh + basemap, DEM, slider/bão mực nước, chế độ IoT + chip, chỉ số cảnh
├── workers/
│   ├── dataParser.worker.ts          # 2D: master SoA, di chuyển về đích + bearing, lọc bbox, transfer
│   ├── dataParser3d.worker.ts        # 3D: generate + parse master toà nhà, lọc theo viewport (bbox)
│   ├── spatialAnalysis.worker.ts     # Spatial: SoA master + rebuild kdbush mỗi tick + broadcast 2 channel
│   ├── motionStream.worker.ts        # MotionStream: master SoA, tick "nhỏ giọt" 3s, subset viewport { coords, bearing, idx }
│   ├── tspSolver.worker.ts           # Route Optimizer: bộ giải ma trận thuần — Nearest Neighbor → 2-opt → Held-Karp (chính xác)
│   ├── geofence.worker.ts            # Geofence Monitor: 50k SoA + 1000 polygon, spatial grid + bbox + Turf PiP, cache trạng thái
│   ├── playbackHistory.worker.ts     # History Playback: sinh một-lần khối không-thời gian 5k×301 (transferable)
│   └── floodSim.worker.ts            # Flood Twin: sinh một-lần nhà giả lập (JSON) + mảng instance cây/rào
│   (Offline Sync không có worker — IndexedDB + tile protocol chạy ở main thread)
└── utils/
    ├── geoHelpers.ts             # Kiểu dữ liệu 2D, sinh SoA, haversine/bearing, helper id/name/ETA
    ├── floodHelpers.ts          # Flood Twin: shader GLSL nước/props, bộ sinh mesh + cảnh, helper GL program
    ├── floodLayers.ts           # Flood Twin: FloodWaterLayer + InstancedPropsLayer (CustomLayerInterface)
    ├── floodSensorFeed.ts       # Flood Twin: client WebSocket mực nước IoT + backoff + fallback simulator client
    ├── google3dTiles.ts         # Flood Twin: deck.gl Tile3DLayer + MapboxOverlay cho Google Photorealistic 3D Tiles
    ├── geofenceHelpers.ts       # Geofence: sinh xe/polygon theo cụm + buildSpatialGrid (lưới index đều)
    ├── geoHelpers3d.ts           # Kiểu dữ liệu toà nhà 3D + bộ sinh JSON lớn
    ├── spatialHelpers.ts         # Buffer circle tự viết, rehydrate kdbush, wrapper around()/distance()
    ├── interpolationHelper.ts    # lerpCoordinate + computeBearing (vòng lặp RAF của MotionStream dùng)
    ├── indexedDbHelper.ts        # idb: clientId + local DB per-tab & shared DB, CRUD OfflineFeature, thao tác tile-cache
    ├── tileCacheHelper.ts        # Protocol tile offline:// (cache-on-browse) + prefetch viewport + tile fallback
    ├── offlineSyncServer.ts      # "Server" chế độ Local: version CAS trên shared IndexedDB
    ├── syncTransport.ts          # Interface SyncTransport + LocalTransport (BroadcastChannel) + RemoteTransport (REST/WS)
    ├── osrmHelper.ts             # Route Optimizer: wrapper OSRM /table + /route, ma trận haversine fallback, gán mode
    ├── routeApiHelper.ts         # Route Optimizer: sinh điểm giao hàng + polyline giả lập theo chặng (fallback)
    └── playbackHelpers.ts        # History Playback: sinh khối không-thời gian + frame index O(1) + ProximityDetector (hash grid)

server/                          # === Backend Node độc lập (không bundle): Offline Sync + IoT ngập lụt ===
├── index.js                     # Express + ws: /api/push, /api/pull, /api/simulate; định tuyến WS /ws (sync) + /ws-sensors (IoT)
├── store.js                     # Offline Sync: kho version + CAS + seq, lưu bền ra data.json
└── sensorFeed.js                # Flood Twin: WebSocketServer /ws-sensors phát mực nước (~500ms)
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
- ETA dùng đường đi thực tế (routing/OSRM) thay cho khoảng cách đường chim bay × tốc độ trung bình — đã hiện thực ở dashboard **Route Optimizer** (§12).
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
- **WebSocket bền bỉ:** tự reconnect với backoff luỹ thừa (1s→2s→…→tối đa 32s, thử lại vô hạn tới khi transport bị đóng); khi **nối lại** sẽ `pull` ngay để bắt kịp các thay đổi đã lỡ lúc mất kết nối (idempotent nhờ con trỏ `seq`). Lúc mất kết nối, panel hiện 🔴.
- **Đã kiểm chứng:** mở **2 trình duyệt khác nhau** ở chế độ Backend → vẽ/sửa ở bên này hiện sang bên kia theo thời gian thực (WebSocket → pull).
- **Lưu ý:** chỉ chạy ở môi trường dev (dựa vào Vite proxy; production phải host server riêng). Local và Backend là **2 server tách biệt** (IndexedDB chung vs file JSON) — không tự migrate dữ liệu, nên chọn chế độ từ đầu.

## 12. Module Route Optimizer (TSP / định tuyến giao hàng)

Dashboard thứ sáu ([`src/components/RouteOptimizer/`](src/components/RouteOptimizer/)) giải **bài toán Người bán hàng (TSP)** cho 20 điểm giao hàng ngẫu nhiên quanh Hà Nội: tìm thứ tự đi qua sao cho tổng quãng đường ngắn nhất. Vẫn theo triết lý "worker giữ việc nặng + cầu nối imperative" — thuật toán chạy trong Web Worker, mọi hình học nằm trong `useRef`, chỉ kết quả cuối cùng đã sắp xếp mới vào React state.

### 12.1. Định tuyến đường THẬT (OSRM), không phải đường chim bay
Bản trước giả lập cả chi phí (haversine) lẫn đường vẽ (polyline bẻ cong sin) — nên lộ trình bỏ qua mạng đường thật. Giờ hai lời gọi OSRM (server demo công khai `router.project-osrm.org`, profile `driving`) làm nó thành thật:
- **`/table`** trả ma trận N×N khoảng cách + thời gian **theo đường** trong vài ms (Contraction Hierarchies). Đây mới là thứ TSP tối ưu trên đó — không phải đường chim bay.
- **`/route`** (`geometries=geojson`, `steps=true`) trả hình học đường chi tiết của thứ tự đã tối ưu trong **một** request; hình học từng chặng dựng lại bằng cách nối geometry các step trong leg.

Cả hai gọi thẳng từ browser (không cần backend) và **fallback an toàn** — OSRM lỗi/bị rate-limit thì dashboard dựng lại ma trận haversine + polyline giả lập, đúng triết lý auto-fallback của dự án (Offline Sync → Local, tile → xám). Panel báo rõ đang dùng nguồn nào.

> [`src/utils/osrmHelper.ts`](src/utils/osrmHelper.ts) · [`src/utils/routeApiHelper.ts`](src/utils/routeApiHelper.ts)

### 12.2. Ba thuật toán TSP chạy nối tiếp (mỗi pha ≤ pha trước)
Worker là **bộ giải ma trận thuần**: main thread đưa ma trận chi phí, worker không hề biết tọa độ.
- **Nearest Neighbor** (tham lam, O(N²)): từ kho luôn nhảy tới điểm chưa thăm gần nhất. <1ms, ~25% trên tối ưu — dùng làm lời giải khởi đầu.
- **2-opt** (local search, O(N²)/lượt): gỡ cạnh cắt chéo bằng cách đảo đoạn giữa hai cạnh; nhận swap khi `D(a,c)+D(b,d) − D(a,b) − D(c,d) < 0`. Vài ms, ~2–5% trên tối ưu (cực tiểu *cục bộ*).
- **Held-Karp** (quy hoạch động, O(N²·2ᴺ)) khi N ≤ 20: `dp[mask][j]` = chi phí nhỏ nhất xuất phát từ kho, thăm đúng tập `mask`, kết tại `j`. **Tối ưu tuyệt đối**. Ở N=20 bảng là `Float32Array` ~84MB, chạy ~1–2s — chấp nhận được trong worker (ngoài luồng UI). N>20 thì bỏ qua, giữ kết quả 2-opt.

Nên `nnKm ≥ twoOptKm ≥ exactKm`, hiển thị thành chuỗi cải thiện trên panel kèm badge "✓ tối ưu tuyệt đối". Vì Held-Karp giải được tối ưu ở N=20 nên Genetic Algorithm không cần thiết ở quy mô này (chỉ đáng giá khi N lớn hơn hoặc có thêm ràng buộc → VRP).

> [`src/workers/tspSolver.worker.ts`](src/workers/tspSolver.worker.ts)

### 12.3. Render đa phương thức + overlay so sánh NN
Route source là `FeatureCollection` các `LineString` theo chặng, mỗi cái gắn `mode`. Phải dùng hai line layer vì **`line-dasharray` không data-driven trong MapLibre** — không đổi nét đứt/liền per-feature bằng expression. Nên một layer nét liền xanh lá (`mode == "ride"`, xe máy) và một layer nét đứt xanh dương (`mode == "walk"`, chặng ngắn "vào ngõ") lọc theo property. (OSRM demo chỉ có profile ô tô nên phân loại mode mang tính **minh hoạ** — hình học luôn là đường xe.)

Tích **"chồng lộ trình Nearest Neighbor"** vẽ lộ trình NN thô bằng **đường thẳng** nét đứt đỏ nối các điểm theo thứ tự NN. Thẳng (không bám phố) là cố ý: 2-opt/Held-Karp sinh ra để tháo các cạnh *cắt chéo*, và nét thẳng làm chỗ chéo đó lộ rõ so với lộ trình tối ưu phía dưới.

> [`src/components/RouteOptimizer/MapContainerTsp.tsx`](src/components/RouteOptimizer/MapContainerTsp.tsx) · [`ControlPanelTsp.tsx`](src/components/RouteOptimizer/ControlPanelTsp.tsx) · [`index.tsx`](src/components/RouteOptimizer/index.tsx)

Luồng: **`/table` → Worker(matrix) → `/route` → vẽ**. Orchestrator giữ ma trận, hình học leg và coords overlay NN trong ref; chỉ danh sách thứ tự cuối + tổng quãng đường/thời gian vào React state.

## 13. Module Geofence Monitor (giám sát vùng cấm quy mô lớn)

Dashboard thứ bảy ([`src/components/Geofencing/`](src/components/Geofencing/)) giám sát **50.000 xe** di chuyển trên **toàn Việt Nam** và phát cảnh báo tức thì mỗi khi một xe **đi VÀO** hoặc **ĐI RA** khỏi một trong **1.000 vùng cấm hình thù bất kỳ (polygon)**. Worker giữ toàn bộ dữ liệu và chạy trọn pipeline phát hiện; main thread chỉ render subset trong viewport bằng layer circle GPU.

### 13.1. Vì sao cách ngây thơ bùng nổ — và spatial grid để khắc phục
Cách hiển nhiên — mỗi tick kiểm tra mọi xe với mọi polygon — là `50.000 × 1.000 = 50.000.000` phép point-in-polygon mỗi tick → làm chảy worker. Giải pháp là **pipeline lọc 3 lớp** ([`geofence.worker.ts`](src/workers/geofence.worker.ts), [`geofenceHelpers.ts`](src/utils/geofenceHelpers.ts)):

- **Lớp 0 — Spatial grid index.** `buildSpatialGrid` phủ lưới đều (ô ~0.3°) lên bbox cả nước và băm mỗi polygon vào **mọi ô mà bbox của nó chạm tới**. Lúc truy vấn, một xe rơi vào đúng **một** ô và chỉ xét vài polygon đăng ký trong ô đó → độ phức tạp tụt từ `O(xe × tổng_vùng)` xuống `O(xe × vùng/ô)`. **Đây là thay đổi khiến mở rộng diện tích chạy được.**
- **Lớp 1 — Bounding box (đại số).** Mỗi polygon ứng viên qua phép kiểm tra rẻ `xmin ≤ x ≤ xmax && ymin ≤ y ≤ ymax` (`zoneBboxFlat` tính sẵn). Vẫn cần vì bbox của polygon có thể tràn sang ô lưới bên cạnh.
- **Lớp 2 — Turf `booleanPointInPolygon`.** Chỉ những xe sống sót qua Lớp 0+1 mới chạm phép kiểm tra hình học chính xác ([Turf.js](https://turfjs.org/)); tọa độ truyền dạng mảng thô `[lng, lat]` (không cấp phát object mỗi lần gọi).

### 13.2. Cache trạng thái — cảnh báo theo *chuyển đổi*, không theo *điều kiện*
Một typed array thô `Int16Array zoneOf` (mỗi xe một ô, giá trị = id vùng hiện tại, `-1` = ngoài mọi vùng) là **cache trạng thái trước đó** — cố ý **không** dùng React state. Mỗi tick worker so vùng vừa tính với `zoneOf[i]`: **Enter** chỉ phát khi `ngoài → trong`, **Exit** chỉ phát khi `trong → ngoài`. Một xe nằm im *bên trong* vùng suốt nghìn tick sinh ra **0** cảnh báo lặp. Cờ `primed` biến tick 0 thành baseline im lặng để xe spawn sẵn trong vùng không phát "enter" giả.

### 13.3. Render, gom cụm chuyển động, và điều khiển tốc độ
Xe được spawn theo **cụm quanh 12 anchor đô thị** (trọng số theo quy mô) và mỗi xe lượn trong bán kính `ROAM_RADIUS` quanh "nhà" của nó, nên đội xe bám đất liền và liên tục cắt qua các vùng (thay vì trôi đều ra biển). Chúng render bằng **layer `circle` GPU** với **màu data-driven** — `["case", ["==", ["get","v"], 1], đỏ, xanh]` — nên xe vi phạm hóa đỏ mà không cần JS per-feature. Kênh render tái dùng **two-pass count-then-pack** lọc theo viewport + transferable của dự án, cộng cờ `Uint8Array violating`. Một **thanh trượt tốc độ** gửi `SET_SPEED { factor }` để chỉnh tốc độ live (kéo về **0** để đóng băng — phát hiện vẫn chạy nhưng không có chuyển trạng thái mới). Khi load, map `fitBounds` về bbox cả nước.

### 13.4. Ý nghĩa các chỉ số trên panel
Panel điều khiển ([`ControlPanelGeofence.tsx`](src/components/Geofencing/ControlPanelGeofence.tsx)) hiển thị:

| Chỉ số | Ý nghĩa |
|--------|---------|
| **Xe đang vi phạm** | Số **tức thời** xe hiện đang nằm trong một vùng bất kỳ (`zoneOf[i] !== -1`), trên *toàn* đội xe — không chỉ viewport. Lên xuống liên tục. |
| **Xe trong viewport** | Bao nhiêu xe rơi vào khung nhìn hiện tại — tức bao nhiêu chấm thực sự được vẽ tick này (subset render đã lọc bbox). |
| **Tổng lượt VÀO (Enter)** | **Tổng cộng dồn** (chỉ tăng) số lần chuyển `ngoài → trong` từ lúc bắt đầu giám sát. Là bộ đếm *lưu lượng* — bao nhiêu lần vượt biên vào vùng, không phải bao nhiêu xe đang ở trong. |
| **Tổng lượt RA (Exit)** | Tương tự, cho chuyển `trong → ngoài`. Bám sát Enter theo thời gian (mỗi lần vào rồi sẽ ra); Enter thường nhỉnh hơn chút vì còn xe đang kẹt bên trong. |
| **Turf PiP checks/tick** | Số lần gọi `booleanPointInPolygon` trong **tick gần nhất** — tức bao nhiêu xe sống sót qua Lớp 0+1 và cần kiểm tra chính xác. Đây là **bằng chứng hiệu năng**: thường chỉ vài nghìn, so với 50.000.000 nếu quét brute-force. Dao động theo từng tick tùy số xe đang lảng vảng gần vùng. |
| **Simulation ticks** | Số tick worker đã chạy. Mỗi tick **250 ms** (4 Hz), nên `ticks × 0,25 s` ≈ thời gian giám sát đã trôi. Ngừng tăng nếu tạm dừng giám sát. |
| Tiêu đề **Cảnh báo trực tiếp** | `(N sự kiện · xem 80 gần nhất)` — `N` là tổng thật (`Enter + Exit`); danh sách cuộn bị giới hạn **80 dòng mới nhất** để panel nhẹ. Việc độ dài danh sách đứng yên ở 80 là do cap, không phải số sự kiện. |

Hợp đồng message: main→worker `INIT_DATA { count, geofenceCount, bbox }`, `UPDATE_BBOX { bbox }`, `SET_STREAMING { isActive }`, `SET_INTERACTING { isActive }`, `SET_SPEED { factor }`; worker→main `GEOFENCES_READY { geojson }` (polygon, gửi 1 lần), `DATA_UPDATED { count, coords, violating, idx, totalViolating, pipCount, alerts }` (typed array transferable; `alerts` = chỉ các chuyển đổi), và `ALERTS_ONLY { alerts, totalViolating, pipCount }` (phát **trong lúc** pan/zoom nên giám sát không bao giờ dừng). Phát hiện chạy trên toàn bộ xe bất kể viewport; chỉ kênh render mới lọc theo bbox.

## 14. Module History Playback (tua lại chuỗi thời gian + phát hiện va chạm)

Dashboard thứ tám ([`src/components/HistoryPlayback/`](src/components/HistoryPlayback/)) rời chủ đề streaming real-time để giải bài toán **tua lại lịch sử**: kéo tới/lui qua lịch sử di chuyển đã ghi của **5.000 xe** trong cửa sổ **300 giây**, đồng thời tự động phát hiện mọi cặp xe từng **lại gần nhau dưới 5 m** (nguy cơ va chạm) tại bất kỳ thời điểm nào. Việc sinh dữ liệu nặng chạy trong worker; phần tua + phát hiện chạy ở main thread 60fps.

### 14.1. Cấu trúc dữ liệu Không-Thời gian (tối ưu RAM, truy xuất O(1))
Cách ngây thơ `Vehicle[][]` (mỗi giây một mảng object) sẽ là **hàng triệu object** — phình RAM và GC liên tục. Thay vào đó toàn bộ lịch sử là **một `Float32Array` phẳng — "khối không-thời gian"** ([`playbackHelpers.ts`](src/utils/playbackHelpers.ts)) bố trí `[frame][xe][lng,lat]` với `offset(t,i) = t*stride + i*2` (`stride = count*2`):
- id của xe **chính là** index mảng `i` (ổn định qua mọi frame) → không cần lưu id;
- frame của giây `t` là một **view `subarray` zero-copy** trỏ vào cùng buffer, nên `Map<timestamp, frame>` yêu cầu ([`buildFrameIndex`](src/utils/playbackHelpers.ts)) cho truy xuất **O(1)** mà **không cấp phát thêm**;
- dung lượng: 5k × 301 × 2 × 4 B ≈ **12 MB** cho cả lịch sử, sinh **một lần** trong [`playbackHistory.worker.ts`](src/workers/playbackHistory.worker.ts) và **transfer zero-copy** (không structured-clone).

Mỗi xe được sinh như một quỹ đạo "giao thông" (hướng + tốc độ, bẻ lái nhẹ mỗi giây, dội lại khi chạm biên vùng) trong một khu phố gọn ~3,5 km × 2,8 km để mật độ đủ cao → các cặp xe thực sự có lúc đi qua nhau trong 5 m — pha lại gần là **tự phát**, không dàn dựng.

### 14.2. Bộ điều khiển tua (nội suy RAF 60fps)
Timeline chạy 0→300 s. Vòng lặp `requestAnimationFrame` ([`MapContainerPlayback.tsx`](src/components/HistoryPlayback/MapContainerPlayback.tsx)) tiến `time += dt × speed` và **nội suy tuyến tính** mỗi xe giữa hai mốc giây liền kề, đẩy vào MapLibre bằng `source.setData()` — nên chuyển động luôn mượt 60fps bất kể tốc độ tua (1×–60×). Slider hai chiều: vòng RAF publish thời gian hiện tại về React **throttle** (~16 Hz) nên dashboard không re-render mỗi frame; kéo slider dùng **token `seekNonce`** để cập nhật từ RAF không gây vòng lặp seek (pattern ref-for-prop của dự án). Xe render bằng layer `circle` GPU với **màu data-driven** — đỏ khi đang trong pha va chạm gần, xanh lơ khi an toàn — qua object pool (không cấp phát mỗi frame).

### 14.3. Phát hiện va chạm — spatial hash grid (không O(N²))
So mọi cặp là `5000 × 4999 / 2 ≈ 12,5 triệu` phép **mỗi frame** — bất khả thi ở 60fps. [`ProximityDetector`](src/utils/playbackHelpers.ts) thay bằng cách băm xe vào **lưới đều có cạnh ô = ngưỡng 5 m**: hai xe chỉ có thể trong 5 m nếu cùng ô hoặc ô kề, nên mỗi xe chỉ so với **9 ô xung quanh** (và chỉ `j > i` để khỏi đếm 2 lần). Tụt về ~O(N) khi mật độ đều. Mảng bucket tái dùng qua free-list và `cellIdx` mỗi xe được tái dùng, nên sau warm-up bộ dò **gần như không cấp phát mỗi frame**. Bộ dò chạy **mỗi frame trên vị trí đã nội suy**, nên vòng cảnh báo bám đúng những gì đang vẽ. Một pha va chạm chỉ được ghi log khi cặp xe **mới** lại gần (một chuyển đổi, như cache Enter của geofence) để danh sách không tràn; mỗi hit còn vẽ một vòng **halo hổ phách + lõi đỏ** tại trung điểm cặp xe.

### 14.4. Thước đo (đo khoảng cách khi Pause)
Bật **📏 Thước đo** sẽ tạm dừng playback (để xe đứng yên cho đo chính xác) và biến cú click thành thao tác đo: bấm 2 xe để vẽ đường đứt nét vàng nối chúng (điểm A lime, điểm B cam) kèm nhãn khoảng cách live (`haversine`, hiện m hoặc km) cả trên bản đồ lẫn trên panel. Bấm xe thứ 3 bắt đầu cặp mới. Đường đo cũng tự vẽ lại khi kéo slider, nên có thể so khoảng cách của cùng cặp xe ở các thời điểm khác nhau. (Cặp đang chọn giữ trong ref; lúc đang phát không có gì per-frame chạm React state.)

### 14.5. Ý nghĩa các chỉ số trên panel
Panel điều khiển ([`ControlPanelPlayback.tsx`](src/components/HistoryPlayback/ControlPanelPlayback.tsx)) hiển thị (rê chuột vào ⓘ để xem tooltip tại chỗ):

| Giá trị | Ý nghĩa |
|---------|---------|
| **Timeline `mm:ss / mm:ss`** + **tốc độ (1×–60×)** | Vị trí hiện tại trong cửa sổ 300 s / tổng. Tốc độ = số **giây lịch sử** phát mỗi **giây thực** (10× ⇒ toàn bộ 300 s xem hết trong 30 s). Kéo slider nhảy tới bất kỳ giây nào với **O(1)** (view zero-copy vào cube). |
| **Cặp đang va chạm gần** | Số **tức thời** các cặp xe hiện cách nhau dưới 5 m **tại đúng khung hình đang xem**. Lên/xuống khi tua; `0` nghĩa là khoảnh khắc đó không có nguy cơ va chạm. |
| **Tổng sự kiện đã ghi** | **Tổng cộng dồn** (chỉ tăng) số lần một cặp **mới** lại gần dưới ngưỡng — đếm ở *thời điểm bắt đầu* lại gần, không đếm lại mỗi frame cặp vẫn đang gần. Chỉ tăng khi đang phát; tua tay không sinh sự kiện. |
| **Phép so cặp / frame** | Số phép so khoảng cách spatial grid **thực sự** chạy ở frame này (chỉ các xe cùng ô hoặc ô kề). Đây là **bằng chứng hiệu năng**: thường vài nghìn so với ~12,5 triệu nếu quét O(N²). |
| **FPS** | Tốc độ khung hình thực đo của vòng RAF (publish ~2 Hz). Mục tiêu 60 — đo cả nội suy **+** dò va chạm mỗi frame **+** `setData`, gộp lại. |
| **Thời gian dựng cube** | Thời gian Worker mất để sinh toàn bộ khối không-thời gian (5.000 × 301 frame) **một lần** lúc mở, trước khi transfer zero-copy. Sau đó việc tua không tốn thêm chi phí sinh dữ liệu. |
| Ô **Spatial grid** | Nhắc lại *phép so cặp/frame* đối chiếu với con số brute-force `N²/2` — tỉ lệ hiệu quả live của lưới. |
| Ô **Thước đo** | Khi bật thước đo: 2 xe đang chọn + khoảng cách (m/km). Chỉ hiện khi đang tạm dừng. |

Hợp đồng message: main→worker `GENERATE { count, frames }`; worker→main `GENERATED { cube, count, frames, stride, genMs }` (`ArrayBuffer` của `cube` là **transferable**). Khác mọi worker khác, worker này **không trạng thái, chạy một lần** — không `setInterval`, không bbox, không fetch: sinh cube một lần rồi main thread tự lo việc tua + phát hiện (gần với tinh thần xử-lý-trên-main-thread của Offline Sync, nhưng có worker cho bước sinh dữ liệu nặng).

## 15. Module 3D Flood Digital Twin (custom WebGL shader + DEM + 3D Tiles)

Dashboard thứ chín ([`src/components/FloodSim/`](src/components/FloodSim/)) là một **bản sao số (digital twin)** ngập lụt: thành phố 3D có đường phố và chân các toà nhà bị nước dâng nhấn chìm, mực nước điều khiển real-time từ cảm biến IoT. Khác mọi dashboard khác, nó đi **xuống dưới style API của MapLibre tới GLSL thô**, qua hai layer `CustomLayerInterface` dùng chung GL context của bản đồ.

### 15.1. Shader nước tuỳ biến (điểm nhấn)
[`FloodWaterLayer`](src/utils/floodLayers.ts) là một **mặt phẳng trong suốt** giữ ở cao độ `u_levelZ` (mét → mercator). Hiệu ứng sóng làm **hoàn toàn trong fragment shader** (tổng các hàm sin + vệt phản quang), tính theo **toạ độ MÉT thật** (`v_local = (a_pos − u_origin) / u_meter`) nên bước sóng cố định trong không gian thật, nhìn **giống nhau ở mọi zoom**. Tấm nước là một quad lớn phủ kín tầm nhìn; vẽ sau cùng với `depthMask(false)` + alpha blend để đọc depth của nhà/địa hình và nhấn chìm mọi thứ thấp hơn mực nước, kèm `gl.POLYGON_OFFSET_FILL(0, −4)` (**chỉ bias hằng số**, factor = 0) để thắng z-fighting với mặt đất ở xa mà không leo đè lên tường khi nhìn nghiêng. Nhà để **đục hoàn toàn** cho depth sạch.

### 15.2. Slider bỏ qua React (điều khiển trực tiếp uniform)
Mực nước nằm trong một **đối tượng dùng chung** `useRef<{ meters }>` được trao cho cả hai layer WebGL lúc khởi tạo. `onChange` của `<input type=range>` (uncontrolled) **mutate `waterRef.current.meters`** + cập nhật thumb/nhãn qua **DOM ref** — không qua React state — nên kéo slider bơm thẳng giá trị vào uniform GPU **mà không re-render bản đồ**. Lũ thật 0–5 m so với nhà cao 100 m chỉ là lớp màng mỏng, nên cao độ mặt nước (và mốc so chìm của props) được nhân `FLOOD_VIS_SCALE` (×4, **phóng đại trực quan** — slider vẫn là mét thật).

### 15.3. Instanced Rendering (cây + rào chắn cứu hộ)
[`InstancedPropsLayer`](src/utils/floodLayers.ts) vẽ hàng nghìn cây (thân hộp + 2 nón) và rào (hộp + dải phản quang) bằng **`drawArraysInstanced`** (WebGL2) / `ANGLE_instanced_arrays` (fallback WebGL1): 1 base-mesh VBO dùng chung + 1 VBO theo-instance nhỏ (`[mercX, mercY, scale, rot]`, 16 B/instance) → VRAM phẳng bất kể số lượng. Phần vật thể dưới mực nước bị nhuộm xanh ("chìm").

### 15.4. Ba nguồn cảnh (toggle trên panel)
- **🏙️ Synthetic** — nhà (`fill-extrusion`) + props instanced sinh một lần trong [`floodSim.worker.ts`](src/workers/floodSim.worker.ts).
- **🗼 MapTiler** — nhà 3D **thật** từ vector **OpenMapTiles** của MapTiler bằng `fill-extrusion` native trên lớp `building` (`render_height`/`render_min_height`) — *không* dùng deck.gl/3D-Tiles (`v3-openmaptiles/tiles.json` là vector tileset). Cần key MapTiler; key **giới hạn theo origin** nên 403 nghĩa là origin chưa được allowlist tại cloud.maptiler.com.
- **🌍 Google** — **OGC Photorealistic 3D Tiles** qua deck.gl `Tile3DLayer` + `@deck.gl/mapbox` `MapboxOverlay({ interleaved: true })` ([`google3dTiles.ts`](src/utils/google3dTiles.ts)), dùng chung depth buffer nên nước vẫn ngập theo cao độ thật. Cần **bật Map Tiles API** trên project Google Cloud nếu không tileset sẽ 403. deck.gl + loaders.gl tách chunk vendor `deckgl` (lazy).

Cả hai nguồn thật đều ẩn nhà/props giả lập. Key override qua `VITE_MAPTILER_KEY` / `VITE_GOOGLE_3D_TILES_KEY`.

### 15.5. Địa hình DEM + feed IoT qua WebSocket
- **DEM** — source `raster-dem` Terrarium (công khai, không cần key) + `map.setTerrain` để lũ ngập theo cao độ địa hình thật; áp dụng cho **Synthetic & MapTiler** (Google tự có địa hình).
- **Feed IoT** — ở chế độ "📡 Cảm biến IoT", một WebSocket ([`floodSensorFeed.ts`](src/utils/floodSensorFeed.ts) → `/ws-sensors`, phục vụ bởi [`server/sensorFeed.js`](server/sensorFeed.js)) bắn mực nước mỗi ~500 ms vào cùng đường uniform; tự reconnect backoff và **tự fallback sang simulator phía client** khi không có backend (để `npm run dev` vẫn chạy). Path `/ws-sensors` **riêng** (WebSocketServer riêng) để không đụng `/ws` của Offline Sync.

### 15.6. Ý nghĩa các giá trị trên panel
Panel điều khiển ([`ControlPanelFlood.tsx`](src/components/FloodSim/ControlPanelFlood.tsx)):

| Điều khiển / giá trị | Ý nghĩa |
|----------------------|---------|
| **Nguồn cảnh 3D** — 🏙️ Synthetic / 🗼 MapTiler / 🌍 Google | Chọn cái dựng thành phố 3D: khối hộp giả lập, nhà vector thật của MapTiler, hay 3D Tiles photorealistic của Google (§15.4). Chuyển nguồn sẽ ẩn/hiện các layer tương ứng. |
| **Địa hình DEM thật** (checkbox, Synthetic/MapTiler) | Bật/tắt địa hình thật (`raster-dem`); khi bật, mép nước ngập theo cao độ mặt đất thay vì nền phẳng z=0. |
| **Phóng đại** ×N (terrain) | Hệ số phóng đại chiều cao của lưới địa hình DEM (Hà Nội phẳng nên cần phóng đại mới thấy rõ). Thuần hiển thị. |
| **Chip trạng thái 3D Tiles** (Google) | `Sẵn sàng` → `Đang tải…` → `đã tải` / `Lỗi tải tiles` (thường do chưa bật Map Tiles API). |
| **Bản đồ nền** — 🌑 Tối / ☀️ Sáng / 🗺️ Voyager | Đổi style nền Carto (tối / sáng / đường phố). Gọi `map.setStyle()`, sau đó mọi custom layer/terrain/overlay được dựng lại tự động. |
| **Nguồn mực nước** — 📡 IoT / ✋ Thủ công | IoT = feed cảm biến WebSocket điều khiển mực nước (slider chỉ đọc); Thủ công = bạn tự kéo slider + chạy kịch bản bão. |
| **Chip trạng thái feed** (chế độ IoT) | `LIVE` (xanh, cảm biến thật) / `SIMULATED` (cam, không có backend → simulator client) / `CONNECTING`, kèm mã trạm. |
| **Mức độ ngập lụt: X.X m** + slider (0–5 m) | Mực nước theo **mét thật** — bơm thẳng vào uniform `u_water_level` của GPU (không re-render React). Cao độ vẽ ×4 (phóng đại trực quan) để thấy rõ nước dâng; con số là mét thật. |
| **🌊 Mô phỏng bão về (0 → 5m)** | Kịch bản "bão": dâng mực nước từ tốn 0→5 m (chỉ ở chế độ Thủ công). |
| **Toà nhà (fill-extrusion)** | Số toà nhà giả lập trong cảnh (số feature GeoJSON sinh ra). |
| **Cây xanh (instanced)** | Số instance cây do layer instanced vẽ (1 mesh dùng chung). |
| **Rào chắn (instanced)** | Số instance rào chắn cứu hộ do layer instanced vẽ. |
| **Worker sinh cảnh** | Thời gian (ms) worker mất để sinh toàn bộ cảnh giả lập **một lần** (JSON nhà + mảng props), trước khi transfer. |
| **Tổng vật thể props** | cây + rào — tổng số instance đẩy lên GPU từ **một** lần nạp mesh (con số minh hoạ "instancing"). |
| **↻ Sinh lại bản sao số đô thị** | Sinh lại cảnh giả lập (nhà/props ngẫu nhiên mới). |

Hợp đồng message: **IoT** server→client trên path **riêng** `/ws-sensors` — `{ type:"sensor", stationId, level, ts }` mỗi ~500 ms (`level` 0–5 m). **Worker sinh cảnh** ([`floodSim.worker.ts`](src/workers/floodSim.worker.ts)) main→worker `GENERATE { buildingCount, treeCount, barrierCount }`; worker→main `SCENE_READY { buildings, trees, barriers, genMs }` (`buildings` structured-clone, `trees`/`barriers` transferable). Phân tích kiến trúc chuyên sâu (đánh đổi 3D Tiles/HLOD, DEM, instancing quy mô lớn) nằm ở [`docs/flood-architecture.md`](docs/flood-architecture.md).
