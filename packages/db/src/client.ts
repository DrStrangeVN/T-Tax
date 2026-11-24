import Database from "better-sqlite3"
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import {
  DEFAULT_VN_LEGAL_RULES,
  getAccountsForRegime,
  type AccountingRegime
} from "@t-tax/core"
import * as schema from "./schema.js"
import {
  DEFAULT_CATEGORIES_SEED,
  DEFAULT_CURRENCIES_SEED,
  DEFAULT_FIELDS_SEED,
  DEFAULT_SETTINGS_SEED
} from "./seed-data.js"

export type TTaxDb = BetterSQLite3Database<typeof schema>

const INIT_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tax_code TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'enterprise',
  accounting_regime TEXT NOT NULL DEFAULT 'TT99_2025',
  fiscal_year_start TEXT NOT NULL DEFAULT '01-01',
  base_currency TEXT NOT NULL DEFAULT 'VND',
  address TEXT,
  bank_details_json TEXT,
  lock_date TEXT,
  logo_path TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  value TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS settings_ws_code_uq ON settings(workspace_id, code);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#2563EB',
  llm_prompt TEXT,
  default_debit_account TEXT,
  default_credit_account TEXT,
  tax_deductible_default INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX IF NOT EXISTS categories_ws_code_uq ON categories(workspace_id, code);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#38BDF8',
  llm_prompt TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_ws_code_uq ON projects(workspace_id, code);

