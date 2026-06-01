import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
  // Proxy REST + WebSocket sang backend Offline Sync (npm run server, cổng 3001) -> cùng origin, tránh CORS.
  server: {
    proxy: {
      "/api": "http://localhost:3001",
      "/ws": { target: "ws://localhost:3001", ws: true },
    },
  },
  build: {
    // maplibre-gl ~1MB là chunk vendor không thể nhỏ hơn; đã tách riêng nên nâng ngưỡng để hết cảnh báo nhiễu
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        // Tách maplibre-gl (nặng ~1MB) ra chunk vendor riêng: cache độc lập, tải song song với app code
        manualChunks(id) {
          if (id.includes("node_modules/maplibre-gl")) return "maplibre";
        },
      },
    },
  },
})
