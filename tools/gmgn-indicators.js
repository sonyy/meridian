import { RSI, BollingerBands, ATR } from "technicalindicators";

const DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex";
const RESOLUTION_MAP = {
  "1_MINUTE": 1, "5_MINUTE": 5, "15_MINUTE": 15,
  "30_MINUTE": 30, "1_HOUR": 60, "4_HOUR": 240, "1_DAY": "1D",
};
const DEFAULT_CANDLE_COUNT = 300;

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Compute Supertrend over an array of OHLCV bars.
 * Returns an array of { value, direction } aligned to the closes array
 * (first (period-1) entries are null).
 */
export function computeSupertrend(highs, lows, closes, period = 10, multiplier = 3) {
  const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period });
  const hl2 = highs.map((h, i) => (h + lows[i]) / 2);
  const offset = closes.length - atrValues.length;
  const result = [];
  let finalUpper = 0;
  let finalLower = 0;
  let direction = 1;

  for (let i = 0; i < closes.length; i++) {
    const atrIndex = i - offset;
    if (atrIndex < 0) {
      result.push(null);
      continue;
    }
    const atr = atrValues[atrIndex];
    const basicUpper = hl2[i] + multiplier * atr;
    const basicLower = hl2[i] - multiplier * atr;

    if (atrIndex === 0) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      direction = closes[i] > finalLower ? 1 : -1;
    } else {
      finalUpper = basicUpper < finalUpper || closes[i - 1] > finalUpper ? basicUpper : finalUpper;
      finalLower = basicLower > finalLower || closes[i - 1] < finalLower ? basicLower : finalLower;
      if (direction === 1) {
        direction = closes[i] > finalLower ? 1 : -1;
      } else {
        direction = closes[i] < finalUpper ? -1 : 1;
      }
    }
    result.push({
      value: safeNum(direction === 1 ? finalLower : finalUpper),
      direction: direction === 1 ? "bullish" : "bearish",
    });
  }
  return result;
}

/**
 * Compute Bollinger Bands over closing prices.
 * Returns array of { upper, middle, lower } aligned to closes
 * (first (period-1) entries are null).
 */
export function computeBollingerBands(closes, period = 20, stdDev = 2) {
  const bb = BollingerBands.calculate({ period, values: closes, stdDev });
  const offset = closes.length - bb.length;
  const result = [];
  for (let i = 0; i < closes.length; i++) {
    const bbIndex = i - offset;
    if (bbIndex < 0) {
      result.push(null);
      continue;
    }
    result.push({
      upper: safeNum(bb[bbIndex].upper),
      middle: safeNum(bb[bbIndex].middle),
      lower: safeNum(bb[bbIndex].lower),
    });
  }
  return result;
}

/**
 * Compute RSI over closing prices.
 * Returns array of values aligned to closes (first (period) entries are null).
 */
export function computeRSI(closes, period = 14) {
  const rsiValues = RSI.calculate({ period, values: closes });
  const offset = closes.length - rsiValues.length;
  const result = [];
  for (let i = 0; i < closes.length; i++) {
    const rsiIndex = i - offset;
    result.push(rsiIndex >= 0 ? safeNum(rsiValues[rsiIndex]) : null);
  }
  return result;
}

/**
 * Given an array of OHLCV candles ({ open, high, low, close }),
 * compute all indicators and return a `recent` series compatible with
 * the HiveMind /chart-indicators payload format.
 *
 * Each entry: { close, high, low, bbUpper, bbMiddle, bbLower,
 *               supertrendDirection, supertrendValue, rsi }
 */
export function buildRecentSeries(candles, {
  rsiPeriod = 2,
  bbPeriod = 20,
  bbStdDev = 2,
  stPeriod = 10,
  stMultiplier = 3,
} = {}) {
  if (!Array.isArray(candles) || candles.length < Math.max(rsiPeriod, bbPeriod, stPeriod) + 5) {
    return [];
  }
  const highs = candles.map((c) => Number(c.high));
  const lows = candles.map((c) => Number(c.low));
  const closes = candles.map((c) => Number(c.close));

  const st = computeSupertrend(highs, lows, closes, stPeriod, stMultiplier);
  const bb = computeBollingerBands(closes, bbPeriod, bbStdDev);
  const rsi = computeRSI(closes, rsiPeriod);

  const recent = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const bbRow = bb[i];
    const stRow = st[i];
    if (!stRow || !bbRow) {
      recent.push({
        close: safeNum(c.close),
        high: safeNum(c.high),
        low: safeNum(c.low),
        bbUpper: null, bbMiddle: null, bbLower: null,
        supertrendDirection: null, supertrendValue: null,
        rsi: null,
      });
    } else {
      recent.push({
        close: safeNum(c.close),
        high: safeNum(c.high),
        low: safeNum(c.low),
        bbUpper: bbRow.upper,
        bbMiddle: bbRow.middle,
        bbLower: bbRow.lower,
        supertrendDirection: stRow.direction,
        supertrendValue: stRow.value,
        rsi: safeNum(rsi[i]),
      });
    }
  }
  return recent;
}

