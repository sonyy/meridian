import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);
import { log } from "../logger.js";
import { config } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.WEBUI_PORT || 3031;

// ── Global error handlers (prevent crash on unhandled rejections) ─────
process.on("unhandledRejection", (reason, promise) => {
  console.error(`[UNHANDLED REJECTION]`, reason?.stack || reason);
});
process.on("uncaughtException", (err) => {
  console.error(`[UNCAUGHT EXCEPTION]`, err?.stack || err);
});

// ── AbortController timeout helper (fetch does NOT natively support timeout) ──
function fetchWithTimeout(url, opts = {}) {
  const { timeout = 10000, ...rest } = opts;
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeout);
  return fetch(url, { ...rest, signal: ac.signal }).finally(() => clearTimeout(id));
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Token mint address lookup (symbol → mint) ──────────────────────────
const TOKEN_MINTS = {
  PARQ: "VtwGKv7dcpY7aFb8H7MvZfEtUAKwtsHcXSkejCAparq",
  BOUNTYWORK: "J4x1EMmQjF6WEzXq2tUtzY89x5aMhYz5CzfevcJEpump",
  POKE: "FADNLNo4xc8ot3bcgbHFQuuSKg93jKfpR8pcCR76pump",
  MAGPIE: "9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump",
  DUCK: "236ziZWiNPWeNk8aNB7abJpv4A6vHNP2XpxHH9VUpump",
};
// lowercase alias
for (const [k, v] of Object.entries(TOKEN_MINTS)) {
  TOKEN_MINTS[k.toLowerCase()] = v;
}

const _mintCache = {};
async function resolveMint(symbol) {
  const upper = symbol.toUpperCase();
  if (TOKEN_MINTS[upper]) return TOKEN_MINTS[upper];
  if (_mintCache[upper]) return _mintCache[upper];
  try {
    const paperMod = await import("../paper-positions.js");
    const allPaper = paperMod.listPaperPositions();
    const pos = allPaper.find(p => p.pair?.split("-")[0]?.toUpperCase() === upper && p.pool_address);
    if (pos?.pool_address) {
      const res = await fetchWithTimeout(`https://dlmm.datapi.meteora.ag/pools/${pos.pool_address}`, { timeout: 8000 });
      if (res.ok) {
        const data = await res.json();
        const mint = data.token_x?.address;
        if (mint) {
          _mintCache[upper] = mint;
          return mint;
        }
      }
    }
  } catch {}
  return null;
}

// ── Kline in-memory cache (reduce subprocess spawns) ──────────────────
const _klineCache = new Map();
const KLINE_CACHE_TTL = 120_000; // 2 minutes

function getCachedKline(key) {
  const entry = _klineCache.get(key);
  if (entry && Date.now() - entry.ts < KLINE_CACHE_TTL) return entry.data;
  return null;
}
function setCachedKline(key, data) {
  _klineCache.set(key, { ts: Date.now(), data });
  // Prune stale entries periodically
  if (_klineCache.size > 50) {
    const cutoff = Date.now() - KLINE_CACHE_TTL;
    for (const [k, v] of _klineCache) {
      if (v.ts < cutoff) _klineCache.delete(k);
    }
  }
}

// ── Earliest deploy time (1h before first position) ────────────────────
const DEPLOY_START = new Date("2026-06-01T00:00:00.000Z"); // start of pool history (pool created June 2)

async function fetchKlineAll(mint, fromTs, toTs) {
  const WINDOW = 500 * 60;
  const all = [];
  let cur = fromTs;
  while (cur < toTs) {
    const end = Math.min(cur + WINDOW, toTs);
    try {
      const { stdout } = await execAsync(
        `gmgn-cli market kline --chain sol --address ${mint} --resolution 5m --from ${cur} --to ${end} --raw 2>/dev/null`,
        { timeout: 15000, encoding: "utf8" }
      );
      const raw = stdout.trim();
      let chunk;
      try { chunk = JSON.parse(raw); } catch { chunk = []; }
      const list = Array.isArray(chunk) ? chunk : (chunk.list || []);
      all.push(...list);
      if (list.length === 0) break;
      const last = Number(list[list.length - 1].time || list[list.length - 1].t);
      cur = Math.max(cur + 1, Math.floor(last / 1000));
    } catch {
      break;
    }
  }
  return all;
}

