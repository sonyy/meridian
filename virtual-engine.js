/**
 * virtual-engine.js
 *
 * Virtual trading mode for Meridian.
 * Wraps paper-positions.js with a virtual wallet, management-cycle hooks,
 * and SL/TP rule simulation. When virtual mode is ON, all deploy/close/claim
 * operations use the paper simulator instead of real on-chain transactions.
 *
 * State persisted to virtual-data.json (wallet + stats).
 * Paper positions persisted to paper-positions.json (via paper-positions.js).
 */

import fs from "fs";
import { log } from "./logger.js";
import { config } from "./config.js";
import { repoPath } from "./repo-root.js";
import { trackPosition } from "./state.js";
import { recordClose } from "./state.js";
import {
  openPaperPosition,
  closePaperPosition,
  getPaperPosition,
  listPaperPositions,
  tickPaperPositions,
  fetchPoolConfig,
} from "./paper-positions.js";

const STATE_FILE = repoPath("virtual-data.json");

// ─── Internal state ───────────────────────────────────────────────────────────

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return createDefaultState();
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) {
    log("virtual", `Failed to load state: ${e.message}`);
    return createDefaultState();
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log("virtual", `Failed to save state: ${e.message}`);
  }
}

function createDefaultState() {
  return {
    wallet: {
      sol: 100,
      initial_sol: 100,
    },
    stats: {
      total_deploys: 0,
      total_closes: 0,
      total_fees_earned: 0,
      total_pnl: 0,
      created_at: new Date().toISOString(),
    },
  };
}

// ─── Mode check ───────────────────────────────────────────────────────────────

/**
 * Is virtual mode currently active?
 * Reads from config — toggled via update_config / Telegram settings.
 */
export function isVirtualMode() {
  return config?.virtual?.mode === true;
}

// ─── Virtual wallet ───────────────────────────────────────────────────────────

/**
 * Get virtual wallet balance.
 */
export function getVirtualWallet() {
  const state = loadState();
  return { sol: state.wallet.sol, initial_sol: state.wallet.initial_sol };
}

/**
 * Deduct from virtual wallet. Returns remaining SOL.
 */
function deductFromWallet(amount) {
  const state = loadState();
  if (state.wallet.sol < amount) {
    throw new Error(
      `Virtual wallet insufficient: ${state.wallet.sol.toFixed(2)} SOL < ${amount.toFixed(2)} SOL`
    );
  }
  state.wallet.sol = +(state.wallet.sol - amount).toFixed(6);
  saveState(state);
  return state.wallet.sol;
}

/**
 * Add to virtual wallet. Returns new balance.
 */
function addToWallet(amount) {
  const state = loadState();
  state.wallet.sol = +(state.wallet.sol + amount).toFixed(6);
  saveState(state);
  return state.wallet.sol;
}

// ─── Virtual deploy / close / claim ───────────────────────────────────────────

/**
 * Virtual deploy — uses paper-positions.js simulation.
 * Accepts both LLM tool-call format and direct format.
 *
 * LLM tool-call format (from deploy_position schema):
 *   { pool_address, amount_y?, amount_sol?, strategy?, bins_below?, bins_above? }
 *
 * Direct format:
 *   { pool_address, deposit_amount, lower_price, upper_price, strategy_type }
 */
