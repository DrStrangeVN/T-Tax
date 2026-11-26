export type EntityType = "enterprise" | "household" | "freelancer"
export type AccountingRegime = "TT99_2025" | "TT200_2014" | "TT133_2016" | "HKD_2026"
export type TransactionDirection = "input" | "output"
export type TransactionType = "expense" | "income" | "transfer"
export type PaymentStatus = "unpaid" | "paid" | "partial"
export type ComplianceStatus = "valid" | "warning" | "error" | "pending"
export type ExtractionMethod = "none" | "xml" | "pdf_text" | "vlm" | "hybrid" | "local_ocr"
export type DocumentKind = "einvoice" | "handwritten_bill" | "printed_receipt"
export type GlassIntensity = "clear" | "balanced" | "solid"
export type SidebarMode = "expanded" | "rail" | "collapsed"
export type ThemeMode = "dark" | "light" | "system"
export type HkdTaxSectorCode = "pp" | "dv" | "sx" | "khac"

export interface UiPreferences {
  isLight: boolean
  glassIntensity: GlassIntensity
  sidebarMode: SidebarMode
  activeWorkspaceId?: string
  visibleCols?: string[]
  unsortedSplitPct?: number
  txInspectorWidth?: number
  batchSplitPct?: number
  hkdSector?: HkdTaxSectorCode
}

export interface WorkspaceBadgeCounts {
  unreviewedCount: number
  complianceWarnings: number
  unmatchedBankCount?: number
}

export interface TrialBalanceRow {
  code: string
  name: string
  nature: string
  openingDebit: number
  openingCredit: number
  periodDebit: number
  periodCredit: number
  closingDebit: number
  closingCredit: number
}

export interface OpeningBalanceRow {
  accountCode: string
  openingDebit: number
  openingCredit: number
}

export interface AccountLedgerRow {
  entryId: string
  voucherNo: string
  voucherDate: string
  description: string
  counterAccount: string
  debitAmount: number
  creditAmount: number
  runningBalance: number
  transactionId?: string | null
}

export interface BankMatchItem {
  transactionId: string
  allocatedAmountVnd: number
  merchant?: string | null
  invoiceNumber?: string | null
  issuedAt?: string | null
  totalAmount?: number
}

export interface BatchAnalyzeProgressEvent {
  jobId: string
  done: number
  total: number
  currentFileId: string
  currentFilename: string
  status: "running" | "done" | "cancelled" | "error"
  error?: string
}

export interface BankDetails {
  bankBin?: string
  bankName?: string
  accountNo?: string
  accountName?: string
}

export interface WorkspaceDTO {
  id: string
  name: string
  taxCode: string
  entityType: EntityType
  accountingRegime: AccountingRegime
  fiscalYearStart: string
  baseCurrency: string
  address?: string | null
  bankDetails?: BankDetails | null
  lockDate?: string | null
  logoPath?: string | null
  createdAt: string
  updatedAt: string
}

export interface FieldProvenance {
  source: "xml" | "pdf_text" | "vlm" | "manual" | "rule" | "local_ocr"
  confidence: number
  warning?: string
}

export interface LineItemDTO {
  index: number
  nature?: number // TChat: 1=HHDV, 2=KhuyenMai, 3=ChietKhau, 4=GhiChu
  code?: string
  name: string
  unit?: string
  quantity?: string
  unitPrice?: string
  discountRate?: string
  discountAmount?: number
  preTaxAmount: number
  vatRate?: string
  vatAmount?: number
  amount: number
  suggestedAccountCode?: string
  categoryCode?: string
  projectCode?: string
}

export interface PartyInfo {
  name?: string
  taxCode?: string
  address?: string
  phone?: string
  email?: string
  bankAccount?: string
  bankName?: string
  contactName?: string
  buyerCode?: string
  citizenId?: string // CCCDan (ND 70/2025)
  budgetUnitCode?: string // MDVQHNSach (ND 70/2025)
}

export interface DecodedInvoiceSymbol {
  templateCode: string // 1..6
  templateLabel: string
  fullSymbol: string // 6 chars e.g. C26TAA
  hasTaxAuthorityCode: boolean // C = true, K = false
  year: number // 2026
  kindCode: string // T, D, L, M, N, B, G, H
  kindLabel: string
  managementCode: string
  isCashRegister: boolean // kindCode === 'M'
}

export interface VatBreakdownEntry {
  vatRate: string // "0%", "5%", "8%", "10%", "KCT", "KKKNT", "KHAC:..."
  taxableAmount: number
  vatAmount: number
}

