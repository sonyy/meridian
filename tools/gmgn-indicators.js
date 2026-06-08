import { config } from "../config.js";
import { gmgnFetch } from "./gmgn-client.js";   // leaf client — NOT gmgn.js (avoids import cycle)

// Compute chart indicators from GMGN klines, matching the payload shape that
// tools/chart-indicators.js consumers expect. Pure functions + one cached fetch.

// Bucket ascending-by-time 1-minute OHLCV candles into N-minute candles, anchored to
// wall-clock boundaries (bucketStart = floor(time / N·60s) · N·60s) rather than array
// index. Clock alignment makes a given wall-clock period always group the same minutes,
// so a sliding 1m window no longer re-phases the resampled series on every refresh — the
// trailing CLOSED buckets are invariant to where the window happens to start. Each output
// candle's `time` is the aligned bucket start. Gaps are handled naturally (each minute
// lands in its own clock bucket).
//
// `dropInProgress`: drop the latest (highest-start) bucket — the still-forming current
// period — so the supertrend/RSI/Bollinger decision is taken on the last CLOSED bar and
// does not repaint as new 1m candles arrive within the period.
export function resampleKlines(klines1m, targetMinutes, { dropInProgress = false } = {}) {
  if (!Array.isArray(klines1m) || klines1m.length === 0) return [];
  const widthMs = Math.max(1, Math.floor(targetMinutes)) * 60_000;
  const buckets = new Map(); // bucketStart → aggregate
  for (const k of klines1m) {
    const t = Number(k.time);
    if (!Number.isFinite(t)) continue;
    const start = Math.floor(t / widthMs) * widthMs;
    const b = buckets.get(start);
    if (!b) {
      buckets.set(start, {
        time: start,
        firstTime: t,
        lastTime: t,
        open: k.open,
        close: k.close,
        high: k.high,
        low: k.low,
        volume: Number(k.volume) || 0,
      });
    } else {
      if (t < b.firstTime) { b.firstTime = t; b.open = k.open; }
      if (t >= b.lastTime) { b.lastTime = t; b.close = k.close; }
      if (k.high > b.high) b.high = k.high;
      if (k.low < b.low) b.low = k.low;
      b.volume += Number(k.volume) || 0;
    }
  }
  const out = [...buckets.values()]
    .sort((a, b) => a.time - b.time)
    .map(({ firstTime, lastTime, ...candle }) => candle);
  if (dropInProgress && out.length > 0) out.pop(); // latest period is still forming
  return out;
}

// Wilder's RSI of the final close. Returns null if insufficient data.
// Needs length+1 closes minimum; uses all available history for smoothing.
export function computeRsi(closes, length = 2) {
  if (!Array.isArray(closes) || closes.length < length + 1) return null;
  let avgGain = 0;
  let avgLoss = 0;
  // Seed with the first `length` deltas (simple average).
  for (let i = 1; i <= length; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) avgGain += delta;
    else avgLoss -= delta;
  }
  avgGain /= length;
  avgLoss /= length;
  // Wilder-smooth across the rest.
  for (let i = length + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (length - 1) + gain) / length;
    avgLoss = (avgLoss * (length - 1) + loss) / length;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Rolling Wilder RSI aligned to `closes` (one value per close; null before warmup).
// series[i] uses the same Wilder smoothing as computeRsi, so series[last] agrees with
// computeRsi(closes) to floating-point precision.
export function computeRsiSeries(closes, length = 2) {
  const len = Array.isArray(closes) ? closes.length : 0;
  const out = new Array(len).fill(null);
  if (len < length + 1) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= length; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) avgGain += delta;
    else avgLoss -= delta;
  }
  avgGain /= length;
  avgLoss /= length;
  const rsiFrom = (g, l) => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  out[length] = rsiFrom(avgGain, avgLoss);
  for (let i = length + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (length - 1) + gain) / length;
    avgLoss = (avgLoss * (length - 1) + loss) / length;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