const DLMM_API = "https://dlmm.datapi.meteora.ag";

async function fetchKlineFromMeteora(symbol, fromTs, toTs) {
  try {
    const paperMod = await import("../paper-positions.js");
    const allPaper = paperMod.listPaperPositions();
    const pos = allPaper.find(p => {
      const sym = p.pair?.split("-")[0]?.toUpperCase();
      return sym === symbol.toUpperCase();
    });
    if (!pos?.pool_address) return [];
    const base = `${DLMM_API}/pools/${pos.pool_address}/ohlcv?timeframe=5m`;
    const limit = 500; // safety cap
    const allCandles = [];

    // Page backwards from now: each batch returns up to 10 candles,
    // use earliest timestamp as next end_time (exclusive).
    let endTime = null;
    for (let i = 0; i < 20 && allCandles.length < limit; i++) {
      const url = endTime ? `${base}&end_time=${endTime}` : base;
      const resp = await fetchWithTimeout(url, { timeout: 10000 });
      if (!resp.ok) break;
      const data = await resp.json();
      const raw = data?.data ?? [];
      if (!raw.length) break;
      allCandles.push(...raw);
      endTime = raw[0].timestamp; // earliest in this batch is next cursor
      if (endTime <= fromTs) break; // reached requested start time
    }

    // Dedup by timestamp, sort ascending, filter to range
    const seen = new Set();
    return allCandles
      .filter(c => {
        if (seen.has(c.timestamp)) return false;
        seen.add(c.timestamp);
        return c.timestamp >= fromTs && c.timestamp <= toTs;
      })
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(c => ({
        t: c.timestamp * 1000,
        o: String(c.open),
        h: String(c.high),
        l: String(c.low),
        c: String(c.close),
        v: String(c.volume ?? 0),
      }));
  } catch {
    return [];
  }
}

app.get("/api/kline/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const mint = await resolveMint(symbol);
    if (!mint) return res.status(404).json({ error: `Unknown token: ${symbol}` });

    const toTs = req.query.to ? parseInt(req.query.to, 10) : Math.floor(Date.now() / 1000);
    let fromTs = toTs - 6 * 3600;
    if (req.query.from) fromTs = parseInt(req.query.from, 10);

    // Check in-memory cache before external calls
    const cacheKey = `${req.query.position || symbol}_${fromTs}_${toTs}`;
    const cached = getCachedKline(cacheKey);
    if (cached) return res.json(cached);

    // Try Meteora first (same source as simulation) when position given
    let candles;
    if (req.query.position) {
      candles = await fetchKlineFromMeteora(symbol, fromTs, toTs);
    }

    // Fall back to GMGN
    if (!candles || candles.length === 0) {
      candles = await fetchKlineAll(mint, fromTs, toTs);
    }

    // Scale all candles to align with position entry_price
    if (req.query.position && candles.length > 0) {
      const paperMod = await import("../paper-positions.js");
      const allPaper = paperMod.listPaperPositions();
      const pos = allPaper.find(p => p.id === req.query.position || p.position === req.query.position);
      if (pos && pos.entry_price) {
        const firstClose = parseFloat(candles[0].close || candles[0].c || candles[0].close);
        if (firstClose > 0) {
          const scaleFactor = pos.entry_price / firstClose;
          candles = candles.map(c => {
            const keys = ['open', 'high', 'low', 'close', 'o', 'h', 'l', 'c'];
            const res = { ...c };
            for (const k of keys) {
              if (res[k] !== undefined) {
                res[k] = String(parseFloat(res[k]) * scaleFactor);
              }
            }
            return res;
          });
        }
      }
    }

    const result = { symbol, mint, from: fromTs, to: toTs, candles: candles };
    setCachedKline(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Health check ────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), ts: Date.now() });
});

