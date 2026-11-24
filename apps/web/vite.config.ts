import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { resolve } from "node:path"

export default defineConfig({
  root: resolve("src/client"),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@t-tax/ui": resolve("../../packages/ui/src"),
      "@t-tax/core/browser": resolve("../../packages/core/src/browser.ts"),
      "@t-tax/core": resolve("../../packages/core/src/browser.ts")
    }
  },
  build: {
    outDir: resolve("dist/public"),
    emptyOutDir: true
  },
  server: {
    port: 7332,
    proxy: {
      "/api": "http://localhost:7331"
    }
  }
})
