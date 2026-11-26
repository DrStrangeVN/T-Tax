import { matchSmartRule } from "../accounting/intelligence.js"
import type { AuditIssue, DocumentKind, FieldProvenance, LineItemDTO, SmartRuleDTO } from "../types.js"

const VI_DIGITS: Record<string, number> = {
  khong: 0,
  linh: 0,
  le: 0,
  mot: 1,
  mots: 1,
  hai: 2,
  ba: 3,
  bon: 4,
  tu: 4,
  nam: 5,
  lam: 5,
  nham: 5,
  sau: 6,
  bay: 7,
  tam: 8,
  chin: 9
}

const EN_NUMS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fourty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90
}

export function stripViAccents(input: string): string {
  return String(input || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim()
}

function parseViThreeDigitGroup(tokens: string[]): number {
  let val = 0
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]!
    const next = tokens[i + 1]
    if (next === "tram" && t in VI_DIGITS) {
      val += VI_DIGITS[t]! * 100
      i += 2
      continue
    }
    if (t === "muoi") {
      // "mười" (10) vs "mươi" (tens multiplier) — both fold to "muoi"
      if (val % 100 === 0) {
        val += 10
      }
      i += 1
      continue
    }
    if (next === "muoi" && t in VI_DIGITS) {
      val += VI_DIGITS[t]! * 10
      i += 2
      continue
    }
    if (t === "linh" || t === "le") {
      i += 1
      continue
    }
    if (t === "ruoi") {
      // handled at scale level
      i += 1
      continue
    }
    if (t in VI_DIGITS) {
      val += VI_DIGITS[t]!
    }
    i += 1
  }
  return val
}

/**
 * Parses Vietnamese ("Năm trăm mười sáu triệu, chín trăm tám mươi sáu ngàn, bảy trăm tám mươi chín đồng")
 * AND English ("Two Thousand Only", "Three Hundred Sixty Rupees Only") money-in-words lines.
 */
export function parseMoneyInWords(rawText?: string | null): number | null {
  if (!rawText || typeof rawText !== "string") return null
  const clean = stripViAccents(rawText)
    .replace(/[,.;:()\-/]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!clean || clean.length < 3) return null

  const tokens = clean.split(" ").filter(Boolean)

  // Detect Vietnamese money words first
  const hasViWords = tokens.some((t) =>
    ["nghin", "ngan", "trieu", "ty", "ti", "tram", "muoi", "dong", "chan"].includes(t)
  )
  if (hasViWords) {
    // Reject obvious hallucinated duplicates like "ngan ... nghin" repeated abnormally
    const scaleHits = tokens.filter((t) => t === "nghin" || t === "ngan").length
    if (scaleHits > 1) {
      // Deduplicate malformed OCR repeats conservatively — do not trust garbled words
      return null
    }
    const stopWords = new Set(["dong", "vnd", "chan", "y", "bang", "chu", "so", "tien", "viet", "cong", "thanh"])
    const numTokens = tokens.filter((t) => !stopWords.has(t))
    if (numTokens.length === 0) return null

    let total = 0
    let group: string[] = []
    let lastScale = 0

    for (let i = 0; i < numTokens.length; i++) {
      const tok = numTokens[i]!
      if (tok === "ty" || tok === "ti") {
        const g = Math.max(1, parseViThreeDigitGroup(group))
        total += g * 1_000_000_000
        group = []
        lastScale = 1_000_000_000
      } else if (tok === "trieu") {
        const g = Math.max(1, parseViThreeDigitGroup(group))
        total += g * 1_000_000
        group = []
        lastScale = 1_000_000
      } else if (tok === "nghin" || tok === "ngan") {
        const g = group.length > 0 ? parseViThreeDigitGroup(group) : 1
        total += g * 1_000
        group = []
        lastScale = 1_000
      } else if (tok === "ruoi" && lastScale > 0) {
        total += lastScale / 2
      } else {
        group.push(tok)
      }
    }
    if (group.length > 0) {
      const rem = parseViThreeDigitGroup(group)
      // Handle "hai trieu nam" -> 2,500,000 when single digit follows trieu/nghin
      if (group.length === 1 && rem >= 1 && rem <= 9 && lastScale >= 1000) {
        total += rem * (lastScale / 10)
      } else {
        total += rem
      }
    }
    return total > 0 ? Math.round(total) : null
  }

  // English money words ("Two Thousand Only", "One Thousand Four Hundred Seventy Six Dollars")
  const hasEnWords = tokens.some((t) => t in EN_NUMS || t === "hundred" || t === "thousand" || t === "million" || t === "lakh")
  if (hasEnWords) {
    let total = 0
    let current = 0
    let seen = false
    for (const tok of tokens) {
      if (tok in EN_NUMS) {
        current += EN_NUMS[tok]!
        seen = true
      } else if (tok === "hundred") {
        current = (current || 1) * 100
        seen = true
      } else if (tok === "thousand") {
        total += (current || 1) * 1000
        current = 0
        seen = true
      } else if (tok === "lakh" || tok === "lakhs") {
        total += (current || 1) * 100_000
        current = 0
        seen = true
      } else if (tok === "million") {
        total += (current || 1) * 1_000_000
        current = 0
        seen = true
      }
    }
    const result = total + current
    return seen && result > 0 ? result : null
  }

  return null
}

/**
 * Coerces numbers from messy handwritten OCR / VLM strings:
 * - "1.340.000 đ", "516.986.789", "430.w", "150k", "1tr5", "2,430", "$1,476.00", "£6.26", "2000/-"
 */
