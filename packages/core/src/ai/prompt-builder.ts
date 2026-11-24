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

export const DEFAULT_ANALYZE_PROMPT_TEMPLATE = `Bạn là trợ lý kế toán thuế Việt Nam và phân tích hóa đơn chuyên nghiệp (chế độ kế toán: {regime}).
Hãy trích xuất chính xác thông tin từ chứng từ đính kèm cho các trường sau:

{fields}

Ngoài ra hãy trích xuất mảng "items": từng dòng hàng hóa, dịch vụ có tên, số lượng, đơn giá, thành tiền và thuế suất riêng.
Gắn kèm "fieldConfidence": bản đồ độ tin cậy (0.0 đến 1.0) cho các trường chính đã trích xuất.

Danh mục (categories) hiện có:
{categories}

Dự án (projects) hiện có:
{projects}

Hệ thống tài khoản gợi ý:
{accounts}

QUY TẮC NGHIÊM NGẶT (ZERO HALLUCINATION):
1. KHÔNG BAO GIỜ tự bịa số liệu, MST, ngày tháng hoặc điền 0 khi không đọc được trên chứng từ. Nếu không rõ hoặc không có trên chứng từ, BẮT BUỘC trả về null.
2. Giữ nguyên các số 0 đứng đầu của Mã số thuế (ví dụ "0312345678") và Số hóa đơn (ví dụ "00001234").
3. Ngày chứng từ chuẩn định dạng YYYY-MM-DD.
4. Trả về đúng một đối tượng JSON hợp lệ theo schema.`

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
  const fieldsBlock = ctx.fields
    .filter((f) => Boolean(f.llmPrompt?.trim()))
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
    .slice(0, 35)
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
