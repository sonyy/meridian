import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { log } from "../logger.js";
import { config } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.WEBUI_PORT || 3031;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Token mint address lookup (symbol → mint) ──────────────────────────
const TOKEN_MINTS = {
  PARQ: "VtwGKv7dcpY7aFb8H7MvZfEtUAKwtsHcXSkejCAparq",
  BOUNTYWORK: "J4x1EMmQjF6WEzXq2tUtzY89x5aMhYz5CzfevcJEpump",
  POKE: "FADNLNo4xc8ot3bcgbHFQuuSKg93jKfpR8pcCR76pump",
};
// lowercase alias
for (const [k, v] of Object.entries(TOKEN_MINTS)) {
  TOKEN_MINTS[k.toLowerCase()] = v;
}

// ── Earliest deploy time (1h before first position) ────────────────────
const DEPLOY_START = new Date("2026-06-10T04:00:00.000Z"); // 1h before first deploy

async function fetchKlineAll(mint, fromTs, toTs) {
  const WINDOW = 500 * 60;
  const all = [];
  let cur = fromTs;
  while (cur < toTs) {
    const end = Math.min(cur + WINDOW, toTs);
    const raw = execSync(
      `gmgn-cli market kline --chain sol --address ${mint} --resolution 5m --from ${cur} --to ${end} --raw 2>/dev/null`,
      { timeout: 15000, encoding: "utf8" }
    ).trim();
    let chunk;
    try { chunk = JSON.parse(raw); } catch { chunk = []; }
    const list = Array.isArray(chunk) ? chunk : (chunk.list || []);
    all.push(...list);
    if (list.length === 0) break;
    const last = Number(list[list.length - 1].time || list[list.length - 1].t);
    cur = Math.max(cur + 1, Math.floor(last / 1000));
  }
  return all;
}

app.get("/api/kline/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const mint = TOKEN_MINTS[symbol] || TOKEN_MINTS[symbol.toLowerCase()];
    if (!mint) return res.status(404).json({ error: `Unknown token: ${symbol}` });

    let fromTs = Math.floor(DEPLOY_START.getTime() / 1000);
    if (req.query.position) {
      const paperMod = await import("../paper-positions.js");
      const allPaper = paperMod.listPaperPositions();
      const pos = allPaper.find(p => p.id === req.query.position || p.position === req.query.position);
      if (pos && pos.opened_at) {
        fromTs = Math.floor((new Date(pos.opened_at).getTime() - 3600000) / 1000);
      }
    }
    if (req.query.from) fromTs = parseInt(req.query.from, 10);
    const toTs = req.query.to ? parseInt(req.query.to, 10) : Math.floor(Date.now() / 1000);

    const candles = await fetchKlineAll(mint, fromTs, toTs);
    res.json({ symbol, mint, from: fromTs, to: toTs, candles: candles });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
    const tracked = stateMod.getTrackedPositions();
    const wallet = virtualMod.getVirtualWalletBalances();

    const open = allPaper
      .filter((p) => p.status === "open")
      .map((p) => enrich(p, tracked, "open"));

    const closed = allPaper
      .filter((p) => p.status === "closed")
      .map((p) => enrich(p, tracked, "closed"));

    const totalPnl = closed.reduce((s, p) => s + (p.net_pnl || 0), 0);
    const totalFees = closed.reduce((s, p) => s + (p.fees_earned || 0), 0);
    const totalDeployed = open.reduce((s, p) => s + (p.deposit || 0), 0);
    const winCount = closed.filter((p) => (p.net_pnl || 0) > 0).length;
    const lossCount = closed.filter((p) => (p.net_pnl || 0) <= 0).length;

    res.json({
      wallet,
      summary: {
        open_count: open.length,
        closed_count: closed.length,
        total_deployed_sol: +totalDeployed.toFixed(2),
        total_pnl_sol: +totalPnl.toFixed(2),
        total_fees_sol: +totalFees.toFixed(2),
        win_rate: closed.length > 0 ? +((winCount / closed.length) * 100).toFixed(1) : 0,
        wins: winCount,
        losses: lossCount,
      },
      config: {
        stopLossPct: config.management?.stopLossPct ?? null,
        takeProfitPct: config.management?.takeProfitPct ?? null,
        trailingTakeProfit: config.management?.trailingTakeProfit ?? null,
        trailingTriggerPct: config.management?.trailingTriggerPct ?? null,
        trailingDropPct: config.management?.trailingDropPct ?? null,
        outOfRangeWaitMinutes: config.management?.outOfRangeWaitMinutes ?? null,
        strategy: config.strategy?.strategy ?? null,
        deployAmountSol: config.management?.deployAmountSol ?? null,
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
    in_range: paperPos.in_range_pct != null ? paperPos.in_range_pct > 0 : true,
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
    chart_token: paperPos.pair?.split("-")[0] || null,
  };
}

createServer(app).listen(PORT, () => {
  log("webui", `🌐 WebUI running at http://localhost:${PORT}`);
});
