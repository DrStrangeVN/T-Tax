import { BrowserWindow, nativeTheme, systemPreferences } from "electron"
import { join } from "node:path"

function readReduceTransparency(): boolean {
  try {
    if (process.platform === "darwin") {
      // Electron systemPreferences exposes accessibilityDisplayShouldReduceTransparency on newer/supported hosts or via user defaults
      const fn = (systemPreferences as unknown as { getUserDefault?: (k: string, t: string) => unknown }).getUserDefault
      if (typeof fn === "function") {
        // Fallback check on macOS Accessibility universalaccess plist
        return Boolean(fn.call(systemPreferences, "reduceTransparency", "boolean"))
      }
    }
  } catch {
    // ignore
  }
  return false
}

export function createMainWindow(preloadPath: string, rendererUrlOrFile: { url?: string; file?: string }): BrowserWindow {
  const isMac = process.platform === "darwin"
  const isWin = process.platform === "win32"

  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    show: false,
    ...(isMac
      ? {
          backgroundColor: "#00000000",
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 16, y: 18 },
          vibrancy: "under-window" as const,
          visualEffectState: "followWindow" as const
        }
      : isWin
        ? {
            backgroundColor: "#0C0E14",
            titleBarStyle: "hidden" as const,
            backgroundMaterial: "mica" as const
          }
        : {
            backgroundColor: "#0C0E14"
          }),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  if (rendererUrlOrFile.url) {
    win.loadURL(rendererUrlOrFile.url)
  } else if (rendererUrlOrFile.file) {
    win.loadFile(rendererUrlOrFile.file)
  }

  win.once("ready-to-show", () => {
    win.show()
    win.webContents.send("ttax:theme-changed", {
      shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
      reduceTransparency: readReduceTransparency()
    })
  })

  const notifyTheme = () => {
    if (!win.isDestroyed()) {
      win.webContents.send("ttax:theme-changed", {
        shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
        reduceTransparency: readReduceTransparency()
      })
    }
  }

  nativeTheme.on("updated", notifyTheme)
  win.on("closed", () => {
    nativeTheme.off("updated", notifyTheme)
  })

  return win
}

export function resolvePreloadPath(dirnameVal: string): string {
  return join(dirnameVal, "../preload/index.cjs")
}
