import { XMLParser } from "fast-xml-parser"
import { Decimal } from "decimal.js"
import type {
  LineItemDTO,
  ParsedEInvoice,
  PartyInfo,
  RelatedInvoiceRef,
  VatBreakdownEntry
} from "../types.js"
import { decodeInvoiceSymbol } from "./symbol-decoder.js"

type XmlNode = Record<string, unknown>

const ARRAY_TAGS = new Set(["HHDVu", "LTSuat", "TTin", "Signature", "Reference", "X509Certificate"])

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false, // Critical: preserve leading zeros in MST & SHDon
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name)
})

function asNode(value: unknown): XmlNode | undefined {
  if (Array.isArray(value)) {
    return asNode(value[0])
  }
  return typeof value === "object" && value !== null ? (value as XmlNode) : undefined
}

function getText(node: XmlNode | undefined, key: string): string | undefined {
  if (!node) return undefined
  const value = node[key]
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value)) return getText({ v: value[0] }, "v")
  if (typeof value === "object") {
    const inner = (value as XmlNode)["#text"]
    if (inner === undefined || inner === null) return undefined
    const s = String(inner).trim()
    return s === "" ? undefined : s
  }
  const s = String(value).trim()
  return s === "" ? undefined : s
}

function toNumber(raw: string | undefined, fallback = 0): number {
  if (!raw) return fallback
  const cleaned = raw.replace(/,/g, "").trim()
  if (!cleaned) return fallback
  try {
    const d = new Decimal(cleaned)
    return d.isFinite() ? Math.round(d.toNumber()) : fallback
  } catch {
    return fallback
  }
}

function toDecimalString(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const cleaned = raw.replace(/,/g, "").trim()
  if (!cleaned) return undefined
  try {
    const d = new Decimal(cleaned)
    return d.isFinite() ? d.toString() : undefined
  } catch {
    return undefined
  }
}

