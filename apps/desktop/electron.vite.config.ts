import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { resolve } from "node:path"

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ["@t-tax/core", "@t-tax/db"]
      })
    ],
    build: {
      rollupOptions: {
        external: ["better-sqlite3", "sharp", "@napi-rs/canvas", "pdfjs-dist"]
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs"
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
        "@t-tax/ui": resolve("../../packages/ui/src"),
        "@t-tax/core/browser": resolve("../../packages/core/src/browser.ts"),
        "@t-tax/core": resolve("../../packages/core/src/browser.ts")
      }
    },
    build: {
      minify: "esbuild",
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          tray: resolve("src/renderer/tray.html")
        },
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
    plugins: [react(), tailwindcss()]
  }
})
