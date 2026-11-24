import { sqliteTable, text, integer, real, uniqueIndex, index, primaryKey } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  taxCode: text("tax_code").notNull(),
  entityType: text("entity_type").notNull().default("enterprise"),
  accountingRegime: text("accounting_regime").notNull().default("TT99_2025"),
  fiscalYearStart: text("fiscal_year_start").notNull().default("01-01"),
  baseCurrency: text("base_currency").notNull().default("VND"),
  address: text("address"),
  bankDetailsJson: text("bank_details_json"),
  lockDate: text("lock_date"),
  logoPath: text("logo_path"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`)
})

export const settings = sqliteTable(
  "settings",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    value: text("value")
  },
  (t) => [uniqueIndex("settings_ws_code_uq").on(t.workspaceId, t.code)]
)

export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    color: text("color").notNull().default("#2563EB"),
    llmPrompt: text("llm_prompt"),
    defaultDebitAccount: text("default_debit_account"),
    defaultCreditAccount: text("default_credit_account"),
    taxDeductibleDefault: integer("tax_deductible_default", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`)
  },
  (t) => [uniqueIndex("categories_ws_code_uq").on(t.workspaceId, t.code)]
)

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    color: text("color").notNull().default("#38BDF8"),
    llmPrompt: text("llm_prompt"),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`)
  },
  (t) => [uniqueIndex("projects_ws_code_uq").on(t.workspaceId, t.code)]
)

export const fields = sqliteTable(
  "fields",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull().default("string"),
    llmPrompt: text("llm_prompt"),
    optionsJson: text("options_json"),
    isVisibleInList: integer("is_visible_in_list", { mode: "boolean" }).notNull().default(false),
    isVisibleInAnalysis: integer("is_visible_in_analysis", { mode: "boolean" }).notNull().default(false),
    isRequired: integer("is_required", { mode: "boolean" }).notNull().default(false),
    isExtra: integer("is_extra", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(100),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`)
  },
  (t) => [uniqueIndex("fields_ws_code_uq").on(t.workspaceId, t.code)]
)

export const currencies = sqliteTable(
  "currencies",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    minorUnitScale: integer("minor_unit_scale").notNull().default(100),
    isCrypto: integer("is_crypto", { mode: "boolean" }).notNull().default(false)
  },
  (t) => [uniqueIndex("currencies_ws_code_uq").on(t.workspaceId, t.code)]
)

export const fxRatesCache = sqliteTable(
  "fx_rates_cache",
  {
    fromCode: text("from_code").notNull(),
    toCode: text("to_code").notNull(),
    rateDate: text("rate_date").notNull(),
    rateDecimal: text("rate_decimal").notNull(),
    source: text("source").notNull(),
    fetchedAt: text("fetched_at").notNull().default(sql`(CURRENT_TIMESTAMP)`)
  },
  (t) => [primaryKey({ columns: [t.fromCode, t.toCode, t.rateDate, t.source] })]
)

export const files = sqliteTable(
  "files",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    normalizedAsciiName: text("normalized_ascii_name").notNull(),
    relativePath: text("relative_path").notNull(),
    sha256: text("sha256").notNull(),
    mimetype: text("mimetype").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    source: text("source").notNull().default("upload"),
    metadataJson: text("metadata_json"),
    pairedFileId: text("paired_file_id"),
    isReviewed: integer("is_reviewed", { mode: "boolean" }).notNull().default(false),
    isSplitted: integer("is_splitted", { mode: "boolean" }).notNull().default(false),
    extractionMethod: text("extraction_method").notNull().default("none"),
    extractionConfidence: real("extraction_confidence"),
    cachedParseResultJson: text("cached_parse_result_json"),
    fieldProvenanceJson: text("field_provenance_json"),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`)
  },
  (t) => [
    index("files_ws_sha_idx").on(t.workspaceId, t.sha256),
    index("files_ws_reviewed_idx").on(t.workspaceId, t.isReviewed)
  ]
)

export const transactions = sqliteTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name"),
    description: text("description"),
    merchant: text("merchant"),
    merchantTaxCode: text("merchant_tax_code"),
    direction: text("direction").notNull().default("input"),
    type: text("type").notNull().default("expense"),
    preTaxAmount: integer("pre_tax_amount").notNull().default(0),
    vatAmount: integer("vat_amount").notNull().default(0),
    totalAmount: integer("total_amount").notNull().default(0),
    currencyCode: text("currency_code").notNull().default("VND"),
    fxRateDecimal: text("fx_rate_decimal").default("1"),
    convertedTotalVnd: integer("converted_total_vnd"),
    convertedCurrencyCode: text("converted_currency_code"),
    vatRateCode: text("vat_rate_code"),
    invoiceSymbol: text("invoice_symbol"),
    invoiceNumber: text("invoice_number"),
    itemsJson: text("items_json").notNull().default("[]"),
    filesJson: text("files_json").notNull().default("[]"),
    extraJson: text("extra_json"),
    categoryCode: text("category_code"),
    projectCode: text("project_code"),
    issuedAt: text("issued_at"),
    paymentMethod: text("payment_method"),
    paymentStatus: text("payment_status").notNull().default("paid"),
    complianceStatus: text("compliance_status").notNull().default("pending"),
    complianceIssuesJson: text("compliance_issues_json"),
    note: text("note"),
    extractedText: text("extracted_text"),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`)
  },
  (t) => [
    index("tx_ws_issued_idx").on(t.workspaceId, t.issuedAt),
    index("tx_ws_dir_issued_idx").on(t.workspaceId, t.direction, t.issuedAt),
    index("tx_ws_compliance_idx").on(t.workspaceId, t.complianceStatus),
    index("tx_ws_cat_idx").on(t.workspaceId, t.categoryCode),
    index("tx_ws_proj_idx").on(t.workspaceId, t.projectCode),
    index("tx_ws_mst_idx").on(t.workspaceId, t.merchantTaxCode)
  ]
)