export interface RelatedInvoiceRef {
  nature?: number // 1=Thay the, 2=Dieu chinh
  templateCode?: string
  symbol?: string
  number?: string
  issuedDate?: string
  note?: string
}

export interface ParsedEInvoice {
  uniqueKey: string // MST_Ban|KHMSHDon|KHHDon|SHDon
  version?: string // PBan (e.g., 2.0.1 / 2.1.0)
  invoiceTitle?: string // THDon
  templateCode: string // KHMSHDon
  symbol: string // KHHDon
  decodedSymbol?: DecodedInvoiceSymbol
  invoiceNumber: string // SHDon (string preserving leading zeros!)
  issuedDate: string // NLap (YYYY-MM-DD)
  signedDate?: string
  currencyCode: string // DVTTe (VND)
  exchangeRate: string // TGia
  paymentMethod?: string // HTTToan
  mccqt?: string // Ma co quan thue
  tvanTaxCode?: string // MSTTCGP
  relatedInvoice?: RelatedInvoiceRef
  seller: PartyInfo
  buyer: PartyInfo
  items: LineItemDTO[]
  vatBreakdown: VatBreakdownEntry[]
  totals: {
    totalBeforeVat: number
    totalDiscount: number
    totalVat: number
    totalPayable: number
    totalPayableInWords?: string
  }
  hasDigitalSignature: boolean
  rawSignatureXmlPresent: boolean
  qrContent?: string
}

export interface XmlSignatureVerification {
  status: "valid" | "invalid" | "unsigned" | "unverified_ca"
  sellerSigned: boolean
  taxAuthoritySigned: boolean
  digestMatched: boolean
  signatureCryptographicValid: boolean
  signerCn?: string
  signerTaxCode?: string
  signerIssuer?: string
  validFrom?: string
  validTo?: string
  signingTime?: string
  issues: string[]
}

export interface AuditIssue {
  code:
    | "LINE_ARITHMETIC_MISMATCH"
    | "SUBTOTAL_MISMATCH"
    | "TOTAL_PAYABLE_MISMATCH"
    | "DUPLICATE_INVOICE"
    | "NON_CASH_THRESHOLD_CASH"
    | "ADJUSTED_OR_REPLACED_INVOICE"
    | "UNSIGNED_XML"
    | "INVALID_SIGNATURE"
    | "CERT_EXPIRED_AT_SIGNING"
    | "SELLER_MST_RISK"
    | "MISSING_MCCQT_FOR_CODED"
    | "LOW_OCR_CONFIDENCE"
    | "HANDWRITTEN_NO_EINVOICE"
    | "HANDWRITTEN_ARITHMETIC_MISMATCH"
    | "AMOUNT_IN_WORDS_MISMATCH"
    | "TOTAL_AUTO_SUMMED"
    | "AUTO_ROTATED_IMAGE"
    | "VND_THOUSANDS_NORMALIZED"
  severity: "error" | "warning" | "info"
  message: string
  field?: string
  expected?: string | number
  actual?: string | number
}

export interface LegalRule {
  ruleKey: string
  title: string
  documentRef: string
  effectiveFrom: string
  expiresAt: string
  replacedBy?: string | null
  payload: Record<string, unknown>
}

export type LLMProviderType = "openai" | "google" | "mistral" | "anthropic" | "openai_compatible"

export interface LLMProviderConfig {
  provider: LLMProviderType
  apiKey: string
  model: string
  baseUrl?: string
  maxConcurrency?: number
  enabled?: boolean
}

export interface AnalyzeProgressCounts {
  analyzing: number
  queued: number
  done: number
  error: number
  total: number
}

export interface SmartRuleDTO {
  id: string
  workspaceId: string
  name: string
  priority: number
  enabled: boolean
  matchField: "merchant" | "merchantTaxCode" | "name" | "description" | "any"
  matchType: "contains" | "equals" | "regex"
  pattern: string
  direction: "all" | "input" | "output"
  assignCategoryCode?: string | null
  assignDebitAccount?: string | null
  assignCreditAccount?: string | null
  assignProjectCode?: string | null
  taxDeductible?: boolean | null
  hitCount: number
  createdAt: string
}