function normalizeDate(raw: string | undefined): string {
  if (!raw) return ""
  const trimmed = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10)
  const dmy = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})/)
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`
  return trimmed
}

function findDataBlock(root: XmlNode): { hdon: XmlNode; dlhdon: XmlNode } | undefined {
  const hdon = asNode(root["HDon"]) ?? asNode(root["TDiep"] && asNode(asNode(root["TDiep"])?.["DLieu"])?.["HDon"]) ?? root
  if (!hdon) return undefined

  const direct = asNode(hdon["DLHDon"])
  if (direct) return { hdon, dlhdon: direct }

  const dlieu = asNode(hdon["DLieu"])
  if (dlieu) {
    const innerHdon = asNode(dlieu["HDon"])
    if (innerHdon && asNode(innerHdon["DLHDon"])) {
      return { hdon: innerHdon, dlhdon: asNode(innerHdon["DLHDon"])! }
    }
    const innerDl = asNode(dlieu["DLHDon"])
    if (innerDl) return { hdon, dlhdon: innerDl }
    if (dlieu["TTChung"]) return { hdon, dlhdon: dlieu }
  }

  if (hdon["TTChung"] && hdon["NDHDon"]) return { hdon, dlhdon: hdon }
  return undefined
}

function parseParty(node: XmlNode | undefined, isBuyer: boolean): PartyInfo {
  const party: PartyInfo = {}
  const assign = (k: keyof PartyInfo, val: string | undefined) => {
    if (val !== undefined) party[k] = val
  }
  assign("name", getText(node, "Ten"))
  assign("taxCode", getText(node, "MST"))
  assign("address", getText(node, "DChi"))
  assign("phone", getText(node, "SDThoai"))
  assign("email", getText(node, "DCTDTu"))
  assign("bankAccount", getText(node, "STKNHang"))
  assign("bankName", getText(node, "TNHang"))
  if (isBuyer) {
    assign("contactName", getText(node, "HVTNMHang"))
    assign("buyerCode", getText(node, "MKHang"))
    assign("citizenId", getText(node, "CCCDan") ?? getText(node, "SoCMND"))
    assign("budgetUnitCode", getText(node, "MDVQHNSach") ?? getText(node, "MaDVQHNS"))
  }
  return party
}

function parseLineItem(node: XmlNode, fallbackIdx: number): LineItemDTO {
  const preTax = toNumber(getText(node, "ThTien"), 0)
  const vatAmountRaw = getText(node, "TThue")
  const tsuat = getText(node, "TSuat")
  let vatAmount = vatAmountRaw ? toNumber(vatAmountRaw, 0) : undefined

  if (vatAmount === undefined && tsuat) {
    const rateMatch = tsuat.match(/^(\d+(?:\.\d+)?)%?$/)
    if (rateMatch && rateMatch[1]) {
      vatAmount = new Decimal(preTax).mul(rateMatch[1]).div(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber()
    }
  }

  const discountAmount = toNumber(getText(node, "STCKhau"), 0)
  const amount = vatAmount !== undefined ? preTax + vatAmount : preTax

  return {
    index: toNumber(getText(node, "STT"), fallbackIdx),
    nature: getText(node, "TChat") ? toNumber(getText(node, "TChat"), 1) : 1,
    code: getText(node, "MHHDVu"),
    name: getText(node, "THHDVu") ?? "",
    unit: getText(node, "DVTinh"),
    quantity: toDecimalString(getText(node, "SLuong")),
    unitPrice: toDecimalString(getText(node, "DGia")),
    discountRate: toDecimalString(getText(node, "TLCKhau")),
    discountAmount: discountAmount || undefined,
    preTaxAmount: preTax,
    vatRate: tsuat,
    vatAmount,
    amount
  }
}

function parseVatBreakdown(ttoan: XmlNode | undefined): VatBreakdownEntry[] {
  const wrapper = asNode(ttoan?.["THTTLTSuat"])
  const rawList = wrapper?.["LTSuat"]
  const arr = Array.isArray(rawList) ? rawList : rawList ? [rawList] : []
  const result: VatBreakdownEntry[] = []

  for (const entry of arr) {
    const n = asNode(entry)
    if (!n) continue
    result.push({
      vatRate: getText(n, "TSuat") ?? "",
      taxableAmount: toNumber(getText(n, "ThTien"), 0),
      vatAmount: toNumber(getText(n, "TThue"), 0)
    })
  }
  return result
}

function parseRelatedInvoice(ttchung: XmlNode): RelatedInvoiceRef | undefined {
  const rel = asNode(ttchung["TTHDLQuan"])
  if (!rel) return undefined
  return {
    nature: getText(rel, "TCHDon") ? toNumber(getText(rel, "TCHDon"), 0) : undefined,
    templateCode: getText(rel, "KHMSHDCLQuan"),
    symbol: getText(rel, "KHHDCLQuan"),
    number: getText(rel, "SHDCLQuan"),
    issuedDate: normalizeDate(getText(rel, "NLHDCLQuan")),
    note: getText(rel, "GChu")
  }
}

export function extractTT78Xml(rawXml: string): ParsedEInvoice {
  const cleanedXml = rawXml.replace(/^\uFEFF/, "").trim()
  if (!cleanedXml.startsWith("<")) {
    throw new Error("Tệp không phải định dạng XML hợp lệ.")
  }

  const parsed = asNode(parser.parse(cleanedXml))
  if (!parsed) {
    throw new Error("Không thể phân tích cấu trúc XML.")
  }

  const found = findDataBlock(parsed)
  if (!found) {
    throw new Error("Không tìm thấy khối dữ liệu hóa đơn (DLHDon) theo chuẩn QĐ 1450/1510.")
  }

  const { hdon, dlhdon } = found
  const ttchung = asNode(dlhdon["TTChung"])
  const ndhdon = asNode(dlhdon["NDHDon"])
  if (!ttchung || !ndhdon) {
    throw new Error("XML thiếu thẻ bắt buộc TTChung hoặc NDHDon.")
  }

  const templateCode = getText(ttchung, "KHMSHDon") ?? "1"
  const symbol = getText(ttchung, "KHHDon") ?? ""
  const invoiceNumber = getText(ttchung, "SHDon") ?? ""
  const seller = parseParty(asNode(ndhdon["NBan"]), false)
  const buyer = parseParty(asNode(ndhdon["NMua"]), true)

  const dshhdvu = asNode(ndhdon["DSHHDVu"])
  const rawItems = dshhdvu?.["HHDVu"]
  const itemNodes = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : []
  const items: LineItemDTO[] = itemNodes
    .map((entry) => asNode(entry))
    .filter((entry): entry is XmlNode => entry !== undefined)
    .map((node, idx) => parseLineItem(node, idx + 1))

  const ttoan = asNode(ndhdon["TToan"])
  const vatBreakdown = parseVatBreakdown(ttoan)

  const totalBeforeVat = toNumber(
    getText(ttoan, "TgTCThue"),
    items.reduce((sum, it) => sum + (it.nature === 3 ? -it.preTaxAmount : it.preTaxAmount), 0)
  )
  const totalDiscount = toNumber(getText(ttoan, "TgCKTMai"), 0)
  const totalVat = toNumber(
    getText(ttoan, "TgTThue"),
    vatBreakdown.reduce((sum, v) => sum + v.vatAmount, 0)
  )
  const totalPayable = toNumber(getText(ttoan, "TgTTTBSo"), totalBeforeVat + totalVat)

  const mccqt = getText(hdon, "MCCQT") ?? getText(dlhdon, "MCCQT")
  const dsks = asNode(hdon["DSCKS"]) ?? asNode(dlhdon["DSCKS"])
  const hasDSCKS = Boolean(dsks && (dsks["NBan"] || dsks["CQT"] || dsks["CCKSKhac"]))
  const rawSignatureXmlPresent = /<([a-zA-Z0-9_-]+:)?Signature[\s>]/i.test(cleanedXml)

  const decodedSymbol = decodeInvoiceSymbol(symbol, templateCode)
  const uniqueKey = `${seller.taxCode ?? "UNKNOWN"}|${templateCode}|${symbol}|${invoiceNumber}`

  // Extract QR if stored in TTKhac
  let qrContent: string | undefined
  const ttkhac = asNode(dlhdon["TTKhac"]) ?? asNode(ttchung["TTKhac"])
  const ttins = ttkhac?.["TTin"]
  const ttinArr = Array.isArray(ttins) ? ttins : ttins ? [ttins] : []
  for (const t of ttinArr) {
    const tn = asNode(t)
    const fieldName = getText(tn, "TTruong")?.toLowerCase()
    if (fieldName && (fieldName.includes("qr") || fieldName.includes("tracuu") || fieldName.includes("link"))) {
      qrContent = getText(tn, "DLieu")
      if (qrContent) break
    }
  }

  return {
    uniqueKey,
    version: getText(ttchung, "PBan"),
    invoiceTitle: getText(ttchung, "THDon"),
    templateCode,
    symbol,
    decodedSymbol,
    invoiceNumber,
    issuedDate: normalizeDate(getText(ttchung, "NLap")),
    signedDate: normalizeDate(getText(asNode(dsks?.["NBan"]), "SigningTime")),
    currencyCode: (getText(ttchung, "DVTTe") ?? "VND").toUpperCase(),
    exchangeRate: toDecimalString(getText(ttchung, "TGia")) ?? "1",
    paymentMethod: getText(ttchung, "HTTToan"),
    mccqt,
    tvanTaxCode: getText(ttchung, "MSTTCGP"),
    relatedInvoice: parseRelatedInvoice(ttchung),
    seller,
    buyer,
    items,
    vatBreakdown,
    totals: {
      totalBeforeVat,
      totalDiscount,
      totalVat,
      totalPayable,
      totalPayableInWords: getText(ttoan, "TgTTTBChu")
    },
    hasDigitalSignature: hasDSCKS || rawSignatureXmlPresent,
    rawSignatureXmlPresent,
    qrContent
  }
}
