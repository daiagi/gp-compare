import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server = "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, proxy: { "/api": server, "/archive": server } },
});
