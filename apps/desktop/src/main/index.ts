import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron"
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
let emailSyncTimer: ReturnType<typeof setInterval> | null = null

function installAppMenu(getMain: () => BrowserWindow | null) {
  const sendCmd = (cmd: string) => {
    const w = getMain()
    if (w && !w.isDestroyed()) w.webContents.send("ttax:menu-command", cmd)
  }
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [{ role: "appMenu" as const }]
      : []),
    {
      label: "Tệp & Chứng từ",
      submenu: [
        { label: "Nạp chứng từ...", accelerator: "CmdOrCtrl+O", click: () => sendCmd("open-upload") },
        { label: "Xuất Bảng kê HTKK...", accelerator: "CmdOrCtrl+E", click: () => sendCmd("export-htkk") },
        { type: "separator" },
        { role: process.platform === "darwin" ? "close" : "quit" }
      ]
    },
    { role: "editMenu" },
    {
      label: "Hiển thị",
      submenu: [
        { label: "Thu gọn / Mở rộng Sidebar", click: () => sendCmd("toggle-sidebar") },
        { role: "reload" },
        { role: "toggleDevTools" }
      ]
    },
    { role: "windowMenu" }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

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
    ? {
        url: devUrl,
        trayUrl: `${devUrl.replace(/\/$/, "")}/tray.html?view=tray`
      }
    : {
        file: join(__dirname, "../renderer/index.html"),
        trayFile: join(__dirname, "../renderer/tray.html")
      }

  mainWindow = createMainWindow(preloadPath, rendererTarget)
  installAppMenu(() => mainWindow)

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

  // Background IMAP auto-sync scheduler (checks every 5 minutes without blocking shutdown)
  const lastSyncRun = new Map<string, number>()
  emailSyncTimer = setInterval(async () => {
    try {
      const wss = service.listWorkspaces()
      const now = Date.now()
      for (const ws of wss) {
        const sched = service.getAppData<{ enabled?: boolean; intervalMinutes?: number }>(ws.id, "email_schedule")
        if (!sched.enabled) continue
        const intervalMs = Math.max(5, sched.intervalMinutes ?? 30) * 60_000
        const prev = lastSyncRun.get(ws.id) ?? 0
        if (now - prev < intervalMs) continue
        lastSyncRun.set(ws.id, now)
        const mailCfg = service.getAppData<{ servers?: Array<{ id: string; isActive?: boolean }> }>(ws.id, "email")
        for (const srv of mailCfg.servers ?? []) {
          if (srv.isActive === false) continue
          await service.syncEmailNow(ws.id, srv.id, (enc) => secrets.decrypt(enc)).catch(() => {})
        }
        refreshTrayCount()
      }
    } catch {
      // ignore scheduled sync error
    }
  }, 5 * 60_000)
  emailSyncTimer.unref()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().filter((w) => w !== trayCtrl?.popover).length === 0) {
      mainWindow = createMainWindow(preloadPath, rendererTarget)
    } else {
      mainWindow?.show()
    }
  })

  app.on("before-quit", () => {
    if (emailSyncTimer) clearInterval(emailSyncTimer)
    trayCtrl?.destroy()
    conn.close()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})