export function parseFlexibleMoney(raw: unknown, currencyCode?: string | null): number | null {
  if (raw === null || raw === undefined) return null
  const cur = (currencyCode || "").toUpperCase()

  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null
    // Repair VND dot-as-thousands float misparse (e.g. "362.852.693" read as 362852.693 or 362852.69)
    if (cur === "VND" && !Number.isInteger(raw)) {
      const decStr = String(raw).split(".")[1] || ""
      if (decStr.length === 3 && raw >= 10) {
        return Math.round(raw * 1000)
      }
      if (raw >= 1000) {
        // VND has zero decimals; e.g. 362852.69 came from 362.852.690
        return Math.round(raw * 1000)
      }
    }
    return raw
  }

  let s = String(raw).trim()
  if (!s) return null
  const lower = stripViAccents(s)

  // Vietnamese shorthand: "1tr5", "1,5tr", "2.5 trieu", "150k", "430.w", "1340.w"
  const trCompact = lower.match(/^([\d.,]+)\s*(?:tr|trieu)\s*(\d)?$/)
  if (trCompact) {
    const base = Number(trCompact[1]!.replace(",", "."))
    const tail = trCompact[2] ? Number(trCompact[2]) * 100_000 : 0
    if (Number.isFinite(base)) return Math.round(base * 1_000_000 + tail)
  }
  const kMatch = lower.match(/^([\d.,]+)\s*(?:k|nghin|ngan)$/)
  if (kMatch) {
    const base = Number(kMatch[1]!.replace(",", "."))
    if (Number.isFinite(base)) return Math.round(base * 1_000)
  }
  // Cursive Vietnamese ".000" written as ".w" or ".uu" or ".00" after a dot on VND bills
  const vnSquiggle = lower.match(/^(\d{1,5})[.,]\s*(?:w|uu|vv|oo|000)$/)
  if (vnSquiggle) {
    return Number(vnSquiggle[1]!) * 1000
  }

  // Strip currency markers and trailing "/-"
  s = s.replace(/\/-$/g, "").replace(/[₫đ$£€¥₹]/gi, "").replace(/\b(?:vnd|vnđ|rs\.?|inr|usd|gbp|try|tl|eur)\b/gi, "").trim()
  s = s.replace(/\s+/g, "")
  if (!s || !/\d/.test(s)) return null

  const zeroDecimalCur = cur === "VND" || cur === "JPY" || cur === "KRW" || cur === "IDR"
  const dotCount = (s.match(/\./g) || []).length
  const commaCount = (s.match(/,/g) || []).length

  if (dotCount > 1 && commaCount === 0) {
    // Clearly thousands separator: 516.986.789 or 1.340.000
    const n = Number(s.replace(/\./g, ""))
    return Number.isFinite(n) ? n : null
  }
  if (commaCount > 1 && dotCount === 0) {
    // Clearly thousands separator: 1,340,000
    const n = Number(s.replace(/,/g, ""))
    return Number.isFinite(n) ? n : null
  }
  if (dotCount === 1 && commaCount === 0) {
    const [left, right] = s.split(".")
    if (right && right.length === 3 && (zeroDecimalCur || (left && Number(left) >= 1))) {
      // e.g. "2.430" (TRY/VND), "150.000", "450.000"
      if (zeroDecimalCur || cur === "TRY" || cur === "INR" || cur === "EUR") {
        const n = Number(`${left}${right}`)
        return Number.isFinite(n) ? n : null
      }
    }
    if (zeroDecimalCur && right && right.length <= 2 && left && Number(left) >= 100) {
      // e.g. "1340.00" on VND bill -> 1,340,000 or 1340
      const n = Number(s)
      return Number.isFinite(n) ? n : null
    }
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }
  if (commaCount === 1 && dotCount === 0) {
    const [left, right] = s.split(",")
    if (right && right.length === 3) {
      const n = Number(`${left}${right}`)
      return Number.isFinite(n) ? n : null
    }
    const n = Number(s.replace(",", "."))
    return Number.isFinite(n) ? n : null
  }
  if (dotCount >= 1 && commaCount >= 1) {
    const lastDot = s.lastIndexOf(".")
    const lastComma = s.lastIndexOf(",")
    if (lastDot > lastComma) {
      // US format: 1,476.00
      const n = Number(s.replace(/,/g, ""))
      return Number.isFinite(n) ? n : null
    } else {
      // VN/EU format: 1.476,50
      const n = Number(s.replace(/\./g, "").replace(",", "."))
      return Number.isFinite(n) ? n : null
    }
  }

  const fallback = Number(s.replace(/[^\d.-]/g, ""))
  return Number.isFinite(fallback) ? fallback : null
}

/**
 * Parses Vietnamese & international handwritten dates into YYYY-MM-DD:
 * - "Ngày 02 tháng 05 năm 2022", "15/08/2019", "15-07-26", "12/20/81", "24/5/24", "18.01.2026"
 */
export function parseFlexibleDate(raw: unknown): string | null {
  if (!raw || typeof raw !== "string") return null
  const s = raw.trim()
  if (!s) return null

  const iso = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (iso) {
    const y = Number(iso[1])
    const m = Number(iso[2])
    const d = Number(iso[3])
    if (y >= 1900 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
    }
  }

  const norm = stripViAccents(s)
  const viProse = norm.match(/ngay\s*(\d{1,2})\s*thang\s*(\d{1,2})\s*nam\s*(\d{2,4})/)
  if (viProse) {
    const d = Number(viProse[1])
    const m = Number(viProse[2])
    let y = Number(viProse[3])
    if (y < 100) y = y >= 50 ? 1900 + y : 2000 + y
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
    }
  }

  const dmy = s.match(/(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{2,4})/)
  if (dmy) {
    let a = Number(dmy[1])
    let b = Number(dmy[2])
    let y = Number(dmy[3])
    if (y < 100) y = y >= 50 ? 1900 + y : 2000 + y
    // Default DD/MM/YYYY (VN & India/UK); swap if month > 12 (US MM/DD/YY like 12/20/81)
    if (b > 12 && a <= 12) {
      const tmp = a
      a = b
      b = tmp
    }
    if (b >= 1 && b <= 12 && a >= 1 && a <= 31 && y >= 1900 && y <= 2099) {
      return `${y}-${String(b).padStart(2, "0")}-${String(a).padStart(2, "0")}`
    }
  }

  return null
}

