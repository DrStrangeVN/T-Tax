import { SignedXml } from "xml-crypto"
import forge from "node-forge"
import type { XmlSignatureVerification } from "../types.js"

const SIGNATURE_BLOCK_REGEX = /<(?:[a-zA-Z0-9_-]+:)?Signature\b[^>]*>[\s\S]*?<\/(?:[a-zA-Z0-9_-]+:)?Signature>/gi
const X509_CERT_REGEX = /<(?:[a-zA-Z0-9_-]+:)?X509Certificate\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?X509Certificate>/gi
const SIGNING_TIME_REGEX = /<(?:[a-zA-Z0-9_-]+:)?SigningTime\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?SigningTime>/i

const KNOWN_VN_CA_KEYWORDS = [
  "VNPT",
  "VIETTEL",
  "BKAV",
  "MISA",
  "FPT",
  "VINA",
  "NEWCA",
  "TRUSTCA",
  "EFY",
  "NC-CA",
  "FASTCA",
  "EASYCA",
  "SAFE-CA",
  "CA2",
  "MIC",
  "ROOTCA",
  "TONG CUC THUE",
  "CUC THUE"
]

function extractSubjectField(attrs: forge.pki.CertificateField[], shortName: string): string | undefined {
  const match = attrs.find((a) => a.shortName === shortName || a.name === shortName)
  return typeof match?.value === "string" ? match.value : undefined
}

function extractMstFromCert(cert: forge.pki.Certificate): string | undefined {
  for (const attr of cert.subject.attributes) {
    const val = String(attr.value || "")
    const mstMatch = val.match(/MST[:\s]*(\d{10}(?:-\d{3})?)/i)
    if (mstMatch?.[1]) return mstMatch[1]
    if (attr.shortName === "serialNumber" && /^\d{10}/.test(val)) return val
  }
  return undefined
}

export function verifyEInvoiceXmlSignature(rawXml: string): XmlSignatureVerification {
  const cleanedXml = rawXml.replace(/^\uFEFF/, "").trim()
  const sigMatches = cleanedXml.match(SIGNATURE_BLOCK_REGEX) ?? []

  if (sigMatches.length === 0) {
    return {
      status: "unsigned",
      sellerSigned: false,
      taxAuthoritySigned: false,
      digestMatched: false,
      signatureCryptographicValid: false,
      issues: ["Hóa đơn XML chưa có khối chữ ký số (<Signature>)."]
    }
  }

  const sellerSigned = /<NBan\b[^>]*>[\s\S]*?<Signature\b/i.test(cleanedXml) || sigMatches.length >= 1
  const taxAuthoritySigned = /<CQT\b[^>]*>[\s\S]*?<Signature\b/i.test(cleanedXml) || sigMatches.length >= 2

  let signerCn: string | undefined
  let signerTaxCode: string | undefined
  let signerIssuer: string | undefined
  let validFrom: string | undefined
  let validTo: string | undefined
  let signingTime: string | undefined
  let knownVnCa = false
  const issues: string[] = []

  const timeMatch = cleanedXml.match(SIGNING_TIME_REGEX)
  if (timeMatch?.[1]) {
    signingTime = timeMatch[1].trim()
  }

  // Extract first embedded X.509 certificate (seller certificate)
  const certMatches = [...cleanedXml.matchAll(X509_CERT_REGEX)]
  let firstCertPem: string | undefined

  if (certMatches.length > 0 && certMatches[0]?.[1]) {
    const b64 = certMatches[0][1].replace(/\s+/g, "")
    firstCertPem = `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)?.join("\n") ?? b64}\n-----END CERTIFICATE-----`
    try {
      const cert = forge.pki.certificateFromPem(firstCertPem)
      signerCn = extractSubjectField(cert.subject.attributes, "CN")
      signerTaxCode = extractMstFromCert(cert)
      const issuerFull = cert.issuer.attributes.map((a) => String(a.value ?? "")).join(" ")
      signerIssuer =
        extractSubjectField(cert.issuer.attributes, "O") ??
        extractSubjectField(cert.issuer.attributes, "CN")
      validFrom = cert.validity.notBefore.toISOString()
      validTo = cert.validity.notAfter.toISOString()

      const issuerUpper = issuerFull.toUpperCase()
      knownVnCa = KNOWN_VN_CA_KEYWORDS.some((kw) => issuerUpper.includes(kw))

      if (signingTime) {
        const signDt = new Date(signingTime)
        if (!Number.isNaN(signDt.getTime())) {
          if (signDt < cert.validity.notBefore || signDt > cert.validity.notAfter) {
            issues.push(`Thời điểm ký (${signingTime}) nằm ngoài thời hạn hiệu lực chứng thư số.`)
          }
        }
      }
    } catch {
      issues.push("Không thể giải mã chứng thư số X.509 nhúng trong XML.")
    }
  } else {
    issues.push("Khối chữ ký số thiếu dữ liệu X509Certificate.")
  }

  let cryptoValid = false
  let digestMatched = false

  if (firstCertPem && sigMatches[0]) {
    try {
      const sig = new SignedXml({
        publicCert: firstCertPem,
        getCertFromKeyInfo: () => firstCertPem!
      })
      sig.loadSignature(sigMatches[0])
      cryptoValid = sig.checkSignature(cleanedXml)
      digestMatched = cryptoValid
      if (!cryptoValid) {
        issues.push("Chữ ký số XMLDSig không khớp với nội dung dữ liệu hóa đơn (có thể file đã bị chỉnh sửa sau khi ký).")
      }
    } catch (err) {
      // Some VN TVAN XMLs use multi-signature Reference IDs or non-standard c14n; surface clear technical note
      issues.push(
        `Không thể xác thực mật mã XMLDSig đầy đủ: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  let status: XmlSignatureVerification["status"] = "unverified_ca"
  if (!cryptoValid && issues.some((i) => i.includes("không khớp"))) {
    status = "invalid"
  } else if (cryptoValid && knownVnCa && issues.length === 0) {
    status = "valid"
  } else if (cryptoValid) {
    status = "unverified_ca"
  } else {
    status = issues.length > 0 ? "invalid" : "unverified_ca"
  }

  return {
    status,
    sellerSigned,
    taxAuthoritySigned,
    digestMatched,
    signatureCryptographicValid: cryptoValid,
    signerCn,
    signerTaxCode,
    signerIssuer,
    validFrom,
    validTo,
    signingTime,
    issues
  }
}
