import sharp from "sharp"
import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

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

export interface NormalizedImageResult {
  mediaType: string
  buffer: Buffer
  rotatedDeg: number
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

/**
 * Uses local Tesseract OSD (`--psm 0`) to detect 90° / 180° / 270° rotated phone photos
 * that lack EXIF orientation tags. Returns 0 silently if Tesseract is unavailable or uncertain.
 */
export async function detectImageOrientationDeg(buffer: Buffer): Promise<number> {
  let dir: string | null = null
  try {
    const meta = await sharp(buffer, { failOn: "none" }).metadata()
    if ((meta.width ?? 0) < 500 || (meta.height ?? 0) < 500) {
      return 0
    }
    // Preserve detail for small receipts in phone frames while respecting EXIF orientation first
    const probeBuf = await sharp(buffer, { failOn: "none" })
      .rotate()
      .resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer()

    dir = await mkdtemp(join(tmpdir(), "ttax-osd-"))
    const imgPath = join(dir, "probe.jpg")
    await writeFile(imgPath, probeBuf)

    const { stdout, stderr } = await execFileAsync("tesseract", [imgPath, "stdout", "--psm", "0"], {
      timeout: 6000,
      maxBuffer: 1024 * 512
    })
    const combined = `${stdout}\n${stderr}`
    const rotMatch = combined.match(/Rotate:\s*(\d+)/i)
    const confMatch = combined.match(/Orientation confidence:\s*([\d.]+)/i)
    const rot = rotMatch ? Number(rotMatch[1]) : 0
    const conf = confMatch ? Number(confMatch[1]) : 0

    // High-confidence threshold prevents false 180° flips on messy Vietnamese handwriting
    if ((rot === 90 || rot === 180 || rot === 270) && conf >= 2.2) {
      return rot
    }
    return 0
  } catch {
    return 0
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/**
 * Runs local offline Tesseract OCR (`vie+eng`, falling back to `eng`) on an image buffer.
 * Returns empty string silently if Tesseract CLI is not installed on the host.
 */
export async function runLocalTesseractOcr(buffer: Buffer): Promise<string> {
  let dir: string | null = null
  try {
    const cleanBuf = await sharp(buffer, { failOn: "none" })
      .rotate()
      .resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true })
      .greyscale()
      .normalise()
      .sharpen({ sigma: 0.9 })
      .png()
      .toBuffer()

    dir = await mkdtemp(join(tmpdir(), "ttax-ocr-"))
    const imgPath = join(dir, "page.png")
    await writeFile(imgPath, cleanBuf)

    try {
      const { stdout } = await execFileAsync("tesseract", [imgPath, "stdout", "-l", "vie+eng", "--psm", "6"], {
        timeout: 15000,
        maxBuffer: 1024 * 1024 * 4
      })
      return stdout.trim()
    } catch {
      const { stdout } = await execFileAsync("tesseract", [imgPath, "stdout", "-l", "eng", "--psm", "6"], {
        timeout: 15000,
        maxBuffer: 1024 * 1024 * 4
      })
      return stdout.trim()
    }
  } catch {
    return ""
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

export async function normalizeImageForLLM(
  buffer: Buffer,
  format: AttachmentImageFormat = "webp",
  maxDimension = 1800,
  options: { autoOrient?: boolean; enhanceHandwriting?: boolean } = {}
): Promise<NormalizedImageResult> {
  const rotatedDeg = options.autoOrient ? await detectImageOrientationDeg(buffer) : 0

  let img = sharp(buffer, { failOn: "none" }).rotate()
  if (rotatedDeg !== 0) {
    img = img.rotate(rotatedDeg)
  }
  img = img.resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })

  if (options.enhanceHandwriting) {
    // Gentle contrast stretch & ink sharpening that preserves pen color cues on carbon paper
    img = img.normalise({ lower: 1, upper: 99 }).sharpen({ sigma: 0.85 })
  }

  if (format === "png") {
    return { mediaType: "image/png", buffer: await img.png({ compressionLevel: 8 }).toBuffer(), rotatedDeg }
  }
  if (format === "jpeg") {
    return { mediaType: "image/jpeg", buffer: await img.jpeg({ quality: 88 }).toBuffer(), rotatedDeg }
  }
  return { mediaType: "image/webp", buffer: await img.webp({ quality: 84 }).toBuffer(), rotatedDeg }
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
