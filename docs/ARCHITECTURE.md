# Kiến trúc Kỹ thuật T-Tax

## 1. Luồng xử lý Dữ liệu & Tách biệt Browser / Node

- **`@t-tax/core/browser`**: Chỉ chứa kiểu dữ liệu TypeScript, bộ giải mã ký hiệu hóa đơn (`KHMSHDon`/`KHHDon`), và hằng số preset (LLM providers, Email IMAP, danh sách ngân hàng VietQR, metadata chế độ kế toán). Tuyệt đối không nhập khẩu Node builtins hay native binary.
- **`@t-tax/core`**: Chứa toàn bộ engine xử lý nặng:
  - `xml/`: `fast-xml-parser` (`parseTagValue: false`), `xml-crypto` + `node-forge` xác thực `XMLDSig`, kiểm toán số học `Decimal.js`, dựng bản thể hiện iTaxViewer HTML.
  - `ai/`: Vercel AI SDK (`ai`) + 5 provider adapters, dynamic Zod schema, `ConcurrencyLimiter` tự giảm ngưỡng khi gặp HTTP 429, và bộ render PDF **Zero-Ghostscript** (`pdfjs-dist` + `@napi-rs/canvas` + `sharp`).
  - `accounting/`: Hệ thống tài khoản `TT99_2025`, `TT200_2014`, `TT133_2016`, `HKD_2026`, bộ máy định khoản tự động Nợ/Có, kiểm tra cân bằng bút toán, đối chiếu sao kê ngân hàng 3 bên, bộ nhớ pháp lý có TTL.
  - `export/`: ExcelJS (HTKK, MISA, Fast/Bravo), TaxHacker CSV+ZIP, VietQR EMVCo CRC-16, chuẩn hóa tên tệp ASCII (tránh xung đột NFD macOS ↔ NFC Windows).

## 2. Lưu trữ & Bảo mật

- **SQLite (WAL + FTS5):** Khởi động Desktop tức thì không cần cài PostgreSQL. Bảng `transactions_fts` tự đồng bộ qua SQLite triggers cho phép tìm kiếm theo MST, số hóa đơn, tên đối tác và nội dung trích xuất dưới `15ms`.
- **Vault:** Chứng từ lưu bất biến tại `<userData>/vault/<workspaceId>/YYYY-MM/`, chống trùng bằng `sha256` và tự ghép cặp tệp `.xml` ↔ `.pdf` cùng tên gốc.
- **Mã hóa bí mật:** Trên Desktop dùng `safeStorage` (macOS Keychain / Windows DPAPI) cho API Key LLM và mật khẩu Email IMAP; trên Web dùng `AES-256-GCM` với khóa `scrypt`.

## 3. Giao diện Minimal Specular Liquid Glass

- Tuân thủ triệt để quy tắc **Chrome-Only Glass** của macOS Tahoe 26: `backdrop-filter` chỉ gắn lên thanh bên (`.side`), tiêu đề dính (`.top`), thanh thao tác hàng loạt (`.batch-bar`), command palette `⌘K` (`.pal`), context menu (`.menu`) và Menu Bar Popover `364px`.
- Vùng nội dung làm việc nằm trong **Inset Content Sheet** bo `13px` nền matte sạch (`#101217` Dark / `#FFFFFF` Light) kết hợp lưới cấu trúc `1px solid var(--line)`.
- Tự đồng bộ chế độ Dark/Light và `Reduce Transparency` từ hệ điều hành; tắt hoàn toàn gradient nền và emoji làm icon điều hướng.
