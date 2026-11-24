import { describe, it, expect } from "vitest"
import forge from "node-forge"
import { SignedXml } from "xml-crypto"
import {
  extractTT78Xml,
  decodeInvoiceSymbol,
  verifyEInvoiceXmlSignature,
  auditParsedEInvoice,
  renderEInvoiceHtml
} from "@t-tax/core"

const SAMPLE_VAT_XML = `\uFEFF<?xml version="1.0" encoding="UTF-8"?>
<inv:HDon xmlns:inv="http://hoadondientu.gdt.gov.vn/schema">
  <inv:DLieu>
    <inv:DLHDon Id="InvoiceData">
      <inv:TTChung>
        <inv:PBan>2.1.0</inv:PBan>
        <inv:THDon>HÓA ĐƠN GIÁ TRỊ GIA TĂNG</inv:THDon>
        <inv:KHMSHDon>1</inv:KHMSHDon>
        <inv:KHHDon>C26TAA</inv:KHHDon>
        <inv:SHDon>00001234</inv:SHDon>
        <inv:NLap>2026-05-15</inv:NLap>
        <inv:DVTTe>VND</inv:DVTTe>
        <inv:TGia>1</inv:TGia>
        <inv:HTTToan>Tiền mặt</inv:HTTToan>
      </inv:TTChung>
      <inv:NDHDon>
        <inv:NBan>
          <inv:Ten>CÔNG TY TNHH GIẢI PHÁP T-TAX</inv:Ten>
          <inv:MST>0312345678</inv:MST>
          <inv:DChi>123 Lê Lợi, Quận 1, TP.HCM</inv:DChi>
        </inv:NBan>
        <inv:NMua>
          <inv:Ten>CÔNG TY CP KHÁCH HÀNG</inv:Ten>
          <inv:MST>0109876543</inv:MST>
          <inv:DChi>Hà Nội</inv:DChi>
          <inv:CCCDan>079095001234</inv:CCCDan>
          <inv:MDVQHNSach>1020304</inv:MDVQHNSach>
        </inv:NMua>
        <inv:DSHHDVu>
          <inv:HHDVu>
            <inv:TChat>1</inv:TChat>
            <inv:STT>1</inv:STT>
            <inv:THHDVu>Gói phần mềm kế toán doanh nghiệp</inv:THHDVu>
            <inv:DVTinh>Gói</inv:DVTinh>
            <inv:SLuong>2</inv:SLuong>
            <inv:DGia>11000000</inv:DGia>
            <inv:ThTien>22000000</inv:ThTien>
            <inv:TSuat>8%</inv:TSuat>
          </inv:HHDVu>
        </inv:DSHHDVu>
        <inv:TToan>
          <inv:THTTLTSuat>
            <inv:LTSuat>
              <inv:TSuat>8%</inv:TSuat>
              <inv:ThTien>22000000</inv:ThTien>
              <inv:TThue>1760000</inv:TThue>
            </inv:LTSuat>
          </inv:THTTLTSuat>
          <inv:TgTCThue>22000000</inv:TgTCThue>
          <inv:TgTThue>1760000</inv:TgTThue>
          <inv:TgTTTBSo>23760000</inv:TgTTTBSo>
          <inv:TgTTTBChu>Hai mươi ba triệu bảy trăm sáu mươi nghìn đồng</inv:TgTTTBChu>
        </inv:TToan>
      </inv:NDHDon>
    </inv:DLHDon>
  </inv:DLieu>
  <inv:MCCQT>00112233445566778899AABBCCDDEEFF</inv:MCCQT>
</inv:HDon>`