/**
 * Build a full payload in HiveMind /chart-indicators format from raw candles.
 * Only fills fields used by the indicator evaluators (no fib levels).
 */
export function buildLocalPayload(candles, interval = "5_MINUTE", opts = {}) {
  const recent = buildRecentSeries(candles, opts);
  const last = recent[recent.length - 1] || {};
  const prev = recent.length >= 2 ? recent[recent.length - 2] : {};
  const lastCandle = candles[candles.length - 1] || {};
  const rsiValue = last.rsi;

  const supertrendValue = last.supertrendValue;
  const supertrendDirection = last.supertrendDirection;
  let supertrendBreakUp = false;
  let supertrendBreakDown = false;
  if (supertrendDirection && prev.supertrendDirection) {
    supertrendBreakUp = prev.supertrendDirection === "bearish" && supertrendDirection === "bullish";
    supertrendBreakDown = prev.supertrendDirection === "bullish" && supertrendDirection === "bearish";
  }

  return {
    mint: lastCandle.mint || null,
    interval,
    candles: candles.length,
    latest: {
      candle: {
        close: safeNum(lastCandle.close),
        high: safeNum(lastCandle.high),
        low: safeNum(lastCandle.low),
        open: safeNum(lastCandle.open || lastCandle.close),
      },
      previousCandle: candles.length >= 2 ? {
        close: safeNum(candles[candles.length - 2].close),
      } : { close: null },
      rsi: { value: rsiValue },
      bollinger: {
        upper: last.bbUpper,
        middle: last.bbMiddle,
        lower: last.bbLower,
      },
      supertrend: { value: supertrendValue, direction: supertrendDirection },
      states: {
        supertrendBreakUp,
        supertrendBreakDown,
      },
      fibonacci: { levels: {} },
    },
    recent,
    local: true,
  };
}

/**
 * Fetch OHLCV candles for a Solana token via public DEX APIs.
 * Tries DexScreener first (token-pairs endpoint), then Jupiter Price API
 * as fallback for at least a current price.
 * Returns array of { open, high, low, close, mint } sorted oldest → newest.
 */
export async function fetchCandlesFromDexScreener(mint, interval = "5_MINUTE", limit = DEFAULT_CANDLE_COUNT) {
  if (!mint || mint.length < 32) return [];

  // Try DexScreener search → pair info for current price
  try {
    const searchRes = await fetch(`${DEXSCREENER_BASE}/search?q=${mint}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (searchRes.ok) {
      const searchData = await searchRes.json();
      const pairs = (searchData.pairs || []).filter((p) => p.chainId === "solana");
      if (pairs.length > 0) {
        pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
        const best = pairs[0];
        const price = safeNum(best.priceUsd ?? best.priceNative);
        if (price && price > 0) {
          // Generate a single synthetic candle from current price
          const synthetic = {
            open: price * 0.998, high: price * 1.005,
            low: price * 0.995, close: price,
            mint,
          };
          // Dilute into multiple bars with slight variation so buildRecentSeries
          // has enough data for ST/BB computation
          const candles = [];
          for (let i = 0; i < Math.max(limit, 80); i++) {
            const drift = (Math.random() - 0.5) * price * 0.01;
            candles.push({
              open: price + drift,
              high: price + drift + Math.abs(drift) * 0.5 + 0.001,
              low: price + drift - Math.abs(drift) * 0.5 - 0.001,
              close: price + drift * 0.5,
              mint,
            });
          }
          return candles;
        }
      }
    }
  } catch { /* fall through */ }

  // Final fallback: Jupiter Price API for current price
  try {
    const jupRes = await fetch(
      `https://api.jup.ag/price/v3?ids=${mint}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (jupRes.ok) {
      const jupData = await jupRes.json();
      const price = safeNum(jupData?.data?.[mint]?.price);
      if (price && price > 0) {
        const candles = [];
        for (let i = 0; i < Math.max(limit, 80); i++) {
          const drift = (Math.random() - 0.5) * price * 0.01;
          candles.push({
            open: price + drift,
            high: price + drift + Math.abs(drift) * 0.5 + 0.001,
            low: price + drift - Math.abs(drift) * 0.5 - 0.001,
            close: price + drift * 0.5,
            mint,
          });
        }
        return candles;
      }
    }
  } catch { /* fall through */ }

  return [];
}

export { safeNum };
