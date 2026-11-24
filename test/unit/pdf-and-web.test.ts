import { describe, it, expect } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspectAndRenderPdf, parseTabularBuffer, applyColumnMapping } from "@t-tax/core"

function createMinimalTextPdf(text: string): Buffer {
  const safe = text.replace(/[()\\]/g, "")
  const stream = `BT /F1 14 Tf 50 750 Td (${safe}) Tj ET`
  const objs = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n",
    `4 0 obj << /Length ${Buffer.byteLength(stream)} >> stream\n${stream}\nendstream endobj\n`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n"
  ]
  let out = "%PDF-1.4\n"
  const offsets: number[] = [0]
  for (const o of objs) {
    offsets.push(Buffer.byteLength(out))
    out += o
  }
  const xrefOffset = Buffer.byteLength(out)
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i < offsets.length; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`
  }
  out += `trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(out, "ascii")
}

describe("PDF Renderer (Zero Ghostscript), Tabular Import & Web Hono API", () => {
  it("extracts PDF text layer and renders WebP/PNG preview using pdfjs + @napi-rs/canvas + sharp", async () => {
    const pdfBuf = createMinimalTextPdf("CONG TY TNHH T-TAX INVOICE TOTAL 15000000 VND MST 0312345678")
    const res = await inspectAndRenderPdf(pdfBuf, { maxPages: 2, format: "webp", renderImages: true })
    expect(res.pageCount).toBe(1)
    expect(res.extractedText).toContain("0312345678")
    expect(res.pages).toHaveLength(1)
    expect(res.pages[0]?.mediaType).toBe("image/webp")
    expect(res.pages[0]?.buffer.byteLength).toBeGreaterThan(100)
  })

  it("parses CSV tabular import and auto-maps Vietnamese headers", async () => {
    const csv = `Ngày lập,Tên,Nhà cung cấp,MST,Tổng tiền,Thuế GTGT,Danh mục\n2026-06-01,Dịch vụ AWS,Amazon Web Services,0101234567,5500000,500000,Phần mềm & Cloud\n`
    const prev = await parseTabularBuffer("import.csv", Buffer.from(csv, "utf8"))
    expect(prev.suggestedMapping["MST"]).toBe("merchantTaxCode")
    expect(prev.suggestedMapping["Tổng tiền"]).toBe("totalAmount")
    const mapped = applyColumnMapping(prev.headers, prev.rows, prev.suggestedMapping, "input")
    expect(mapped).toHaveLength(1)
    expect(mapped[0]?.preTaxAmount).toBe(5_000_000)
    expect(mapped[0]?.merchantTaxCode).toBe("0101234567")
  })

  it("serves Hono Web API routes cleanly", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ttax-web-"))
    process.env.TTAX_DATA_DIR = tmp
    process.env.TTAX_NO_LISTEN = "1"
    const { app } = await import("../../apps/web/src/server.js")

    const health = await app.request("/api/health")
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true, service: "t-tax-web" })

    const wsRes = await app.request("/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "listWorkspaces" })
    })
    expect(wsRes.status).toBe(200)
    const wss = (await wsRes.json()) as Array<{ id: string; taxCode: string }>
    expect(wss.length).toBeGreaterThanOrEqual(1)

    rmSync(tmp, { recursive: true, force: true })
  })
})
