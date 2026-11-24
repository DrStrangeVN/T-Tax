import { test, expect, _electron as electron } from "@playwright/test"
import { mkdtempSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<HDon>
  <DLHDon>
    <TTChung>
      <THDon>HÓA ĐƠN GIÁ TRỊ GIA TĂNG</THDon>
      <KHMSHDon>1</KHMSHDon>
      <KHHDon>C26TAA</KHHDon>
      <SHDon>00004321</SHDon>
      <NLap>2026-07-01</NLap>
      <DVTTe>VND</DVTTe>
      <TGia>1</TGia>
      <HTTToan>Chuyển khoản</HTTToan>
    </TTChung>
    <NDHDon>
      <NBan>
        <Ten>CÔNG TY TNHH DỊCH VỤ PHẦN MỀM VN</Ten>
        <MST>0312000111</MST>
        <DChi>Quận 3, TP.HCM</DChi>
      </NBan>
      <NMua>
        <Ten>Công ty TNHH T-Tax Demo</Ten>
        <MST>0312345678</MST>
      </NMua>
      <DSHHDVu>
        <HHDVu>
          <STT>1</STT>
          <THHDVu>Thuê bản quyền T-Tax Enterprise</THHDVu>
          <DVTinh>Năm</DVTinh>
          <SLuong>1</SLuong>
          <DGia>12000000</DGia>
          <ThTien>12000000</ThTien>
          <TSuat>8%</TSuat>
        </HHDVu>
      </DSHHDVu>
      <TToan>
        <THTTLTSuat>
          <LTSuat>
            <TSuat>8%</TSuat>
            <ThTien>12000000</ThTien>
            <TThue>960000</TThue>
          </LTSuat>
        </THTTLTSuat>
        <TgTCThue>12000000</TgTCThue>
        <TgTThue>960000</TgTThue>
        <TgTTTBSo>12960000</TgTTTBSo>
      </TToan>
    </NDHDon>
  </DLHDon>
</HDon>`

test("T-Tax macOS Desktop E2E: Liquid Glass UI, Shortcuts, XML Ingest, Approval & VAS Ledger", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "ttax-e2e-"))
  const shotDir = process.env.TTAX_SHOT_DIR || join(userDataDir, "shots")
  mkdirSync(shotDir, { recursive: true })

  const app = await electron.launch({
    args: [resolve("apps/desktop/out/main/index.js")],
    env: {
      ...process.env,
      TTAX_USER_DATA_DIR: userDataDir
    }
  })

  try {
    // Wait for main window (exclude 364px tray popover)
    let page = await app.firstWindow()
    for (let i = 0; i < 15; i++) {
      const wins = app.windows()
      const mainWin = wins.find((w) => !w.url().includes("view=tray"))
      if (mainWin) {
        page = mainWin
        break
      }
      await new Promise((r) => setTimeout(r, 200))
    }

    await page.waitForLoadState("domcontentloaded")
    await page.waitForSelector(".ttax-shell", { timeout: 15_000 })

    const pageErrors: string[] = []
    page.on("pageerror", (err) => pageErrors.push(err.message))

    // 1. Audit Liquid Glass rules on Dashboard (Dark Mode)
    const audit = await page.evaluate(() => {
      const bodyStyle = getComputedStyle(document.body)
      const bgImg = bodyStyle.backgroundImage
      const overflow = document.documentElement.scrollWidth > document.documentElement.clientWidth
      const hasTabular = bodyStyle.fontVariantNumeric.includes("tabular-nums")
      return { bgImg, overflow, hasTabular }
    })
    expect(audit.bgImg).toBe("none")
    expect(audit.overflow).toBe(false)
    expect(audit.hasTabular).toBe(true)

    await page.screenshot({ path: join(shotDir, "01-dashboard-dark.png") })

    // 2. Test Command Palette (⌘K / Ctrl+K) + Vietnamese diacritic-insensitive match
    await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k")
    await expect(page.locator(".pal")).toBeVisible()
    await page.locator('.pal input[type="text"], .pal input:not([type])').first().fill("phieu ke toan")
    await expect(page.locator('.pal >> text=Tạo phiếu kế toán').first()).toBeVisible({ timeout: 5_000 })
    await page.locator('.pal input[type="text"], .pal input:not([type])').first().fill("")
    await page.screenshot({ path: join(shotDir, "02-command-palette.png") })
    await page.keyboard.press("Escape")

    // 3. Test Sidebar Collapse (⌘\)
    await page.keyboard.press(process.platform === "darwin" ? "Meta+\\" : "Control+\\")
    await expect(page.locator("body")).toHaveClass(/sb-off/)
    await page.keyboard.press(process.platform === "darwin" ? "Meta+\\" : "Control+\\")
    await expect(page.locator("body")).not.toHaveClass(/sb-off/)

    // 4. Navigate to Unsorted Inbox & upload XML via transport/file input
    await page.click('[data-nav="unsorted"]')
    const fileInput = page.locator('input[type="file"][accept*=".xml"]').last()
    await fileInput.setInputFiles({
      name: "HD_00004321.xml",
      mimeType: "application/xml",
      buffer: Buffer.from(SAMPLE_XML, "utf8")
    })

    await expect(page.locator("text=HD_00004321.xml").first()).toBeVisible({ timeout: 10_000 })
    await page.click('button:has-text("Bóc tách ngay")')
    await expect(page.locator("text=XML 100%").first()).toBeVisible({ timeout: 10_000 })
    await page.screenshot({ path: join(shotDir, "03-unsorted-xml-review.png") })

    // Approve & auto-post + Undo Toast check
    await page.click('button:has-text("Duyệt & Ghi sổ")')
    await expect(page.locator("text=Hộp thư chứng từ đang sạch")).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('button:has-text("Hoàn tác")').first()).toBeVisible({ timeout: 5_000 })

    // 5. Verify Transaction Ledger, Bộ lọc, Sticky Tổng cộng & Docked Split-Pane Right Inspector
    await page.click('[data-nav="transactions"]')
    await expect(page.locator("text=00004321")).toBeVisible({ timeout: 10_000 })
    await expect(page.locator("text=0312000111")).toBeVisible()
    await expect(page.locator('button:has-text("Bộ lọc")').first()).toBeVisible()
    await expect(page.locator('button:has-text("Tổng cộng")').first()).toBeVisible()
    await page.locator("text=00004321").first().click()
    await expect(page.locator('button:has-text("Định khoản")').first()).toBeVisible({ timeout: 10_000 })
    await page.click('button:has-text("Mặt hàng & Cảnh báo")')
    await expect(page.getByText("Thuê bản quyền T-Tax Enterprise", { exact: true })).toBeVisible({ timeout: 10_000 })
    await page.screenshot({ path: join(shotDir, "04-transactions-ledger.png") })
    await page.keyboard.press("Escape")

    // 6. Verify Accounting VAS Journal Entry, Trial Balance & Account Ledger Drawer
    await page.click('[data-nav="accounting"]')
    await expect(page.locator("h1")).toContainText("Kế toán", { timeout: 10_000 })
    await expect(page.locator('input[value="1331"]').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator("text=∑Nợ = ∑Có")).toBeVisible()
    await page.screenshot({ path: join(shotDir, "05-accounting-vas.png") })
    await page.click('button:has-text("Cân đối Tài khoản")')
    await expect(page.locator("text=Tổng Cân đối Tài khoản").first()).toBeVisible({ timeout: 10_000 })
    await page.screenshot({ path: join(shotDir, "05b-accounting-trial-balance.png") })
    await page.locator('tbody tr:has-text("1331")').first().click()
    await expect(page.locator("text=Sổ chi tiết Tài khoản 1331").first()).toBeVisible({ timeout: 10_000 })
    await page.screenshot({ path: join(shotDir, "05c-accounting-ledger-drawer.png") })
    await page.keyboard.press("Escape")

    // Test Command Palette FTS5 Search after tx committed
    await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k")
    await page.locator('.pal input[type="text"], .pal input:not([type])').first().fill("00004321")
    await expect(page.locator('.pal >> text=00004321').first()).toBeVisible({ timeout: 5_000 })
    await page.keyboard.press("Escape")

    // 7. Batch Converter XML scan, selection & preview
    await page.click('[data-nav="converter"]')
    const batchInput = page.locator('main input[type="file"][accept*=".xml"]').first()
    await batchInput.setInputFiles({
      name: "BATCH_00004321.xml",
      mimeType: "application/xml",
      buffer: Buffer.from(SAMPLE_XML, "utf8")
    })
    await expect(page.locator("text=00004321").first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('button:has-text("Ghi sổ")').first()).toBeVisible()
    await page.click('main button:has-text("Xem")')
    await expect(page.locator('iframe[title="iTaxViewer Preview"]')).toBeVisible({ timeout: 10_000 })
    await page.screenshot({ path: join(shotDir, "07-converter.png") })

    // 8. Counterparties MST Registry (Vietnamese badges)
    await page.click('[data-nav="counterparties"]')
    await expect(page.locator("text=0312000111").first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator("text=Chưa tra cứu").first()).toBeVisible({ timeout: 5_000 })
    await page.screenshot({ path: join(shotDir, "08-counterparties.png") })

    // 9. Mini-Apps Hub & Outgoing Invoice + VietQR
    await page.click('[data-nav="apps"]')
    await expect(page.locator("text=Trình Tạo Hóa đơn & VietQR")).toBeVisible({ timeout: 10_000 })
    await page.click('button:has-text("Trình Tạo Hóa đơn & VietQR")')
    await expect(page.locator('iframe[title="Outgoing Invoice Preview"]')).toBeVisible({ timeout: 10_000 })
    await page.screenshot({ path: join(shotDir, "09-miniapps-invoice-vietqr.png") })

    // 10. Vault Master-Detail & Settings (including Period Lock)
    await page.click('[data-nav="vault"]')
    await expect(page.locator("text=HD_00004321.xml").first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('button:has-text("Đã gắn sổ")').first()).toBeVisible()
    await page.locator("text=HD_00004321.xml").first().click()
    await expect(page.locator('iframe[title="Vault XML Preview"], pre').first()).toBeVisible({ timeout: 10_000 })
    await page.screenshot({ path: join(shotDir, "09b-vault.png") })
    await page.click('[data-nav="settings"]')
    await expect(page.locator("text=Thông tin Pháp nhân & Chế độ Kế toán")).toBeVisible({ timeout: 10_000 })
    await expect(page.locator("text=Khóa sổ Kỳ kế toán").first()).toBeVisible({ timeout: 5_000 })
    await page.screenshot({ path: join(shotDir, "10-settings.png") })

    // 11. Toggle Light Mode & verify clean Light Liquid Glass
    await page.click('[title="Đổi Sáng / Tối"]')
    await expect(page.locator("body")).toHaveClass(/light/)
    await page.click('[data-nav="dashboard"]')
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(shotDir, "06-dashboard-light.png") })

    // 12. Verify Tray Popover window rendered & synced
    const trayWin = app.windows().find((w) => w.url().includes("view=tray"))
    expect(trayWin).toBeTruthy()
    if (trayWin) {
      await expect(trayWin.locator("text=T-Tax Quick Drop")).toBeVisible({ timeout: 10_000 })
      await trayWin.screenshot({ path: join(shotDir, "11-tray-popover.png") })
    }

    expect(pageErrors).toEqual([])
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
