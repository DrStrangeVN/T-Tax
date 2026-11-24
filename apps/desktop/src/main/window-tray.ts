import { app, BrowserWindow, nativeImage, screen, Tray } from "electron"
import { existsSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import type { TTaxService } from "@t-tax/db"

export interface TrayController {
  tray: Tray
  popover: BrowserWindow
  updateTooltip: (unreviewedCount: number) => void
  destroy: () => void
}

function getResourcePath(name: string): string {
  const devPath = join(app.getAppPath(), "resources", name)
  if (existsSync(devPath)) return devPath
  return join(process.resourcesPath, name)
}

export function createTrayController(params: {
  preloadPath: string
  rendererUrlOrFile: { url?: string; file?: string }
  service: TTaxService
  getMainWindow: () => BrowserWindow | null
}): TrayController {
  const iconFile = process.platform === "darwin" ? "trayTemplate.png" : "icon.png"
  const img = nativeImage.createFromPath(getResourcePath(iconFile))
  if (process.platform === "darwin") {
    img.setTemplateImage(true)
  } else {
    img.resize({ width: 18, height: 18 })
  }

  const tray = new Tray(img)
  if (process.platform === "darwin") {
    tray.setTitle("") // Strictly monochrome logo-only in macOS Menu Bar
  }
  tray.setToolTip("T-Tax — Trợ lý Kế toán & Hóa đơn")

  const popover = new BrowserWindow({
    width: 364,
    height: 440,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: process.platform === "darwin",
    backgroundColor: process.platform === "darwin" ? "#00000000" : "#161923",
    vibrancy: process.platform === "darwin" ? "popover" : undefined,
    webPreferences: {
      preload: params.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  if (params.rendererUrlOrFile.url) {
    popover.loadURL(`${params.rendererUrlOrFile.url}?view=tray`)
  } else if (params.rendererUrlOrFile.file) {
    popover.loadFile(params.rendererUrlOrFile.file, { query: { view: "tray" } })
  }

  popover.on("blur", () => {
    if (popover.isVisible()) popover.hide()
  })

  const togglePopover = () => {
    if (popover.isVisible()) {
      popover.hide()
      return
    }
    const trayBounds = tray.getBounds()
    const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })
    const popBounds = popover.getBounds()
    const x = Math.round(
      Math.max(
        display.workArea.x + 8,
        Math.min(
          trayBounds.x + trayBounds.width / 2 - popBounds.width / 2,
          display.workArea.x + display.workArea.width - popBounds.width - 8
        )
      )
    )
    const y =
      process.platform === "darwin"
        ? Math.round(trayBounds.y + trayBounds.height + 6)
        : Math.round(display.workArea.y + display.workArea.height - popBounds.height - 8)
    popover.setPosition(x, y, false)
    popover.webContents.send("ttax:tray-dropped")
    popover.show()
    popover.focus()
  }

  tray.on("click", togglePopover)

  // Support dropping XML / PDF / ZIP files directly onto the macOS Menu Bar icon
  tray.on("drop-files", async (_event, filePaths) => {
    try {
      const ws = params.service.ensureWorkspace()
      const inputs = filePaths.map((fp) => ({
        filename: basename(fp),
        buffer: readFileSync(fp)
      }))
      const res = await params.service.ingestFiles(ws.id, inputs, "tray")
      if (res.createdFiles.length > 0) {
        const mainWin = params.getMainWindow()
        mainWin?.webContents.send("ttax:tray-dropped")
        const pending = params.service.listFiles(ws.id, { unreviewedOnly: true }).length
        tray.setToolTip(`T-Tax — ${pending} chứng từ chờ duyệt`)
      }
    } catch {
      // ignore drop failure
    }
  })

  return {
    tray,
    popover,
    updateTooltip: (unreviewedCount: number) => {
      tray.setToolTip(`T-Tax — ${unreviewedCount} chứng từ chờ duyệt`)
      if (!popover.isDestroyed()) {
        popover.webContents.send("ttax:tray-dropped")
      }
    },
    destroy: () => {
      if (!popover.isDestroyed()) popover.destroy()
      tray.destroy()
    }
  }
}