// EMA aligned to `values`; null before the seed bar. Seed = SMA of the first `period`.
function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period || period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// MACD over `closes`. Returns { macd, signal, histogram } for the last bar plus the aligned
// `histogramSeries` (one value per close; null before the signal line is defined), or null
// when there is not enough data for the slow EMA + signal EMA. Used for first-green detection.
export function computeMacd(closes, { fast = 12, slow = 26, signal = 9 } = {}) {
  if (!Array.isArray(closes) || closes.length < slow + signal) return null;
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null);
  // Signal EMA over the defined portion of macdLine, mapped back to aligned indices.
  const firstMacd = macdLine.findIndex((v) => v != null);
  const defined = firstMacd >= 0 ? macdLine.slice(firstMacd) : [];
  const sigDefined = emaSeries(defined, signal);
  const signalLine = new Array(closes.length).fill(null);
  for (let j = 0; j < sigDefined.length; j++) {
    if (sigDefined[j] != null) signalLine[firstMacd + j] = sigDefined[j];
  }
  const histogramSeries = closes.map((_, i) =>
    macdLine[i] != null && signalLine[i] != null ? macdLine[i] - signalLine[i] : null);
  const last = closes.length - 1;
  if (histogramSeries[last] == null) return null;
  return {
    macd: macdLine[last],
    signal: signalLine[last],
    histogram: histogramSeries[last],
    histogramSeries,
  };
}

// Bollinger Bands for the final candle. Population stddev. Null if insufficient data.
export function computeBollinger(closes, period = 20, stdDevMult = 2) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const window = closes.slice(-period);
  const mean = window.reduce((sum, v) => sum + v, 0) / period;
  const variance = window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return {
    middle: mean,
    upper: mean + stdDevMult * sd,
    lower: mean - stdDevMult * sd,
  };
}

// Per-bar Bollinger bands (plus close/high/low/rsi/macdHist) for the last `n` candles.
// Each band is computed over the trailing `period` closes ending at that bar, so the
// series is non-repainting. Used to detect band interactions across a window of recently
// CLOSED bars — a lower-band dip OR an upper-band tag. Bars without enough history get
// null bands. Optional 4th arg `series` carries candle-aligned arrays for rsi/macdHist
// (produced by computeRsiSeries / computeMacd.histogramSeries), attached per bar so
// consumers can read per-bar RSI and MACD histogram without recomputing.
export function buildRecentSeries(candles, params, n, series = {}) {
  const out = [];
  if (!Array.isArray(candles) || candles.length === 0) return out;
  const count = Math.max(0, Number.isFinite(n) ? Math.floor(n) : 1);
  if (count === 0) return out;
  const rsiSeries = Array.isArray(series.rsiSeries) ? series.rsiSeries : null;
  const macdHistSeries = Array.isArray(series.macdHistSeries) ? series.macdHistSeries : null;
  const start = Math.max(0, candles.length - count);
  for (let i = start; i < candles.length; i++) {
    const closesUpToI = candles.slice(0, i + 1).map((c) => c.close);
    const bb = computeBollinger(closesUpToI, params.bollingerPeriod, params.bollingerStdDev);
    out.push({
      close: candles[i].close,
      high: candles[i].high,
      low: candles[i].low,
      bbLower: bb ? bb.lower : null,
      bbMiddle: bb ? bb.middle : null,
      bbUpper: bb ? bb.upper : null,
      rsi: rsiSeries ? rsiSeries[i] ?? null : null,
      macdHist: macdHistSeries ? macdHistSeries[i] ?? null : null,
    });
  }
  return out;
}

