import { safeStorage } from "electron"
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export class SecretVault {
  private fallbackKey: Buffer | null = null

  constructor(private readonly userDataDir: string) {}

  private getFallbackKey(): Buffer {
    if (this.fallbackKey) return this.fallbackKey
    const secretFile = join(this.userDataDir, ".ttax_secret")
    let rawSecret: string
    if (existsSync(secretFile)) {
      rawSecret = readFileSync(secretFile, "utf8").trim()
    } else {
      mkdirSync(dirname(secretFile), { recursive: true })
      rawSecret = randomBytes(32).toString("hex")
      writeFileSync(secretFile, rawSecret, { mode: 0o600 })
    }
    this.fallbackKey = scryptSync(rawSecret, "t-tax-local-secret-salt", 32)
    return this.fallbackKey
  }

  encrypt(plaintext: string): string {
    if (!plaintext) return ""
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const buf = safeStorage.encryptString(plaintext)
        return `os:${buf.toString("base64")}`
      }
    } catch {
      // Fallback below
    }
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", this.getFallbackKey(), iv)
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
    const tag = cipher.getAuthTag()
    return `aes:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`
  }

  decrypt(stored: string): string {
    if (!stored) return ""
    if (stored.startsWith("os:")) {
      const buf = Buffer.from(stored.slice(3), "base64")
      return safeStorage.decryptString(buf)
    }
    if (stored.startsWith("aes:")) {
      const [, ivB64, tagB64, dataB64] = stored.split(":")
      if (!ivB64 || !tagB64 || !dataB64) return ""
      const decipher = createDecipheriv("aes-256-gcm", this.getFallbackKey(), Buffer.from(ivB64, "base64"))
      decipher.setAuthTag(Buffer.from(tagB64, "base64"))
      return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8")
    }
    return stored
  }
}
