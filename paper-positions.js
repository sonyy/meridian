/**
 * paper-positions.js
 *
 * Tracks virtual LP positions for dry-run simulation.
 * Each position is opened with a deposit + range + strategy, then ticked
 * every 5m by fetching live OHLCV candles. Fees and IL are derived from
 * real market data without any on-chain transactions.
 *
 * State persisted to paper-positions.json.
 */

import fs from "fs";
import { log } from "./logger.js";
import { config } from "./config.js";

const STATE_FILE = "./paper-positions.json";
const DLMM_API  = "https://dlmm.datapi.meteora.ag";

// ─── Persistence ──────────────────────────────────────────────────────────────

function load() {
  if (!fs.existsSync(STATE_FILE)) return { positions: {} };
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) {
    log("paper_sim", `Failed to read ${STATE_FILE}: ${e.message}`);
    return { positions: {} };
  }
}

function save(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log("paper_sim", `Failed to write ${STATE_FILE}: ${e.message}`);
  }
}

// ─── Concentration model ──────────────────────────────────────────────────────

/**
 * Estimate total active bins in a DLMM pool based on bin step.
 * DLMM pools concentrate liquidity in a band around the current price.
 * Narrow binStep → more bins for same price range → more total active bins.
 *
 * These are calibrated for memecoin pools where LPs typically cover
 * a ~50-200% price band around the active price.
 */
function estimateActiveBins(binStep) {
  if (binStep <= 10)  return 200;  // tight pools (SOL-USDC, stables)
  if (binStep <= 50)  return 150;  // moderate
  if (binStep <= 125) return 100;  // typical memecoin-SOL (Bountywork, Magpie)
  return 60;                        // wide step (binStep ≥ 200)
}

// ─── DLMM helpers (lazy-loaded) ───────────────────────────────────────────────

let _DLMM = null;
let _getBinIdFromPrice = null;
let _getPriceOfBinByBinId = null;
let _conn = null;

async function getDLMMHelpers() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
    _getBinIdFromPrice = mod.default?.getBinIdFromPrice;
    _getPriceOfBinByBinId = mod.getPriceOfBinByBinId;
  }
  return {
    DLMM: _DLMM,
    getBinIdFromPrice: _getBinIdFromPrice,
    getPriceOfBinByBinId: _getPriceOfBinByBinId,
  };
}

async function getConnection() {
  if (!_conn) {
    const { Connection } = await import("@solana/web3.js");
    _conn = new Connection(process.env.RPC_URL, "confirmed");
  }
  return _conn;
}

// ─── API helpers ──────────────────────────────────────────────────────────────

export async function fetchPoolConfig(poolAddress) {
  const res = await fetch(`${DLMM_API}/pools/${poolAddress}`);
  if (!res.ok) throw new Error(`Pool fetch failed: ${res.status}`);
  const d = await res.json();
  return {
    name:            d.name,
    binStep:         d.pool_config?.bin_step,
    baseFeePct:      d.pool_config?.base_fee_pct ?? 0,
    protocolFeePct:  d.pool_config?.protocol_fee_pct ?? 5,
    tvl:             d.tvl ?? 0,
    tokenXSymbol:    d.token_x?.symbol,
    tokenYSymbol:    d.token_y?.symbol,
    tokenXPrice:     d.token_x?.price ?? 0,
    tokenYPrice:     d.token_y?.price ?? 0,
    currentPrice:    d.current_price ?? 0,  // datapi scale — matches OHLCV candle prices
  };
}

/**
 * Fetch 5m candles from startTimestamp (unix seconds) to now.
 * Returns only candles newer than startTimestamp.
 */