export function normalizeCurrencyCode(raw: unknown, contextText = ""): string {
  const s = String(raw || "").trim().toUpperCase()
  const ctx = stripViAccents(contextText)

  // Strong geographic/currency evidence overrides a mistaken default "VND" from Vietnamese prompts
  if (
    /\b(?:rupees?|inr|rs\.?|gstin|kerala|aluva|chunangamvely|erumathala|choondy|pasighat|nashik|pune|cuddalore|itanagar|arunachal|maharashtra|indian oil|boban & moly|fresco electricals|benny p\.?d\.?|shalom mattress|varnamm|b&k motorsports|rahul auto|anand electricals|ganesh mobile|laxmi hardware|tashi enterprises)\b/.test(ctx) ||
    contextText.includes("₹")
  ) {
    return "INR"
  }
  if (/\b(?:istanbul|sultanahmet|siparis|fisi|tutar|miktar|kofte|bira|palmiye)\b/.test(ctx) || contextText.includes("₺")) {
    return "TRY"
  }
  if (contextText.includes("£") || /\b(?:manchester|gbp|sterling|pounds|newton heath)\b/.test(ctx)) {
    return "GBP"
  }
  if (contextText.includes("$") || /\b(?:usd|bedford,\s*ma|illinois|kmart|temptations|stella campbell|dollars?)\b/.test(ctx)) {
    return "USD"
  }

  const known = new Set(["VND", "USD", "EUR", "GBP", "INR", "TRY", "JPY", "KRW", "CNY", "SGD", "THB", "AUD", "CAD"])
  if (known.has(s)) return s
  if (s === "VNĐ" || s === "Đ" || s === "DONG") return "VND"
  if (s === "RS" || s === "RS." || s === "₹" || s === "RUPEES" || s === "RUPEE") return "INR"
  if (s === "$" || s === "US$") return "USD"
  if (s === "£") return "GBP"
  if (s === "TL" || s === "₺") return "TRY"

  return "VND"
}

