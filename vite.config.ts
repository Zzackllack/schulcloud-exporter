import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    // Must match the port `node src/cli.mjs serve` listens on (PORT or 4317).
    proxy: {
      "/api": "http://127.0.0.1:4317",
      "/media": "http://127.0.0.1:4317",
    },
  },
});