async function fetchNewCandles(poolAddress, fromTimestamp) {
  const end = Math.floor(Date.now() / 1000);
  const url  = `${DLMM_API}/pools/${poolAddress}/ohlcv?timeframe=5m&start_time=${fromTimestamp}&end_time=${end}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`OHLCV fetch failed: ${res.status}`);
  const data = await res.json();
  // Filter out the candle at exactly fromTimestamp (already processed)
  return (data.data ?? []).filter((c) => c.timestamp > fromTimestamp);
}

// ─── Liquidity distribution ───────────────────────────────────────────────────

function buildWeights(strategyType, lowerBinId, upperBinId, activeBinId) {
  const n      = upperBinId - lowerBinId + 1;
  const center = activeBinId - lowerBinId;
  const sigma  = Math.max(n / 4, 1);
  const w      = Array.from({ length: n }, (_, i) => {
    const d = i - center;
    if (strategyType === "curve")   return Math.exp(-0.5 * (d / sigma) ** 2);
    if (strategyType === "bid-ask") return 1 - Math.exp(-0.5 * (d / sigma) ** 2) + 0.01;
    return 1; // spot
  });
  const total = w.reduce((s, v) => s + v, 0);
  return w.map((v) => v / total);
}

// ─── Initial X/Y token split ──────────────────────────────────────────────────

/**
 * Compute how the deposit splits into token X and token Y at entry.
 * Uses concentrated liquidity geometry (sqrt-price space).
 * Returns { xUsd, yUsd } — both in USD.
 */
function computeInitialSplit(depositUsd, entryPrice, lowerPrice, upperPrice) {
  // Clamp entry price to range
  const p  = Math.max(lowerPrice, Math.min(upperPrice, entryPrice));
  const pa = lowerPrice;
  const pb = upperPrice;

  // y fraction (quote token) = (sqrt(p) - sqrt(pa)) / (sqrt(pb) - sqrt(pa))
  const sqrtP  = Math.sqrt(p);
  const sqrtPa = Math.sqrt(pa);
  const sqrtPb = Math.sqrt(pb);
  const yFrac  = (sqrtP - sqrtPa) / (sqrtPb - sqrtPa);
  const xFrac  = 1 - yFrac;

  return {
    xUsd: depositUsd * xFrac,
    yUsd: depositUsd * yFrac,
  };
}

// ─── Per-candle fee + IL update ───────────────────────────────────────────────

/**
 * Given one 5m candle, return { feeEarned, newIlUsd } relative to the position.
 */
function processCandle(candle, position) {
  const { low, high, close, volume } = candle;
  const { lowerPrice, upperPrice, lpFeeFraction, avgExistingBinTvl, weights, lowerBinId, upperBinId, depositAmount, initialXUsd, initialYUsd, entryPrice, tokenYPrice } = position;

  // ── Fee accrual ──
  // How much of the candle's price range overlaps our position range?
  const candleLow  = Math.min(low, close);
  const candleHigh = Math.max(high, close);
  const overlapLow  = Math.max(candleLow, lowerPrice);
  const overlapHigh = Math.min(candleHigh, upperPrice);

  let feeEarned = 0;
  if (overlapHigh >= overlapLow) {
    const overlapFrac = (overlapHigh - overlapLow) / Math.max(candleHigh - candleLow, 1e-12);

    // Volume from Meteora OHLCV is in USD, convert to SOL.
    // avgExistingBinTvl is in USD (from d.tvl), convert to SOL using tokenYPrice.
    // ourAvgBinDeposit is depositAmount / bins (in SOL).
    const solPrice           = tokenYPrice > 0 ? tokenYPrice : 1;
    const volumeValueSol     = solPrice > 0 ? volume / solPrice : 0;
    const volumeInRangeSol   = volumeValueSol * overlapFrac;
    const existingBinTvlSol  = avgExistingBinTvl / solPrice;
    const ourAvgBinDeposit   = depositAmount / weights.length;
    const totalAvgBinLiq     = existingBinTvlSol + ourAvgBinDeposit;
    const avgTvlShare        = ourAvgBinDeposit / totalAvgBinLiq;

    feeEarned = volumeInRangeSol * lpFeeFraction * avgTvlShare;
  }

  // ── IL ──
  // Use price ratio formula: IL% = 2*sqrt(r)/(1+r) - 1 where r = currentPrice/entryPrice
  // Clamp current price to range (when OOR, IL is locked at the boundary price ratio)
  const effectivePrice = Math.max(lowerPrice, Math.min(upperPrice, close));
  const r = entryPrice > 0 ? effectivePrice / entryPrice : 1;
  const ilPct = r > 0 ? (2 * Math.sqrt(r)) / (1 + r) - 1 : 0;
  // Amplify for concentrated liquidity: IL is higher in a narrow range
  const rangeWidth = upperPrice > lowerPrice ? Math.sqrt(upperPrice / lowerPrice) : 1;
  const ilUsd = depositAmount * ilPct * rangeWidth;

  return { feeEarned, ilUsd, currentPrice: close, inRange: overlapHigh > overlapLow };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Open a new paper position. Returns the position object.
 */
export async function openPaperPosition({
  pool_address,
  deposit_amount,
  lower_price,
  upper_price,
  strategy_type = "spot",
}) {
  const { getBinIdFromPrice } = await getDLMMHelpers();
  const poolCfg = await fetchPoolConfig(pool_address);

  const { binStep, baseFeePct, protocolFeePct, tvl, name, tokenXSymbol, tokenYSymbol, tokenYPrice, currentPrice } = poolCfg;
  const lpFeeFraction = (baseFeePct / 100) * (1 - protocolFeePct / 100);

  const lowerBinId  = getBinIdFromPrice(lower_price, binStep, true);
  const upperBinId  = getBinIdFromPrice(upper_price, binStep, false);
  const activeBinId = getBinIdFromPrice((lower_price + upper_price) / 2, binStep, true);

  if (lowerBinId >= upperBinId) throw new Error("lower_price must be less than upper_price");

  // SDK bin prices and OHLCV candle prices may differ in scale due to token decimal differences.
  // Detect scale factor by comparing SDK midpoint to datapi current_price (which matches OHLCV scale).
  const sdkMidPrice = (lower_price + upper_price) / 2;
  const priceScale  = currentPrice > 0 && sdkMidPrice > 0 ? currentPrice / sdkMidPrice : 1;

  // Normalized prices — consistent with OHLCV candle close/high/low values
  const normLowerPrice = lower_price * priceScale;
  const normUpperPrice = upper_price * priceScale;
  const normEntryPrice = sdkMidPrice * priceScale; // ≈ currentPrice

  const numBins           = upperBinId - lowerBinId + 1;
  // Use estimated total active bins (not numBins) so avgTvlShare reflects
  // DLMM concentration: our narrow-range deposit competes only against
  // the active liquidity band, not the entire pool's TVL.
  const totalActiveBins   = tvl > 0 ? estimateActiveBins(binStep) : 1;
  const avgExistingBinTvl = tvl > 0 ? tvl / totalActiveBins : deposit_amount;
  const weights           = buildWeights(strategy_type, lowerBinId, upperBinId, activeBinId);

  const { xUsd, yUsd } = computeInitialSplit(deposit_amount, normEntryPrice, normLowerPrice, normUpperPrice);

  const nowSec = Math.floor(Date.now() / 1000);
  const id     = `paper-${Date.now().toString(36)}`;

  const position = {
    id,
    pool_address,
    pool_name:    name || pool_address.slice(0, 8),
    pair:         `${tokenXSymbol}-${tokenYSymbol}`,
    deposit_amount,
    lower_price,
    upper_price,
    strategy_type,
    bin_step:         binStep,
    lp_fee_fraction:  lpFeeFraction,
    lower_bin_id:     lowerBinId,
    upper_bin_id:     upperBinId,
    weights,
    avg_existing_bin_tvl: avgExistingBinTvl,
    token_y_price:        tokenYPrice,

    // entry state (prices in OHLCV/datapi scale)
    entry_price:       normEntryPrice,
    lower_price:       normLowerPrice,
    upper_price:       normUpperPrice,
    price_scale:       priceScale,
    entry_timestamp:   nowSec,
    opened_at:         new Date().toISOString(),
    initial_x_usd:     xUsd,
    initial_y_usd:     yUsd,

    // accumulated (updated each tick)
    fees_earned:       0,
    il_usd:            0,
    net_pnl:           0,
    candles_total:     0,
    candles_in_range:  0,
    last_price:        normEntryPrice,
    last_candle_timestamp: nowSec,
    status:            "open",
    closed_at:         null,
  };

  const state = load();
  state.positions[id] = position;
  save(state);

  log("paper_sim", `Opened paper position ${id}: ${position.pair} ◎${deposit_amount} [${lower_price}–${upper_price}] ${strategy_type}`);
  return formatSummary(position);
}

/**
 * Tick all open paper positions — fetch new 5m candles and update state.
 * Called every 5m from the cron in index.js.
 */
export async function tickPaperPositions() {
  const state = load();
  const open  = Object.values(state.positions).filter((p) => p.status === "open");
  if (open.length === 0) return;

  log("paper_sim", `Ticking ${open.length} paper position(s)`);

  for (const pos of open) {
    try {
      const candles = await fetchNewCandles(pos.pool_address, pos.last_candle_timestamp);
      if (candles.length === 0) continue;

      let { fees_earned, il_usd, candles_total, candles_in_range } = pos;

      for (const candle of candles) {
        const { feeEarned, ilUsd, currentPrice, inRange } = processCandle(candle, {
          lowerPrice:         pos.lower_price,
          upperPrice:         pos.upper_price,
          lpFeeFraction:      pos.lp_fee_fraction,
          avgExistingBinTvl:  pos.avg_existing_bin_tvl,
          weights:            pos.weights,
          lowerBinId:         pos.lower_bin_id,
          upperBinId:         pos.upper_bin_id,
          depositAmount:      pos.deposit_amount,
          initialXUsd:        pos.initial_x_usd,
          initialYUsd:        pos.initial_y_usd,
          entryPrice:         pos.entry_price,
          tokenYPrice:        pos.token_y_price,
        });

        fees_earned     += feeEarned;
        il_usd           = ilUsd;
        candles_total   += 1;
        if (inRange) candles_in_range += 1;

        pos.last_price            = currentPrice;
        pos.last_candle_timestamp = candle.timestamp;
      }

      pos.fees_earned      = fees_earned;
      pos.il_usd           = il_usd;
      pos.net_pnl          = fees_earned + il_usd;
      pos.candles_total    = candles_total;
      pos.candles_in_range = candles_in_range;

      const netPnlPct = pos.deposit_amount > 0 ? (pos.net_pnl / pos.deposit_amount) * 100 : 0;
      if (pos.peak_pnl_pct == null || netPnlPct > pos.peak_pnl_pct) {
        pos.peak_pnl_pct = netPnlPct;
      }
      pos.trailing_active = pos.peak_pnl_pct >= (config.management?.trailingTriggerPct ?? 3);

      state.positions[pos.id] = pos;
      log("paper_sim", `${pos.id} ticked +${candles.length} candles | fees=◎${pos.fees_earned} IL=◎${pos.il_usd} netPnL=◎${pos.net_pnl}`);
    } catch (e) {
      log("paper_sim", `Tick failed for ${pos.id}: ${e.message}`);
    }
  }

  save(state);
}

/**
 * Get a paper position by ID.
 */
export function getPaperPosition(id) {
  const state = load();
  const pos   = state.positions[id];
  if (!pos) throw new Error(`Paper position ${id} not found`);
  return formatSummary(pos);
}

/**
 * List all paper positions (open + closed).
 */
export function listPaperPositions() {
  const state = load();
  return Object.values(state.positions).map(formatSummary);
}

/**
 * Close a paper position. Returns final summary.
 */
export function closePaperPosition(id, reason = null) {
  const state = load();
  const pos   = state.positions[id];
  if (!pos) throw new Error(`Paper position ${id} not found`);
  if (pos.status === "closed") throw new Error(`Position ${id} is already closed`);

  pos.status    = "closed";
  pos.closed_at = new Date().toISOString();
  pos.close_reason = reason;
  state.positions[id] = pos;
  save(state);

  log("paper_sim", `Closed paper position ${id}: netPnL=◎${pos.net_pnl} fees=◎${pos.fees_earned} IL=◎${pos.il_usd} reason="${reason}"`);
  return formatSummary(pos);
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatSummary(pos) {
  const durationHours = pos.last_candle_timestamp
    ? +((pos.last_candle_timestamp - pos.entry_timestamp) / 3600).toFixed(1)
    : 0;
  const inRangePct = pos.candles_total > 0
    ? +((pos.candles_in_range / pos.candles_total) * 100).toFixed(1)
    : null;
  const annualizedApr = durationHours > 0 && pos.fees_earned > 0
    ? +((pos.fees_earned / pos.deposit_amount) * (8760 / durationHours) * 100).toFixed(2)
    : null;

  return {
    id:            pos.id,
    pool:          pos.pool_name,
    pool_address:  pos.pool_address,
    pair:          pos.pair,
    status:        pos.status,
    strategy:      pos.strategy_type,
    deposit:       pos.deposit_amount,
    range:         { lower: pos.lower_price, upper: pos.upper_price, scale: pos.price_scale ?? 1 },
    entry_price:   pos.entry_price,
    last_price:    pos.last_price,
    opened_at:     pos.opened_at,
    closed_at:     pos.closed_at ?? null,
    duration_hours: durationHours,
    fees_earned:   pos.fees_earned,
    il_usd:        pos.il_usd,
    net_pnl:       pos.net_pnl,
    in_range_pct:  inRangePct,
    candles_total: pos.candles_total,
    annualized_fee_apr: annualizedApr,
    close_reason:  pos.close_reason ?? null,
    // bin distribution for chart overlay
    bin_step:      pos.bin_step ?? null,
    lower_bin_id:  pos.lower_bin_id ?? null,
    upper_bin_id:  pos.upper_bin_id ?? null,
    weights:       pos.weights ?? null,
  };
}
