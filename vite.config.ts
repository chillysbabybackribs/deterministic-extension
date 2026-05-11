import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: true,
    rollupOptions: {
      input: {
        sidepanel: "src/app/index.html",
        serviceWorker: "src/background/serviceWorker.ts"
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "serviceWorker" ? "background/serviceWorker.js" : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    },
    outDir: "dist",
    emptyOutDir: true
  }
});
