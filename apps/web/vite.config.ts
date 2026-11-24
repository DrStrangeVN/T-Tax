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
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const nid = id.replace(/\\/g, "/")
          if (nid.includes("/node_modules/react/") || nid.includes("/node_modules/react-dom/") || nid.includes("/node_modules/scheduler/")) {
            return "vendor-react"
          }
          if (nid.includes("/node_modules/lucide-react/")) return "vendor-icons"
          return undefined
        }
      }
    }
  },
  server: {
    port: 7332,
    proxy: {
      "/api": "http://localhost:7331"
    }
  }
})