// ATR-based Supertrend over OHLC candles (ascending by time).
// Returns { value, direction, breakUp, breakDown } for the final candle, or null.
// direction: "bullish" | "bearish". breakUp/breakDown = direction flipped on the
// final candle relative to the prior one.
export function computeSupertrend(candles, period = 10, multiplier = 3) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;

  // True Range series.
  const tr = [];
  for (let i = 0; i < candles.length; i++) {
    const cur = candles[i];
    if (i === 0) {
      tr.push(cur.high - cur.low);
      continue;
    }
    const prevClose = candles[i - 1].close;
    tr.push(Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prevClose),
      Math.abs(cur.low - prevClose),
    ));
  }

  // Wilder ATR.
  const atr = new Array(candles.length).fill(null);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += tr[i];
  atr[period - 1] = seed / period;
  for (let i = period; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }

  // Supertrend bands + direction.
  // Seed the initial direction from the first evaluated bar's price position relative
  // to its basic mid-band (HL2) instead of assuming bullish: close >= mid → bullish,
  // else bearish. This avoids reporting bullish on a token whose early candles are in a
  // downtrend but haven't crossed the lower band yet.
  const seedIdx = period - 1;
  const seedMid = (candles[seedIdx].high + candles[seedIdx].low) / 2;
  let dirNum = candles[seedIdx].close >= seedMid ? 1 : -1;
  let prevDirNum = dirNum;
  let direction = dirNum === 1 ? "bullish" : "bearish";
  let finalUpper = null;
  let finalLower = null;
  let supertrend = null;

  for (let i = period - 1; i < candles.length; i++) {
    const mid = (candles[i].high + candles[i].low) / 2;
    const basicUpper = mid + multiplier * atr[i];
    const basicLower = mid - multiplier * atr[i];
    const close = candles[i].close;
    const prevClose = candles[i - 1].close;

    finalUpper = (finalUpper == null || prevClose > finalUpper)
      ? basicUpper
      : Math.min(basicUpper, finalUpper);
    finalLower = (finalLower == null || prevClose < finalLower)
      ? basicLower
      : Math.max(basicLower, finalLower);

    prevDirNum = dirNum;
    if (close > finalUpper) dirNum = 1;
    else if (close < finalLower) dirNum = -1;
    // else: direction unchanged

    supertrend = dirNum === 1 ? finalLower : finalUpper;
    direction = dirNum === 1 ? "bullish" : "bearish";
  }

  return {
    value: supertrend,
    direction,
    breakUp: prevDirNum === -1 && dirNum === 1,
    breakDown: prevDirNum === 1 && dirNum === -1,
  };
}

// Best-effort Fibonacci retracement levels from the swing high/low of the last N bars.
// Approximate by design (the upstream feed may anchor swings differently). Present so
// the payload shape is complete; the fibo_* presets are not in active use.
export function computeFibonacci(candles, lookbackBars = 55) {
  const window = candles.slice(-Math.max(2, lookbackBars));
  const high = Math.max(...window.map((c) => c.high));
  const low = Math.min(...window.map((c) => c.low));
  const span = high - low;
  const level = (ratio) => high - span * ratio;
  return {
    levels: {
      "0.236": level(0.236),
      "0.382": level(0.382),
      "0.500": level(0.5),
      "0.618": level(0.618),
      "0.786": level(0.786),
    },
  };
}

// Orchestrate all indicators into the payload shape consumers expect.
// Throws if there is insufficient data to compute the core indicators — the seam
// catches this and falls back to the Meridian endpoint.
export function computeIndicators(candles, params) {
  if (!Array.isArray(candles) || candles.length < 2) {
    throw new Error("insufficient kline data for indicators");
  }
  const closes = candles.map((c) => c.close);
  const supertrend = computeSupertrend(candles, params.supertrendPeriod, params.supertrendMultiplier);
  const bollinger = computeBollinger(closes, params.bollingerPeriod, params.bollingerStdDev);
  const rsi = computeRsi(closes, params.rsiLength);
  if (!supertrend || !bollinger || rsi == null) {
    throw new Error("insufficient kline data for indicators");
  }
  // MACD is best-effort: null when history is short → triggers that need it simply don't fire.
  const rsiSeries = computeRsiSeries(closes, params.rsiLength);
  const macd = computeMacd(closes, { fast: params.macdFast, slow: params.macdSlow, signal: params.macdSignal });
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  return {
    latest: {
      candle: { open: last.open, high: last.high, low: last.low, close: last.close },
      previousCandle: { close: prev.close },
      rsi: { value: rsi },
      macd: macd ? { macd: macd.macd, signal: macd.signal, histogram: macd.histogram } : null,
      bollinger: { upper: bollinger.upper, middle: bollinger.middle, lower: bollinger.lower },
      supertrend: { value: supertrend.value, direction: supertrend.direction },
      states: {
        supertrendBreakUp: supertrend.breakUp,
        supertrendBreakDown: supertrend.breakDown,
      },
      fibonacci: computeFibonacci(candles, params.fibLookbackBars),
    },
    recent: buildRecentSeries(candles, params, params.recentSeriesBars || 16, {
      rsiSeries,
      macdHistSeries: macd ? macd.histogramSeries : null,
    }),
  };
}

const INTERVAL_MINUTES = { "5_MINUTE": 5, "15_MINUTE": 15 };

