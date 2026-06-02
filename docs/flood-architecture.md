# 3D Flood Digital Twin — Phân tích kiến trúc (demo ↔ sản xuất)

Tài liệu này phân tích giải pháp kiến trúc **sản xuất** cho một "Bản sao số đô thị mô phỏng ngập lụt" theo 3 trụ cột, so sánh với **demo hiện tại** trong repo (dashboard FloodSim — `/flood-twin`), và đề ra lộ trình tiến hoá.

> Demo hiện tại: ~3000 toà nhà GeoJSON `fill-extrusion`, 2 custom WebGL layer (mặt nước phẳng + cây/rào instanced), mực nước điều khiển bằng Slider → uniform shader (bypass React). Xem các file: [src/components/FloodSim/](../src/components/FloodSim/), [src/utils/floodHelpers.ts](../src/utils/floodHelpers.ts), [src/utils/floodLayers.ts](../src/utils/floodLayers.ts), [src/workers/floodSim.worker.ts](../src/workers/floodSim.worker.ts).

---

## Trụ cột 1 — Dữ liệu 3D khổng lồ: chuẩn 3D Tiles + HLOD

### Vì sao GeoJSON sụp đổ ở quy mô thật
GeoJSON là văn bản, phải nạp + `JSON.parse` **toàn bộ** vào RAM, không có phân cấp LOD, không phân trang theo không gian. Dữ liệu LiDAR cả thành phố lên tới **hàng chục TB** → không thể giữ trong bộ nhớ trình duyệt. Cụm 3000 polygon tổng hợp của demo chỉ để minh hoạ kỹ thuật render, không phải mô hình dữ liệu sản xuất.

### Chuẩn 3D Tiles (OGC) + HLOD
- **Tileset** là một cây *bounding volume* (`tileset.json`) trỏ tới payload từng tile (`b3dm`/glTF, hoặc 3D Tiles 1.1: glTF + *implicit tiling*).
- **HLOD (Hierarchical Level of Detail):** node cha = mô hình thô, node con = mịn dần. Runtime duyệt cây theo **Screen-Space Error (SSE)** kết hợp vị trí camera: chỉ tải tile **đang trong tầm nhìn** ở **mức LOD vừa đủ**, stream dần, cache, và **giải phóng VRAM** cho tile ở xa.
- → Yêu cầu "nhìn xa tải khối hộp thô, zoom sát mới tải chi tiết cửa sổ/ban công" chính là **refinement theo SSE**.

### Lựa chọn engine — khuyến nghị: **deck.gl + MapLibre (interleaved)**
| Phương án | Ưu | Nhược |
|---|---|---|
| **deck.gl `Tile3DLayer` + `@deck.gl/mapbox` `MapboxOverlay` (interleaved)** ✅ | Giữ MapLibre v5 làm nền 2D; chia sẻ **cùng GL context + depth buffer** nên custom flood-water shader vẫn occlude/blend đúng với khối 3D Tiles; traversal/SSE/cache có sẵn (`@loaders.gl/3d-tiles` + `Tileset3D`) | Thêm dependency deck.gl (chỉ nạp lazy ở dashboard này) |
| **CesiumJS** | Engine 3D Tiles mạnh & chuẩn nhất | Là cả một globe engine → phải **bỏ MapLibre**, đổi mô hình camera; viết lại gần như toàn bộ dashboard |
| **three.js + 3DTilesRendererJS** | Linh hoạt, dùng chung GL context qua custom layer | Nhiều việc thủ công (traversal, cache, đồng bộ camera) |

### Khoảng cách demo → sản xuất
Thay nguồn `fill-extrusion` tổng hợp bằng `Tile3DLayer` trỏ tới tileset thật. Giữ custom water layer nhưng chuyển sang chạy **interleaved** để dùng chung depth với deck.gl.

---

## Trụ cột 2 — Mô phỏng ngập bằng GPU Shader (IoT + DEM)

