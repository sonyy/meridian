// ─── Strategy Library ──────────────────────────────────────────────────────────
// Persisted to strategy-library.json at repo root.

import fs from "node:fs";
import { repoPath } from "./repo-root.js";

const STATE_FILE = repoPath("strategy-library.json");

// ─── Default strategies ───────────────────────────────────────────────────────

const DEFAULT_STRATEGIES = {
  custom_ratio_spot: {
    id: "custom_ratio_spot",
    name: "Custom Ratio Spot",
    author: "system",
    lp_strategy: "spot",
    token_criteria: {},
    entry: { condition: "Express directional bias via token:SOL ratio" },
    range: { type: "default", notes: "Standard spot range" },
    exit: { notes: "Standard exit rules" },
    best_for: "Directional bias with custom token:SOL ratio",
    raw: "",
  },
  single_sided_reseed: {
    id: "single_sided_reseed",
    name: "Single-Sided Bid-Ask + Re-seed",
    author: "system",
    lp_strategy: "bid_ask",
    token_criteria: {},
    entry: { condition: "Token-only redeploys on OOR downside" },
    range: { type: "default", notes: "Bid-ask range" },
    exit: { notes: "Re-seed on OOR downside" },
    best_for: "Recovering from out-of-range downside positions",
    raw: "",
  },
  fee_compounding: {
    id: "fee_compounding",
    name: "Fee Compounding",
    author: "system",
    lp_strategy: "any",
    token_criteria: {},
    entry: { condition: "Claim + add back to same position" },
    range: { type: "default", notes: "Any range" },
    exit: { notes: "Claim fees periodically" },
    best_for: "Compounding returns via fee re-investment",
    raw: "",
  },
  multi_layer: {
    id: "multi_layer",
    name: "Multi-Layer",
    author: "system",
    lp_strategy: "mixed",
    token_criteria: {},
    entry: { condition: "One position, multiple add-liquidity layers with different shapes" },
    range: { type: "wide", notes: "Multiple layers across range" },
    exit: { notes: "Standard per-layer exit" },
    best_for: "Diversified liquidity within a single pool",
    raw: "",
  },
  partial_harvest: {
    id: "partial_harvest",
    name: "Partial Harvest",
    author: "system",
    lp_strategy: "any",
    token_criteria: {},
    entry: { condition: "Withdraw 50% at 10% return; rest keeps running" },
    range: { type: "default", notes: "Standard range" },
    exit: { take_profit_pct: 10, notes: "Harvest 50% at 10% return" },
    best_for: "Taking partial profits while keeping a position open",
    raw: "",
  },
};

// ─── State ────────────────────────────────────────────────────────────────────

function load() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { active: "custom_ratio_spot", strategies: { ...DEFAULT_STRATEGIES } };
  }
}

function save(data) {
  try {
    const tmp = STATE_FILE + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error(`[STRATEGY] Failed to write ${STATE_FILE}: ${e.message}`);
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export function getActiveStrategy() {
  const state = load();
  const strategy = state.strategies[state.active];
  return strategy || null;
}

export function addStrategy({ id, name, author, lp_strategy, token_criteria, entry, range, exit, best_for, raw }) {
  const state = load();
  if (state.strategies[id]) return { success: false, error: `Strategy "${id}" already exists` };
  state.strategies[id] = { id, name, author: author || "user", lp_strategy: lp_strategy || "bid_ask", token_criteria: token_criteria || {}, entry: entry || {}, range: range || {}, exit: exit || {}, best_for: best_for || "", raw: raw || "" };
  save(state);
  return { success: true, id };
}

export function listStrategies() {
  const state = load();
  return Object.values(state.strategies).map((s) => ({
    id: s.id,
    name: s.name,
    author: s.author,
    lp_strategy: s.lp_strategy,
    active: s.id === state.active,
    best_for: s.best_for,
  }));
}

export function getStrategy(id) {
  const state = load();
  return state.strategies[id] || null;
}

export function setActiveStrategy(id) {
  const state = load();
  if (!state.strategies[id]) return { success: false, error: `Strategy "${id}" not found` };
  state.active = id;
  save(state);
  return { success: true, active: id };
}

export function removeStrategy(id) {
  const state = load();
  if (!state.strategies[id]) return { success: false, error: `Strategy "${id}" not found` };
  if (Object.keys(state.strategies).length <= 1) return { success: false, error: "Cannot remove the last strategy" };
  delete state.strategies[id];
  if (state.active === id) state.active = Object.keys(state.strategies)[0];
  save(state);
  return { success: true };
}
