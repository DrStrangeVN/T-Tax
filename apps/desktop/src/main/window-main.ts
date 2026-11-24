import { app, BrowserWindow, nativeTheme, screen, systemPreferences } from "electron"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

interface SavedBounds {
  width: number
  height: number
  x?: number
  y?: number
  isMaximized?: boolean
}

function loadSavedBounds(): SavedBounds {
  const fallback: SavedBounds = { width: 1240, height: 820 }
  try {
    const file = join(app.getPath("userData"), "window-bounds.json")
    if (!existsSync(file)) return fallback
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SavedBounds>
    const width = typeof parsed.width === "number" ? Math.max(940, parsed.width) : 1240
    const height = typeof parsed.height === "number" ? Math.max(640, parsed.height) : 820
    if (typeof parsed.x === "number" && typeof parsed.y === "number") {
      const disp = screen.getDisplayMatching({ x: parsed.x, y: parsed.y, width, height })
      const wa = disp.workArea
      if (parsed.x >= wa.x - 100 && parsed.x < wa.x + wa.width - 100 && parsed.y >= wa.y - 40 && parsed.y < wa.y + wa.height - 80) {
        return { width, height, x: parsed.x, y: parsed.y, isMaximized: Boolean(parsed.isMaximized) }
      }
    }
    return { width, height, isMaximized: Boolean(parsed.isMaximized) }
  } catch {
    return fallback
  }
}

function saveWindowBounds(win: BrowserWindow) {
  try {
    if (win.isDestroyed()) return
    const bounds = win.getNormalBounds()
    const payload: SavedBounds = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized: win.isMaximized()
    }
    writeFileSync(join(app.getPath("userData"), "window-bounds.json"), JSON.stringify(payload))
  } catch {
    // ignore
  }
}

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
  const saved = loadSavedBounds()

  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    ...(typeof saved.x === "number" && typeof saved.y === "number" ? { x: saved.x, y: saved.y } : {}),
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
    if (saved.isMaximized) win.maximize()
    win.show()
    win.webContents.send("ttax:theme-changed", {
      shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
      reduceTransparency: readReduceTransparency()
    })
  })

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => saveWindowBounds(win), 250)
  }
  win.on("resize", scheduleSave)
  win.on("move", scheduleSave)
  win.on("maximize", scheduleSave)
  win.on("unmaximize", scheduleSave)

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
    if (saveTimer) clearTimeout(saveTimer)
    saveWindowBounds(win)
    nativeTheme.off("updated", notifyTheme)
  })

  return win
}

export function resolvePreloadPath(dirnameVal: string): string {
  return join(dirnameVal, "../preload/index.cjs")
}