// ── API: All positions (open + closed) merged with state + config ─────────
app.get("/api/positions", async (req, res) => {
  try {
    const [paperMod, stateMod, virtualMod] = await Promise.all([
      import("../paper-positions.js"),
      import("../state.js"),
      import("../virtual-engine.js"),
    ]);

    const allPaper = paperMod.listPaperPositions();
    const trackedArray = stateMod.getTrackedPositions();
    const tracked = Object.fromEntries(trackedArray.map(t => [t.position, t]));
    const wallet = virtualMod.getVirtualWalletBalances();

    const open = await Promise.all(
      allPaper
        .filter((p) => p.status === "open")
        .map((p) => enrich(p, tracked, "open"))
    );

    const closed = await Promise.all(
      allPaper
        .filter((p) => p.status === "closed")
        .map((p) => enrich(p, tracked, "closed"))
    );

    const openUnrealizedPnl = open.reduce((s, p) => s + (p.net_pnl || 0), 0);
    const totalPnl = closed.reduce((s, p) => s + (p.net_pnl || 0), 0) + openUnrealizedPnl;
    const totalFees = closed.reduce((s, p) => s + (p.fees_earned || 0), 0) + open.reduce((s, p) => s + (p.fees_earned || 0), 0);
    const totalDeployed = closed.reduce((s, p) => s + (p.deposit || 0), 0) + open.reduce((s, p) => s + (p.deposit || 0), 0);
    const openDeployed = open.reduce((s, p) => s + (p.deposit || 0), 0);
    const closedDeployed = closed.reduce((s, p) => s + (p.deposit || 0), 0);
    const winCount = closed.filter((p) => (p.net_pnl ?? 0) > 0).length;
    const lossCount = closed.filter((p) => (p.net_pnl ?? 0) < 0).length;
    const breakEvenCount = closed.length - winCount - lossCount;

    // Dynamic SOL formatting: show enough decimals for small values
    function fmtSol(v) {
      const a = Math.abs(v);
      if (a < 0.0001) return 0;
      if (a < 0.01) return +v.toFixed(4);
      if (a < 1) return +v.toFixed(3);
      return +v.toFixed(2);
    }

    res.json({
      wallet,
      summary: {
        open_count: open.length,
        closed_count: closed.length,
        total_deployed_sol: +totalDeployed.toFixed(2),
        open_deployed_sol: +openDeployed.toFixed(2),
        closed_deployed_sol: +closedDeployed.toFixed(2),
        total_pnl_sol: fmtSol(totalPnl),
        total_fees_sol: fmtSol(totalFees),
        win_rate: (winCount + lossCount) > 0 ? +((winCount / (winCount + lossCount)) * 100).toFixed(1) : 0,
        wins: winCount,
        losses: lossCount,
        break_even: breakEvenCount,
      },
      config: {
        stopLossPct: config.management?.stopLossPct ?? null,
        takeProfitPct: config.management?.takeProfitPct ?? null,
        trailingTakeProfit: config.management?.trailingTakeProfit ?? null,
        trailingTriggerPct: config.management?.trailingTriggerPct ?? null,
        trailingDropPct: config.management?.trailingDropPct ?? null,
        outOfRangeWaitMinutes: config.management?.outOfRangeWaitMinutes ?? null,
        strategy: config.strategy?.strategy ?? null,
        minBinsBelow: config.strategy?.minBinsBelow ?? null,
        maxBinsBelow: config.strategy?.maxBinsBelow ?? null,
        minBinStep: config.screening?.minBinStep ?? null,
        maxBinStep: config.screening?.maxBinStep ?? null,
        deployAmountSol: config.management?.deployAmountSol ?? null,
        positionSizePct: config.management?.positionSizePct ?? null,
        gasReserve: config.management?.gasReserve ?? null,
        maxDeployAmount: config.risk?.maxDeployAmount ?? null,
        minFeePerTvl24h: config.management?.minFeePerTvl24h ?? null,
        virtualMode: config.virtual?.mode ?? false,
      },
      open,
      closed,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Bin weight recomputation (stored weights may be stale from older code) ──
function rebuildWeights(strategy, lowerBinId, upperBinId) {
  if (strategy !== "bid_ask" && strategy !== "curve") return null; // spot = uniform
  const n = upperBinId - lowerBinId + 1;
  if (n <= 0 || n > 500) return null;
  const center = Math.floor(n / 2);
  const sigma = Math.max(n / 4, 1);
  const w = Array.from({ length: n }, (_, i) => {
    const d = i - center;
    if (strategy === "curve")   return Math.exp(-0.5 * (d / sigma) ** 2);
    if (strategy === "bid_ask") return 1 - Math.exp(-0.5 * (d / sigma) ** 2) + 0.01;
    return 1;
  });
  const total = w.reduce((s, v) => s + v, 0);
  return w.map((v) => v / total);
}

function enrich(paperPos, trackedMap, status) {
  const t = trackedMap[paperPos.id];
  const outSince = t?.out_of_range_since
    ? Math.floor((Date.now() - new Date(t.out_of_range_since).getTime()) / 60000)
    : null;

  return {
    id: paperPos.id,
    pool: paperPos.pool,
    pair: paperPos.pair,
    status: paperPos.status,
    strategy: paperPos.strategy || t?.strategy || null,
    deposit: paperPos.deposit,
    net_pnl: paperPos.net_pnl,
    pnl_pct: paperPos.deposit > 0 ? +((paperPos.net_pnl / paperPos.deposit) * 100).toFixed(2) : 0,
    fees_earned: paperPos.fees_earned || 0,
    in_range: paperPos.last_price != null && paperPos.range?.lower != null && paperPos.range?.upper != null
      ? paperPos.last_price >= paperPos.range.lower && paperPos.last_price <= paperPos.range.upper
      : (t ? !t.out_of_range_since : (paperPos.in_range_pct != null ? paperPos.in_range_pct > 0 : true)),
    in_range_pct: paperPos.in_range_pct,
    minutes_out_of_range: outSince,
    range_lower: paperPos.range?.lower || null,
    range_upper: paperPos.range?.upper || null,
    entry_price: paperPos.entry_price || null,
    last_price: paperPos.last_price || null,
    annualized_fee_apr: paperPos.annualized_fee_apr || null,
    il_usd: paperPos.il_usd || 0,
    opened_at: paperPos.opened_at,
    closed_at: paperPos.closed_at || null,
    duration_hours: paperPos.duration_hours || null,
    candles_total: paperPos.candles_total || 0,
    peak_pnl_pct: t?.peak_pnl_pct ?? null,
    trailing_active: t?.trailing_active ?? false,
    out_of_range_since: t?.out_of_range_since || null,
    pool_address: paperPos.pool_address || null,
    token_mint: (paperPos.pair?.split("-")[0] && (TOKEN_MINTS[paperPos.pair.split("-")[0].toUpperCase()] || null)) || null,
    chart_token: paperPos.pair?.split("-")[0] || null,
    close_reason: (() => {
      const r = paperPos.close_reason;
      if (r) return r;
      const note = t?.notes?.[t.notes.length - 1];
      if (note) {
        // Strip "Closed at <timestamp>: " prefix if present
        const m = note.match(/^Closed at .+: (.+)$/);
        return m ? m[1] : note;
      }
      return null;
    })(),
    // bin distribution for chart overlay — recompute weights from strategy+bin_ids
    bin_volumes: paperPos.deposit > 0 && paperPos.lower_bin_id != null && paperPos.upper_bin_id != null
      ? (() => {
          const w = paperPos.strategy === "bid_ask" || paperPos.strategy === "curve"
            ? rebuildWeights(paperPos.strategy, paperPos.lower_bin_id, paperPos.upper_bin_id)
            : null;
          const weights = w ?? (paperPos.weights?.length > 0 ? paperPos.weights : null);
          if (!weights) return null;
          return weights.map(w => +(paperPos.deposit * w).toFixed(6));
        })()
      : null,
    bin_step: paperPos.bin_step ?? null,
    lower_bin_id: paperPos.lower_bin_id ?? null,
    upper_bin_id: paperPos.upper_bin_id ?? null,
  };
}

createServer(app).listen(PORT, () => {
  log("webui", `🌐 WebUI running at http://localhost:${PORT}`);
});