function hasVietnameseEvidence(text: string): boolean {
  if (/[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i.test(text)) {
    return true
  }
  const low = stripViAccents(text)
  return /\b(?:hoa don|thanh tien|tong cong|nha hang|xe may|hai san|ban le|viet nam|ha noi|ho chi minh|da nang|nha trang|vnd|phieu thu|chi vy|my hanh|pgl motor)\b/.test(low)
}

const CATEGORY_ALIASES: Record<string, string> = {
  "an uong": "food",
  "tiep khach": "food",
  "nha hang": "food",
  "restaurant": "food",
  "dining": "food",
  "meals": "food",
  "cafe": "food",
  "van chuyen": "transport",
  "xang dau": "transport",
  "sua xe": "transport",
  "fuel": "transport",
  "automotive": "transport",
  "vehicle": "transport",
  "vat lieu": "materials",
  "nguyen vat lieu": "materials",
  "hardware": "materials",
  "construction": "materials",
  "cong cu": "tools",
  "equipment": "tools",
  "hang hoa": "goods",
  "tap hoa": "goods",
  "clothing": "goods",
  "retail": "goods",
  "groceries": "goods",
  "van phong pham": "office",
  "stationery": "office",
  "dien nuoc": "utility_bills",
  "utilities": "utility_bills",
  "water": "utility_bills",
  "thue nha": "rental",
  "rent": "rental",
  "quang cao": "ads",
  "marketing": "ads",
  "design": "ads",
  "cong tac": "travel",
  "luu tru": "travel",
  "hotel": "travel",
  "phan mem": "software",
  "vien thong": "communication",
  "luong": "salary",
  "thue phi": "fees",
  "dao tao": "education",
  "tai san": "assets"
}

interface LexiconRule {
  category: string
  strong: RegExp[]
  medium: RegExp[]
}

const CATEGORY_LEXICON: LexiconRule[] = [
  {
    category: "transport",
    strong: [
      /\b(?:xe may|o to|oto|sua xe|bao duong xe|pgl motor|honda|yamaha|gara|garage|motorsports?|auto works?)\b/,
      /\b(?:petrol|diesel|hsd|indian oil|xang dau|tram xang|dau lap|dau nhot|engine oil|nhot xe|day cu ?roa|bua con|bo bi vang)\b/,
      /\b(?:brake pad|spark plug|kick rod|clutch plate|tyre tube|headlight|acceleration cable|side mirror)\b/,
      /\b(?:van chuyen|cuoc van tai|chuyen phat|giao hang|grab|xanh sm|cau duong|gui xe)\b/
    ],
    medium: [/\b(?:tyre|tire|brake|fuel|oil|xe ga|phu tung|lop xe|bo thang)\b/]
  },
  {
    category: "food",
    strong: [
      /\b(?:nha hang|quan an|hai san|tom hum|ca mu|ca bo da|muc la|oc huong|oc bien|so diep|ghe do|ghe hap|tu hai|tom su)\b/,
      /\b(?:com trua|com trang|com rang|lau ga|de hap|bo 1 nang|bun cha|bun bo|pho|tra sua|cafe|ca phe|coffee)\b/,
      /\b(?:bia tiger|tiger nau|tiger bac|heineken|larue|ruou can|nuoc ngot|coca|pepsi|khan lanh)\b/,
      /\b(?:restaurant|country club|palmiye cafe|temptations|hamburger|french fries|milkshake|cheeseburger|pancakes|sundae|prawn cocktail|sirloin|t-?bone|kofte|humus|bira)\b/
    ],
    medium: [/\b(?:an sang|tra nhai|rau muong|rau xanh|thit|ga nuong|ban so|mon an|thuc don|waiter|covers|table no|diner|coke)\b/]
  },
  {
    category: "materials",
    strong: [
      /\b(?:vat lieu xay dung|vlxd|xi mang|cement|sat thep|cat da|gach op|son nuoc|paint \d|ong nuoc|day dien)\b/,
      /\b(?:electricals?\s*&\s*hardwares?|fresco electricals|anand electricals|laxmi hardware|wire\s*2\.5mm|wire socket|kilcott|clamps?|pvc pipe)\b/
    ],
    medium: [/\b(?:hardware|electrical|sanitary|bulb|switch|socket|wire|clamp|vat tu)\b/]
  },
  {
    category: "utility_bills",
    strong: [
      /\b(?:purified drinking water|drinking water|benny p\.?d\.?|nuoc uong dong binh|binh nuoc 20l|tien dien|tien nuoc|evn|cap nuoc|ve sinh moi truong)\b/,
      /\b(?:boiler repair|expansion valve|pressure gauge|sealing washers|re-?pressurised|service kit)\b/
    ],
    medium: [/\b(?:20l\s*jar|tien ich|phi quan ly toa nha|dien nuoc)\b/]
  },
  {
    category: "goods",
    strong: [
      /\b(?:sarees?|salwars?|varnamm|blouse|velvet suit|kashmiri|chanderi|grey suit|blue suit|false suit|quan ao|thoi trang)\b/,
      /\b(?:fine groceries|tap hoa|kmart|atari|space invaders|asteroids|mattress|shalom mattress|quilt pillow|barley|onions)\b/
    ],
    medium: [/\b(?:suit|saree|groceries|salescheck|retail|ban le|hang hoa|mobile cover|charger|ear phone)\b/]
  },
  {
    category: "ads",
    strong: [
      /\b(?:logo design|brand colour|brand color|social media graphics|quang cao|facebook ads|google ads|tiktok ads|marketing|truyen thong|in an banner)\b/
    ],
    medium: [/\b(?:design package|branding|thiet ke|poster)\b/]
  },
  {
    category: "travel",
    strong: [
      /\b(?:farmstay|homestay|khach san|nha nghi|resort|hotel|ve may bay|leu doi|leu 4|phong nghi|luu tru|cong tac phi)\b/
    ],
    medium: [/\b(?:booking|check-?in|phong kim ngan|may bay)\b/]
  },
  {
    category: "office",
    strong: [/\b(?:van phong pham|giay a4|but bi|muc in|photocopy|stationery|pen box|notebook)\b/],
    medium: [/\b(?:so tay|kep giay|in an)\b/]
  },
  {
    category: "rental",
    strong: [/\b(?:tien phong tro|thue nha|thue van phong|thue mat bang|thue kho|tien tro)\b/],
    medium: [/\b(?:hop dong thue|dat coc phong)\b/]
  },
  {
    category: "software",
    strong: [/\b(?:phan mem|ban quyen|saas|cloud|server|hosting|domain|chatgpt|openai|github|vercel|aws|azure)\b/],
    medium: [/\b(?:subscription|license)\b/]
  },
  {
    category: "communication",
    strong: [/\b(?:vien thong|cuoc internet|vnpt|viettel|fpt telecom|mobifone|vinaphone|cuoc dien thoai)\b/],
    medium: [/\b(?:internet|sim|4g|5g)\b/]
  },
  {
    category: "assets",
    strong: [/\b(?:nhuong ban can ho|chuyen quyen sdd|gia ban nha|tai san co dinh|may moc thiet bi|macbook|o to con)\b/],
    medium: [/\b(?:can ho|bat dong san)\b/]
  },
  {
    category: "fees",
    strong: [/\b(?:le phi mon bai|cong chung|phi ngan hang|le phi nha nuoc|thue phi)\b/],
    medium: [/\b(?:notary fee|service fee|phi dich vu)\b/]
  },
  {
    category: "tools",
    strong: [/\b(?:cong cu dung cu|may khoan|dung cu sua chua|thiet bi van phong)\b/],
    medium: [/\b(?:tools?|handle|kit)\b/]
  }
]

/**
 * Hybrid Vietnamese & International Receipt Classifier:
 * Priority:
 * 1. Workspace Smart Rules (user-defined or learned rules always win)
 * 2. Weighted domain lexicon scoring across merchant + name + items + extractedText
 * 3. Normalized LLM categoryCode validated against workspace categories
 */
export function classifyVietnameseReceipt(params: {
  merchant?: string | null
  merchantTaxCode?: string | null
  name?: string | null
  items?: Array<{ name?: string | null }>
  extractedText?: string | null
  llmCategoryCode?: string | null
  validCategoryCodes: string[]
  smartRules?: SmartRuleDTO[]
}): { categoryCode: string; source: "rule" | "vlm" | "lexicon"; confidence: number; matchedReason?: string } {
  const validSet = new Set(params.validCategoryCodes.length > 0 ? params.validCategoryCodes : ["other"])

  // 1. Check Workspace Smart Rules first
  if (params.smartRules && params.smartRules.length > 0) {
    const matched = matchSmartRule(params.smartRules, {
      merchant: params.merchant,
      merchantTaxCode: params.merchantTaxCode,
      name: params.name,
      description: params.extractedText
    })
    if (matched?.assignCategoryCode && validSet.has(matched.assignCategoryCode)) {
      return {
        categoryCode: matched.assignCategoryCode,
        source: "rule",
        confidence: 0.98,
        matchedReason: `Quy tắc AI "${matched.name}"`
      }
    }
  }

  // 2. Normalize LLM category
  let llmCat: string | null = null
  if (params.llmCategoryCode) {
    const rawCat = stripViAccents(String(params.llmCategoryCode))
    if (validSet.has(rawCat)) {
      llmCat = rawCat
    } else if (CATEGORY_ALIASES[rawCat] && validSet.has(CATEGORY_ALIASES[rawCat]!)) {
      llmCat = CATEGORY_ALIASES[rawCat]!
    }
  }

  // 3. Weighted Lexicon Scoring across merchant (3x), name (2x), items (1.5x), text (1x)
  const merchantNorm = stripViAccents(params.merchant || "")
  const nameNorm = stripViAccents(params.name || "")
  const itemsNorm = (params.items ?? []).map((i) => stripViAccents(i.name || "")).join(" | ")
  const textNorm = stripViAccents(params.extractedText || "")

  const scores = new Map<string, number>()
  const addScore = (cat: string, pts: number) => {
    if (!validSet.has(cat)) return
    scores.set(cat, (scores.get(cat) ?? 0) + pts)
  }

  for (const rule of CATEGORY_LEXICON) {
    if (!validSet.has(rule.category)) continue
    for (const rx of rule.strong) {
      if (merchantNorm && rx.test(merchantNorm)) addScore(rule.category, 6)
      if (nameNorm && rx.test(nameNorm)) addScore(rule.category, 4)
      if (itemsNorm && rx.test(itemsNorm)) {
        // Count how many distinct items match
        const itemHits = (params.items ?? []).filter((it) => rx.test(stripViAccents(it.name || ""))).length
        addScore(rule.category, Math.min(9, Math.max(3, itemHits * 2.5)))
      }
      if (textNorm && rx.test(textNorm)) addScore(rule.category, 2)
    }
    for (const rx of rule.medium) {
      if (merchantNorm && rx.test(merchantNorm)) addScore(rule.category, 2.5)
      if (nameNorm && rx.test(nameNorm)) addScore(rule.category, 1.5)
      if (itemsNorm && rx.test(itemsNorm)) addScore(rule.category, 1.5)
      if (textNorm && rx.test(textNorm)) addScore(rule.category, 0.8)
    }
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1])
  const best = ranked[0]
  const bestCat = best?.[0]
  const bestScore = best?.[1] ?? 0
  const llmScore = llmCat ? (scores.get(llmCat) ?? 0) : 0

  // Strong lexicon override when LLM fell back to "other"/null OR strongly disagrees with clear merchant/item evidence
  if (bestCat && bestScore >= 4) {
    if (!llmCat || llmCat === "other") {
      return {
        categoryCode: bestCat,
        source: "lexicon",
        confidence: Math.min(0.95, 0.72 + bestScore * 0.02),
        matchedReason: `Phân loại ngữ nghĩa chứng từ (điểm ${bestScore.toFixed(1)})`
      }
    }
    // Override weak LLM guess (e.g. LLM picked "goods" or "revenue_service" when merchant is "PGL MOTOR" or "Indian Oil")
    if (bestCat !== llmCat && bestScore >= llmScore + 4.5) {
      return {
        categoryCode: bestCat,
        source: "lexicon",
        confidence: Math.min(0.94, 0.75 + (bestScore - llmScore) * 0.02),
        matchedReason: `Chuẩn hóa danh mục từ "${llmCat}" → "${bestCat}" theo nội dung hóa đơn`
      }
    }
  }

  if (llmCat) {
    return { categoryCode: llmCat, source: "vlm", confidence: llmCat === "other" ? 0.65 : 0.86 }
  }
  if (bestCat && bestScore >= 2) {
    return { categoryCode: bestCat, source: "lexicon", confidence: 0.78 }
  }

  return { categoryCode: validSet.has("other") ? "other" : params.validCategoryCodes[0] || "other", source: "lexicon", confidence: 0.55 }
}

