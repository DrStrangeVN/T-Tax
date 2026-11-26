export interface PromptFieldInput {
  code: string
  name: string
  type: string
  llmPrompt?: string | null
}

export interface PromptCategoryInput {
  code: string
  name: string
  llmPrompt?: string | null
}

export interface PromptProjectInput {
  code: string
  name: string
  llmPrompt?: string | null
}

export interface PromptAccountInput {
  code: string
  name: string
}

export const DEFAULT_ANALYZE_PROMPT_TEMPLATE = `Bạn là chuyên gia OCR kế toán thuế Việt Nam và đọc hóa đơn viết tay, hóa đơn bán lẻ, phiếu thu và hóa đơn điện tử (chế độ kế toán: {regime}).
Hãy trích xuất chính xác thông tin từ chứng từ đính kèm thành ĐÚNG 1 đối tượng JSON gọn (KHÔNG bọc markdown) gồm các trường sau:

- documentKind: "handwritten_bill" (hóa đơn bán lẻ/phiếu viết tay), "printed_receipt" (bill in nhiệt/POS), hoặc "einvoice" (HĐĐT GTGT có ký hiệu/MST/MCCQT)
- amountInWords: nguyên văn dòng "Viết bằng chữ" / "Amount in words" nếu có trên chứng từ, ngược lại null
{fields}
- items: mảng các dòng hàng hóa/dịch vụ [{ name, unit, quantity, unitPrice, preTaxAmount, vatRate, vatAmount, total }]
- fieldConfidence: bản đồ điểm tin cậy (0.0 đến 1.0) cho các trường chính (merchant, issuedAt, total, categoryCode)

Danh mục hợp lệ (BẮT BUỘC chọn đúng 1 mã trong danh sách):
{categories}

Dự án (projects) hiện có:
{projects}

Hệ thống tài khoản gợi ý:
{accounts}

QUY TẮC CHUYÊN BIỆT CHO HÓA ĐƠN VIẾT TAY & CHỐNG ẢO GIÁC (ZERO HALLUCINATION):
1. KHÔNG BAO GIỜ tự bịa MST, ngày tháng hoặc số liệu không có trên ảnh. Nếu không có hoặc không đọc được, trả về null (KHÔNG điền 0 thay cho null).
2. TIỀN VIỆT NAM (VND):
   - Dấu chấm "." và dấu phẩy "," trên hóa đơn VND ĐỀU là dấu phân cách hàng nghìn — VND KHÔNG có số thập phân (VD: "362.852.693" -> 362852693; "516.986.789" -> 516986789; "42.500.000" -> 42500000).
   - Trên bill viết tay VN, ký hiệu ".000" viết ngoáy giống ".w", ".uu", ".00" hoặc bỏ 3 số 0 (VD: "430.w" = 430000, "1340.w" = 1340000, đơn giá "x20" = 20000) là đơn vị nghìn đồng -> quy đổi ra đầy đủ VND.
   - Đọc đúng con số ở dòng TỔNG CỘNG cuối cùng (bao gồm cả thuế/phí nếu có; nếu hóa đơn có gạch sửa/cọc/giảm giá dẫn đến tổng sau cùng khoanh tròn thì lấy số tổng thanh toán chính). Nếu ô Tổng cộng để trống thì trả total = null và liệt kê đủ tất cả dòng items.
3. TIỀN TỆ QUỐC TẾ: Nhận diện đúng mã tiền tệ ISO 4217 theo ký hiệu/địa chỉ trên chứng từ (Rs./₹/Rupees/India -> INR, $ -> USD, £ -> GBP, Istanbul/TL -> TRY, đ/VNĐ/Việt Nam -> VND).
4. NGÀY CHỨNG TỪ: Chuẩn hóa YYYY-MM-DD (VD "Ngày 02 tháng 05 năm 2022" -> "2022-05-02", "15/07/26" -> "2026-07-15", "19/03/22" -> "2022-03-19").
5. Giữ nguyên các số 0 đứng đầu của Mã số thuế ("0400105014") và Số hóa đơn ("0000906").
6. Chọn đúng categoryCode sát nhất với loại hình cửa hàng & mặt hàng (VD: sửa xe/xăng dầu -> transport; quán ăn/hải sản/cafe -> food; điện nước/bình nước uống/sửa nồi hơi -> utility_bills; vật liệu/điện/kim khí -> materials; quần áo/tạp hóa/bán lẻ -> goods; thiết kế/quảng cáo -> ads; khách sạn/lều trại/farmstay -> travel).`

