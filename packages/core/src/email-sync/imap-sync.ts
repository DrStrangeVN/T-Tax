import { ImapFlow } from "imapflow"
import { simpleParser } from "mailparser"
export { EMAIL_PROVIDER_PRESETS } from "./presets.js"

export interface EmailServerConfig {
  id: string
  name: string
  provider: "gmail" | "outlook" | "hotmail" | "fastmail" | "yahoo" | "apple" | "custom"
  host: string
  port: number
  secure: boolean
  username: string
  encryptedPassword: string
  folder: string
  allowedExtensions: string[]
  syncIntervalMinutes: number
  lastProcessedUid: number
  lastSyncedAt?: string
  status?: "connected" | "error" | "idle"
  errorMessage?: string | null
  isActive: boolean
}

export interface FetchedAttachment {
  filename: string
  mimetype: string
  buffer: Buffer
  uid: number
  emailSubject: string
  emailFrom: string
  emailDate?: string
}

export function attachmentMatchesExtensions(filename: string, allowed: string[]): boolean {
  const lower = filename.toLowerCase()
  const exts = allowed.length ? allowed : [".xml", ".pdf", ".zip", ".png", ".jpg", ".jpeg", ".webp"]
  return exts.some((ext) => lower.endsWith(ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`))
}

/**
 * Fetches attachments newer than `lastProcessedUid` safely via imapflow.
 */
export async function syncEmailAttachments(params: {
  host: string
  port: number
  secure: boolean
  username: string
  password: string
  folder?: string
  lastProcessedUid?: number
  allowedExtensions?: string[]
  maxMessages?: number
}): Promise<{ attachments: FetchedAttachment[]; maxUid: number }> {
  const client = new ImapFlow({
    host: params.host,
    port: params.port,
    secure: params.secure,
    auth: {
      user: params.username,
      pass: params.password
    },
    logger: false
  })

  await client.connect()
  const lock = await client.getMailboxLock(params.folder || "INBOX")

  const attachments: FetchedAttachment[] = []
  let maxUid = params.lastProcessedUid ?? 0
  const allowed = params.allowedExtensions ?? [".xml", ".pdf", ".zip", ".png", ".jpg", ".jpeg", ".webp"]

  try {
    const startUid = maxUid > 0 ? maxUid + 1 : 1
    const uids = await client.search({ uid: `${startUid}:*` }, { uid: true })
    const sorted = (uids || []).filter((u) => u > maxUid).sort((a, b) => a - b).slice(-(params.maxMessages ?? 50))

    if (sorted.length > 0) {
      for await (const msg of client.fetch(sorted, { uid: true, source: true }, { uid: true })) {
        if (msg.uid <= maxUid) continue
        if (msg.source) {
          const parsed = await simpleParser(msg.source)
          for (const att of parsed.attachments ?? []) {
            const fname = att.filename || `attachment-${msg.uid}.bin`
            if (!attachmentMatchesExtensions(fname, allowed)) continue
            attachments.push({
              filename: fname,
              mimetype: att.contentType || "application/octet-stream",
              buffer: att.content,
              uid: msg.uid,
              emailSubject: parsed.subject || "",
              emailFrom: parsed.from?.text || "",
              emailDate: parsed.date?.toISOString()
            })
          }
        }
        if (msg.uid > maxUid) maxUid = msg.uid
      }
    }
  } finally {
    lock.release()
    await client.logout()
  }

  return { attachments, maxUid }
}