// Default indicator params; overridden by config.gmgn.indicatorParams.
export const DEFAULT_INDICATOR_PARAMS = {
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
  bollingerPeriod: 20,
  bollingerStdDev: 2,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  fibLookbackBars: 55,
  klineCacheTtlSec: 30,
  // How many 1m candles to fetch per mint. Must give the COARSEST interval enough
  // warmup after resampling. GMGN hard-caps a single token_kline call at ~1000 1m bars
  // (verified: requesting 5000 returns 1000), i.e. ~66 closed 15m bars (~17h) — the
  // ceiling for 15m parity. Fetch the full 1000 so the 15m warmup below can be filled.
  // (900 yielded only ~60 closed 15m bars, just inside the seed-flap zone.)
  klineLimit: 1000,
  // Anchor the indicator window to a FIXED number of most-recent CLOSED resampled bars.
  // The 1m fetch is a sliding window, so without this the oldest bar (and thus the
  // supertrend seed) moved every refresh and could flip direction at the same instant.
  // Pinning to the last N closed buckets makes the seed advance only when a bar actually
  // closes — one controlled step, never per-fetch jitter.
  //
  // VALUE (66, not 50): the supertrend seed only washes out once the window contains the
  // last trend-defining band cross. On range-bound tokens a 50-bar 15m window (~12.5h) can
  // miss it and report the seed's guess instead of the true carried state — CUM-SOL's last
  // deploy seeded bullish at 50 bars while GMGN's TradingView ST read bearish (price below
  // 0.0005067). Convergence to GMGN is non-monotonic and only stabilizes from ~58 bars up,
  // so anchor to 66 — essentially all bars a 1000-kline fetch yields for 15m, safely clear
  // of the flap zone. See scripts/sweep-warmup-parity.js and the CUM 15m regression in
  // gmgn-indicators.test.js.
  warmupBars: 66,
  // How many most-recent CLOSED bars to expose in the payload's `recent` series.
  // Consumed by the supertrend_bb_extension entry preset to detect an upper-band tag across
  // a window of closed bars (a durable signal, vs a single-bar event that the 30-min
  // screener would usually miss). Keep >= the largest expected extensionLookbackBars.
  recentSeriesBars: 16,
  // Intervals (e.g. "15_MINUTE") to fetch at NATIVE resolution instead of resampling the
  // 1m feed. The 1m feed hard-caps at ~1000 candles → only ~66 closed 15m bars (~17h),
  // below the ~100-bar history the path-dependent supertrend needs to carry the last
  // trend-defining band cross on slower tokens. Native N-minute candles reach days of
  // history, so the supertrend matches the GMGN chart instead of reporting the seed's
  // guess. Default OFF (empty) so the single-fetch 1m→5m/15m optimization and the legacy
  // resample path are unchanged unless explicitly enabled in gmgn-config.json. Costs one
  // extra GMGN call per native interval per mint per cycle.
  nativeFetchIntervals: [],
  // Fixed anchor (most-recent CLOSED native bars) for the native path. Mirrors warmupBars'
  // role but sized for native depth: >= ~100 clears the supertrend seed-flap zone. Native
  // 15m yields ~137 bars, so 120 anchors safely past convergence while staying deterministic
  // (advances exactly one bar per close). See scripts/sweep-warmup-parity.js.
  nativeWarmupBars: 120,
  // Candles to request at native resolution. GMGN serves ~137 closed 15m bars (~34h).
  nativeKlineLimit: 300,
};

function indicatorParams() {
  return { ...DEFAULT_INDICATOR_PARAMS, ...(config.gmgn?.indicatorParams || {}) };
}

// Kline cache, keyed by resolution: Map<`${mint}` | `${mint}|${resolution}`, { klines, ts }>.
// In-memory, TTL-bounded, no disk. 1m uses the bare mint key (back-compat); native fetches
// are namespaced by resolution so they don't collide with the 1m series.
const klineCache = new Map();

// Injectable fetchers for tests. When null, the real GMGN fetch is used.
let klineFetcher = null;        // 1m series
let nativeKlineFetcher = null;  // native-resolution series, (mint, resolution, limit) => candles
export function __setKlineFetcherForTest(fn) { klineFetcher = fn; }
export function __setNativeKlineFetcherForTest(fn) { nativeKlineFetcher = fn; }
export function __clearKlineCacheForTest() { klineCache.clear(); }