export function buildAnalyzePrompt(
  template: string,
  ctx: {
    fields: PromptFieldInput[]
    categories: PromptCategoryInput[]
    projects: PromptProjectInput[]
    accounts?: PromptAccountInput[]
    regime?: string
  }
): string {
  // Exclude verbose full-text dump ("text") from structured VLM extraction to avoid token-repeat loops & 2x speedup
  const fieldsBlock = ctx.fields
    .filter((f) => Boolean(f.llmPrompt?.trim()) && f.code !== "text")
    .map((f) => `- ${f.code} (${f.type}): ${f.llmPrompt}`)
    .join("\n")

  const categoriesBlock = ctx.categories
    .filter((c) => Boolean(c.llmPrompt?.trim()))
    .map((c) => `- ${c.code} (${c.name}): ${c.llmPrompt}`)
    .join("\n")

  const projectsBlock = ctx.projects
    .filter((p) => Boolean(p.llmPrompt?.trim()))
    .map((p) => `- ${p.code} (${p.name}): ${p.llmPrompt}`)
    .join("\n")

  const accountsBlock = (ctx.accounts ?? [])
    .slice(0, 24)
    .map((a) => `- ${a.code}: ${a.name}`)
    .join("\n")

  return template
    .replaceAll("{fields}", fieldsBlock)
    .replaceAll("{categories}", categoriesBlock)
    .replaceAll("{projects}", projectsBlock)
    .replaceAll("{categories.code}", ctx.categories.map((c) => c.code).join(", "))
    .replaceAll("{projects.code}", ctx.projects.map((p) => p.code).join(", "))
    .replaceAll("{accounts}", accountsBlock || "1331, 33311, 5111, 6421, 6427, 6428, 1561, 1111, 1121, 331")
    .replaceAll("{regime}", ctx.regime ?? "TT99_2025")
}

/**
 * Laser-focused compact prompt (~260 tokens) optimized for local Vision LLMs (Ollama qwen3-vl / qwen2.5vl)
 * so prefill is 3x faster and header/total/category keys always appear BEFORE items[].
 */
export function buildCompactLocalVlmPrompt(ctx: {
  categories: PromptCategoryInput[]
}): string {
  const catCodes = ctx.categories.map((c) => c.code).join(", ") || "goods,materials,tools,assets,office,software,communication,utility_bills,rental,ads,transport,travel,food,salary,fees,education,revenue_goods,revenue_service,other"
  return `Read this receipt/invoice (handwritten or printed) and return ONLY one compact JSON object with keys in this exact order:
{
  "documentKind": "handwritten_bill" | "printed_receipt" | "einvoice",
  "merchant": string or null,
  "merchantTaxCode": string or null,
  "issuedAt": "YYYY-MM-DD" or null,
  "invoiceNumber": string or null,
  "currencyCode": "VND" | "INR" | "USD" | "GBP" | "TRY" | "EUR",
  "preTaxAmount": number or null,
  "vatRateCode": string or null,
  "vatAmount": number or 0,
  "total": number or null,
  "amountInWords": string or null,
  "paymentMethod": string or null,
  "categoryCode": one of [${catCodes}],
  "name": short summary string,
  "items": [{ "name": string, "qty": number|string|null, "price": number|null, "total": number|null }]
}
Rules:
1. Never invent missing dates, tax codes, or totals; return null if blank/illegible. If TOTAL box is blank, set total=null and extract every line item.
2. Vietnamese VND bills: "." and "," are THOUSANDS separators (no decimals: "516.986.789" -> 516986789, "42.500.000" -> 42500000). Cursive ".w"/".uu"/".00" or omitted ".000" on Vietnamese bills means thousands (430.w -> 430000, 1340.w -> 1340000). Copy "Viết bằng chữ" verbatim into amountInWords if present.
3. Non-VN bills: detect currency from symbols/location (Rs./₹/Rupees/India/Aluva/Kerala/Pune/Nashik/Pasighat -> INR; $ -> USD; £/Manchester -> GBP; Istanbul/TL -> TRY). Keep exact decimals for USD/GBP (e.g. 6.26, 211.60, 1.55).
4. Convert dates to YYYY-MM-DD (DD/MM/YY like 15/07/26 -> 2026-07-15, "Ngày 02 tháng 05 năm 2022" -> 2022-05-02, US 12/20/81 -> 1981-12-20).
5. Preserve leading zeros on tax codes & invoice numbers. Limit items array to at most 16 lines.`
}
