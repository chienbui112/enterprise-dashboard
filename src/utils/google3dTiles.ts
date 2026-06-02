// google3dTiles.ts
// Phase C — Tích hợp 3D Tiles HLOD (chuẩn OGC) bằng deck.gl, chạy interleaved trong MapLibre.
//
// Nguồn: Google Photorealistic 3D Tiles (tileset.json gốc + glTF con, hệ ECEF). deck.gl
// `Tile3DLayer` (qua `@loaders.gl/3d-tiles`) lo toàn bộ traversal/HLOD/SSE + stream + cache,
// còn `@deck.gl/mapbox` `MapboxOverlay({ interleaved: true })` chèn layer vào ĐÚNG ngăn xếp
// render của MapLibre và DÙNG CHUNG depth buffer — nhờ vậy custom FloodWaterLayer (trong suốt)
// vẫn occlude/blend đúng với khối nhà/địa hình thật.
//
// API key: lấy từ biến môi trường VITE_GOOGLE_3D_TILES_KEY (đặt trong .env.local, KHÔNG commit).
// Thiếu key -> tileset 403, dashboard hiện chip lỗi và ở lại chế độ synthetic.

import { MapboxOverlay } from "@deck.gl/mapbox";
import { Tile3DLayer } from "@deck.gl/geo-layers";
import { Tiles3DLoader } from "@loaders.gl/3d-tiles";

// Chỉ đọc từ biến môi trường (đặt trong .env.local) — KHÔNG hardcode key vào source.
export const GOOGLE_3D_TILES_KEY = (import.meta.env.VITE_GOOGLE_3D_TILES_KEY as string | undefined) || "";

const GOOGLE_TILESET_URL = "https://tile.googleapis.com/v1/3dtiles/root.json";

export interface Google3DTilesCallbacks {
  onTilesetLoad?: () => void;
  onError?: (message: string) => void;
  // Chèn TRƯỚC layer này (vd layer mặt nước) để nước trong suốt luôn vẽ sau -> nằm trên.
  beforeId?: string;
}

export const createGoogle3DTilesOverlay = (cb: Google3DTilesCallbacks = {}): MapboxOverlay => {
  const layer = new Tile3DLayer({
    id: "google-3d-tiles",
    data: GOOGLE_TILESET_URL,
    loader: Tiles3DLoader,
    loadOptions: {
      // loaders.gl tự nối session token cho các tile con của Google và tái dùng header này.
      fetch: { headers: { "X-GOOG-API-KEY": GOOGLE_3D_TILES_KEY } },
    },
    beforeId: cb.beforeId,
    onTilesetLoad: () => cb.onTilesetLoad?.(),
    onTileError: (_tile: unknown, message: string) => cb.onError?.(message),
  });

  return new MapboxOverlay({ interleaved: true, layers: [layer] });
};
