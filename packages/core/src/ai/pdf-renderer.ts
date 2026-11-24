import sharp from "sharp"
import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas"

export type AttachmentImageFormat = "webp" | "png" | "jpeg"

export interface RenderedPage {
  pageIndex: number
  mediaType: string
  buffer: Buffer
}

export interface PdfInspectionResult {
  pageCount: number
  extractedText: string
  hasRichTextLayer: boolean
  pages: RenderedPage[]
}

class NodeCanvasFactory {
  create(width: number, height: number): { canvas: Canvas; context: SKRSContext2D } {
    const canvas = createCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)))
    const context = canvas.getContext("2d")
    return { canvas, context }
  }
  reset(canvasAndContext: { canvas: Canvas; context: SKRSContext2D }, width: number, height: number) {
    canvasAndContext.canvas.width = Math.max(1, Math.ceil(width))
    canvasAndContext.canvas.height = Math.max(1, Math.ceil(height))
  }
  destroy(canvasAndContext: { canvas: Canvas; context: SKRSContext2D }) {
    canvasAndContext.canvas.width = 0
    canvasAndContext.canvas.height = 0
  }
}

export async function normalizeImageForLLM(
  buffer: Buffer,
  format: AttachmentImageFormat = "webp",
  maxDimension = 1800
): Promise<{ mediaType: string; buffer: Buffer }> {
  const img = sharp(buffer, { failOn: "none" })
    .rotate()
    .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })

  if (format === "png") {
    return { mediaType: "image/png", buffer: await img.png({ compressionLevel: 8 }).toBuffer() }
  }
  if (format === "jpeg") {
    return { mediaType: "image/jpeg", buffer: await img.jpeg({ quality: 86 }).toBuffer() }
  }
  return { mediaType: "image/webp", buffer: await img.webp({ quality: 84 }).toBuffer() }
}

/**
 * Extracts text layer and renders up to `maxPages` pages to images using pdfjs-dist + @napi-rs/canvas + sharp.
 * Requires zero external Ghostscript or GraphicsMagick binaries on macOS or Windows.
 */
export async function inspectAndRenderPdf(
  pdfBuffer: Buffer,
  options: { maxPages?: number; format?: AttachmentImageFormat; renderImages?: boolean } = {}
): Promise<PdfInspectionResult> {
  const maxPages = options.maxPages ?? 4
  const format = options.format ?? "webp"
  const renderImages = options.renderImages ?? true

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    useSystemFonts: true,
    disableFontFace: true,
    CanvasFactory: NodeCanvasFactory,
    verbosity: 0
  })

  const doc = await loadingTask.promise
  const pageCount = doc.numPages
  const limit = Math.min(pageCount, maxPages)
  const textChunks: string[] = []
  const pages: RenderedPage[] = []
  const canvasFactory = new NodeCanvasFactory()

  for (let p = 1; p <= limit; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
    if (pageText) textChunks.push(pageText)

    if (renderImages) {
      const viewport = page.getViewport({ scale: 2.0 })
      const { canvas, context } = canvasFactory.create(viewport.width, viewport.height)
      // White page background so dark/transparent PDFs stay legible
      context.fillStyle = "#ffffff"
      context.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport
      }).promise

      const pngBuf = canvas.toBuffer("image/png")
      const normalized = await normalizeImageForLLM(pngBuf, format)
      pages.push({
        pageIndex: p,
        mediaType: normalized.mediaType,
        buffer: normalized.buffer
      })
      canvasFactory.destroy({ canvas, context })
    }
  }

  await doc.destroy()

  const extractedText = textChunks.join("\n").trim()
  const hasRichTextLayer = extractedText.length >= 120

  return {
    pageCount,
    extractedText,
    hasRichTextLayer,
    pages
  }
}