### Phần demo ĐÃ làm đúng
- **Không** thay đổi cao độ vật lý của object. Mực nước là một biến **uniform** (`u_water_level`).
- Slider/feed → ghi vào `waterRef.current.meters` (một object mutable, **bypass React**) → mỗi frame các custom layer đọc uniform → GPU tô/leo nước, mượt 60 FPS. Đây đúng là mô hình trụ cột 2 mô tả.

### Phần còn thiếu cho sản xuất
1. **Nguồn dữ liệu thật qua WebSocket** (thay `setInterval` "bão"). → **đã triển khai** (xem mục dưới): kênh `/ws-sensors` riêng, client tự fallback mô phỏng khi offline.
2. **DEM (Digital Elevation Model):** ngập thật phụ thuộc cao độ địa hình — một điểm bị ngập khi `elevation(x,y) < waterSurfaceElevation`. Demo dùng nền phẳng z=0. Hai cách sản xuất:
   - **(i) Terrain MapLibre** (`raster-dem` source + `setTerrain`): dựng lưới địa hình 3D, để depth buffer tự che mặt nước ở vùng cao → ngập chỉ hiện ở chỗ trũng.
   - **(ii) Sample texture terrain-RGB trong fragment shader**: giải mã cao độ per-pixel, tính `floodDepth = max(0, waterElev − terrainElev)` → tô màu theo độ sâu, vẽ đường bờ (shoreline) chính xác.
3. **Nhiều trạm cảm biến (zonal):** uniform hiện là **một** mức toàn cục. Sản xuất cần **trường mực nước theo vùng** (nhiều trạm → nội suy IDW trong shader, hoặc một texture mực nước). Hiện tại để 1 trạm toàn cục cho khớp uniform.

---

## Trụ cột 3 — Hybrid 2D/3D + Instanced Rendering (hàng triệu)

### Demo đã đúng hướng
Nền vector 2D (MapLibre) + custom 3D layer + **instancing**: 1 base-mesh VBO dùng chung + 1 VBO theo-instance `[mercX, mercY, scale, rot]` (16 byte/instance) + `drawArraysInstanced` (WebGL2) / `ANGLE_instanced_arrays` (WebGL1). Xem [InstancedPropsLayer trong floodLayers.ts](../src/utils/floodLayers.ts).

### Mở rộng tới hàng triệu
- Dữ liệu instance typed-array gọn (1M ≈ 16MB — chấp nhận được).
- Cần **viewport/frustum culling**: chia instance theo **lưới không gian (bucket)**, mỗi frame chỉ vẽ bucket trong tầm nhìn.
- Cần **LOD instance**: xa = billboard/impostor, gần = mesh đầy đủ.
- Có thể giữ custom instanced layer + thêm culling, hoặc chuyển sang deck.gl `ScenegraphLayer`/`SimpleMeshLayer` nếu đã dùng deck.gl ở trụ cột 1.

### Tính đúng đắn của layering hybrid (depth)
Thứ tự vẽ: nền 2D → 3D Tiles/mesh (đặc, **ghi** depth) → mặt nước (trong suốt, vẽ **cuối**, dùng chung depth, **không** ghi depth). Các gotcha đã gặp & xử lý trong demo (đáng nhớ cho mọi custom layer):
- Ma trận chiếu phải là `args.defaultProjectionData.mainMatrix` (KHÔNG phải `modelViewProjectionMatrix`).
- Phải `gl.disable(gl.CULL_FACE)` (MapLibre để bật → mặt phẳng ngang bị cull, biến mất).
- `gl.POLYGON_OFFSET_FILL` chống z-fighting tại đường giao mặt nước ↔ tường nhà.
- Mặt nước giữ **phẳng tuyệt đối** (sóng làm bằng màu trong fragment shader) để mép nước cắt ngang đều, không "nhảy" khi zoom.

---

## Bảng khoảng cách (demo ↔ sản xuất)

