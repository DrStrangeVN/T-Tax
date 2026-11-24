import { z } from "zod"
import type { PromptFieldInput } from "./prompt-builder.js"

function fieldTypeToZod(type: string, description: string): z.ZodTypeAny {
  switch (type.toLowerCase()) {
    case "number":
    case "integer":
      return z.number().nullable().optional().describe(description)
    case "boolean":
      return z.boolean().nullable().optional().describe(description)
    default:
      return z.string().nullable().optional().describe(description)
  }
}

export function buildDynamicAnalyzeSchema(fields: PromptFieldInput[]) {
  const shape: Record<string, z.ZodTypeAny> = {}

  for (const field of fields) {
    if (!field.llmPrompt?.trim()) continue
    shape[field.code] = fieldTypeToZod(field.type, field.llmPrompt)
  }

  // Ensure standard fallback baseline fields always exist cleanly
  if (!shape.name) shape.name = z.string().nullable().optional().describe("Tên tóm tắt giao dịch")
  if (!shape.merchant) shape.merchant = z.string().nullable().optional().describe("Tên nhà cung cấp / người bán")
  if (!shape.total) shape.total = z.number().nullable().optional().describe("Tổng tiền thanh toán")
  if (!shape.currencyCode) shape.currencyCode = z.string().nullable().optional().describe("Mã tiền tệ ISO 4217 (VD: VND, USD, EUR)")
  if (!shape.issuedAt) shape.issuedAt = z.string().nullable().optional().describe("Ngày lập chứng từ (YYYY-MM-DD)")

  const itemShape: Record<string, z.ZodTypeAny> = {
    name: z.string().describe("Tên hàng hóa / dịch vụ"),
    unit: z.string().nullable().optional().describe("Đơn vị tính"),
    quantity: z.string().nullable().optional().describe("Số lượng"),
    unitPrice: z.string().nullable().optional().describe("Đơn giá"),
    preTaxAmount: z.number().nullable().optional().describe("Thành tiền chưa thuế"),
    vatRate: z.string().nullable().optional().describe("Thuế suất GTGT"),
    vatAmount: z.number().nullable().optional().describe("Tiền thuế GTGT"),
    total: z.number().nullable().describe("Tổng cộng dòng hàng"),
    categoryCode: z.string().nullable().optional().describe("Mã danh mục phù hợp"),
    projectCode: z.string().nullable().optional().describe("Mã dự án phù hợp")
  }

  return z.object({
    ...shape,
    items: z
      .array(z.object(itemShape))
      .default([])
      .describe("Danh sách các mặt hàng hoặc dịch vụ tách rời trên chứng từ"),
    fieldConfidence: z
      .record(z.string(), z.number().min(0).max(1))
      .optional()
      .describe("Điểm tin cậy từ 0.0 tới 1.0 cho từng mã trường")
  })
}
