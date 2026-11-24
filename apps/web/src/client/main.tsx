import React from "react"
import { createRoot } from "react-dom/client"
import { TransportProvider, TTaxApp, createHttpTransport } from "@t-tax/ui"
import "./index.css"

const transport = createHttpTransport("/api")

createRoot(document.getElementById("root")!).render(
  <TransportProvider transport={transport}>
    <TTaxApp />
  </TransportProvider>
)