export async function virtualDeployPosition(args) {
  const wallet = getVirtualWallet();
  const { pool_address } = args;

  // Normalize deposit amount from LLM format (amount_y/amount_sol) or direct format
  const deposit_amount =
    args.deposit_amount ?? args.amount_y ?? args.amount_sol ?? 0;

  const strategy_type = args.strategy_type || args.strategy || "bid_ask";

  // Check wallet first
  if (wallet.sol < deposit_amount + 0.01) {
    return {
      success: false,
      error: `Virtual wallet only has ${wallet.sol.toFixed(2)} SOL, need ${deposit_amount.toFixed(2)}`,
    };
  }

  try {
    let lower_price = args.lower_price;
    let upper_price = args.upper_price;

    // If bins_below/bins_above provided (LLM format), convert to price range
    if ((args.bins_below != null || args.bins_above != null) && (lower_price == null || upper_price == null)) {
      const poolCfg = await fetchPoolConfig(pool_address);
      const { currentPrice, binStep } = poolCfg;
      const binRatio = 1 + binStep / 10000;
      const binsBelow = args.bins_below ?? 0;
      const binsAbove = args.bins_above ?? 0;

      if (lower_price == null) {
        lower_price = currentPrice / Math.pow(binRatio, binsBelow);
      }
      if (upper_price == null) {
        upper_price = currentPrice * Math.pow(binRatio, binsAbove);
      }
    }

    // Handle downside_pct / upside_pct (human-friendly % range)
    if ((args.downside_pct != null || args.upside_pct != null) && (lower_price == null || upper_price == null)) {
      if (lower_price == null && upper_price == null) {
        const poolCfg = await fetchPoolConfig(pool_address);
        const { currentPrice } = poolCfg;
        const downsidePct = args.downside_pct ?? 0;
        const upsidePct = args.upside_pct ?? 0;
        if (lower_price == null) {
          lower_price = currentPrice * (1 - downsidePct / 100);
        }
        if (upper_price == null) {
          upper_price = currentPrice * (1 + upsidePct / 100);
        }
      }
    }

    if (lower_price == null || upper_price == null) {
      return { success: false, error: `Cannot determine price range from args: ${JSON.stringify(args)}` };
    }

    // Open paper position — fetches real pool config and creates the position
    const paperPos = await openPaperPosition({
      pool_address,
      deposit_amount,
      lower_price,
      upper_price,
      strategy_type,
    });

    // Deduct from virtual wallet
    const remaining = deductFromWallet(deposit_amount);
    const state = loadState();
    state.stats.total_deploys++;
    saveState(state);

    // Track in state.json so management cycle SL/TP/OOR/trailing checks work
    try {
      trackPosition({
        position: paperPos.id,
        pool: pool_address,
        pool_name: paperPos.pair || pool_address.slice(0, 8),
        strategy: strategy_type,
        bin_range: { lower: lower_price, upper: upper_price },
        amount_sol: deposit_amount,
        active_bin: paperPos.active_bin_id,
        bin_step: paperPos.bin_step,
        initial_value_usd: deposit_amount,
      });
    } catch (err) {
      log("virtual", `Failed to track position in state.json: ${err.message}`);
    }

    log(
      "virtual",
      `Deployed virtual position ${paperPos.id}: ${paperPos.pair} @ ${deposit_amount} SOL | wallet: ${remaining.toFixed(2)} SOL`
    );

    return {
      success: true,
      position_id: paperPos.id,
      pool: paperPos.pool,
      pair: paperPos.pair,
      deposit: paperPos.deposit,
      wallet_remaining_sol: remaining,
      summary: paperPos,
    };
  } catch (e) {
    log("virtual", `Virtual deploy failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

/**
 * Virtual close — closes a paper position and credits proceeds back to wallet.
 *
 * @param {string} positionId — paper position ID (e.g. "paper-abc123")
 * @returns {object} close result with PnL
 */
export function virtualClosePosition(positionId) {
  try {
    // Get position before closing to know deposit + net PnL
    const pos = getPaperPosition(positionId);
    if (!pos || pos.status === "closed") {
      return { success: false, error: `Position ${positionId} not found or already closed` };
    }

    // Close the paper position
    const result = closePaperPosition(positionId);

    // Calculate proceeds: deposit + net pnl
    const netPnl = result.net_pnl ?? 0;
    const deposit = result.deposit ?? 0;
    const proceeds = +(deposit + netPnl).toFixed(6);

    // Credit wallet
    const newBalance = addToWallet(proceeds);

    const state = loadState();
    state.stats.total_closes++;
    state.stats.total_fees_earned += result.fees_earned ?? 0;
    state.stats.total_pnl += netPnl;
    saveState(state);

    // Mark position closed in state.json
    try {
      recordClose(positionId, "virtual_close");
    } catch (err) {
      log("virtual", `Failed to record close in state.json: ${err.message}`);
    }

    log(
      "virtual",
      `Closed virtual position ${positionId}: deposit=◎${deposit} pnl=◎${netPnl} proceeds=◎${proceeds} | wallet: ${newBalance.toFixed(2)} SOL`
    );

    return {
      success: true,
      position_id: positionId,
      pool: result.pool,
      pair: result.pair,
      deposit,
      fees_earned: result.fees_earned ?? 0,
      net_pnl: netPnl,
      proceeds,
      wallet_remaining_sol: newBalance,
      annualized_fee_apr: result.annualized_fee_apr,
      duration_hours: result.duration_hours,
    };
  } catch (e) {
    log("virtual", `Virtual close failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

/**
 * Virtual claim — no-op in paper mode (fees auto-accrue in the simulation).
 * Returns current unclaimed fees estimate (paper positions track everything).
 */
export function virtualClaimFees(positionId) {
  // Paper positions auto-accrue; claiming is a no-op since there's no
  // separate fee account. The fees are already in the position's net_pnl.
  try {
    const pos = getPaperPosition(positionId);
    return {
      success: true,
      position_id: positionId,
      note: "Virtual position — fees auto-accrue in PnL. No separate claim needed.",
      fees_earned: pos?.fees_earned ?? 0,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── Position reconciliation ──────────────────────────────────────────────────

/**
 * Get virtual wallet balance in the same format as getWalletBalances().
 * Augments the real balance (or overrides it) with virtual wallet data.
 */
export function getVirtualWalletBalances() {
  const wallet = getVirtualWallet();
  // Match the format from wallet.js getWalletBalances
  return {
    sol: wallet.sol,
    total_usd: wallet.sol, // simplified: 1 SOL = 1 USD for display
    // We keep it simple — virtual wallet just tracks SOL
    tokens: [],
  };
}

export { getPaperPosition } from "./paper-positions.js";

// ─── Tick virtual positions before management ─────────────────────────────────

/**
 * Tick all open virtual (paper) positions.
 * Called before the management cycle evaluates them.
 */
export async function tickVirtualPositions() {
  if (!isVirtualMode()) return;
  log("virtual", "Ticking virtual positions...");
  await tickPaperPositions();
}

// ─── Get positions in a format compatible with management cycle ────────────────

/**
 * Convert paper positions to a format similar to what getMyPositions returns.
 * This allows the management cycle to evaluate virtual positions with the same rules.
 */
export function getVirtualPositionsAsReal() {
  const paperPositions = listPaperPositions().filter(p => p.status === "open");
  const currencySymbol = config?.management?.solMode ? "◎" : "$";

  return paperPositions.map((pp) => {
    const durationMs = Date.now() - new Date(pp.opened_at).getTime();
    const minutesOpen = Math.floor(durationMs / 60000);
    const hoursOpen = durationMs / 3600000;
    const pnlPct = pp.deposit > 0 ? (pp.net_pnl / pp.deposit) * 100 : 0;

    // Use paper position's annualized fee APR if available, else estimate
    let feePerTvl24h = null;
    if (pp.annualized_fee_apr != null) {
      feePerTvl24h = +pp.annualized_fee_apr.toFixed(2);
    } else if (pp.fees_earned > 0 && pp.deposit > 0 && hoursOpen > 0) {
      feePerTvl24h = +(((pp.fees_earned / pp.deposit) / hoursOpen) * 24 * 100).toFixed(2);
    }

    return {
      position: pp.id, // use paper ID as position "address"
      pool: pp.pool_address || pp.pool_name || pp.pair,
      pair: pp.pair,
      base_mint: pp.base_mint ?? null,
      strategy: pp.strategy || null,
      lower_bin: null,
      upper_bin: null,
      active_bin: null,
      lower_price: pp.range?.lower || null,
      upper_price: pp.range?.upper || null,
      entry_price: pp.entry_price || null,
      last_price: pp.last_price || null,
      deposit_amount: pp.deposit,
      in_range: pp?.in_range_pct != null ? pp.in_range_pct > 0 : true,
      minutes_out_of_range: pp.in_range_pct != null && pp.in_range_pct < 100
        ? Math.round(minutesOpen * (1 - pp.in_range_pct / 100))
        : 0,
      unclaimed_fees_usd: pp.fees_earned || 0, // paper positions fees auto-accrue in PnL
      total_value_usd: pp.deposit + pp.net_pnl,
      pnl_pct: +pnlPct.toFixed(2),
      pnl_pct_suspicious: false,
      fee_per_tvl_24h: feePerTvl24h,
      age_minutes: minutesOpen,
      instruction: null,

      // Augmented with paper position details
      _paper_id: pp.id,
      _paper_summary: pp,
      _is_virtual: true,
    };
  });
}

// ─── Virtual status report ────────────────────────────────────────────────────

/**
 * Get a human-readable status summary of virtual mode.
 */
export function getVirtualStatus() {
  const state = loadState();
  const wallet = state.wallet;
  const open = listPaperPositions().filter(p => p.status === "open");
  const closed = listPaperPositions().filter(p => p.status === "closed");

  const totalPnl = closed.reduce((s, p) => s + (p.net_pnl ?? 0), 0);
  const totalFees = closed.reduce((s, p) => s + (p.fees_earned ?? 0), 0);
  const winRate = closed.length > 0
    ? ((closed.filter(p => (p.net_pnl ?? 0) > 0).length / closed.length) * 100).toFixed(0)
    : "N/A";

  const lines = [
    `🧪 Virtual Mode: ${config?.virtual?.mode ? "🟢 ON" : "⚪ OFF"}`,
    `💰 Wallet: ${wallet.sol.toFixed(2)} SOL (started with ${wallet.initial_sol} SOL)`,
    `📊 Positions: ${open.length} open / ${closed.length} closed`,
    `📈 Total PnL: ◎${totalPnl.toFixed(2)} | Fees: ◎${totalFees.toFixed(2)}`,
    `🎯 Win Rate: ${winRate}%`,
    `🔄 Total deploys: ${state.stats.total_deploys} | closes: ${state.stats.total_closes}`,
  ];

  if (open.length > 0) {
    lines.push("");
    lines.push("Open positions:");
    open.forEach((p) => {
      lines.push(`  ${p.id}: ${p.pair} | deposit ◎${p.deposit} | PnL ◎${p.net_pnl?.toFixed(2) ?? 0} | fees ◎${p.fees_earned?.toFixed(4) ?? 0}`);
    });
  }

  return lines.join("\n");
}