export interface TaxAuditAnomaly {
  id: string
  code:
    | "DUPLICATE_INVOICE_NO"
    | "DUPLICATE_PAYMENT_SUSPECT"
    | "NON_CASH_THRESHOLD_VIOLATION"
    | "VENDOR_CATEGORY_DRIFT"
    | "AMOUNT_SPIKE_ANOMALY"
    | "COUNTERPARTY_MST_RISK"
    | "ARITHMETIC_MISMATCH"
    | "MISSING_MST_HIGH_VALUE"
    | "COMPLIANCE_FLAGGED"
  severity: "critical" | "high" | "medium" | "info"
  title: string
  description: string
  recommendation: string
  transactionIds: string[]
  merchant?: string
  merchantTaxCode?: string
  vatAtRiskVnd: number
  citAtRiskVnd: number
  amountVnd: number
}

export interface TaxAuditReport {
  scannedAt: string
  totalTransactions: number
  healthScore: number
  summary: {
    critical: number
    high: number
    medium: number
    info: number
    totalVatAtRiskVnd: number
    totalCitAtRiskVnd: number
  }
  anomalies: TaxAuditAnomaly[]
}

export interface RecurringExpenseItem {
  merchant: string
  merchantTaxCode?: string
  categoryCode?: string
  occurrences: number
  averageAmountVnd: number
  estimatedMonthlyVnd: number
  intervalDays: number
  lastIssuedAt: string
  nextExpectedAt: string
  confidence: "high" | "medium"
}

export interface CashflowForecastMonth {
  period: string
  projectedRevenueVnd: number
  projectedExpenseVnd: number
  projectedVatPayableVnd: number
  projectedCitEstimateVnd: number
  netCashflowVnd: number
  endingCashBalanceVnd: number
}

export interface CashflowAnalytics {
  currentCashVnd: number
  averageMonthlyRevenueVnd: number
  averageMonthlyBurnVnd: number
  netMonthlyCashflowVnd: number
  runwayMonths: number | null
  recurringMonthlyTotalVnd: number
  recurringExpenses: RecurringExpenseItem[]
  forecastMonths: CashflowForecastMonth[]
  estimatedQuarterlyCitVnd: number
  estimatedVatPayableVnd: number
}

export interface AgingBucketSummary {
  current0To30: number
  days31To60: number
  days61To90: number
  over90: number
  total: number
}

export interface CounterpartyAgingRow {
  counterpartyKey: string
  name: string
  taxCode: string
  direction: "receivable" | "payable"
  invoiceCount: number
  oldestDate: string
  buckets: AgingBucketSummary
  transactionIds: string[]
}

export interface ArApAgingReport {
  asOfDate: string
  receivableTotal: number
  payableTotal: number
  receivableBuckets: AgingBucketSummary
  payableBuckets: AgingBucketSummary
  rows: CounterpartyAgingRow[]
}

export interface FixedAssetDTO {
  id: string
  workspaceId: string
  code: string
  name: string
  assetType: "tscd" | "ccdc"
  purchaseDate: string
  originalCostVnd: number
  residualValueVnd: number
  usefulLifeMonths: number
  monthlyDepreciationVnd: number
  accumulatedDepreciationVnd: number
  remainingValueVnd: number
  assetAccount: string
  depreciationAccount: string
  expenseAccount: string
  department?: string | null
  status: "active" | "fully_depreciated" | "disposed"
  lastDepreciatedPeriod?: string | null
  sourceTransactionId?: string | null
  createdAt: string
}

export interface ExternalMcpServerConfig {
  id: string
  name: string
  transport: "stdio" | "http"
  enabled: boolean
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  bearerToken?: string
  cachedTools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>
  lastConnectedAt?: string
  lastError?: string
}

export interface McpHostStatus {
  running: boolean
  host: string
  port: number
  url: string
  bearerToken: string
  requestCount: number
  recentLogs: Array<{
    ts: string
    method: string
    tool?: string
    ok: boolean
    durationMs: number
    error?: string
  }>
}

export interface AiCopilotToolTrace {
  toolName: string
  source: "ttax" | "mcp"
  serverName?: string
  args: Record<string, unknown>
  summary: string
  ok: boolean
  durationMs: number
}

export interface AiCopilotAction {
  label: string
  kind: "navigate" | "open_tx" | "open_accounting" | "open_counterparty"
  target: string
}

export interface AiCopilotMessage {
  id: string
  sessionId: string
  role: "user" | "assistant"
  content: string
  toolTraces?: AiCopilotToolTrace[]
  actions?: AiCopilotAction[]
  providerUsed?: string
  createdAt: string
}

export interface AiCopilotSession {
  id: string
  workspaceId: string
  title: string
  createdAt: string
  updatedAt: string
}