function createSignedInvoiceXml(rawXml: string): string {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = "01"
  cert.validity.notBefore = new Date(Date.now() - 86400_000)
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400_000)
  const attrs = [
    { name: "commonName", value: "CONG TY TNHH GIAI PHAP T-TAX MST:0312345678" },
    { name: "organizationName", value: "VNPT-CA TEST" }
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.sign(keys.privateKey, forge.md.sha256.create())

  const privatePem = forge.pki.privateKeyToPem(keys.privateKey)
  const certPem = forge.pki.certificateToPem(cert)
  const certB64 = certPem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, "")

  const sig = new SignedXml({
    privateKey: privatePem,
    publicCert: certPem,
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"
  })
  sig.addReference({
    xpath: "//*[local-name()='DLHDon']",
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"]
  })
  sig.keyInfoProvider = {
    getKeyInfo: () => `<X509Data><X509Certificate>${certB64}</X509Certificate></X509Data>`,
    getKey: () => Buffer.from(certPem)
  } as never

  const unsignedClean = rawXml.replace(/^\uFEFF/, "")
  sig.computeSignature(unsignedClean, {
    location: { reference: "//*[local-name()='HDon']", action: "append" }
  })
  return sig.getSignedXml()
}

describe("VN E-Invoice XML Engine (QĐ 1450/1510 & NĐ 70/2025)", () => {
  it("preserves leading zeros in MST & SHDon, strips BOM/prefixes, and decodes ND70 buyer fields", () => {
    const parsed = extractTT78Xml(SAMPLE_VAT_XML)
    expect(parsed.seller.taxCode).toBe("0312345678")
    expect(parsed.buyer.taxCode).toBe("0109876543")
    expect(parsed.invoiceNumber).toBe("00001234")
    expect(parsed.buyer.citizenId).toBe("079095001234")
    expect(parsed.buyer.budgetUnitCode).toBe("1020304")
    expect(parsed.items).toHaveLength(1)
    expect(parsed.items[0]?.vatAmount).toBe(1_760_000)
    expect(parsed.totals.totalPayable).toBe(23_760_000)
    expect(parsed.uniqueKey).toBe("0312345678|1|C26TAA|00001234")
  })

  it("decodes Cash Register (M) and standard symbols cleanly", () => {
    const m = decodeInvoiceSymbol("1C26MAA")
    expect(m?.hasTaxAuthorityCode).toBe(true)
    expect(m?.year).toBe(2026)
    expect(m?.isCashRegister).toBe(true)
    expect(m?.templateCode).toBe("1")
  })

  it("verifies valid XMLDSig and rejects tampered XML", () => {
    const signed = createSignedInvoiceXml(SAMPLE_VAT_XML)
    const validRes = verifyEInvoiceXmlSignature(signed)
    expect(validRes.signatureCryptographicValid).toBe(true)
    expect(validRes.signerTaxCode).toBe("0312345678")
    expect(validRes.status).toBe("valid")

    const tampered = signed.replace("22000000", "22000001")
    const badRes = verifyEInvoiceXmlSignature(tampered)
    expect(badRes.signatureCryptographicValid).toBe(false)
    expect(badRes.status).toBe("invalid")
  })

  it("flags arithmetic mismatch, duplicate uniqueKey, and non-cash cash payment threshold", async () => {
    const parsed = extractTT78Xml(SAMPLE_VAT_XML)
    const audit1 = auditParsedEInvoice(parsed, {
      nonCashThresholdVnd: 20_000_000,
      existingUniqueKeys: new Set([parsed.uniqueKey])
    })
    expect(audit1.arithmeticValid).toBe(true)
    expect(audit1.issues.some((i) => i.code === "DUPLICATE_INVOICE")).toBe(true)
    expect(audit1.issues.some((i) => i.code === "NON_CASH_THRESHOLD_CASH")).toBe(true)

    const broken = { ...parsed, totals: { ...parsed.totals, totalPayable: 99_999_999 } }
    const audit2 = auditParsedEInvoice(broken)
    expect(audit2.arithmeticValid).toBe(false)
    expect(audit2.issues.some((i) => i.code === "TOTAL_PAYABLE_MISMATCH")).toBe(true)

    const html = await renderEInvoiceHtml(parsed)
    expect(html).toContain("0312345678")
    expect(html).toContain("00001234")
  })
})