export interface ReconcileHandwrittenResult {
  documentKind: DocumentKind
  cleanedFields: Record<string, unknown>
  items: LineItemDTO[]
  provenance: Record<string, FieldProvenance>
  auditIssues: AuditIssue[]
  amountInWords: string | null
}

/**
 * Post-processes & mathematically self-verifies VLM / OCR extractions for handwritten & retail bills:
 * 1. Normalizes messy handwritten money strings, dates, currencies, and leading-zero invoice numbers
 * 2. Repairs Vietnamese VND thousand-scale shorthand ("430.w" -> 430,000; "1340" -> 1,340,000)
 * 3. Cross-checks Vietnamese/English "Bằng chữ" (amountInWords) against numeric total
 * 4. Auto-sums missing/blank total boxes from extracted line items (e.g. B&K Motorsports)
 * 5. Flags handwritten addition errors (sum(items) != stated total)
 * 6. Enforces Vietnam tax compliance rules for non-VAT handwritten retail bills (KCT / VAT = 0 / Bảng kê 01/TNDN warning)
 * 7. Runs hybrid Smart-Rules + Lexicon + VLM Vietnamese category classification
 */
export function reconcileHandwrittenBill(
  rawOutput: Record<string, unknown>,
  ctx: {
    filename: string
    method: "pdf_text" | "vlm" | "local_ocr"
    validCategoryCodes: string[]
    smartRules?: SmartRuleDTO[]
    extractedText?: string
    detectedRotationDeg?: number
  }
): ReconcileHandwrittenResult {
  const issues: AuditIssue[] = []
  const provenance: Record<string, FieldProvenance> = {}
  const confMap = (rawOutput.fieldConfidence as Record<string, number> | undefined) ?? {}
  const sourceTag = ctx.method

  const contextBlob = [
    ctx.filename,
    String(rawOutput.merchant ?? ""),
    String(rawOutput.name ?? ""),
    String(rawOutput.amountInWords ?? ""),
    String(rawOutput.text ?? ""),
    ctx.extractedText ?? "",
    ...(Array.isArray(rawOutput.items) ? rawOutput.items.map((x: Record<string, unknown>) => String(x?.name ?? "")) : [])
  ].join(" ")

  const currencyCode = normalizeCurrencyCode(rawOutput.currencyCode, contextBlob)
  const isVnd = currencyCode === "VND"

  // Determine documentKind
  const rawKind = String(rawOutput.documentKind ?? "").toLowerCase()
  let documentKind: DocumentKind =
    rawKind === "einvoice" || rawKind === "printed_receipt" || rawKind === "handwritten_bill"
      ? (rawKind as DocumentKind)
      : "handwritten_bill"
  if (rawOutput.taxAuthorityCode || (rawOutput.invoiceSymbol && /^[1-6][CK]\d{2}/i.test(String(rawOutput.invoiceSymbol)))) {
    documentKind = "einvoice"
  }

  // Parse line items cleanly (accepting both standard and compact local VLM keys qty/price)
  const rawItems = Array.isArray(rawOutput.items) ? (rawOutput.items as Array<Record<string, unknown>>) : []
  let items: LineItemDTO[] = rawItems
    .filter((it) => it && (it.name || it.total !== undefined || it.unitPrice !== undefined || it.price !== undefined))
    .map((it, idx) => {
      const rawQty = it.quantity ?? it.qty
      const rawPrice = it.unitPrice ?? it.price
      const qtyNum = parseFlexibleMoney(rawQty, "USD") // quantities may be decimals like 5.8 kg
      const unitNum = parseFlexibleMoney(rawPrice, currencyCode)
      let lineTotal = parseFlexibleMoney(it.total, currencyCode)
      const preTax = parseFlexibleMoney(it.preTaxAmount, currencyCode)
      if ((lineTotal === null || lineTotal === 0) && preTax && preTax > 0) lineTotal = preTax
      if ((lineTotal === null || lineTotal === 0) && qtyNum && unitNum && qtyNum > 0 && unitNum > 0) {
        lineTotal = Math.round(qtyNum * unitNum * 100) / 100
      }
      const amt = isVnd ? Math.round(lineTotal ?? 0) : Math.round((lineTotal ?? 0) * 100) / 100
      return {
        index: idx + 1,
        name: String(it.name ?? "").trim() || `Mặt hàng #${idx + 1}`,
        unit: it.unit ? String(it.unit).trim() : undefined,
        quantity: rawQty !== null && rawQty !== undefined && String(rawQty).trim() !== "" ? String(rawQty).trim() : undefined,
        unitPrice: unitNum !== null ? String(unitNum) : rawPrice ? String(rawPrice) : undefined,
        preTaxAmount: preTax !== null ? (isVnd ? Math.round(preTax) : preTax) : amt,
        vatRate: it.vatRate ? String(it.vatRate) : undefined,
        vatAmount: parseFlexibleMoney(it.vatAmount, currencyCode) ?? undefined,
        amount: amt,
        categoryCode: it.categoryCode ? String(it.categoryCode) : undefined,
        projectCode: it.projectCode ? String(it.projectCode) : undefined
      }
    })

  let total = parseFlexibleMoney(rawOutput.total, currencyCode)
  let preTaxAmount = parseFlexibleMoney(rawOutput.preTaxAmount, currencyCode)
  let vatAmount = parseFlexibleMoney(rawOutput.vatAmount, currencyCode) ?? 0
  const amountInWords = typeof rawOutput.amountInWords === "string" && rawOutput.amountInWords.trim() ? rawOutput.amountInWords.trim() : null
  const wordsValue = parseMoneyInWords(amountInWords)

  // VND thousand-scale shorthand repair — STRICTLY guarded by Vietnamese language evidence!
  let vndScaled = false
  if (isVnd && hasVietnameseEvidence(contextBlob)) {
    const positiveItems = items.filter((it) => it.amount > 0)
    const maxItemAmt = positiveItems.reduce((m, it) => Math.max(m, it.amount), 0)
    const minItemAmt = positiveItems.length > 0 ? positiveItems.reduce((m, it) => Math.min(m, it.amount), Infinity) : Infinity

    // Case A: VND handwritten bill where items & total are clearly in thousands (e.g. items 50..2500, total 1340)
    const looksLikeThousands =
      (total !== null && total > 0 && total < 2000) ||
      (total !== null && total > 0 && total < 10000 && positiveItems.length >= 2 && minItemAmt < 1000 && maxItemAmt < 5000) ||
      (total === null && positiveItems.length > 0 && maxItemAmt < 5000 && minItemAmt < 1000)

    if (looksLikeThousands) {
      if (total !== null) total = Math.round(total * 1000)
      if (preTaxAmount !== null && preTaxAmount < 10000) preTaxAmount = Math.round(preTaxAmount * 1000)
      if (vatAmount > 0 && vatAmount < 2000) vatAmount = Math.round(vatAmount * 1000)
      items = items.map((it) => ({
        ...it,
        amount: it.amount > 0 && it.amount < 10000 ? Math.round(it.amount * 1000) : it.amount,
        preTaxAmount: it.preTaxAmount > 0 && it.preTaxAmount < 10000 ? Math.round(it.preTaxAmount * 1000) : it.preTaxAmount
      }))
      vndScaled = true
    }

    // Case B: Line items themselves are in thousands while total is already full VND (e.g., VOV seafood bill: item unitPrice=2500, total=42,500,000)
    if (!vndScaled && total !== null && total >= 100_000 && positiveItems.length > 0) {
      const rawItemsSum = positiveItems.reduce((s, it) => s + it.amount, 0)
      if (rawItemsSum > 0 && Math.abs(rawItemsSum * 1000 - total) <= total * 0.15) {
        items = items.map((it) => ({
          ...it,
          amount: Math.round(it.amount * 1000),
          preTaxAmount: Math.round(it.preTaxAmount * 1000)
        }))
      }
    }
  }

  // Cross-check amountInWords ("Bằng chữ" / "Two Thousand Only")
  if (wordsValue !== null && wordsValue > 0) {
    if (total === null || total <= 0) {
      total = wordsValue
      provenance.total = {
        source: "rule",
        confidence: 0.9,
        warning: `Lấy tổng tiền từ dòng bằng chữ ("${amountInWords}")`
      }
    } else if (Math.abs(total * 1000 - wordsValue) <= wordsValue * 0.05) {
      // Exact 1000x scale mismatch (e.g., VND decimal misread on red invoice) -> repair using Bằng chữ!
      total = wordsValue
      if (preTaxAmount !== null && preTaxAmount < wordsValue / 500) preTaxAmount = Math.round(preTaxAmount * 1000)
      if (vatAmount > 0 && vatAmount < wordsValue / 500) vatAmount = Math.round(vatAmount * 1000)
      provenance.total = {
        source: "rule",
        confidence: 0.92,
        warning: `Đã hiệu chỉnh sai lệch hàng nghìn dựa theo dòng bằng chữ ("${amountInWords}")`
      }
    } else if (Math.abs(total - wordsValue) > Math.max(1000, wordsValue * 0.03)) {
      issues.push({
        code: "AMOUNT_IN_WORDS_MISMATCH",
        severity: "warning",
        field: "total",
        message: `Số tiền bằng số (${total.toLocaleString("vi-VN")}) khác dòng bằng chữ (${wordsValue.toLocaleString("vi-VN")}: "${amountInWords}").`
      })
    }
  }

  // Blank total auto-summation from line items (e.g. handwritten bill with empty TOTAL box)
  const itemsSum = items.reduce((s, it) => s + (Number.isFinite(it.amount) ? it.amount : 0), 0)
  if ((total === null || total <= 0) && itemsSum > 0) {
    total = isVnd ? Math.round(itemsSum + vatAmount) : Math.round((itemsSum + vatAmount) * 100) / 100
    provenance.total = {
      source: "rule",
      confidence: 0.88,
      warning: `Ô Tổng cộng trống — tự động cộng từ ${items.length} dòng hàng hóa (${itemsSum.toLocaleString("vi-VN")}${vatAmount > 0 ? ` + thuế ${vatAmount.toLocaleString("vi-VN")}` : ""}).`
    }
    issues.push({
      code: "TOTAL_AUTO_SUMMED",
      severity: "info",
      field: "total",
      message: `Hóa đơn để trống ô Tổng cộng — T-Tax tự động cộng từ ${items.length} mặt hàng = ${total.toLocaleString("vi-VN")} ${currencyCode}.`
    })
  } else if (total !== null && total > 0 && itemsSum > 0 && items.length >= 2) {
    // Check arithmetic consistency between line items and stated total (allowing VAT/tax or small service charge)
    const expectedWithVat = itemsSum + vatAmount
    const diff = Math.abs(total - expectedWithVat)
    const diffRaw = Math.abs(total - itemsSum)
    const bestDiff = Math.min(diff, diffRaw)
    // Check if total appears way larger or smaller than sum of lines (>15% off and not explained by 5-20% tax/service)
    if (bestDiff > Math.max(5, total * 0.22)) {
      issues.push({
        code: "HANDWRITTEN_ARITHMETIC_MISMATCH",
        severity: "warning",
        field: "total",
        message: `Tổng cộng ghi trên hóa đơn (${total.toLocaleString("vi-VN")}) chênh lệch với tổng các dòng hàng (${itemsSum.toLocaleString("vi-VN")}) — cần đối chiếu phép cộng tay.`
      })
    }
  }

  // Reconcile preTaxAmount & vatAmount cleanly
  const finalTotal = total ?? 0
  if (isVnd) {
    vatAmount = Math.round(vatAmount)
  }
  if (preTaxAmount === null || preTaxAmount <= 0) {
    preTaxAmount = vatAmount > 0 && finalTotal > vatAmount ? Math.round((finalTotal - vatAmount) * 100) / 100 : finalTotal
  } else if (vatAmount === 0 && finalTotal > 0 && Math.abs(preTaxAmount - finalTotal) > finalTotal * 0.5) {
    // Repair stale/wrong preTax when VAT=0
    preTaxAmount = finalTotal
  }

  // Normalize VAT rate code & payment method for handwritten retail bills
  let vatRateCode = typeof rawOutput.vatRateCode === "string" && rawOutput.vatRateCode.trim() ? rawOutput.vatRateCode.trim() : null
  if (!vatRateCode) {
    if (vatAmount > 0 && preTaxAmount > 0) {
      const pct = Math.round((vatAmount / preTaxAmount) * 100)
      vatRateCode = [0, 5, 8, 10, 12, 18, 20].includes(pct) ? `${pct}%` : `${pct}%`
    } else if (documentKind === "handwritten_bill" || documentKind === "printed_receipt") {
      vatRateCode = "KCT"
    }
  }

  let paymentMethod = typeof rawOutput.paymentMethod === "string" && rawOutput.paymentMethod.trim() ? rawOutput.paymentMethod.trim() : null
  if (!paymentMethod && (documentKind === "handwritten_bill" || documentKind === "printed_receipt")) {
    paymentMethod = "Tiền mặt"
  }

  const merchant = typeof rawOutput.merchant === "string" && rawOutput.merchant.trim() ? rawOutput.merchant.trim() : null
  const merchantTaxCode =
    typeof rawOutput.merchantTaxCode === "string" && rawOutput.merchantTaxCode.trim()
      ? rawOutput.merchantTaxCode.replace(/\s+/g, "").trim()
      : null
  const issuedAt = parseFlexibleDate(rawOutput.issuedAt)

  // Synthesize crisp name if missing
  let name = typeof rawOutput.name === "string" && rawOutput.name.trim() ? rawOutput.name.trim() : ""
  if (!name) {
    const firstItem = items[0]?.name
    if (merchant && firstItem) {
      name = `${merchant} — ${firstItem}${items.length > 1 ? ` (+${items.length - 1})` : ""}`
    } else if (merchant) {
      name = `Hóa đơn ${merchant}`
    } else if (firstItem) {
      name = `${firstItem}${items.length > 1 ? ` (+${items.length - 1})` : ""}`
    } else {
      name = ctx.filename
    }
  }

  // Hybrid Classification (Smart Rules + Lexicon + VLM)
  const classification = classifyVietnameseReceipt({
    merchant,
    merchantTaxCode,
    name,
    items,
    extractedText: contextBlob,
    llmCategoryCode: typeof rawOutput.categoryCode === "string" ? rawOutput.categoryCode : null,
    validCategoryCodes: ctx.validCategoryCodes,
    smartRules: ctx.smartRules
  })

  // Vietnam Tax Compliance Alert for Handwritten Retail Bills without E-Invoice
  if (documentKind === "handwritten_bill" && isVnd && !rawOutput.taxAuthorityCode && vatAmount === 0) {
    issues.push({
      code: "HANDWRITTEN_NO_EINVOICE",
      severity: "warning",
      field: "invoiceNumber",
      message:
        "Hóa đơn bán lẻ viết tay (không phải HĐĐT theo NĐ 70/2025): Không được khấu trừ thuế GTGT (TK 1331 = 0); cần lập Bảng kê 01/TNDN nếu đủ điều kiện hoặc theo dõi chi phí không được trừ khi quyết toán TNDN."
    })
  }
  if (ctx.detectedRotationDeg && ctx.detectedRotationDeg !== 0) {
    issues.push({
      code: "AUTO_ROTATED_IMAGE",
      severity: "info",
      message: `T-Tax đã tự động xoay ảnh ${ctx.detectedRotationDeg}° về chiều đứng trước khi đọc OCR.`
    })
  }
  if (vndScaled) {
    issues.push({
      code: "VND_THOUSANDS_NORMALIZED",
      severity: "info",
      field: "total",
      message: `Đã tự động quy đổi đơn vị viết tắt nghìn đồng trên hóa đơn viết tay VN → ${finalTotal.toLocaleString("vi-VN")} ₫.`
    })
  }

  // Build cleanedFields & provenance
  const cleanedFields: Record<string, unknown> = {
    ...rawOutput,
    documentKind,
    name,
    merchant,
    merchantTaxCode,
    issuedAt,
    invoiceSymbol: typeof rawOutput.invoiceSymbol === "string" && rawOutput.invoiceSymbol.trim() ? rawOutput.invoiceSymbol.trim() : null,
    invoiceNumber: typeof rawOutput.invoiceNumber === "string" && rawOutput.invoiceNumber.trim() ? rawOutput.invoiceNumber.trim() : null,
    preTaxAmount,
    vatRateCode,
    vatAmount,
    total: finalTotal,
    currencyCode,
    categoryCode: classification.categoryCode,
    projectCode: typeof rawOutput.projectCode === "string" && rawOutput.projectCode.trim() ? rawOutput.projectCode.trim() : "general",
    paymentMethod,
    amountInWords
  }
  delete cleanedFields.items
  delete cleanedFields.fieldConfidence

  for (const [key, val] of Object.entries(cleanedFields)) {
    if (provenance[key]) continue
    const conf = typeof confMap[key] === "number" ? confMap[key]! : 0.85
    if (key === "categoryCode") {
      provenance[key] = {
        source: classification.source === "vlm" ? sourceTag : "rule",
        confidence: classification.confidence,
        warning: classification.matchedReason
      }
      continue
    }
    if (conf < 0.72 && val !== null && val !== undefined) {
      provenance[key] = {
        source: sourceTag,
        confidence: conf,
        warning: `Độ tin cậy OCR thấp (${Math.round(conf * 100)}%) — cần kế toán xác nhận.`
      }
      issues.push({
        code: "LOW_OCR_CONFIDENCE",
        severity: "warning",
        field: key,
        message: `Trường "${key}" có độ tin cậy OCR thấp (${Math.round(conf * 100)}%).`
      })
    } else {
      provenance[key] = { source: sourceTag, confidence: conf }
    }
  }

  return {
    documentKind,
    cleanedFields,
    items,
    provenance,
    auditIssues: issues,
    amountInWords
  }
}