// Normalize a GMGN token_kline response to ascending-by-time numeric OHLCV candles.
function normalizeKlines(payload) {
  const list = payload?.data?.list ?? payload?.list ?? payload?.data ?? [];
  if (!Array.isArray(list)) return [];
  return list
    .map((k) => ({
      time: Number(k.time),
      open: Number(k.open),
      high: Number(k.high),
      low: Number(k.low),
      close: Number(k.close),
      volume: Number(k.volume),
    }))
    .filter((k) => Number.isFinite(k.time) && Number.isFinite(k.close))
    .sort((a, b) => a.time - b.time);
}

async function realFetch1mKlines(mint) {
  const limit = Math.max(300, Number(indicatorParams().klineLimit) || 900);
  return normalizeKlines(await gmgnFetch("/v1/market/token_kline", {
    params: { chain: "sol", address: mint, resolution: "1m", limit },
  }));
}

async function realFetchNativeKlines(mint, resolution, limit) {
  return normalizeKlines(await gmgnFetch("/v1/market/token_kline", {
    params: { chain: "sol", address: mint, resolution, limit: Math.max(50, Number(limit) || 300) },
  }));
}

// Shared TTL-bounded cache wrapper. Only caches usable (non-empty) results so a transient
// empty GMGN response can't poison the cache for the whole TTL window and suppress the path.
async function getCachedKlines(cacheKey, fetchFn) {
  const ttlMs = Math.max(0, Number(indicatorParams().klineCacheTtlSec)) * 1000;
  const hit = klineCache.get(cacheKey);
  if (hit && ttlMs > 0 && Date.now() - hit.ts < ttlMs) return hit.klines;
  const klines = await fetchFn();
  if (Array.isArray(klines) && klines.length > 0) {
    klineCache.set(cacheKey, { klines, ts: Date.now() });
  }
  return klines;
}

async function getCached1mKlines(mint) {
  return getCachedKlines(mint, () => (klineFetcher || realFetch1mKlines)(mint));
}

async function getCachedNativeKlines(mint, resolution, limit) {
  return getCachedKlines(
    `${mint}|${resolution}`,
    () => (nativeKlineFetcher || realFetchNativeKlines)(mint, resolution, limit),
  );
}

// Top-level: produce the Meridian-shaped { latest } payload from GMGN klines.
// Throws on insufficient data or fetch failure — caller (the seam) falls back.
export async function fetchGmgnIndicatorPayload(mint, { interval, rsiLength } = {}) {
  const intervalKey = String(interval || "").trim().toUpperCase();
  const minutes = INTERVAL_MINUTES[intervalKey] || 5;
  const params = { ...indicatorParams(), rsiLength: Number(rsiLength) || 2 };

  const nativeIntervals = Array.isArray(params.nativeFetchIntervals) ? params.nativeFetchIntervals : [];
  if (nativeIntervals.includes(intervalKey)) {
    // Native-resolution path: fetch N-minute candles directly for the deep history the
    // path-dependent supertrend needs (the 1m feed caps at ~66 closed 15m bars, below the
    // last trend-defining band cross on slower tokens → the resample reports the seed's
    // guess, not the carried state). Berries-SOL 2026-06-02: 66-bar resample read
    // bearish/0.000597; native 120-bar read bullish/0.000424 = the GMGN chart.
    const native = await getCachedNativeKlines(mint, `${minutes}m`, params.nativeKlineLimit);
    if (!Array.isArray(native) || native.length === 0) {
      throw new Error("GMGN returned empty native kline list");
    }
    // resampleKlines is identity for already-aligned N-min candles; reused only for its
    // tested dropInProgress (decide on the last CLOSED bar, no repaint).
    const closed = resampleKlines(native, minutes, { dropInProgress: true });
    const anchor = Math.max(params.bollingerPeriod, params.supertrendPeriod) + 1;
    const window = closed.slice(-Math.max(anchor, Number(params.nativeWarmupBars) || 0));
    return computeIndicators(window, params);
  }

  const klines1m = await getCached1mKlines(mint);
  if (!Array.isArray(klines1m) || klines1m.length === 0) {
    throw new Error("GMGN returned empty kline list");
  }
  // Clock-aligned, in-progress bar excluded → decision taken on the last CLOSED bar.
  const closed = resampleKlines(klines1m, minutes, { dropInProgress: true });
  // Anchor to the last N closed bars so the supertrend seed is stable across fetches.
  const warmupBars = Math.max(params.bollingerPeriod, params.supertrendPeriod) + 1;
  const window = closed.slice(-Math.max(warmupBars, Number(params.warmupBars) || 0));
  return computeIndicators(window, params);
}
