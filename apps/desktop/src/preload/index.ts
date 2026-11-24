import { contextBridge, ipcRenderer, webUtils } from "electron"

const invoke = (method: string, ...args: unknown[]) => ipcRenderer.invoke("ttax:rpc", method, args)

const api = {
  getPlatform: () => ipcRenderer.invoke("ttax:platform") as Promise<"macos" | "windows" | "linux">,
  setThemeSource: (mode: "dark" | "light" | "system") => ipcRenderer.invoke("ttax:set-theme-source", mode),
  windowAction: (action: "minimize" | "maximize" | "close" | "open-main") =>
    ipcRenderer.invoke("ttax:window-action", action),
  getNativeFilePaths: (files: File[]): string[] =>
    files.map((f) => {
      try {
        return webUtils.getPathForFile(f) || ""
      } catch {
        return ""
      }
    }),
  onNativeThemeChange: (cb: (info: { shouldUseDarkColors: boolean; reduceTransparency: boolean }) => void) => {
    const handler = (_ev: unknown, info: { shouldUseDarkColors: boolean; reduceTransparency: boolean }) => cb(info)
    ipcRenderer.on("ttax:theme-changed", handler)
    return () => ipcRenderer.removeListener("ttax:theme-changed", handler)
  },
  onFilesDroppedFromTray: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on("ttax:tray-dropped", handler)
    return () => ipcRenderer.removeListener("ttax:tray-dropped", handler)
  },
  onBatchAnalyzeProgress: (cb: (ev: unknown) => void) => {
    const handler = (_ev: unknown, data: unknown) => cb(data)
    ipcRenderer.on("ttax:batch-progress", handler)
    return () => ipcRenderer.removeListener("ttax:batch-progress", handler)
  },
  onMenuCommand: (cb: (cmd: string) => void) => {
    const handler = (_ev: unknown, cmd: string) => cb(cmd)
    ipcRenderer.on("ttax:menu-command", handler)
    return () => ipcRenderer.removeListener("ttax:menu-command", handler)
  },
  rpc: invoke
}

contextBridge.exposeInMainWorld("ttaxDesktop", api)
