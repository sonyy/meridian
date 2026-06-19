// ─── SQLite persistence layer (PAPER POSITIONS ONLY) ─────────────────────
// Only replaces paper-positions.json. Core files (state.js, decision-log.js,
// pool-memory.js, lessons.js) remain on JSON.
//
// Usage (in paper-positions.js):
//   import { loadPositions, savePositions, upsertPosition } from "./lib/db.js";
//   const state = loadPositions();  // same { positions: { id: {...} } } format
// ─────────────────────────────────────────────────────────────────────────

import Database from "better-sqlite3";
import { repoPath } from "../repo-root.js";

const DB_PATH = repoPath("meridian.db");
const SCHEMA_VERSION = 1;

let _db = null;

function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  migrate();
  return _db;
}

function migrate() {
  const ver = _db.pragma("user_version", { simple: true });
  if (ver >= SCHEMA_VERSION) return;

  _db.exec(`
    CREATE TABLE IF NOT EXISTS paper_positions (
      id                     TEXT PRIMARY KEY,
      pool_address           TEXT NOT NULL,
      pool_name              TEXT,
      pair                   TEXT,
      base_mint              TEXT,

      deposit_amount         REAL,
      lower_price            REAL,
      upper_price            REAL,
      strategy_type          TEXT,
      single_side            TEXT,
      bin_step               INTEGER,
      lower_bin_id           INTEGER,
      upper_bin_id           INTEGER,
      weights                TEXT,
      lp_fee_fraction        REAL,
      avg_existing_bin_tvl   REAL,
      token_y_price          REAL,
      entry_price            REAL,
      price_scale            REAL,
      entry_timestamp        INTEGER,
      opened_at              TEXT,
      fees_earned            REAL NOT NULL DEFAULT 0,
      il_usd                 REAL NOT NULL DEFAULT 0,
      net_pnl                REAL NOT NULL DEFAULT 0,
      candles_total          INTEGER NOT NULL DEFAULT 0,
      candles_in_range       INTEGER NOT NULL DEFAULT 0,
      last_price             REAL,
      last_candle_timestamp  INTEGER,
      status                 TEXT NOT NULL DEFAULT 'open',
      closed_at              TEXT,
      close_reason           TEXT,
      peak_pnl_pct           REAL,
      trailing_active        INTEGER NOT NULL DEFAULT 0,
      initial_x_usd          REAL,
      initial_y_usd          REAL,

      out_of_range_since     TEXT,
      in_range               INTEGER,
      total_fees_claimed_usd REAL NOT NULL DEFAULT 0,
      rebalance_count        INTEGER NOT NULL DEFAULT 0,
      instruction            TEXT,
      notes                  TEXT,
      exit_reason            TEXT,
      signal_snapshot        TEXT,

      created_at             TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_pp_status ON paper_positions(status);
    CREATE INDEX IF NOT EXISTS idx_pp_pool   ON paper_positions(pool_address);
  `);

  _db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

const _COLS = [
  "id","pool_address","pool_name","pair","base_mint",
  "deposit_amount","lower_price","upper_price","strategy_type","single_side",
  "bin_step","lower_bin_id","upper_bin_id","weights","lp_fee_fraction",
  "avg_existing_bin_tvl","token_y_price","entry_price","price_scale",
  "entry_timestamp","opened_at","fees_earned","il_usd","net_pnl",
  "candles_total","candles_in_range","last_price","last_candle_timestamp",
  "status","closed_at","close_reason","peak_pnl_pct","trailing_active",
  "initial_x_usd","initial_y_usd",
  "out_of_range_since","in_range","total_fees_claimed_usd","rebalance_count",
  "instruction","notes","exit_reason","signal_snapshot",
];

const _COLS_CSV = _COLS.join(",");
const _PARAMS   = _COLS.map(() => "?").join(",");

const _UPSERT_SQL = `
  INSERT INTO paper_positions (${_COLS_CSV}, updated_at)
  VALUES (${_PARAMS}, datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    ${_COLS.map((c) => `${c}=excluded.${c}`).join(",")},
    updated_at=datetime('now')
`;

const _DEFAULTS = {
  fees_earned: 0, il_usd: 0, net_pnl: 0,
  candles_total: 0, candles_in_range: 0,
  trailing_active: 0, total_fees_claimed_usd: 0, rebalance_count: 0,
  status: "open",
};

function rowToPosition(row) {
  if (!row) return null;
  const p = { ...row };
  delete p.created_at;
  delete p.updated_at;
  if (typeof p.weights === "string") {
    try { p.weights = JSON.parse(p.weights); } catch { p.weights = []; }
  }
  if (typeof p.signal_snapshot === "string") {
    try { p.signal_snapshot = JSON.parse(p.signal_snapshot); } catch { p.signal_snapshot = null; }
  }
  if (p.trailing_active != null) p.trailing_active = !!p.trailing_active;
  if (p.in_range != null) p.in_range = !!p.in_range;
  return p;
}

function positionToRow(id, data) {
  const r = { id };
  for (const col of _COLS) {
    if (col === "id") continue;
    let val = data[col];
    if (col === "weights" && Array.isArray(val)) val = JSON.stringify(val);
    if (col === "signal_snapshot" && val && typeof val === "object") val = JSON.stringify(val);
    if (col === "trailing_active") val = val ? 1 : 0;
    if (col === "in_range") val = val == null ? null : val ? 1 : 0;
    r[col] = val ?? _DEFAULTS[col] ?? null;
  }
  return r;
}

let _stmtUpsert = null;
let _stmtGet    = null;
let _stmtAll    = null;
let _stmtOpen   = null;

function uStmt() {
  if (!_stmtUpsert) _stmtUpsert = getDb().prepare(_UPSERT_SQL);
  return _stmtUpsert;
}

function gStmt() {
  if (!_stmtGet) _stmtGet = getDb().prepare("SELECT * FROM paper_positions WHERE id = ?");
  return _stmtGet;
}

function aStmt() {
  if (!_stmtAll) _stmtAll = getDb().prepare("SELECT * FROM paper_positions");
  return _stmtAll;
}

function oStmt() {
  if (!_stmtOpen) _stmtOpen = getDb().prepare("SELECT * FROM paper_positions WHERE status = 'open'");
  return _stmtOpen;
}

export function loadPositions() {
  const rows = aStmt().all();
  const positions = {};
  for (const row of rows) positions[row.id] = rowToPosition(row);
  return { positions };
}

export function savePositions(state) {
  const db = getDb();
  const u = uStmt();
  const tx = db.transaction((entries) => {
    for (const [id, data] of Object.entries(entries)) {
      const r = positionToRow(id, data);
      u.run(..._COLS.map((c) => r[c] ?? null));
    }
  });
  tx(state.positions || {});
}

export function upsertPosition(id, data) {
  const r = positionToRow(id, data);
  uStmt().run(..._COLS.map((c) => r[c] ?? null));
}

export function getPosition(id) {
  return rowToPosition(gStmt().get(id));
}

export function getOpenPositions() {
  return oStmt().all().map(rowToPosition);
}

export function getTableCounts() {
  return { paper_positions: getDb().prepare("SELECT COUNT(*) as c FROM paper_positions").get().c };
}

export function close() {
  _stmtUpsert = _stmtGet = _stmtAll = _stmtOpen = null;
  if (_db) { _db.close(); _db = null; }
}
