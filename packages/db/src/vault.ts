import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { safeAsciiFilename } from "@t-tax/core"

export class VaultStorage {
  constructor(private readonly rootDir: string) {
    mkdirSync(this.rootDir, { recursive: true })
  }

  getRoot(): string {
    return this.rootDir
  }

  saveBuffer(params: {
    workspaceId: string
    filename: string
    buffer: Buffer
    dateHint?: string
  }): {
    fileId: string
    asciiName: string
    relativePath: string
    absolutePath: string
    sha256: string
    sizeBytes: number
  } {
    const fileId = randomUUID()
    const asciiName = safeAsciiFilename(params.filename)
    const monthFolder = (params.dateHint ?? new Date().toISOString()).slice(0, 7) || "undated"
    const relDir = join(params.workspaceId, monthFolder)
    const absDir = join(this.rootDir, relDir)
    mkdirSync(absDir, { recursive: true })

    const diskName = `${fileId.slice(0, 8)}_${asciiName}`
    const relativePath = join(relDir, diskName).replace(/\\/g, "/")
    const absolutePath = join(this.rootDir, relativePath)
    writeFileSync(absolutePath, params.buffer)

    const sha256 = createHash("sha256").update(params.buffer).digest("hex")
    return {
      fileId,
      asciiName,
      relativePath,
      absolutePath,
      sha256,
      sizeBytes: params.buffer.byteLength
    }
  }

  resolvePath(relativePath: string): string {
    const abs = resolve(this.rootDir, relativePath)
    if (!abs.startsWith(resolve(this.rootDir))) {
      throw new Error("Invalid vault path traversal attempt")
    }
    return abs
  }

  readFile(relativePath: string): Buffer {
    const abs = this.resolvePath(relativePath)
    return readFileSync(abs)
  }

  exists(relativePath: string): boolean {
    try {
      return existsSync(this.resolvePath(relativePath))
    } catch {
      return false
    }
  }

  deleteFile(relativePath: string): boolean {
    try {
      const abs = this.resolvePath(relativePath)
      if (existsSync(abs)) {
        unlinkSync(abs)
        return true
      }
      return false
    } catch {
      return false
    }
  }

  fileSize(relativePath: string): number {
    try {
      return statSync(this.resolvePath(relativePath)).size
    } catch {
      return 0
    }
  }
}