| Khía cạnh | Demo hiện tại | Kiến trúc sản xuất |
|---|---|---|
| Dữ liệu nhà | 3000 polygon GeoJSON tổng hợp | 3D Tiles HLOD (TB, SSE-driven) qua deck.gl |
| Mực nước | Slider + bão `setInterval` | **IoT WebSocket** (đã làm) + nhiều trạm zonal |
| Địa hình | Nền phẳng z=0 | DEM (`raster-dem`/terrain-RGB), ngập theo cao độ |
| Instancing | Vài nghìn, vẽ hết mỗi frame | Hàng triệu + culling theo bucket + LOD |
| Renderer | MapLibre + custom GL layer | MapLibre 2D + deck.gl interleaved + custom water |

## Lộ trình tiến hoá (độc lập, ship từng phần)
- **Phase A — ĐÃ LÀM:** Feed cảm biến IoT qua WebSocket → uniform (không thêm dependency nặng).
- **Phase B — ĐÃ LÀM:** Terrain DEM thật (`raster-dem` Terrarium + `setTerrain`); nước ngập theo cao độ địa hình (chế độ Synthetic).
- **Phase C — ĐÃ LÀM:** 3D Tiles HLOD qua deck.gl `Tile3DLayer` + `MapboxOverlay` interleaved (Google Photorealistic 3D Tiles), thay cụm nhà tổng hợp.
- **Phase D:** Instancing quy mô lớn (culling theo lưới + LOD) — *chưa làm.*

## Phase B & C đã triển khai — DEM + Google 3D Tiles

**Toggle "Nguồn cảnh 3D"** trong [ControlPanelFlood.tsx](../src/components/FloodSim/ControlPanelFlood.tsx):

- **🏙️ Synthetic + DEM (Phase B):** giữ cụm nhà `fill-extrusion` + cây/rào instanced, **thêm địa hình DEM thật** qua `raster-dem` (tiles Terrarium công khai trên AWS Open Data, không cần key) + `map.setTerrain({ source, exaggeration })` (xem [MapContainerFlood.tsx](../src/components/FloodSim/MapContainerFlood.tsx)). Mặt nước (custom layer) dùng chung depth → ngập theo cao độ địa hình. Có slider phóng đại địa hình. *(Hà Nội khá phẳng nên hiệu ứng DEM tinh tế — dùng exaggeration để thấy rõ.)*
- **🗼 MapTiler 3D (vector, không cần deck.gl):** `https://api.maptiler.com/tiles/v3-openmaptiles/tiles.json` là **vector tiles OpenMapTiles**, KHÔNG phải OGC 3D Tiles. Lấy nhà 3D thật bằng `fill-extrusion` native của MapLibre trên lớp `building` (`render_height`/`render_min_height`) — xem `addMaptilerBuildings` trong [MapContainerFlood.tsx](../src/components/FloodSim/MapContainerFlood.tsx). Kết hợp được với DEM terrain. ⚠️ Key MapTiler **giới hạn theo origin** — nếu 403 "Key usage restricted", thêm origin (localhost + domain) vào allowlist tại cloud.maptiler.com; override qua `VITE_MAPTILER_KEY`.
- **🌍 Google 3D Tiles (Phase C):** `createGoogle3DTilesOverlay` ([google3dTiles.ts](../src/utils/google3dTiles.ts)) tạo `Tile3DLayer` (loaders.gl `Tiles3DLoader`, auth `X-GOOG-API-KEY`) bọc trong `MapboxOverlay({ interleaved: true })`. Khi bật: ẩn nhà/cây giả lập (`setLayoutProperty visibility:none` + `InstancedPropsLayer.setVisible(false)`), tắt DEM terrain (tiles đã có địa hình thật), chèn deck layer **`beforeId` = layer mặt nước** để nước (trong suốt) luôn vẽ sau → blend đúng. **DEM-driven flood đạt được nhờ tile depth:** nước ngập theo cao độ thật của photogrammetry. Trạng thái tải hiện qua chip (loading/ready/error). deck.gl + loaders.gl tách `deckgl` vendor chunk (lazy, ~270KB gzip, chỉ nạp ở dashboard này).