CREATE TABLE IF NOT EXISTS fields (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'string',
  llm_prompt TEXT,
  options_json TEXT,
  is_visible_in_list INTEGER NOT NULL DEFAULT 0,
  is_visible_in_analysis INTEGER NOT NULL DEFAULT 0,
  is_required INTEGER NOT NULL DEFAULT 0,
  is_extra INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX IF NOT EXISTS fields_ws_code_uq ON fields(workspace_id, code);

CREATE TABLE IF NOT EXISTS currencies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  minor_unit_scale INTEGER NOT NULL DEFAULT 100,
  is_crypto INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS currencies_ws_code_uq ON currencies(workspace_id, code);

CREATE TABLE IF NOT EXISTS fx_rates_cache (
  from_code TEXT NOT NULL,
  to_code TEXT NOT NULL,
  rate_date TEXT NOT NULL,
  rate_decimal TEXT NOT NULL,
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  PRIMARY KEY (from_code, to_code, rate_date, source)
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  normalized_ascii_name TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  mimetype TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'upload',
  metadata_json TEXT,
  paired_file_id TEXT,
  is_reviewed INTEGER NOT NULL DEFAULT 0,
  is_splitted INTEGER NOT NULL DEFAULT 0,
  extraction_method TEXT NOT NULL DEFAULT 'none',
  extraction_confidence REAL,
  cached_parse_result_json TEXT,
  field_provenance_json TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS files_ws_sha_idx ON files(workspace_id, sha256);
CREATE INDEX IF NOT EXISTS files_ws_reviewed_idx ON files(workspace_id, is_reviewed);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT,
  description TEXT,
  merchant TEXT,
  merchant_tax_code TEXT,
  direction TEXT NOT NULL DEFAULT 'input',
  type TEXT NOT NULL DEFAULT 'expense',
  pre_tax_amount INTEGER NOT NULL DEFAULT 0,
  vat_amount INTEGER NOT NULL DEFAULT 0,
  total_amount INTEGER NOT NULL DEFAULT 0,
  currency_code TEXT NOT NULL DEFAULT 'VND',
  fx_rate_decimal TEXT DEFAULT '1',
  converted_total_vnd INTEGER,
  converted_currency_code TEXT,
  vat_rate_code TEXT,
  invoice_symbol TEXT,
  invoice_number TEXT,
  items_json TEXT NOT NULL DEFAULT '[]',
  files_json TEXT NOT NULL DEFAULT '[]',
  extra_json TEXT,
  category_code TEXT,
  project_code TEXT,
  issued_at TEXT,
  payment_method TEXT,
  payment_status TEXT NOT NULL DEFAULT 'paid',
  compliance_status TEXT NOT NULL DEFAULT 'pending',
  compliance_issues_json TEXT,
  note TEXT,
  extracted_text TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS tx_ws_issued_idx ON transactions(workspace_id, issued_at);
CREATE INDEX IF NOT EXISTS tx_ws_cat_idx ON transactions(workspace_id, category_code);
CREATE INDEX IF NOT EXISTS tx_ws_proj_idx ON transactions(workspace_id, project_code);
CREATE INDEX IF NOT EXISTS tx_ws_mst_idx ON transactions(workspace_id, merchant_tax_code);

CREATE TABLE IF NOT EXISTS einvoice_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  xml_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  pdf_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  unique_key TEXT NOT NULL,
  template_code TEXT NOT NULL,
  symbol TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  invoice_kind TEXT,
  has_tax_code INTEGER NOT NULL DEFAULT 1,
  mccqt TEXT,
  issued_date TEXT NOT NULL,
  signed_date TEXT,
  seller_name TEXT,
  seller_tax_code TEXT,
  seller_address TEXT,
  buyer_name TEXT,
  buyer_tax_code TEXT,
  buyer_id_card TEXT,
  buyer_budget_code TEXT,
  currency_code TEXT NOT NULL DEFAULT 'VND',
  exchange_rate TEXT NOT NULL DEFAULT '1',
  total_before_vat INTEGER NOT NULL DEFAULT 0,
  total_discount INTEGER NOT NULL DEFAULT 0,
  total_vat INTEGER NOT NULL DEFAULT 0,
  total_payable INTEGER NOT NULL DEFAULT 0,
  total_in_words TEXT,
  vat_breakdown_json TEXT,
  signature_status TEXT NOT NULL DEFAULT 'unsigned',
  signer_cn TEXT,
  signer_tax_code TEXT,
  signer_issuer TEXT,
  signer_valid_to TEXT,
  arithmetic_valid INTEGER NOT NULL DEFAULT 1,
  arithmetic_diff_vnd INTEGER NOT NULL DEFAULT 0,
  seller_risk_status TEXT NOT NULL DEFAULT 'unknown',
  raw_xml_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE UNIQUE INDEX IF NOT EXISTS einv_ws_unique_key_uq ON einvoice_records(workspace_id, unique_key);

CREATE TABLE IF NOT EXISTS einvoice_line_items (
  id TEXT PRIMARY KEY,
  einvoice_id TEXT NOT NULL REFERENCES einvoice_records(id) ON DELETE CASCADE,
  line_index INTEGER NOT NULL,
  nature INTEGER NOT NULL DEFAULT 1,
  item_code TEXT,
  item_name TEXT NOT NULL,
  unit TEXT,
  quantity_decimal TEXT,
  unit_price_decimal TEXT,
  discount_rate TEXT,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  pre_tax_amount INTEGER NOT NULL DEFAULT 0,
  vat_rate_code TEXT,
  vat_amount INTEGER NOT NULL DEFAULT 0,
  total_amount INTEGER NOT NULL DEFAULT 0,
  suggested_account_code TEXT
);

CREATE TABLE IF NOT EXISTS counterparties (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tax_code TEXT NOT NULL,
  name TEXT NOT NULL,
  short_name TEXT,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  default_category_code TEXT,
  default_account_code TEXT,
  bank_account TEXT,
  bank_name TEXT,
  last_checked_at TEXT,
  risk_notes TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS cp_ws_mst_uq ON counterparties(workspace_id, tax_code);

CREATE TABLE IF NOT EXISTS chart_of_accounts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  regime TEXT NOT NULL,
  code TEXT NOT NULL,
  parent_code TEXT,
  name TEXT NOT NULL,
  nature TEXT NOT NULL DEFAULT 'dual',
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS coa_ws_reg_code_uq ON chart_of_accounts(workspace_id, regime, code);

CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  transaction_id TEXT REFERENCES transactions(id) ON DELETE CASCADE,
  voucher_no TEXT NOT NULL,
  voucher_date TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  posted_by TEXT NOT NULL DEFAULT 'auto_rule',
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS je_ws_date_idx ON journal_entries(workspace_id, voucher_date);
CREATE INDEX IF NOT EXISTS je_tx_idx ON journal_entries(transaction_id);

CREATE TABLE IF NOT EXISTS journal_lines (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  debit_account TEXT NOT NULL,
  credit_account TEXT NOT NULL,
  amount_vnd INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  tax_code TEXT,
  partner_tax_code TEXT
);
CREATE INDEX IF NOT EXISTS jl_entry_idx ON journal_lines(entry_id);

CREATE TABLE IF NOT EXISTS bank_statements (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bank_code TEXT NOT NULL DEFAULT 'BANK',
  account_no TEXT,
  tx_date TEXT NOT NULL,
  ref_no TEXT,
  description TEXT NOT NULL,
  debit_amount INTEGER NOT NULL DEFAULT 0,
  credit_amount INTEGER NOT NULL DEFAULT 0,
  balance_amount INTEGER,
  matched_transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  match_confidence REAL,
  match_status TEXT NOT NULL DEFAULT 'unmatched',
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
CREATE INDEX IF NOT EXISTS bs_ws_date_idx ON bank_statements(workspace_id, tx_date);

CREATE TABLE IF NOT EXISTS app_data (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS appdata_ws_app_uq ON app_data(workspace_id, app);

CREATE TABLE IF NOT EXISTS progress_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  current INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS legal_rules_cache (
  rule_key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  document_ref TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  replaced_by TEXT,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- FTS5 Virtual Table for sub-10ms search across Vietnamese transactions & invoices
CREATE VIRTUAL TABLE IF NOT EXISTS transactions_fts USING fts5(
  tx_id UNINDEXED,
  workspace_id UNINDEXED,
  name,
  merchant,
  merchant_tax_code,
  invoice_number,
  description,
  note,
  extracted_text
);

CREATE TRIGGER IF NOT EXISTS tx_fts_ai AFTER INSERT ON transactions BEGIN
  INSERT INTO transactions_fts(tx_id, workspace_id, name, merchant, merchant_tax_code, invoice_number, description, note, extracted_text)
  VALUES (new.id, new.workspace_id, coalesce(new.name,''), coalesce(new.merchant,''), coalesce(new.merchant_tax_code,''), coalesce(new.invoice_number,''), coalesce(new.description,''), coalesce(new.note,''), coalesce(new.extracted_text,''));
END;

CREATE TRIGGER IF NOT EXISTS tx_fts_ad AFTER DELETE ON transactions BEGIN
  DELETE FROM transactions_fts WHERE tx_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS tx_fts_au AFTER UPDATE ON transactions BEGIN
  DELETE FROM transactions_fts WHERE tx_id = old.id;
  INSERT INTO transactions_fts(tx_id, workspace_id, name, merchant, merchant_tax_code, invoice_number, description, note, extracted_text)
  VALUES (new.id, new.workspace_id, coalesce(new.name,''), coalesce(new.merchant,''), coalesce(new.merchant_tax_code,''), coalesce(new.invoice_number,''), coalesce(new.description,''), coalesce(new.note,''), coalesce(new.extracted_text,''));
END;
`

export interface DatabaseConnection {
  sqlite: Database.Database
  db: TTaxDb
  close: () => void
}

export function openTTaxDatabase(dbPath: string): DatabaseConnection {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true })
  }
  const sqlite = new Database(dbPath)
  sqlite.exec(INIT_SQL)
  const wsCols = sqlite.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>
  if (!wsCols.some((c) => c.name === "lock_date")) {
    sqlite.exec("ALTER TABLE workspaces ADD COLUMN lock_date TEXT")
  }
  const db = drizzle(sqlite, { schema })
  seedLegalRules(db)
  return {
    sqlite,
    db,
    close: () => sqlite.close()
  }
}

export function seedLegalRules(db: TTaxDb): void {
  const existing = db.select({ ruleKey: schema.legalRulesCache.ruleKey }).from(schema.legalRulesCache).all()
  const existingKeys = new Set(existing.map((e) => e.ruleKey))
  for (const rule of DEFAULT_VN_LEGAL_RULES) {
    if (!existingKeys.has(rule.ruleKey)) {
      db.insert(schema.legalRulesCache)
        .values({
          ruleKey: rule.ruleKey,
          title: rule.title,
          documentRef: rule.documentRef,
          effectiveFrom: rule.effectiveFrom,
          expiresAt: rule.expiresAt,
          replacedBy: rule.replacedBy ?? null,
          payloadJson: JSON.stringify(rule.payload)
        })
        .run()
    }
  }
}

export function seedWorkspaceDefaults(
  db: TTaxDb,
  workspaceId: string,
  regime: AccountingRegime = "TT99_2025"
): void {
  for (const s of DEFAULT_SETTINGS_SEED) {
    db.insert(schema.settings)
      .values({ id: randomUUID(), workspaceId, ...s })
      .onConflictDoNothing()
      .run()
  }

  for (const c of DEFAULT_CATEGORIES_SEED) {
    db.insert(schema.categories)
      .values({
        id: randomUUID(),
        workspaceId,
        code: c.code,
        name: c.name,
        color: c.color,
        llmPrompt: c.llmPrompt,
        defaultDebitAccount: c.defaultDebit,
        defaultCreditAccount: "331",
        taxDeductibleDefault: true
      })
      .onConflictDoNothing()
      .run()
  }

  db.insert(schema.projects)
    .values({
      id: randomUUID(),
      workspaceId,
      code: "general",
      name: "Hoạt động chung",
      color: "#38BDF8",
      llmPrompt: "chi phí và doanh thu vận hành chung của doanh nghiệp"
    })
    .onConflictDoNothing()
    .run()

  for (const f of DEFAULT_FIELDS_SEED) {
    db.insert(schema.fields)
      .values({ id: randomUUID(), workspaceId, ...f })
      .onConflictDoNothing()
      .run()
  }

  for (const cur of DEFAULT_CURRENCIES_SEED) {
    db.insert(schema.currencies)
      .values({
        id: randomUUID(),
        workspaceId,
        code: cur.code,
        name: cur.name,
        minorUnitScale: cur.scale,
        isCrypto: cur.isCrypto
      })
      .onConflictDoNothing()
      .run()
  }

  const allRegimes: AccountingRegime[] = ["TT99_2025", "TT200_2014", "TT133_2016", "HKD_2026"]
  for (const reg of allRegimes) {
    for (const acc of getAccountsForRegime(reg)) {
      db.insert(schema.chartOfAccounts)
        .values({
          id: randomUUID(),
          workspaceId,
          regime: reg,
          code: acc.code,
          parentCode: acc.parentCode ?? null,
          name: acc.name,
          nature: acc.nature,
          isActive: reg === regime
        })
        .onConflictDoNothing()
        .run()
    }
  }
}

export function ensureDefaultWorkspace(db: TTaxDb) {
  const existing = db.select().from(schema.workspaces).all()
  if (existing.length > 0) return existing[0]!

  const id = randomUUID()
  db.insert(schema.workspaces)
    .values({
      id,
      name: "Công ty TNHH T-Tax Demo",
      taxCode: "0312345678",
      entityType: "enterprise",
      accountingRegime: "TT99_2025",
      fiscalYearStart: "01-01",
      baseCurrency: "VND",
      address: "Quận 1, TP. Hồ Chí Minh"
    })
    .run()

  seedWorkspaceDefaults(db, id, "TT99_2025")
  return db.select().from(schema.workspaces).all()[0]!
}

export function searchTransactionsFts(sqlite: Database.Database, workspaceId: string, query: string): string[] {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
  if (tokens.length === 0) return []
  const matchExpr = tokens.join(" AND ")
  const rows = sqlite
    .prepare("SELECT tx_id FROM transactions_fts WHERE workspace_id = ? AND transactions_fts MATCH ? LIMIT 500")
    .all(workspaceId, matchExpr) as Array<{ tx_id: string }>
  return rows.map((r) => r.tx_id)
}
