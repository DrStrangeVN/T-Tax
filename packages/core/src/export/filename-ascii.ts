const DIACRITIC_MAP: Record<string, string> = {
  đ: "d",
  Đ: "D"
}

/**
 * Converts Vietnamese text (NFC or NFD) to clean ASCII to prevent macOS NFD vs Windows NFC
 * filename corruption when exchanging archives or uploading to Vietnam tax portals.
 */
export function normalizeVietnameseAscii(input: string): string {
  return input
    .normalize("NFC")
    .replace(/[đĐ]/g, (ch) => DIACRITIC_MAP[ch] ?? ch)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .normalize("NFC")
}

export function safeAsciiFilename(filename: string, fallback = "document"): string {
  const clean = normalizeVietnameseAscii(filename).trim()
  const lastDot = clean.lastIndexOf(".")
  const hasExt = lastDot > 0 && lastDot < clean.length - 1
  const stem = hasExt ? clean.slice(0, lastDot) : clean
  const ext = hasExt ? clean.slice(lastDot).toLowerCase().replace(/[^a-z0-9.]/g, "") : ""

  const safeStem = stem
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_.-]+|[_.-]+$/g, "")

  return `${safeStem || fallback}${ext}`
}

export function codeFromName(name: string): string {
  return normalizeVietnameseAscii(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "item"
}
