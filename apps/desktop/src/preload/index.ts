import { contextBridge, ipcRenderer } from "electron"

const invoke = (method: string, ...args: unknown[]) => ipcRenderer.invoke("ttax:rpc", method, args)

const api = {
  getPlatform: () => ipcRenderer.invoke("ttax:platform") as Promise<"macos" | "windows" | "linux">,
  setThemeSource: (mode: "dark" | "light" | "system") => ipcRenderer.invoke("ttax:set-theme-source", mode),
  windowAction: (action: "minimize" | "maximize" | "close" | "open-main") =>
    ipcRenderer.invoke("ttax:window-action", action),
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
  rpc: invoke
}

contextBridge.exposeInMainWorld("ttaxDesktop", api)
