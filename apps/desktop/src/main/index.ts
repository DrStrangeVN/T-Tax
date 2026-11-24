import { app, BrowserWindow } from "electron"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { openTTaxDatabase, TTaxService, VaultStorage } from "@t-tax/db"
import { createMainWindow } from "./window-main.js"
import { createTrayController, type TrayController } from "./window-tray.js"
import { registerIpcHandlers } from "./ipc.js"
import { SecretVault } from "./secrets.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

if (process.env.TTAX_USER_DATA_DIR) {
  app.setPath("userData", process.env.TTAX_USER_DATA_DIR)
}

let mainWindow: BrowserWindow | null = null
let trayCtrl: TrayController | null = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

app.whenReady().then(() => {
  const userDataDir = process.env.TTAX_USER_DATA_DIR || app.getPath("userData")
  const dbPath = join(userDataDir, "ttax.db")
  const vaultDir = join(userDataDir, "vault")

  const conn = openTTaxDatabase(dbPath)
  const vault = new VaultStorage(vaultDir)
  const service = new TTaxService(conn.db, conn.sqlite, vault)
  const defaultWs = service.ensureWorkspace()
  const secrets = new SecretVault(userDataDir)

  const preloadPath = join(__dirname, "../preload/index.cjs")
  const devUrl = process.env.ELECTRON_RENDERER_URL
  const rendererTarget = devUrl
    ? { url: devUrl }
    : { file: join(__dirname, "../renderer/index.html") }

  mainWindow = createMainWindow(preloadPath, rendererTarget)

  const refreshTrayCount = () => {
    try {
      const pending = service.listFiles(defaultWs.id, { unreviewedOnly: true }).length
      trayCtrl?.updateTooltip(pending)
    } catch {
      // ignore
    }
  }

  trayCtrl = createTrayController({
    preloadPath,
    rendererUrlOrFile: rendererTarget,
    service,
    getMainWindow: () => mainWindow
  })
  refreshTrayCount()

  registerIpcHandlers({
    service,
    secrets,
    getMainWindow: () => mainWindow,
    onCountsChanged: refreshTrayCount
  })

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().filter((w) => w !== trayCtrl?.popover).length === 0) {
      mainWindow = createMainWindow(preloadPath, rendererTarget)
    } else {
      mainWindow?.show()
    }
  })

  app.on("before-quit", () => {
    trayCtrl?.destroy()
    conn.close()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})