### ⚠️ Yêu cầu kích hoạt Map Tiles API
Key demo hiện trả **403 `SERVICE_DISABLED`** vì project Google Cloud **chưa bật "Map Tiles API"**. Để Google 3D Tiles hiển thị, vào Google Cloud Console của project và **Enable "Map Tiles API"** (`tile.googleapis.com`), đảm bảo key không bị giới hạn chặn API/referrer. Trước khi bật, dashboard tự hiện chip lỗi và chế độ Synthetic + DEM vẫn chạy bình thường. Có thể override key qua biến môi trường `VITE_GOOGLE_3D_TILES_KEY`.

---

## Phase A đã triển khai — Feed cảm biến IoT qua WebSocket

**Mục tiêu:** thay kịch bản "bão" giả lập bằng dòng dữ liệu mực nước thật từ "trạm cảm biến" qua WebSocket, đẩy thẳng vào uniform shader theo đúng cơ chế bypass React sẵn có.

### Thành phần
- **Server** ([server/sensorFeed.js](../server/sensorFeed.js)): một `WebSocketServer` **riêng** trên path **`/ws-sensors`** (tách hoàn toàn khỏi `/ws` của Offline Sync — ws định tuyến upgrade theo path nên không cross-talk). Mỗi ~500ms broadcast `{ type:"sensor", stationId, level, ts }`, `level ∈ [0,5]` m theo đường cong *thuỷ triều (sine 60s) + đợt dâng bão (sine ~180s luỹ thừa)*. Gắn vào HTTP server hiện có qua `attachSensorFeed(httpServer)` trong [server/index.js](../server/index.js).
- **Proxy** ([vite.config.ts](../vite.config.ts)): thêm `"/ws-sensors": { target: "ws://localhost:3001", ws: true }`.
- **Client** ([src/utils/floodSensorFeed.ts](../src/utils/floodSensorFeed.ts)): `createFloodSensorFeed({ onReading, onStatus }) → { stop() }`. Kết nối WS với **backoff reconnect** (sao mẫu từ `createRemoteTransport` trong [syncTransport.ts](../src/utils/syncTransport.ts)). **Fallback:** nếu WS không nối được/đóng → chạy **simulator client** (cùng đường cong) để demo vẫn chạy dưới `npm run dev`; khi WS (re)connect thì tắt simulator, dùng LIVE. Phát `onStatus` chỉ khi **đổi trạng thái** (`connecting`/`live`/`simulated`).
- **UI** ([ControlPanelFlood.tsx](../src/components/FloodSim/ControlPanelFlood.tsx)): toggle **📡 Cảm biến IoT / ✋ Thủ công**. Ở mode IoT, mỗi reading gọi **chung `setLevel`** (đồng bộ uniform + thumb slider + nhãn), slider + nút bão bị khoá, hiện chip **LIVE/SIMULATED/CONNECTING** + mã trạm. Ở mode Thủ công, feed dừng, slider + bão hoạt động như cũ.

### Vì sao feed đặt trong ControlPanelFlood (không phải index.tsx)
`setLevel` (đồng bộ slider DOM + nhãn + uniform) là **private** của panel. Nếu feed ở `index.tsx` thì chỉ ghi được uniform, thumb/nhãn **không nhúc nhích** lúc live → phải lift DOM ref hoặc thêm imperative handle (coupling hơn). Panel **không** re-render map, và logic "bão" tự động vốn đã ở panel → đặt feed cạnh đó là nhất quán. Bypass React giữ nguyên.

### Hành vi theo cách chạy
- `npm run dev` (chỉ Vite, không backend): `/ws-sensors` nối hụt → chip **SIMULATED**, demo vẫn chạy đầy đủ.
- `npm run dev:all` (Vite + server): chip **LIVE**, reading mỗi 500ms đẩy mực nước. Kill server → **SIMULATED** + backoff; bật lại → tự **LIVE**.
- Không ảnh hưởng Offline Sync (khác path `/ws`).
