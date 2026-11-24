<div align="center">

# T-Tax

**Self-Hosted & Cross-Platform AI Accounting, Vietnam E-Invoice Auditing (TT78 / NĐ 70/2025) & Minimal Specular Liquid Glass Desktop Suite**

[![macOS & Windows Build](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Docker-0071E3?style=flat-square)](#)
[![License: MIT](https://img.shields.io/badge/license-MIT-34D399?style=flat-square)](LICENSE)

</div>

T-Tax kế thừa toàn bộ bộ tính năng tự động hóa chứng từ AI của [`vas3k/TaxHacker`](https://github.com/vas3k/TaxHacker) và tái kiến trúc chuyên sâu cho **nghiệp vụ kế toán & hóa đơn điện tử Việt Nam (2025–2026)** trên giao diện **Minimal Specular Liquid Glass** (macOS Vibrancy + Windows 11 Mica + Web/Docker SPA).

---

## Tính năng cốt lõi

### 1. Bóc tách 3 tầng — Không phụ thuộc Ghostscript hay PostgreSQL
- **Tier 0 — XML Deterministic (`0ms`, `100%` chính xác):** Parse hóa đơn điện tử chuẩn **QĐ 1450/QĐ-TCT & QĐ 1510/QĐ-TCT** (TT 78/2021, TT 32/2025, NĐ 70/2025 — bao gồm hóa đơn máy tính tiền `M`, `CCCDan`, `MDVQHNSach`). Giữ nguyên số `0` đầu của **Mã số thuế** và **Số hóa đơn**.
- **Xác thực chữ ký số & Kiểm toán số học:** Kiểm tra `<ds:Signature>` (`XMLDSig`) kèm thông tin CA Việt Nam, kiểm tra chéo từng dòng hàng (`SL × ĐG − CK`), kiểm tra tổng cộng, phát hiện hóa đơn trùng (`uniqueKey`), cảnh báo ngưỡng thanh toán không dùng tiền mặt và tra cứu rủi ro MST.
- **Tier 1 & 2 — PDF Text & Vision LLM (`Vercel AI SDK`):** Tự render PDF bằng `pdfjs-dist` + `@napi-rs/canvas` + `sharp` (không cần cài Ghostscript/GraphicsMagick). Hỗ trợ fallback đa nhà cung cấp **Google Gemini, OpenAI, Anthropic Claude, Mistral AI**, hoặc **Local LLM OpenAI-compatible** (Ollama, LM Studio, vLLM, OpenRouter).
- **Zero-Hallucination Provenance:** Mọi trường trích xuất gắn badge độ tin cậy (`XML 100%` / `AI 92%` / `Kiểm tra`); trường không đọc được giữ `null` kèm cảnh báo, tuyệt đối không bịa `0`.
- **Item Splitting:** Tách 1 hóa đơn nhiều dòng thành nhiều giao dịch riêng lẻ hoặc giữ nguyên kèm chi tiết mặt hàng.

### 2. Kế toán Việt Nam (TT 99/2025 · TT 200 · TT 133 · Hộ kinh doanh 2026)
- **Đa Công ty / Đa MST:** Chuyển đổi nhanh nhiều mã số thuế & chế độ kế toán (`TT99_2025`, `TT200_2014`, `TT133_2016`, `HKD_2026`) trong cùng một ứng dụng.
- **Tự động định khoản Nợ/Có:** Sinh bút toán kép cân bằng (`∑Nợ === ∑Có`) theo danh mục, đối tác và hình thức thanh toán.
- **Đối chiếu sao kê ngân hàng 3 bên:** Nạp sao kê CSV/XLSX (VCB, TCB, MB, BIDV, ACB, VPBank...) và tự khớp theo số tiền, số hóa đơn, MST và ngày chứng từ.
- **Bảng kê Thuế GTGT & Sổ HKD:** Tổng hợp theo từng thuế suất (`0%`, `5%`, `8%`, `10%`, `KCT`, `KKKNT`) và sổ doanh thu/chi phí S1/S2-HKD.

### 3. Chuyển đổi & Xuất dữ liệu chuẩn Việt Nam
- **Built-in iTaxViewer & Batch XML → PDF:** Xem bản thể hiện hóa đơn chuẩn từ XML và chuyển đổi hàng loạt sang A4 PDF.
- **Xuất Excel chuyên dụng:** Bảng kê Mua vào / Bán ra **HTKK** (cột MST & Số HĐ ép định dạng Text giữ số `0`, sẵn công thức `SUM`), mẫu Import **MISA SME / AMIS**, mẫu **Fast / Bravo**, **CSV + ZIP chứng từ gốc** (chuẩn hóa tên file ASCII không dấu chống lỗi macOS NFD ↔ Windows NFC).
- **Sao lưu & Phục hồi Toàn bộ (`.zip`):** Đóng gói cả SQLite database lẫn kho chứng từ `vault/` vào một tệp ZIP duy nhất.

### 4. Hệ sinh thái Mini-Apps & Multi-Currency
- **Giám sát Email (IMAP Auto-Sync):** Tự động tải XML/PDF/ZIP từ Gmail, Outlook, iCloud, Yahoo, Fastmail, Custom IMAP; lưu mật khẩu qua macOS Keychain / Windows DPAPI.
- **Trình tạo Hóa đơn & VietQR NAPAS 247:** Xuất hóa đơn PDF mẫu VN / EN / DE tích hợp mã QR thanh toán VietQR tự động.
- **Đồng bộ Cổng HĐĐT Tổng cục Thuế (`hoadondientu.gdt.gov.vn`):** Tích hợp modal CAPTCHA SVG để người dùng nhập trực tiếp và kéo hàng loạt XML về sổ.
- **Đa tiền tệ & Crypto:** Hỗ trợ 50+ tiền tệ phổ biến & Crypto kèm tra cứu tỷ giá lịch sử (Vietcombank / currency-api / frankfurter).

---

## Cài đặt & Phát triển (Local Development)

Yêu cầu: **Node.js >= 22**, **pnpm >= 12**.

```bash
# Cài đặt toàn bộ workspace
pnpm install

# Build các thư viện lõi & chạy ứng dụng Desktop trên macOS / Windows
pnpm build
pnpm dev

# Chạy bộ kiểm thử tự động & kiểm tra kiểu TypeScript
pnpm typecheck
pnpm test
pnpm test:e2e:mac
```

### Đóng gói Desktop (macOS `.dmg`/`.zip` & Windows `.exe`)

```bash
# Đóng gói cho macOS (arm64 + x64)
pnpm dist:mac

# Đóng gói cho Windows (NSIS installer + Portable x64)
pnpm dist:win
```

### Chạy chế độ Web / Docker Self-Hosted

```bash
cd apps/web
docker compose up -d --build
# Truy cập http://localhost:7331
```

---

## Kiến trúc Monorepo

- `packages/core`: Logic nghiệp vụ thuần TypeScript (XML parser QĐ 1450/1510, XMLDSig, Audit, AI pipeline, PDF renderer, VAS Auto-Posting, Exporters HTKK/MISA/VietQR, IMAP sync, GDT client).
- `packages/db`: Drizzle ORM SQLite (WAL + FTS5 full-text search), Vault lưu trữ theo SHA-256, Backup/Restore ZIP, ứng dụng `TTaxService`.
- `packages/ui`: Giao diện React 19 + Tailwind CSS v4 theo chuẩn **Minimal Specular Liquid Glass** dùng chung cho Desktop IPC & Web HTTP.
- `apps/desktop`: Vỏ Electron 45 (macOS Vibrancy `under-window` + Tray Popover `364px`, Windows 11 Mica, `safeStorage`, Chromium `printToPDF`).
- `apps/web`: Máy chủ Hono API + Static SPA + Dockerfile.

---

## Bản quyền & Ghi nhận

Phát hành theo giấy phép **MIT** ([LICENSE](LICENSE)). Xem [NOTICE](NOTICE) để biết chi tiết ghi nhận dự án gốc `vas3k/TaxHacker` và các chuẩn dữ liệu hóa đơn điện tử Việt Nam.
