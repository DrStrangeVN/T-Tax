import React, { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { TransportProvider, TTaxApp, type TTaxTransport } from "@t-tax/ui"
import { buildDesktopTransport, type DesktopBridge } from "./transport-bridge"
import "./index.css"

declare global {
  interface Window {
    ttaxDesktop: DesktopBridge
  }
}

function Bootstrap() {
  const [transport, setTransport] = useState<TTaxTransport | null>(null)

  useEffect(() => {
    window.ttaxDesktop.getPlatform().then((p) => {
      setTransport(buildDesktopTransport(p))
    })
  }, [])

  if (!transport) return null

  return (
    <TransportProvider transport={transport}>
      <TTaxApp />
    </TransportProvider>
  )
}

createRoot(document.getElementById("root")!).render(<Bootstrap />)
