import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Development proxy: the frontend only uses relative paths
// (fetch("/api/..."), new WebSocket("ws://<same host>/ws")) — no hardcoded localhost.
const API_TARGET = "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: API_TARGET,
      },
      // The WebSocket hub is mounted on the HTTP server itself at /ws
      // (same transport as in production): the proxy never depends on
      // WS_PORT, and port 8080 being taken by another service is harmless.
      "/ws": {
        target: API_TARGET,
        ws: true,
      },
    },
  },
});