/**
 * Deterministic parser for raw offline Tesseract OCR text (zero-API-key fallback).
 */
export function parseOfflineOcrReceiptText(rawText: string, filename: string): Record<string, unknown> {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  const merchant =
    lines.find(
      (l) =>
        l.length >= 4 &&
        !/^(hoa don|hóa đơn|phieu|phiếu|so|số|ngay|ngày|date|stt|bill|cash bill|invoice)/i.test(stripViAccents(l))
    ) ?? null

  const mstMatch = rawText.match(/(?:MST|Mã số thuế|Tax\s*code)\s*[:.]?\s*(\d{10}(?:-\d{3})?)/i)
  const invMatch = rawText.match(/(?:Số\s*(?:HĐ|Seri|No)?|Invoice\s*No\.?|Bill\s*No\.?|Sl\.?\s*No\.?)\s*[:.]?\s*([A-Z0-9-]{2,15})/i)
  const dateMatch =
    rawText.match(/ngày\s*\d{1,2}\s*tháng\s*\d{1,2}\s*năm\s*\d{2,4}/i)?.[0] ??
    rawText.match(/\b\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}\b/)?.[0] ??
    null
  const wordsLine = rawText.match(/(?:bằng chữ|amount in words|rupees)\s*[:.]?\s*([^\n]{6,120})/i)?.[1]?.trim() ?? null
  const currencyCode = normalizeCurrencyCode("", rawText)

  // Extract total from labeled total line, falling back to largest plausible money value
  let total: number | null = null
  const totalLine = lines.find((l) => /(?:tổng cộng|tong cong|tổng tiền|tong tien|thành tiền|thanh tien|cộng|total|balance|amount due)/i.test(l))
  if (totalLine) {
    const nums = totalLine.match(/[\d.,]+(?:\s*(?:k|tr|w|đ|vnđ))?/gi) ?? []
    const last = nums[nums.length - 1]
    if (last) total = parseFlexibleMoney(last, currencyCode)
  }
  if (!total) {
    const allNums = (rawText.match(/\b\d{1,3}(?:[.,]\d{3})+\b/g) ?? [])
      .map((x) => parseFlexibleMoney(x, currencyCode))
      .filter((n): n is number => n !== null && n > 0)
    if (allNums.length > 0) total = Math.max(...allNums)
  }

  return {
    documentKind: "handwritten_bill",
    merchant,
    merchantTaxCode: mstMatch?.[1] ?? null,
    invoiceNumber: invMatch?.[1] ?? null,
    issuedAt: dateMatch,
    currencyCode,
    total,
    amountInWords: wordsLine,
    name: merchant ? `Hóa đơn ${merchant}` : filename,
    text: rawText.slice(0, 1500),
    items: []
  }
}
