# T-Tax — Tài liệu Hướng dẫn Triển khai & Mở rộng cho AI Agents

Tài liệu này giúp bất kỳ AI agent nào tiếp nhận codebase **T-Tax** đều nắm trọn kiến trúc, ranh giới bất biến và quy trình kiểm thử trên **macOS** & **Windows**.

## 1. Cấu trúc Monorepo & Ranh giới Import

- `packages/core/src/browser.ts` (`@t-tax/core/browser`): Chỉ chứa types, preset metadata (`LLM_PROVIDER_PRESETS`, `EMAIL_PROVIDER_PRESETS`, `VIETNAM_BANKS`, `REGIME_METADATA`), và `decodeInvoiceSymbol`. **Không được import module Node (`fs`, `crypto`, `sharp`, `@napi-rs/canvas`, `imapflow`) vào file này.**
- `packages/core/src/index.ts` (`@t-tax/core`): Chứa toàn bộ engine Node/Worker (`extractTT78Xml`, `verifyEInvoiceXmlSignature`, `auditParsedEInvoice`, `renderEInvoiceHtml`, `inspectAndRenderPdf`, `analyzeDocumentHybrid`, `suggestJournalLines`, `matchBankRowsToTransactions`, `exportHtkkExcelBuffer`, `exportMisaImportExcelBuffer`, `exportFastBravoExcelBuffer`, `exportTransactionsCsvAndZip`, `getHistoricalExchangeRate`, `syncEmailAttachments`, `fetchGdtCaptcha`).
- `packages/db/src/`: SQLite WAL + Drizzle ORM + FTS5 triggers + `VaultStorage` + `exportWorkspaceBackupZip` / `restoreWorkspaceBackupZip` + `TTaxService`.
- `packages/ui/src/`: React 19 + Tailwind v4 UI (`Minimal Specular Liquid Glass`). Mọi giao tiếp dữ liệu đi qua `useTransport()` (`TTaxTransport`).
- `apps/desktop`: Electron 45 (macOS Vibrancy + 364px Tray Popover, Windows 11 Mica, `safeStorage`, `printToPDF`). Các dependency native/external (`better-sqlite3`, `sharp`, `@napi-rs/canvas`, `pdfjs-dist`) **phải luôn khai báo trong `apps/desktop/package.json`**.
- `apps/web`: Hono HTTP server + Vite SPA + Dockerfile cho triển khai tự host.

## 2. Quy tắc Bắt buộc (Guardrails)

1. **XML QĐ 1450/1510 & NĐ 70/2025:** Luôn đặt `parseTagValue: false` trong `fast-xml-parser` và lưu `taxCode`, `invoiceNumber`, `symbol`, `templateCode` dạng `TEXT` trong SQLite + `@` (string format) trong ExcelJS để không mất số `0` ở đầu (`0312345678`, `00001234`).
2. **Số học & Zero-Hallucination:** Dùng integer VND hoặc `Decimal` (`decimal.js`) khi tính VAT/chiết khấu; khi OCR/Vision không đọc chắc chắn trường nào thì trả `null` + cảnh báo, tuyệt đối không điền `0`.
3. **Tên file ASCII:** Mọi file xuất ra ngoài (Excel, PDF, ZIP) chạy qua `safeAsciiFilename()` để tránh vỡ Unicode NFD (macOS) ↔ NFC (Windows).
4. **Minimal Specular Liquid Glass:** `backdrop-filter` chỉ đặt trên chrome nổi (`.side`, `.top`, `.menu`, `.pal`, `.batch-bar`, popover `364px`); nội dung nằm trong `.inset-sheet` nền matte; không dùng gradient nền/thẻ/CTA hay emoji làm icon điều hướng.
5. **Cổng Thuế (`hoadondientu.gdt.gov.vn`):** Chỉ dùng luồng CAPTCHA SVG cho người dùng tự nhập.

## 3. Lệnh Kiểm tra Chuẩn

```bash
pnpm build && pnpm typecheck
pnpm test
pnpm lint
pnpm test:e2e:mac
```