export const einvoiceRecords = sqliteTable(
  "einvoice_records",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id").references(() => transactions.id, { onDelete: "set null" }),
    xmlFileId: text("xml_file_id").references(() => files.id, { onDelete: "set null" }),
    pdfFileId: text("pdf_file_id").references(() => files.id, { onDelete: "set null" }),
    uniqueKey: text("unique_key").notNull(),
    templateCode: text("template_code").notNull(),
    symbol: text("symbol").notNull(),
    invoiceNumber: text("invoice_number").notNull(),
    invoiceKind: text("invoice_kind"),
    hasTaxCode: integer("has_tax_code", { mode: "boolean" }).notNull().default(true),
    mccqt: text("mccqt"),
    issuedDate: text("issued_date").notNull(),
    signedDate: text("signed_date"),
    sellerName: text("seller_name"),
    sellerTaxCode: text("seller_tax_code"),
    sellerAddress: text("seller_address"),
    buyerName: text("buyer_name"),
    buyerTaxCode: text("buyer_tax_code"),
    buyerIdCard: text("buyer_id_card"),
    buyerBudgetCode: text("buyer_budget_code"),
    currencyCode: text("currency_code").notNull().default("VND"),
    exchangeRate: text("exchange_rate").notNull().default("1"),
    totalBeforeVat: integer("total_before_vat").notNull().default(0),
    totalDiscount: integer("total_discount").notNull().default(0),
    totalVat: integer("total_vat").notNull().default(0),
    totalPayable: integer("total_payable").notNull().default(0),
    totalInWords: text("total_in_words"),
    vatBreakdownJson: text("vat_breakdown_json"),
    signatureStatus: text("signature_status").notNull().default("unsigned"),
    signerCn: text("signer_cn"),
    signerTaxCode: text("signer_tax_code"),
    signerIssuer: text("signer_issuer"),
    signerValidTo: text("signer_valid_to"),
    arithmeticValid: integer("arithmetic_valid", { mode: "boolean" }).notNull().default(true),
    arithmeticDiffVnd: integer("arithmetic_diff_vnd").notNull().default(0),
    sellerRiskStatus: text("seller_risk_status").notNull().default("unknown"),
    rawXmlHash: text("raw_xml_hash"),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`)
  },
  (t) => [uniqueIndex("einv_ws_unique_key_uq").on(t.workspaceId, t.uniqueKey)]
)

export const einvoiceLineItems = sqliteTable("einvoice_line_items", {
  id: text("id").primaryKey(),
  einvoiceId: text("einvoice_id")
    .notNull()
    .references(() => einvoiceRecords.id, { onDelete: "cascade" }),
  lineIndex: integer("line_index").notNull(),
  nature: integer("nature").notNull().default(1),
  itemCode: text("item_code"),
  itemName: text("item_name").notNull(),
  unit: text("unit"),
  quantityDecimal: text("quantity_decimal"),
  unitPriceDecimal: text("unit_price_decimal"),
  discountRate: text("discount_rate"),
  discountAmount: integer("discount_amount").notNull().default(0),
  preTaxAmount: integer("pre_tax_amount").notNull().default(0),
  vatRateCode: text("vat_rate_code"),
  vatAmount: integer("vat_amount").notNull().default(0),
  totalAmount: integer("total_amount").notNull().default(0),
  suggestedAccountCode: text("suggested_account_code")
})

export const counterparties = sqliteTable(
  "counterparties",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taxCode: text("tax_code").notNull(),
    name: text("name").notNull(),
    shortName: text("short_name"),
    address: text("address"),
    status: text("status").notNull().default("unknown"),
    defaultCategoryCode: text("default_category_code"),
    defaultAccountCode: text("default_account_code"),
    bankAccount: text("bank_account"),
    bankName: text("bank_name"),
    lastCheckedAt: text("last_checked_at"),
    riskNotes: text("risk_notes")
  },
  (t) => [uniqueIndex("cp_ws_mst_uq").on(t.workspaceId, t.taxCode)]
)

export const chartOfAccounts = sqliteTable(
  "chart_of_accounts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    regime: text("regime").notNull(),
    code: text("code").notNull(),
    parentCode: text("parent_code"),
    name: text("name").notNull(),
    nature: text("nature").notNull().default("dual"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true)
  },
  (t) => [uniqueIndex("coa_ws_reg_code_uq").on(t.workspaceId, t.regime, t.code)]
)

export const journalEntries = sqliteTable(
  "journal_entries",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id").references(() => transactions.id, { onDelete: "cascade" }),
    voucherNo: text("voucher_no").notNull(),
    voucherDate: text("voucher_date").notNull(),
    description: text("description").notNull(),
    status: text("status").notNull().default("draft"),
    postedBy: text("posted_by").notNull().default("auto_rule"),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`)
  },
  (t) => [
    index("je_ws_date_idx").on(t.workspaceId, t.voucherDate),
    index("je_tx_idx").on(t.transactionId)
  ]
)

