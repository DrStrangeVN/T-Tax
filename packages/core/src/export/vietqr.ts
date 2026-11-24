import QRCode from "qrcode"
export { VIETNAM_BANKS, type VietnamBankPreset } from "./banks.js"

function tlv(id: string, value: string): string {
  const len = String(Buffer.byteLength(value, "utf8")).padStart(2, "0")
  return `${id}${len}${value}`
}

function crc16CcittFalse(input: string): string {
  let crc = 0xffff
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff
      } else {
        crc = (crc << 1) & 0xffff
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0")
}

/**
 * Generates an EMVCo NAPAS 247 VietQR payload string.
 */
export function buildVietQrPayload(params: {
  bankBin: string
  accountNo: string
  amountVnd?: number
  description?: string
}): string {
  const bin = params.bankBin.trim()
  const acc = params.accountNo.trim()
  const isDynamic = Boolean(params.amountVnd && params.amountVnd > 0)

  const beneficiary = tlv("00", bin) + tlv("01", acc)
  const consumerInfo = tlv("00", "A000000727") + tlv("01", beneficiary) + tlv("02", "QRIBFTTA")

  const parts = [
    tlv("00", "01"),
    tlv("01", isDynamic ? "12" : "11"),
    tlv("38", consumerInfo),
    tlv("53", "704") // VND ISO 4217 numeric
  ]

  if (isDynamic && params.amountVnd) {
    parts.push(tlv("54", String(Math.round(params.amountVnd))))
  }
  parts.push(tlv("58", "VN"))

  if (params.description?.trim()) {
    const cleanDesc = params.description.trim().slice(0, 60)
    parts.push(tlv("62", tlv("08", cleanDesc)))
  }

  const unsigned = parts.join("") + "6304"
  return unsigned + crc16CcittFalse(unsigned)
}

export async function generateVietQrDataUrl(params: {
  bankBin: string
  accountNo: string
  amountVnd?: number
  description?: string
}): Promise<string> {
  const payload = buildVietQrPayload(params)
  return QRCode.toDataURL(payload, { width: 220, margin: 1 })
}