export const journalLines = sqliteTable(
  "journal_lines",
  {
    id: text("id").primaryKey(),
    entryId: text("entry_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "cascade" }),
    debitAccount: text("debit_account").notNull(),
    creditAccount: text("credit_account").notNull(),
    amountVnd: integer("amount_vnd").notNull().default(0),
    description: text("description"),
    taxCode: text("tax_code"),
    partnerTaxCode: text("partner_tax_code")
  },
  (t) => [
    index("jl_entry_idx").on(t.entryId),
    index("jl_debit_idx").on(t.debitAccount),
    index("jl_credit_idx").on(t.creditAccount)
  ]
)

export const accountOpeningBalances = sqliteTable(
  "account_opening_balances",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountCode: text("account_code").notNull(),
    openingDebit: integer("opening_debit").notNull().default(0),
    openingCredit: integer("opening_credit").notNull().default(0),
    updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`)
  },
  (t) => [uniqueIndex("aob_ws_acc_uq").on(t.workspaceId, t.accountCode)]
)

export const bankStatements = sqliteTable(
  "bank_statements",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    bankCode: text("bank_code").notNull().default("BANK"),
    accountNo: text("account_no"),
    txDate: text("tx_date").notNull(),
    refNo: text("ref_no"),
    description: text("description").notNull(),
    debitAmount: integer("debit_amount").notNull().default(0),
    creditAmount: integer("credit_amount").notNull().default(0),
    balanceAmount: integer("balance_amount"),
    matchedTransactionId: text("matched_transaction_id").references(() => transactions.id, { onDelete: "set null" }),
    matchConfidence: real("match_confidence"),
    matchStatus: text("match_status").notNull().default("unmatched"),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`)
  },
  (t) => [
    index("bs_ws_date_idx").on(t.workspaceId, t.txDate),
    index("bs_ws_status_idx").on(t.workspaceId, t.matchStatus)
  ]
)

export const bankStatementMatches = sqliteTable(
  "bank_statement_matches",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    statementId: text("statement_id")
      .notNull()
      .references(() => bankStatements.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    allocatedAmountVnd: integer("allocated_amount_vnd").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`)
  },
  (t) => [
    index("bsm_stmt_idx").on(t.statementId),
    index("bsm_tx_idx").on(t.transactionId)
  ]
)

export const appData = sqliteTable(
  "app_data",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    app: text("app").notNull(),
    dataJson: text("data_json").notNull().default("{}")
  },
  (t) => [uniqueIndex("appdata_ws_app_uq").on(t.workspaceId, t.app)]
)

export const progressJobs = sqliteTable("progress_jobs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  status: text("status").notNull().default("running"),
  current: integer("current").notNull().default(0),
  total: integer("total").notNull().default(0),
  payloadJson: text("payload_json"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`)
})

export const legalRulesCache = sqliteTable("legal_rules_cache", {
  ruleKey: text("rule_key").primaryKey(),
  title: text("title").notNull(),
  documentRef: text("document_ref").notNull(),
  effectiveFrom: text("effective_from").notNull(),
  expiresAt: text("expires_at").notNull(),
  replacedBy: text("replaced_by"),
  payloadJson: text("payload_json").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`)
})
