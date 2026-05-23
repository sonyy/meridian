import "./envcrypt.js";
import cron from "node-cron";
import readline from "readline";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions, closePosition, getActiveBin } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { evolveThresholds, getPerformanceSummary } from "./lessons.js";
import { executeTool, registerCronRestarter } from "./tools/executor.js";
import {
  startPolling,
  stopPolling,
  sendMessage,
  sendMessageWithButtons,
  sendHTML,
  sendHTMLWithButtons,
  editMessage,
  editMessageWithButtons,
  editHTMLWithButtons,
  answerCallbackQuery,
  notifyOutOfRange,
  notifyScreeningSummary,
  notifyDeployResult,
  isEnabled as telegramEnabled,
  createLiveMessage,
} from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, getTrackedPositions, setPositionInstruction, updatePnlAndCheckExits, queuePeakConfirmation, resolvePendingPeak, queueTrailingDropConfirmation, resolvePendingTrailingDrop } from "./state.js";
import { getActiveStrategy } from "./strategy-library.js";
import { recordPositionSnapshot, recallForPool, addPoolNote } from "./pool-memory.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "./tools/token.js";
import { stageSignals } from "./signal-tracker.js";
import { getWeightsSummary } from "./signal-weights.js";
import { bootstrapHiveMind, ensureAgentId, getHiveMindPullMode, isHiveMindEnabled, pullHiveMindLessons, pullHiveMindPresets, registerHiveMindAgent, startHiveMindBackgroundSync } from "./hivemind.js";
import { appendDecision } from "./decision-log.js";

const entrypointPath = process.env.pm_exec_path || process.argv[1];
const isMain = entrypointPath
  ? path.resolve(entrypointPath) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  log("startup", "DLMM LP Agent starting...");
  log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
  log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);
  ensureAgentId();
  bootstrapHiveMind().catch((error) => log("hivemind_warn", `Bootstrap failed: ${error.message}`));
  startHiveMindBackgroundSync();
}

const TP_PCT = config.management.takeProfitPct;
const DEPLOY = config.management.deployAmountSol;

// Maps chatId -> { amount } for multi-step deploy flow via Telegram buttons
const _pendingDeployAmount = new Map();  // chatId -> amount (for multi-step deploy flow)
const _pendingCustomAmount = new Map();  // chatId -> true (waiting for user to type custom amount)
const _pendingCustomSetting = new Map(); // chatId -> settingKey (waiting for user to type setting value)
let _notifyManagement = true;
let _notifyScreening = true;

// Load persisted notification flags from state.json
function loadNotifFlags() {
  try {
    if (existsSync("./state.json")) {
      const state = JSON.parse(readFileSync("./state.json", "utf8"));
      if (typeof state._notifyManagement === "boolean") _notifyManagement = state._notifyManagement;
      if (typeof state._notifyScreening === "boolean") _notifyScreening = state._notifyScreening;
    }
  } catch (e) {}
}
function saveNotifFlags() {
  try {
    const state = JSON.parse(readFileSync("./state.json", "utf8"));
    state._notifyManagement = _notifyManagement;
    state._notifyScreening = _notifyScreening;
    writeFileSync("./state.json", JSON.stringify(state, null, 2));
  } catch (e) {}
}
loadNotifFlags();

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
let _managementBusy = false; // prevents overlapping management cycles
let _screeningBusy = false;  // prevents overlapping screening cycles
let _screeningLastTriggered = 0; // epoch ms — prevents management from spamming screening
let _pollTriggeredAt = 0; // epoch ms — cooldown for poller-triggered management
const _peakConfirmTimers = new Map();
const _trailingDropConfirmTimers = new Map();
const TRAILING_PEAK_CONFIRM_DELAY_MS = 15_000;
const TRAILING_PEAK_CONFIRM_TOLERANCE = 0.85;
const TRAILING_DROP_CONFIRM_DELAY_MS = 15_000;
const TRAILING_DROP_CONFIRM_TOLERANCE_PCT = 1.0;

/** Strip <think>...</think> reasoning blocks that some models leak into output */
function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function sanitizeUntrustedPromptText(text, maxLen = 500) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned ? JSON.stringify(cleaned) : null;
}

function shouldUsePnlRecheck() {
  return !config.api.lpAgentRelayEnabled;
}

function schedulePeakConfirmation(positionAddress) {
  if (!positionAddress || _peakConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _peakConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      resolvePendingPeak(positionAddress, position?.pnl_pct ?? null, TRAILING_PEAK_CONFIRM_TOLERANCE);
    } catch (error) {
      log("state_warn", `Peak confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_PEAK_CONFIRM_DELAY_MS);

  _peakConfirmTimers.set(positionAddress, timer);
}

function scheduleTrailingDropConfirmation(positionAddress) {
  if (!positionAddress || _trailingDropConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _trailingDropConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      const resolved = resolvePendingTrailingDrop(
        positionAddress,
        position?.pnl_pct ?? null,
        config.management.trailingDropPct,
        TRAILING_DROP_CONFIRM_TOLERANCE_PCT,
      );
      if (resolved?.confirmed) {
        log("state", `[Trailing recheck] Confirmed trailing exit for ${positionAddress} — triggering management`);
        runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Trailing recheck management failed: ${e.message}`));
      }
    } catch (error) {
      log("state_warn", `Trailing drop confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_DROP_CONFIRM_DELAY_MS);

  _trailingDropConfirmTimers.set(positionAddress, timer);
}

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  _cronTasks = [];
}

export async function runManagementCycle({ silent = false } = {}) {
  if (_managementBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");
  let mgmtReport = null;
  let positions = [];
  let liveMessage = null;
  const screeningCooldownMs = 5 * 60 * 1000;

  try {
    if (!silent && telegramEnabled() && _notifyManagement) {
      liveMessage = await createLiveMessage("🔄 Management Cycle", "Evaluating positions...");
    }
    const livePositions = await getMyPositions({ force: true }).catch(() => null);
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      log("cron", "No open positions — triggering screening cycle");
      mgmtReport = "No open positions. Triggering screening cycle.";
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      return mgmtReport;
    }

    // Snapshot + load pool memory
    const positionData = positions.map((p) => {
      recordPositionSnapshot(p.pool, p);
      return { ...p, recall: recallForPool(p.pool) };
    });

    // JS trailing TP check
    const exitMap = new Map();
    for (const p of positionData) {
      if (
        !p.pnl_pct_suspicious &&
        queuePeakConfirmation(p.position, p.pnl_pct, { immediate: !shouldUsePnlRecheck() }) &&
        shouldUsePnlRecheck()
      ) {
        schedulePeakConfirmation(p.position);
      }
      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      if (exit) {
        if (exit.action === "TRAILING_TP" && exit.needs_confirmation && shouldUsePnlRecheck()) {
          if (queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, config.management.trailingDropPct)) {
            scheduleTrailingDropConfirmation(p.position);
          }
          continue;
        }
        exitMap.set(p.position, exit.reason);
        log("state", `Exit alert for ${p.pair}: ${exit.reason}`);
      }
    }

    // ── Deterministic rule checks (no LLM) ──────────────────────────
    // action: CLOSE | CLAIM | STAY | INSTRUCTION (needs LLM)
    const actionMap = new Map();
    for (const p of positionData) {
      // Hard exit — highest priority
      if (exitMap.has(p.position)) {
        actionMap.set(p.position, { action: "CLOSE", rule: "exit", reason: exitMap.get(p.position) });
        continue;
      }
      // Instruction-set — pass to LLM, can't parse in JS
      if (p.instruction) {
        actionMap.set(p.position, { action: "INSTRUCTION" });
        continue;
      }

      const closeRule = getDeterministicCloseRule(p, config.management);
      if (closeRule) {
        actionMap.set(p.position, closeRule);
        continue;
      }
      // Claim rule
      if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
        actionMap.set(p.position, { action: "CLAIM" });
        continue;
      }
      actionMap.set(p.position, { action: "STAY" });
    }

    // ── Build JS report ──────────────────────────────────────────────
    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

    const reportLines = positionData.map((p) => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range ? "🟢 IN" : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
      const val = config.management.solMode ? `◎${p.total_value_usd ?? "?"}` : `$${p.total_value_usd ?? "?"}`;
      const unclaimed = config.management.solMode ? `◎${p.unclaimed_fees_usd ?? "?"}` : `$${p.unclaimed_fees_usd ?? "?"}`;
      const statusLabel = act.action === "INSTRUCTION" ? "HOLD (instruction)" : act.action;
      let line = `**${p.pair}** | Age: ${p.age_minutes ?? "?"}m | Val: ${val} | Unclaimed: ${unclaimed} | PnL: ${p.pnl_pct ?? "?"}% | Yield: ${p.fee_per_tvl_24h ?? "?"}% | ${inRange} | ${statusLabel}`;
      if (p.instruction) line += `\nNote: "${p.instruction}"`;
      if (act.action === "CLOSE" && act.rule === "exit") line += `\n⚡ Trailing TP: ${act.reason}`;
      if (act.action === "CLOSE" && act.rule && act.rule !== "exit") line += `\nRule ${act.rule}: ${act.reason}`;
      if (act.action === "CLAIM") line += `\n→ Claiming fees`;
      return line;
    });

    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    const actionSummary = needsAction.length > 0
      ? needsAction.map(a => a.action === "INSTRUCTION" ? "EVAL instruction" : `${a.action}${a.reason ? ` (${a.reason})` : ""}`).join(", ")
      : "no action";

    const cur = config.management.solMode ? "◎" : "$";
    mgmtReport = reportLines.join("\n\n") +
      `\n\nSummary: 💼 ${positions.length} positions | ${cur}${totalValue.toFixed(4)} | fees: ${cur}${totalUnclaimed.toFixed(4)} | ${actionSummary}`;

    // ── Call LLM only if action needed ──────────────────────────────
    const actionPositions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a.action !== "STAY";
    });

    if (actionPositions.length > 0) {
      log("cron", `Management: ${actionPositions.length} action(s) needed — invoking LLM [model: ${config.llm.managementModel}]`);

      const actionBlocks = actionPositions.map((p) => {
        const act = actionMap.get(p.position);
        return [
          `POSITION: ${p.pair} (${p.position})`,
          `  pool: ${p.pool}`,
          `  action: ${act.action}${act.rule && act.rule !== "exit" ? ` — Rule ${act.rule}: ${act.reason}` : ""}${act.rule === "exit" ? ` — ⚡ Trailing TP: ${act.reason}` : ""}`,
          `  pnl_pct: ${p.pnl_pct}% | unclaimed_fees: ${cur}${p.unclaimed_fees_usd} | value: ${cur}${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
          `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
          p.instruction ? `  instruction: "${p.instruction}"` : null,
        ].filter(Boolean).join("\n");
      }).join("\n\n");

      const { content } = await agentLoop(`
MANAGEMENT ACTION REQUIRED — ${actionPositions.length} position(s)

${actionBlocks}

RULES:
- CLOSE: call close_position only — it handles fee claiming internally, do NOT call claim_fees first
- CLAIM: call claim_fees with position address
- INSTRUCTION: evaluate the instruction condition. If met → close_position. If not → HOLD, do nothing.
- ⚡ exit alerts: close immediately, no exceptions

Execute the required actions. Do NOT re-evaluate CLOSE/CLAIM — rules already applied. Just execute.
After executing, write a brief one-line result per position.
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
      });

      mgmtReport += `\n\n${content}`;
    } else {
      log("cron", "Management: all positions STAY — skipping LLM");
      await liveMessage?.note("No tool actions needed.");
    }

    // Trigger screening after management
    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    if (afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > screeningCooldownMs) {
      log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
    }
  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    if (!silent && telegramEnabled() && _notifyManagement) {
      if (mgmtReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(mgmtReport)).catch(() => {});
        else sendMessage(`🔄 Management Cycle\n\n${stripThink(mgmtReport)}`).catch(() => { });
      }
      for (const p of positions) {
        if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
          notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => { });
        }
      }
    }
  }
  return mgmtReport;
}

export async function runScreeningCycle({ silent = false } = {}) {
  if (_screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _screeningLastTriggered = Date.now();

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  let liveMessage = null;
  let screenReport = null;
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      screenReport = `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions}).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`,
      });
      if (!silent && telegramEnabled() && _notifyScreening) {
        notifyScreeningSummary({ totalScreened: 0, passingCount: 0, finalDecision: "skipped" });
      }
      _screeningBusy = false;
      return screenReport;
    }
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    const isDryRun = process.env.DRY_RUN === "true";
    if (!isDryRun && preBalance.sol < minRequired) {
      log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      screenReport = `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired})`,
      });
      if (!silent && telegramEnabled() && _notifyScreening) {
        notifyScreeningSummary({ totalScreened: 0, passingCount: 0, finalDecision: "skipped" });
      }
      _screeningBusy = false;
      return screenReport;
    }
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    screenReport = `Screening pre-check failed: ${e.message}`;
    if (!silent && telegramEnabled() && _notifyScreening) {
      notifyDeployResult({ type: "skipped", reason: `Pre-check failed: ${e.message}` }).catch(() => {});
    }
    _screeningBusy = false;
    return screenReport;
  }
  if (!silent && telegramEnabled() && _notifyScreening) {
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
  }
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
  try {
    // Reuse pre-fetched balance — no extra RPC call needed
    const currentBalance = preBalance;
    const deployAmount = computeDeployAmount(currentBalance.sol);
    log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

    // Load active strategy
    const activeStrategy = getActiveStrategy();
    const strategyBlock = activeStrategy
      ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy} | bins_above: ${activeStrategy.range?.bins_above ?? 0} (FIXED — never change) | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for}`
      : `No active strategy — use default bid_ask, bins_above: 0, SOL only.`;

    // Fetch top candidates, then recon each sequentially with a small delay to avoid 429s
    const topCandidates = await getTopCandidates({ limit: 10 }).catch(() => null);
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);
    const earlyFilteredExamples = topCandidates?.filtered_examples || [];

    const allCandidates = [];
    for (const pool of candidates) {
      const mint = pool.base?.mint;
      const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
        mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
        mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
      ]);
      allCandidates.push({
        pool,
        sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
        n: narrative.status === "fulfilled" ? narrative.value : null,
        ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
        mem: recallForPool(pool.pool),
      });
      await new Promise(r => setTimeout(r, 150)); // avoid 429s
    }

    // Hard filters after token recon — block launchpads and excessive Jupiter bot holders
    const filteredOut = [];
    const passing = allCandidates.filter(({ pool, ti }) => {
      const launchpad = ti?.launchpad ?? null;
      if (launchpad && config.screening.allowedLaunchpads?.length > 0 && !config.screening.allowedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — launchpad ${launchpad} not in allow-list`);
        filteredOut.push({ name: pool.name, reason: `launchpad ${launchpad} not in allow-list` });
        return false;
      }
      if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — blocked launchpad (${launchpad})`);
        filteredOut.push({ name: pool.name, reason: `blocked launchpad (${launchpad})` });
        return false;
      }
      const botPct = ti?.audit?.bot_holders_pct;
      const maxBotHoldersPct = config.screening.maxBotHoldersPct;
      if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
        log("screening", `Bot-holder filter: dropped ${pool.name} — bots ${botPct}% > ${maxBotHoldersPct}%`);
        filteredOut.push({ name: pool.name, reason: `bot holders ${botPct}% > ${maxBotHoldersPct}%` });
        return false;
      }
      return true;
    });

    if (passing.length === 0) {
      const combined = filteredOut.length > 0 ? filteredOut : earlyFilteredExamples;
      const combinedExamples = combined.slice(0, 3)
        .map((entry) => `- ${entry.name}: ${entry.reason}`)
        .join("\n");
      screenReport = combinedExamples
        ? `No candidates available.\nFiltered examples:\n${combinedExamples}`
        : `No candidates available (all filtered by launchpad / holder-quality rules).`;
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "No candidates available",
        reason: combinedExamples || "All candidates filtered before deploy",
        rejected: combined.slice(0, 5).map((entry) => `${entry.name}: ${entry.reason}`),
      });
      if (!silent && telegramEnabled() && _notifyScreening) {
        notifyScreeningSummary({
          totalScreened: topCandidates?.total_screened ?? candidates.length,
          filteredExamples: earlyFilteredExamples,
          additionalFiltered: filteredOut,
          passingCount: 0,
          finalDecision: "no_deploy",
        });
      }
      return screenReport;
    }

    if (passing.length === 1) {
      const skipReason = getLoneCandidateSkipReason(passing[0]);
      if (skipReason) {
        const candidateName = passing[0].pool?.name || "unknown";
        screenReport = [
          "⛔ NO DEPLOY",
          "",
          "Cycle finished with no valid entry.",
          "",
          "BEST LOOKING CANDIDATE",
          candidateName,
          "",
          "WHY SKIPPED",
          `Only one candidate survived filtering, but it was not worth deploying: ${skipReason}.`,
          "",
          "REJECTED",
          `- ${candidateName}: ${skipReason}`,
        ].join("\n");
        appendDecision({
          type: "no_deploy",
          actor: "SCREENER",
          summary: "Single candidate skipped",
          reason: skipReason,
          pool: passing[0].pool?.pool,
          pool_name: candidateName,
        });
        if (!silent && telegramEnabled() && _notifyScreening) {
          notifyScreeningSummary({
            totalScreened: topCandidates?.total_screened ?? candidates.length,
            filteredExamples: earlyFilteredExamples,
            additionalFiltered: filteredOut,
            passingCount: 1,
            finalDecision: "no_deploy",
          });
        }
        return screenReport;
      }
    }

    // Pre-fetch active_bin for all passing candidates in parallel
    const activeBinResults = await Promise.allSettled(
      passing.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
    );

    // Build compact candidate blocks
    const candidateBlocks = passing.map(({ pool, sw, n, ti, mem }, i) => {
      const botPct = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct = ti?.audit?.top_holders_pct ?? "?";
      const feesSol = ti?.global_fees_sol ?? "?";
      const launchpad = ti?.launchpad ?? null;
      const priceChange = ti?.stats_1h?.price_change;
      const netBuyers = ti?.stats_1h?.net_buyers;
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;

      // OKX signals
      const okxParts = [
        pool.risk_level     != null ? `risk=${pool.risk_level}`               : null,
        pool.bundle_pct     != null ? `bundle=${pool.bundle_pct}%`            : null,
        pool.sniper_pct     != null ? `sniper=${pool.sniper_pct}%`            : null,
        pool.suspicious_pct != null ? `suspicious=${pool.suspicious_pct}%`    : null,
        pool.new_wallet_pct != null ? `new_wallets=${pool.new_wallet_pct}%`   : null,
        pool.is_rugpull != null ? `rugpull=${pool.is_rugpull ? "YES" : "NO"}` : null,
        pool.is_wash != null ? `wash=${pool.is_wash ? "YES" : "NO"}` : null,
      ].filter(Boolean).join(", ");
      const okxUnavailable = !okxParts && pool.price_vs_ath_pct == null;

      const okxTags = [
        pool.smart_money_buy    ? "smart_money_buy"    : null,
        pool.kol_in_clusters    ? "kol_in_clusters"    : null,
        pool.dex_boost          ? "dex_boost"          : null,
        pool.dex_screener_paid  ? "dex_screener_paid"  : null,
        pool.dev_sold_all       ? "dev_sold_all(bullish)" : null,
      ].filter(Boolean).join(", ");
      const pvpLine = pool.is_pvp
        ? `  pvp: HIGH — rival ${pool.pvp_rival_name || pool.pvp_symbol} (${pool.pvp_rival_mint?.slice(0, 8)}...) has pool ${pool.pvp_rival_pool?.slice(0, 8)}..., tvl=$${pool.pvp_rival_tvl}, holders=${pool.pvp_rival_holders}, fees=${pool.pvp_rival_fees}SOL`
        : null;

      const block = [
        `POOL: ${pool.name} (${pool.pool})`,
        `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.tvl ?? pool.active_tvl}, volatility_${pool.volatility_timeframe || "30m"}=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}`,
        `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
        pvpLine,
        okxParts ? `  okx: ${okxParts}` : okxUnavailable ? `  okx: unavailable` : null,
        okxTags  ? `  tags: ${okxTags}` : null,
        pool.price_vs_ath_pct != null ? `  ath: price_vs_ath=${pool.price_vs_ath_pct}%${pool.top_cluster_trend ? `, top_cluster=${pool.top_cluster_trend}` : ""}` : null,
        `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
        activeBin != null ? `  active_bin: ${activeBin}` : null,
        priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
        n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
        mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
      ].filter(Boolean).join("\n");

      // Stage signals for Darwinian weighting — captured before LLM decides
      if (config.darwin?.enabled) {
        const baseMint = pool.base?.mint || pool.base_mint || ti?.mint || null;
        stageSignals(pool.pool, {
          base_mint:             baseMint,
          organic_score:         pool.organic_score         ?? null,
          fee_tvl_ratio:         pool.fee_active_tvl_ratio  ?? null,
          volume:                pool.volume_window         ?? null,
          mcap:                  pool.mcap                  ?? null,
          holder_count:          ti?.holders                ?? null,
          smart_wallets_present: (sw?.in_pool?.length ?? 0) > 0,
          narrative_quality:     n?.narrative ? "present" : "absent",
          volatility:            pool.volatility            ?? null,
        });
      }

      return block;
    });

    const weightsSummary = config.darwin?.enabled ? getWeightsSummary() : null;

    let deployAttempted = false;
    let deploySucceeded = false;

    const bestFeeTvl = Math.max(...passing.map(p => p.pool.fee_active_tvl_ratio ?? 0));
    const bestVol = Math.max(...passing.map(p => p.pool.volume_window ?? 0));
    const bestOrganic = Math.max(...passing.map(p => p.pool.organic_score ?? 0));
    const comparisonHeader = passing.length > 1
      ? `CANDIDATE COMPARISON — best fee_tvl=${bestFeeTvl}%, best vol=$${bestVol}, best organic=${bestOrganic}\nPick the candidate with the best balance of fee_tvl_ratio, volume, and bin_step suited to its volatility.\n`
      : "";

    const { content } = await agentLoop(`
SCREENING CYCLE
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL

PRE-LOADED CANDIDATES (${passing.length} pools):
${comparisonHeader}${candidateBlocks.join("\n\n")}

STEPS:
1. Decide if any candidate is actually worth deploying. One surviving candidate is not automatically good enough.
2. Pick the best candidate based on narrative quality, smart wallets, and pool metrics.
3. Call deploy_position (active_bin is pre-fetched above — no need to call get_active_bin).
   bins_below = round(${config.strategy.minBinsBelow} + (candidate volatility/5)*(${config.strategy.maxBinsBelow - config.strategy.minBinsBelow})) clamped to [${config.strategy.minBinsBelow},${config.strategy.maxBinsBelow}].
   pass deploy_position.volatility = the candidate volatility value.
   For single-side SOL deploys, do not invent upside:
   set amount_y only, keep amount_x = 0, keep bins_above = 0, and let the upper bin stay at the active bin.
4. Report in this exact format (no tables, no extra sections):
   🚀 DEPLOYED

   <pool name>
   <pool address>

   ◎ <deploy amount> SOL | <strategy> | bin <active_bin>
   Range: <minPrice> → <maxPrice>
   Range cover: <downside %> downside | <upside %> upside | <total width %> total

   IMPORTANT:
   - Do NOT calculate the range percentages yourself.
   - Use the actual deploy_position tool result:
     range_coverage.downside_pct
     range_coverage.upside_pct
     range_coverage.width_pct

   MARKET
   Fee/TVL: <x>%
   Volume: $<x>
   TVL: $<x>
   Volatility: <x>
   Organic: <x>
   Mcap: $<x>
   Age: <x>h

   AUDIT
   Top10: <x>%
   Bots: <x>%
   Fees paid: <x> SOL
   Smart wallets: <names or none>

   RISK
   <If OKX advanced/risk data exists, list only the fields that actually exist: Risk level, Bundle, Sniper, Suspicious, ATH distance, Rugpull, Wash.>
   <If only rugpull/wash exist, list just those.>
   <If OKX enrichment is missing, write exactly: OKX: unavailable>

   WHY THIS WON
   <2-4 concise sentences on why this pool won, key risks, and why it still beat the alternatives>
5. If no pool qualifies, report in this exact format instead:
   ⛔ NO DEPLOY

   Cycle finished with no valid entry.

   BEST LOOKING CANDIDATE
   <name or none>

   WHY SKIPPED
   <2-4 concise sentences explaining why nothing was good enough>

   REJECTED
   <short flat list of top candidate names and why they were skipped>
IMPORTANT:
- Never write "unknown" for OKX. Use real values, omit missing fields, or write exactly "OKX: unavailable".
- Keep the whole report compact and highly scannable for Telegram.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048, {
        onToolStart: async ({ name }) => {
          if (name === "deploy_position") deployAttempted = true;
          await liveMessage?.toolStart(name);
        },
        onToolFinish: async ({ name, result, success }) => {
          if (name === "deploy_position") {
            deployAttempted = true;
            deploySucceeded = Boolean(success && result?.success !== false && !result?.error && !result?.blocked);
          }
          await liveMessage?.toolFinish(name, result, success);
        },
      });
    screenReport = content;
    const isNoDeploy = /⛔\s*NO DEPLOY/i.test(content);
    if (isNoDeploy) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "LLM chose no deploy",
        reason: stripThink(content).slice(0, 500),
      });
    } else if (!deploySucceeded) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: deployAttempted ? "Deploy attempt did not succeed" : "No successful deploy in screening cycle",
        reason: stripThink(content).slice(0, 500),
      });
    }
    if (!silent && telegramEnabled() && _notifyScreening && (isNoDeploy || !deploySucceeded)) {
      notifyScreeningSummary({
        totalScreened: topCandidates?.total_screened ?? candidates.length,
        filteredExamples: earlyFilteredExamples,
        additionalFiltered: filteredOut,
        passingCount: passing.length,
        finalDecision: "no_deploy",
      });
    }
  } catch (error) {
    log("cron_error", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    _screeningBusy = false;
    if (!silent && telegramEnabled() && _notifyScreening) {
      if (screenReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(screenReport)).catch(() => {});
        else sendMessage(`🔍 Screening Cycle\n\n${stripThink(screenReport)}`).catch(() => { });
      }
    }
  }
  return screenReport;
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy) return;
    timers.managementLastRun = Date.now();
    await runManagementCycle();
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, runScreeningCycle);

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check");
    try {
      await agentLoop(`
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `, config.llm.maxSteps, [], "MANAGER");
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      _managementBusy = false;
    }
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  // Lightweight 30s PnL poller — updates trailing TP state between management cycles, no LLM
  let _pnlPollBusy = false;
  const pnlPollInterval = setInterval(async () => {
    if (_managementBusy || _screeningBusy || _pnlPollBusy) return;
    if (getTrackedPositions(true).length === 0) return;
    _pnlPollBusy = true;
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!result?.positions?.length) return;
      for (const p of result.positions) {
        if (
          !p.pnl_pct_suspicious &&
          queuePeakConfirmation(p.position, p.pnl_pct, { immediate: !shouldUsePnlRecheck() }) &&
          shouldUsePnlRecheck()
        ) {
          schedulePeakConfirmation(p.position);
        }
        const exit = updatePnlAndCheckExits(p.position, p, config.management);
        if (exit) {
          if (exit.action === "TRAILING_TP" && exit.needs_confirmation && shouldUsePnlRecheck()) {
            if (queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, config.management.trailingDropPct)) {
              scheduleTrailingDropConfirmation(p.position);
            }
            continue;
          }
          const cooldownMs = config.schedule.managementIntervalMin * 60 * 1000;
          const sinceLastTrigger = Date.now() - _pollTriggeredAt;
          if (sinceLastTrigger >= cooldownMs) {
            _pollTriggeredAt = Date.now();
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — triggering management`);
            runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Poll-triggered management failed: ${e.message}`));
          } else {
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — cooldown (${Math.round((cooldownMs - sinceLastTrigger) / 1000)}s left)`);
          }
          break;
        }
        const closeRule = getDeterministicCloseRule(p, config.management);
        if (closeRule) {
          const cooldownMs = config.schedule.managementIntervalMin * 60 * 1000;
          const sinceLastTrigger = Date.now() - _pollTriggeredAt;
          if (sinceLastTrigger >= cooldownMs) {
            _pollTriggeredAt = Date.now();
            log("state", `[PnL poll] Deterministic close rule: ${p.pair} — Rule ${closeRule.rule}: ${closeRule.reason} — triggering management`);
            runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Poll-triggered management failed: ${e.message}`));
          } else {
            log("state", `[PnL poll] Deterministic close rule: ${p.pair} — Rule ${closeRule.rule}: ${closeRule.reason} — cooldown (${Math.round((cooldownMs - sinceLastTrigger) / 1000)}s left)`);
          }
          break;
        }
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, 30_000);

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog];
  // Store interval ref so stopCronJobs can clear it
  _cronTasks._pnlPollInterval = pnlPollInterval;
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
let _shuttingDown = false;

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function shutdown(signal) {
  if (_shuttingDown) {
    log("shutdown", `Received ${signal} while shutdown is already in progress.`);
    return;
  }
  _shuttingDown = true;

  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  stopCronJobs();

  const positions = await withTimeout(
    getMyPositions({ force: true, silent: true }).catch((error) => {
      log("shutdown", `Position snapshot failed during shutdown: ${error.message}`);
      return null;
    }),
    5000
  );
  if (positions) {
    log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  } else {
    log("shutdown", "Open position snapshot skipped during shutdown timeout");
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const bs = ` ${p.bin_step ?? "?"}bps`.padStart(8);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}${bs}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  step  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(72),
    ...lines,
  ].join("\n");
}

function getDeterministicCloseRule(position, managementConfig) {
  const tracked = getTrackedPosition(position.position);
  const pnlSuspect = (() => {
    if (position.pnl_pct == null) return false;
    if (position.pnl_pct > -90) return false;
    if (tracked?.amount_sol && (position.total_value_usd ?? 0) > 0.01) {
      log("cron_warn", `Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has value — skipping PnL rules`);
      return true;
    }
    return false;
  })();

  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct <= managementConfig.stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }
  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct >= managementConfig.takeProfitPct) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin + managementConfig.outOfRangeBinsToClose
  ) {
    return { action: "CLOSE", rule: 3, reason: "pumped far above range" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin &&
    (position.minutes_out_of_range ?? 0) >= managementConfig.outOfRangeWaitMinutes
  ) {
    return { action: "CLOSE", rule: 4, reason: "OOR" };
  }
  if (
    position.fee_per_tvl_24h != null &&
    position.fee_per_tvl_24h < managementConfig.minFeePerTvl24h &&
    (position.age_minutes ?? 0) >= 60
  ) {
    return { action: "CLOSE", rule: 5, reason: "low yield" };
  }
  return null;
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const _telegramQueue = []; // queued messages received while agent was busy
const sessionHistory = []; // persists conversation across REPL turns
const MAX_HISTORY = 20;    // keep last 20 messages (10 exchanges)
let _ttyInterface = null;
let _latestCandidates = [];
let _latestCandidatesAt = null;

function setLatestCandidates(candidates = []) {
  _latestCandidates = Array.isArray(candidates) ? candidates : [];
  _latestCandidatesAt = new Date().toISOString();
}

function getLatestCandidatesMeta() {
  return {
    candidates: _latestCandidates,
    count: _latestCandidates.length,
    updatedAt: _latestCandidatesAt,
  };
}

function describeLatestCandidates(limit = 5) {
  if (!_latestCandidates.length) return "No cached candidates yet. Run /screen first.";
  const lines = _latestCandidates.slice(0, limit).map((pool, i) => {
    const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
    const vol = pool.volume_window ?? pool.volume_24h ?? "?";
    const active = pool.active_pct ?? "?";
    const organic = pool.organic_score ?? "?";
    return `${i + 1}. ${pool.name} | fee/aTVL ${feeTvl}% | vol $${vol} | in-range ${active}% | organic ${organic}`;
  });
  const age = _latestCandidatesAt ? new Date(_latestCandidatesAt).toLocaleString("en-US", { hour12: false }) : "unknown";
  return `Latest candidates (${_latestCandidates.length}) — updated ${age}\n\n${lines.join("\n")}`;
}

function formatWalletStatus(wallet, positions) {
  const deployAmount = computeDeployAmount(wallet.sol);
  const hive = isHiveMindEnabled() ? "on" : "off";
  return [
    `Wallet: ${wallet.sol} SOL ($${wallet.sol_usd})`,
    `SOL price: $${wallet.sol_price}`,
    `Open positions: ${positions.total_positions}/${config.risk.maxPositions}`,
    `Next deploy amount: ${deployAmount} SOL`,
    `Dry run: ${process.env.DRY_RUN === "true" ? "yes" : "no"}`,
    `HiveMind: ${hive}`,
  ].join("\n");
}

function formatConfigSnapshot() {
  return [
    "Config snapshot",
    "",
    `Strategy: ${config.strategy.strategy} | binsBelow: ${config.strategy.minBinsBelow}-${config.strategy.maxBinsBelow} | default ${config.strategy.defaultBinsBelow}`,
    `Deploy: ${config.management.deployAmountSol} SOL | gasReserve: ${config.management.gasReserve} | maxPositions: ${config.risk.maxPositions}`,
    `Stop loss: ${config.management.stopLossPct}% | take profit: ${config.management.takeProfitPct}%`,
    `Trailing: ${config.management.trailingTakeProfit ? "on" : "off"} | trigger ${config.management.trailingTriggerPct}% | drop ${config.management.trailingDropPct}%`,
    `OOR: ${config.management.outOfRangeWaitMinutes}m | cooldown ${config.management.oorCooldownTriggerCount}x / ${config.management.oorCooldownHours}h`,
    `Repeat deploy cooldown: ${config.management.repeatDeployCooldownEnabled ? "on" : "off"} | ${config.management.repeatDeployCooldownTriggerCount}x / ${config.management.repeatDeployCooldownHours}h | min fee earned ${config.management.repeatDeployCooldownMinFeeEarnedPct}% | ${config.management.repeatDeployCooldownScope}`,
    `Yield floor: ${config.management.minFeePerTvl24h}% | min age ${config.management.minAgeBeforeYieldCheck}m`,
    `Screening: ${config.screening.category} / ${config.screening.timeframe} | TVL ${config.screening.minTvl}-${config.screening.maxTvl}`,
    `Intervals: manage ${config.schedule.managementIntervalMin}m | screen ${config.schedule.screeningIntervalMin}m`,
    `HiveMind: ${isHiveMindEnabled() ? "enabled" : "disabled"}${config.hiveMind.agentId ? ` | ${config.hiveMind.agentId}` : ""}`,
  ].join("\n");
}

function getSettingLabel(key) {
  return SETTINGS_MENUS[key]?.label ?? key;
}

function getSettingUnit(key) {
  return SETTINGS_MENUS[key]?.unit ?? "";
}

function formatSettingConfirm(key, oldVal, newVal) {
  const label = getSettingLabel(key);
  const unit = getSettingUnit(key);
  const oldStr = oldVal != null ? `${oldVal}${unit}` : "?";
  const newStr = `${newVal}${unit}`;
  return `✅ ${label}\n${oldStr} → ${newStr}`;
}

function parseConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value.length) return "";
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^null$/i.test(value)) return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return JSON.parse(value);
  }
  return value;
}

function settingValue(key) {
  const values = {
    solMode: config.management.solMode,
    lpAgentRelayEnabled: config.api.lpAgentRelayEnabled,
    chartIndicatorsEnabled: config.indicators.enabled,
    trailingTakeProfit: config.management.trailingTakeProfit,
    useDiscordSignals: config.screening.useDiscordSignals,
    blockPvpSymbols: config.screening.blockPvpSymbols,
    strategy: config.strategy.strategy,
    minBinsBelow: config.strategy.minBinsBelow,
    maxBinsBelow: config.strategy.maxBinsBelow,
    defaultBinsBelow: config.strategy.defaultBinsBelow,
    deployAmountSol: config.management.deployAmountSol,
    gasReserve: config.management.gasReserve,
    maxPositions: config.risk.maxPositions,
    maxDeployAmount: config.risk.maxDeployAmount,
    takeProfitPct: config.management.takeProfitPct,
    stopLossPct: config.management.stopLossPct,
    trailingTriggerPct: config.management.trailingTriggerPct,
    trailingDropPct: config.management.trailingDropPct,
    repeatDeployCooldownEnabled: config.management.repeatDeployCooldownEnabled,
    repeatDeployCooldownTriggerCount: config.management.repeatDeployCooldownTriggerCount,
    repeatDeployCooldownHours: config.management.repeatDeployCooldownHours,
    repeatDeployCooldownMinFeeEarnedPct: config.management.repeatDeployCooldownMinFeeEarnedPct,
    managementIntervalMin: config.schedule.managementIntervalMin,
    screeningIntervalMin: config.schedule.screeningIntervalMin,
    indicatorEntryPreset: config.indicators.entryPreset,
    indicatorExitPreset: config.indicators.exitPreset,
    rsiLength: config.indicators.rsiLength,
    indicatorIntervals: config.indicators.intervals,
    requireAllIntervals: config.indicators.requireAllIntervals,
  };
  return values[key];
}

function settingButton(label, data) {
  return { text: label, callback_data: data };
}

const SETTINGS_MENUS = {
  deployAmountSol: { label: "💰 Deploy Amount", unit: " SOL", presets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.2, 0.5, 1], current: () => `${config.management.deployAmountSol} SOL` },
  gasReserve: { label: "⛽ Gas Reserve", unit: " SOL", presets: [0.05, 0.1, 0.15, 0.2, 0.3, 0.5], current: () => `${config.management.gasReserve} SOL` },
  maxPositions: { label: "📊 Max Positions", unit: "", presets: [1, 2, 3, 5, 10], current: () => `${config.risk.maxPositions}` },
  takeProfitPct: { label: "📈 TP %", unit: "%", presets: [5, 10, 15, 20, 30, 50], current: () => `${config.management.takeProfitPct}%` },
  stopLossPct: { label: "📉 SL %", unit: "%", presets: [5, 10, 15, 20, 25, 30], current: () => `${config.management.stopLossPct}%` },
  managementIntervalMin: { label: "⏱ Manage Interval", unit: "m", presets: [1, 3, 5, 10, 15], current: () => `${config.schedule.managementIntervalMin}m` },
  screeningIntervalMin: { label: "⏱ Screen Interval", unit: "m", presets: [10, 15, 30, 60], current: () => `${config.schedule.screeningIntervalMin}m` },
};

function renderSettingsMenu() {
  const text = "⚙️ Settings\n\nSelect a setting to adjust:";
  const rows = [];
  for (const [key, def] of Object.entries(SETTINGS_MENUS)) {
    rows.push([settingButton(`${def.label} (${def.current()})`, `cfg:show:${key}`)]);
  }
  rows.push([settingButton("🎯 Strategy", "cfg:show:strategy")]);
  rows.push([settingButton("📄 Config Snapshot", "cfg:show:config_snapshot")]);
  rows.push([{ text: "◀️", callback_data: "menu:main" }, settingButton("🔄", "cfg:page:main"), { text: "❌", callback_data: "cfg:close" }]);
  return { text, keyboard: rows };
}

function renderSettingsSubmenu(key) {
  if (key === "strategy") {
    const current = config.strategy.strategy;
    return {
      text: `🎯 Strategy\n\nCurrent: ${current}\n\nSelect strategy:`,
      keyboard: [
        [settingButton(current === "spot" ? "• spot" : "  spot", "cfg:set:strategy:spot")],
        [settingButton(current === "bid_ask" ? "• bid_ask" : "  bid_ask", "cfg:set:strategy:bid_ask")],
        [{ text: "◀️", callback_data: "cfg:back" }, { text: "❌", callback_data: "cfg:close" }],
      ],
    };
  }

  const def = SETTINGS_MENUS[key];
  if (!def) return renderSettingsMenu();

  const currentVal = Number(settingValue(key));
  const text = `${def.label}\n\nCurrent: ${def.current()}\n\nSelect value:`;
  const presetButtons = def.presets.map((p) => settingButton(`${p}${def.unit}`, `cfg:set:${key}:${p}`));
  const rows = [];
  for (let i = 0; i < presetButtons.length; i += 3) {
    rows.push(presetButtons.slice(i, i + 3));
  }
  rows.push([settingButton("✏️ Custom", `cfg:custom:${key}`)]);
  rows.push([{ text: "◀️", callback_data: "cfg:back" }, { text: "❌", callback_data: "cfg:close" }]);
  return { text, keyboard: rows };
}

async function showSettingsMenu({ messageId = null } = {}) {
  const menu = renderSettingsMenu();
  if (messageId) {
    await editMessageWithButtons(menu.text, messageId, menu.keyboard);
  } else {
    await sendMessageWithButtons(menu.text, menu.keyboard);
  }
}

function normalizeMenuValue(key, raw) {
  if (key === "indicatorIntervals") {
    if (raw === "both") return ["5_MINUTE", "15_MINUTE"];
    return [raw];
  }
  return parseConfigValue(raw);
}

async function applySettingsMenuCallback(msg) {
  const data = msg.callbackData || msg.text || "";
  const parts = data.split(":");
  const action = parts[1];

  if (action === "noop") {
    await answerCallbackQuery(msg.callbackQueryId);
    return;
  }
  if (action === "close") {
    await answerCallbackQuery(msg.callbackQueryId, "Closed");
    await editMessage("Settings menu closed.", msg.messageId);
    return;
  }
  if (action === "page") {
    await answerCallbackQuery(msg.callbackQueryId);
    if (parts[2] && parts[2] !== "main") {
      const menu = renderSettingsSubmenu(parts[2]);
      await editMessageWithButtons(menu.text, msg.messageId, menu.keyboard);
    } else {
      await showSettingsMenu({ messageId: msg.messageId });
    }
    return;
  }

  if (action === "show") {
    const key = parts[2];
    await answerCallbackQuery(msg.callbackQueryId);
    if (key === "config_snapshot") {
      await editMessageWithButtons(formatConfigSnapshot(), msg.messageId, [[{ text: "◀️", callback_data: "cfg:back" }, { text: "❌", callback_data: "cfg:close" }]]);
    } else {
      const menu = renderSettingsSubmenu(key);
      await editMessageWithButtons(menu.text, msg.messageId, menu.keyboard);
    }
    return;
  }

  if (action === "custom") {
    const key = parts[2];
    const def = SETTINGS_MENUS[key];
    await answerCallbackQuery(msg.callbackQueryId);
    _pendingCustomSetting.set(msg.chat?.id, key);
    await editMessageWithButtons(
      `✏️ ${def?.label || key}\n\nType the new value (e.g. ${def.presets[0]}${def.unit}):`,
      msg.messageId,
      [[{ text: "◀️", callback_data: "cfg:back" }, { text: "❌", callback_data: "cfg:cancel" }]]
    );
    return;
  }

  if (action === "cancel") {
    await answerCallbackQuery(msg.callbackQueryId, "Cancelled");
    _pendingCustomSetting.delete(msg.chat?.id);
    await editMessage("Settings edit cancelled.", msg.messageId);
    return;
  }

  if (action === "back") {
    await answerCallbackQuery(msg.callbackQueryId);
    _pendingCustomSetting.delete(msg.chat?.id);
    await showSettingsMenu({ messageId: msg.messageId });
    return;
  }

  if (action === "set") {
    const key = parts[2];
    const rawValue = parts.slice(3).join(":");
    const value = normalizeMenuValue(key, rawValue);
    const oldVal = settingValue(key);
    const result = await executeTool("update_config", {
      changes: { [key]: value },
      reason: "Telegram settings menu",
    });
    if (!result?.success) {
      await answerCallbackQuery(msg.callbackQueryId, "❌ Update failed");
      return;
    }
    await answerCallbackQuery(msg.callbackQueryId);
    await sendMessage(formatSettingConfirm(key, oldVal, value)).catch(() => {});
    await editMessageWithButtons(renderSettingsSubmenu(key).text, msg.messageId, renderSettingsSubmenu(key).keyboard);
    return;
  }

  await answerCallbackQuery(msg.callbackQueryId, "Unknown action");
}

function formatHelpText() {
  return [
    "Telegram commands",
    "",
    "/start or /menu — show main menu with buttons",
    "/help — show commands",
    "/status — wallet + positions snapshot",
    "/wallet — wallet, deploy amount, HiveMind status",
    "/positions — list open positions",
    "/pool <n> — detailed info for one open position",
    "/close <n> — close one position by index",
    "/closeall — close all open positions",
    "/set <n> <note> — set note/instruction on position",
    "/config — show important runtime config",
    "/settings — button menu for common config",
    "/setcfg <key> <value> — update persisted config",
    "/screen — refresh deterministic candidate list",
    "/candidates — show latest cached candidates",
    "/deploy — choose amount and deploy via buttons",
    "/deploy <n> — deploy candidate by cached index",
    "/briefing — morning briefing",
    "/notifications — toggle notification on/off",
    "/hive — HiveMind sync status",
    "/hive pull — manual HiveMind pull now",
    "/pause — stop cron cycles",
    "/resume — start cron cycles again",
    "/stop — shut down agent",
  ].join("\n");
}

async function runDeterministicScreen(limit = 5) {
  const top = await getTopCandidates({ limit });
  const candidates = (top?.candidates || top?.pools || []).slice(0, limit);
  setLatestCandidates(candidates);
  const totalScreened = top?.total_screened ?? candidates.length;
  const filteredExamples = (top?.filtered_examples || []).slice(0, 5);
  const lines = [`🔍 Screening Summary — ${totalScreened} pools scanned`];
  if (filteredExamples.length > 0) {
    lines.push(`Filtered: ${filteredExamples.length} pool(s)`);
    filteredExamples.forEach((f) => lines.push(`  • ${f.name}: ${f.reason}`));
  }
  if (candidates.length > 0) {
    lines.push(`Passed: ${candidates.length} pool(s)`);
    candidates.forEach((pool, i) => {
      const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
      const vol = pool.volume_window ?? pool.volume_24h ?? "?";
      lines.push(`${i + 1}. ${pool.name} | fee/aTVL ${feeTvl}% | vol $${vol} | organic ${pool.organic_score ?? "?"}`);
    });
  } else {
    lines.push("Passed: 0 — no candidates available right now.");
  }
  return lines.join("\n");
}

async function deployLatestCandidate(index) {
  const candidate = _latestCandidates[index];
  if (!candidate) {
    throw new Error("Invalid candidate index. Run /screen first.");
  }
  if (_latestCandidates.length === 1) {
    const mint = candidate.base?.mint || candidate.base_mint || null;
    const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
      checkSmartWalletsOnPool({ pool_address: candidate.pool }),
      mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
      mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
    ]);
    const context = {
      pool: candidate,
      sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
      n: narrative.status === "fulfilled" ? narrative.value : null,
      ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
    };
    const skipReason = getLoneCandidateSkipReason(context);
    if (skipReason) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "Single cached candidate skipped",
        reason: skipReason,
        pool: candidate.pool,
        pool_name: candidate.name,
      });
      throw new Error(`NO DEPLOY: only cached candidate ${candidate.name} is not worth deploying — ${skipReason}`);
    }
  }
  const deployAmount = computeDeployAmount((await getWalletBalances()).sol);
  const binsBelow = computeBinsBelow(candidate.volatility);
  const result = await executeTool("deploy_position", {
    pool_address: candidate.pool,
    amount_y: deployAmount,
    strategy: config.strategy.strategy,
    bins_below: binsBelow,
    bins_above: 0,
    pool_name: candidate.name,
    base_mint: candidate.base?.mint || candidate.base_mint || null,
    bin_step: candidate.bin_step,
    base_fee: candidate.base_fee,
    volatility: candidate.volatility,
    fee_tvl_ratio: candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio,
    organic_score: candidate.organic_score,
    initial_value_usd: candidate.tvl ?? candidate.active_tvl ?? null,
  });
  if (result?.blocked || result?.success === false || result?.error) {
    throw new Error(result?.reason || result?.error || "Deploy failed");
  }
  return { result, candidate, deployAmount, binsBelow };
}

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

async function runDeployScreen(chatId, amount, messageId) {
  try {
    const screenResult = await runDeterministicScreen(5);
    const candidates = _latestCandidates;

    if (candidates.length === 0) {
      if (messageId) {
        await editMessageWithButtons(`No candidates available.\n${screenResult}`, messageId, [[{ text: "◀️", callback_data: "deploy:back" }, { text: "❌", callback_data: "deploy:cancel" }]]);
      } else {
        await sendMessage(`No candidates available.\n${screenResult}`);
      }
      _pendingDeployAmount.delete(chatId);
      return;
    }

    const keyboard = candidates.map((pool, i) => {
      const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
      const vol = pool.volume_window ?? pool.volume_24h ?? "?";
      return [{
        text: `${i + 1}. ${pool.name}  |  fee/aTVL ${feeTvl}%  |  vol $${vol}`,
        callback_data: `deploy:candidate:${i}`,
      }];
    });
    keyboard.push([{ text: "◀️", callback_data: "deploy:back" }, { text: "❌ Cancel", callback_data: "deploy:cancel" }]);

    if (messageId) {
      await editMessageWithButtons(`✅ ${candidates.length} candidates\nSelect one to deploy ${amount} SOL:`, messageId, keyboard);
    } else {
      await sendMessageWithButtons(`✅ ${candidates.length} candidates\nSelect one to deploy ${amount} SOL:`, keyboard);
    }
  } catch (e) {
    const errMsg = `⚠️ Screen failed: ${e.message}`;
    if (messageId) await editMessage(errMsg, messageId);
    else await sendMessage(errMsg);
  }
}

async function startDeployFlow(chatId, amount, messageId) {
  _pendingDeployAmount.set(chatId, amount);
  if (messageId) {
    await editMessage(`🔍 Screening pools for ${amount} SOL deploy...`, messageId);
  } else {
    await sendMessage(`🔍 Screening pools for ${amount} SOL deploy...`);
  }
  await runDeployScreen(chatId, amount, messageId);
}

async function handleDeployCallback(msg) {
  const data = msg.callbackData || msg.text || "";
  const parts = data.split(":");
  const chatId = msg.chat?.id;

  if (parts[1] === "amount") {
    const amount = parseFloat(parts[2]);
    if (!Number.isFinite(amount) || amount <= 0) {
      await answerCallbackQuery(msg.callbackQueryId, "Invalid amount");
      return;
    }
    _pendingDeployAmount.set(chatId, amount);
    await answerCallbackQuery(msg.callbackQueryId, `Selected ${amount} SOL`);
    await startDeployFlow(chatId, amount, msg.messageId);
    return;
  }

  if (parts[1] === "custom") {
    await answerCallbackQuery(msg.callbackQueryId, "Type the amount");
    _pendingCustomAmount.set(chatId, true);
    await editMessageWithButtons("✏️ Type the amount in SOL (e.g., 0.15):", msg.messageId, [[{ text: "◀️", callback_data: "deploy:back" }, { text: "❌ Cancel", callback_data: "deploy:cancel" }]]);
    return;
  }

  if (parts[1] === "back") {
    await answerCallbackQuery(msg.callbackQueryId);
    _pendingCustomAmount.delete(chatId);
    _pendingDeployAmount.delete(chatId);
    await renderSubMenu("deploy", msg);
    return;
  }

  if (parts[1] === "candidate") {
    const idx = parseInt(parts[2]);
    const amount = _pendingDeployAmount.get(chatId);

    if (!Number.isFinite(amount)) {
      await answerCallbackQuery(msg.callbackQueryId, "No amount selected. Start with /deploy");
      return;
    }

    const candidate = _latestCandidates[idx];
    if (!candidate) {
      await answerCallbackQuery(msg.callbackQueryId, "Invalid candidate. Run /screen first");
      _pendingDeployAmount.delete(chatId);
      return;
    }

    await answerCallbackQuery(msg.callbackQueryId, `Deploying ${amount} SOL...`);
    await editMessage(`🚀 Deploying ${amount} SOL into ${candidate.name}...`, msg.messageId);

    try {
      const binsBelow = computeBinsBelow(candidate.volatility);
      const result = await executeTool("deploy_position", {
        pool_address: candidate.pool,
        amount_y: amount,
        strategy: config.strategy.strategy,
        bins_below: binsBelow,
        bins_above: 0,
        pool_name: candidate.name,
        base_mint: candidate.base?.mint || candidate.base_mint || null,
        bin_step: candidate.bin_step,
        base_fee: candidate.base_fee,
        volatility: candidate.volatility,
        fee_tvl_ratio: candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio,
        organic_score: candidate.organic_score,
        initial_value_usd: candidate.tvl ?? candidate.active_tvl ?? null,
      });

      const resultType = result?.blocked ? "blocked" : (result?.success === false || result?.error ? "failed" : null);
      if (resultType) {
        throw Object.assign(new Error(result?.reason || result?.error || "Deploy failed"), { deployResultType: resultType, deployPair: candidate.name });
      }

      const successLines = [`✅ Deployed ${candidate.name}`];
      successLines.push(`Amount: ${amount} SOL`);
      if (candidate.bin_step || candidate.base_fee) {
        successLines.push(`Bin step: ${candidate.bin_step ?? "?"}  |  Fee: ${candidate.base_fee != null ? candidate.base_fee + "%" : "?"}`);
      }
      if (result.range_coverage) {
        successLines.push(`Downside: ${fmtPct(result.range_coverage.downside_pct)}  |  Upside: ${fmtPct(result.range_coverage.upside_pct)}  |  Width: ${fmtPct(result.range_coverage.width_pct)}`);
      }
      if (result.position) successLines.push(`Pos: ${result.position.slice(0, 8)}...`);
      if (result.txs?.length) successLines.push(`Tx: ${result.txs[0]}`);

      await editMessage(successLines.join("\n"), msg.messageId);

      notifyDeployResult({
        type: "success",
        pair: candidate.name,
        amountSol: amount,
        position: result.position,
        tx: result.txs?.[0],
        priceRange: result.price_range,
        rangeCoverage: result.range_coverage,
        binStep: candidate.bin_step,
        baseFee: candidate.base_fee,
      }).catch(() => {});
    } catch (e) {
      const failType = e.deployResultType || "failed";
      const failPair = e.deployPair || candidate.name;
      const failReason = e.message;
      await editMessage(`❌ Deploy ${failType === "blocked" ? "blocked" : "failed"}: ${failPair}\nReason: ${failReason}`, msg.messageId);
      notifyDeployResult({ type: failType, pair: failPair, reason: failReason }).catch(() => {});
    }

    _pendingDeployAmount.delete(chatId);
    return;
  }

  if (parts[1] === "cancel") {
    _pendingDeployAmount.delete(chatId);
    await answerCallbackQuery(msg.callbackQueryId, "Cancelled");
    await editMessage("Deploy cancelled.", msg.messageId);
    return;
  }

  await answerCallbackQuery(msg.callbackQueryId, "Unknown deploy action");
}

// ─── Persistent Menu System ──────────────────────────────────────────

function mainMenuText() {
  return `🤖 Meridian — DLMM LP Agent\nMode: ${process.env.DRY_RUN === "true" ? "🔴 DRY RUN" : "🟢 LIVE"}`;
}

function mainMenuKeyboard() {
  return [
    [
      { text: "📊 Status", callback_data: "menu:status" },
      { text: "📍 Positions", callback_data: "menu:positions" },
    ],
    [
      { text: "💰 Deploy", callback_data: "menu:deploy" },
      { text: "🔍 Screen", callback_data: "menu:screen" },
    ],
    [
      { text: "⚙️ Settings", callback_data: "menu:settings" },
      { text: "🔔 Notifications", callback_data: "menu:notifications" },
    ],
    [
      { text: "📌 Lainnya", callback_data: "menu:lainnya" },
      { text: "❓ Help", callback_data: "menu:help" },
    ],
    [
      { text: "❌ Close", callback_data: "menu:close" },
    ],
  ];
}

function backButton(page) {
  return [{ text: "◀️", callback_data: `menu:${page}` }];
}

function buildDeployAmountKeyboard(includeBack = false) {
  const amounts = [0.001, 0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 1];
  const rows = [];
  for (let i = 0; i < amounts.length; i += 2) {
    rows.push([
      { text: `${amounts[i]} SOL`, callback_data: `deploy:amount:${amounts[i]}` },
      i + 1 < amounts.length ? { text: `${amounts[i + 1]} SOL`, callback_data: `deploy:amount:${amounts[i + 1]}` } : null,
    ].filter(Boolean));
  }
  rows.push([{ text: "✏️ Custom", callback_data: "deploy:custom" }]);
  if (includeBack) rows.push([{ text: "◀️", callback_data: "menu:main" }, { text: "❌", callback_data: "menu:close" }]);
  return rows;
}

async function renderSubMenu(page, msg) {
  let text, keyboard;

  if (page === "status") {
    try {
      const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
      const deployAmount = computeDeployAmount(wallet.sol);
      text = [
        "📊 Status",
        `Wallet: ${wallet.sol} SOL ($${wallet.sol_usd})`,
        `SOL price: $${wallet.sol_price}`,
        `Open positions: ${positions.total_positions}/${config.risk.maxPositions}`,
        `Next deploy: ${deployAmount} SOL`,
        `Mode: ${process.env.DRY_RUN === "true" ? "🔴 DRY RUN" : "🟢 LIVE"}`,
        `HiveMind: ${isHiveMindEnabled() ? "on" : "off"}`,
      ].join("\n");
    } catch (e) {
      text = `⚠️ Status error: ${e.message}`;
    }
    keyboard = [[{ text: "🔄 Refresh", callback_data: "menu:status" }], [{ text: "◀️", callback_data: "menu:main" }, { text: "❌", callback_data: "menu:close" }]];
  } else if (page === "positions") {
    try {
      const { positions, total_positions } = await getMyPositions({ force: true });
      if (total_positions === 0) {
        text = "📍 Positions\n\nNo open positions.";
      } else {
        const cur = config.management.solMode ? "◎" : "$";
        const lines = positions.map((p, i) => {
          const pnl = p.pnl_usd >= 0 ? `+${cur}${p.pnl_usd}` : `-${cur}${Math.abs(p.pnl_usd)}`;
          const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
          const oor = !p.in_range ? " ⚠️OOR" : "";
          return `${i + 1}. ${p.pair} | ${cur}${p.total_value_usd} | PnL: ${pnl} | ${age}${oor}`;
        });
        text = `📍 Positions (${total_positions})\n\n${lines.join("\n")}`;
      }
    } catch (e) {
      text = `⚠️ Positions error: ${e.message}`;
    }
    keyboard = [[{ text: "◀️", callback_data: "menu:main" }, { text: "❌", callback_data: "menu:close" }]];
  } else if (page === "deploy") {
    text = "💰 Deploy\n\nSelect deploy amount:";
    keyboard = buildDeployAmountKeyboard(true);
  } else if (page === "screen") {
    text = "🔍 Screen\n\nScan for new pool candidates or view cached list:";
    keyboard = [
      [
        { text: "🔍 Run Screen", callback_data: "menu:run_screen" },
        { text: "📋 Candidates", callback_data: "menu:candidates" },
      ],
      [{ text: "◀️", callback_data: "menu:main" }, { text: "❌", callback_data: "menu:close" }],
    ];
  } else if (page === "notifications") {
    text = [
      "🔔 Notifications",
      "",
      `Management cycle: ${_notifyManagement ? "✅ ON" : "❌ OFF"}`,
      `Screening cycle: ${_notifyScreening ? "✅ ON" : "❌ OFF"}`,
    ].join("\n");
    keyboard = [
      [
        { text: `Mgmt: ${_notifyManagement ? "✅ ON" : "⬜ OFF"}`, callback_data: "notif:toggle:management" },
        { text: `Screen: ${_notifyScreening ? "✅ ON" : "⬜ OFF"}`, callback_data: "notif:toggle:screening" },
      ],
      [{ text: "◀️", callback_data: "menu:main" }, { text: "❌", callback_data: "menu:close" }],
    ];
  } else if (page === "settings") {
    await showSettingsMenu({ messageId: msg?.messageId });
    return;
  } else if (page === "help") {
    text = formatHelpText();
    keyboard = [[{ text: "◀️", callback_data: "menu:main" }, { text: "❌", callback_data: "menu:close" }]];
  } else if (page === "lainnya") {
    text = "📌 Lainnya\n\nOther commands:";
    keyboard = [
      [{ text: "📋 Briefing", callback_data: "menu:briefing" }],
      [{ text: "📊 Thresholds", callback_data: "menu:thresholds" }],
      [{ text: "⚡ Evolve", callback_data: "menu:evolve" }],
      [{ text: "◀️", callback_data: "menu:main" }, { text: "❌", callback_data: "menu:close" }],
    ];
  } else {
    text = mainMenuText();
    keyboard = mainMenuKeyboard();
  }

  if (msg?.messageId) {
    await editMessageWithButtons(text, msg.messageId, keyboard);
  } else {
    await sendMessageWithButtons(text, keyboard);
  }
}

async function handleMenuCallback(msg) {
  const data = msg.callbackData || msg.text || "";
  const page = data.split(":").slice(1).join(":");

  if (page === "run_screen") {
    await answerCallbackQuery(msg.callbackQueryId, "Screening...");
    await editMessage("🔍 Screening pools...", msg.messageId);
    try {
      const result = await runDeterministicScreen(5);
      await editMessageWithButtons(result, msg.messageId, [
        [{ text: "🔄 Refresh", callback_data: "menu:run_screen" }],
        [backButton("screen")[0], { text: "❌", callback_data: "menu:close" }],
      ]);
    } catch (e) {
      await editMessageWithButtons(`⚠️ Screen failed: ${e.message}`, msg.messageId, [backButton("screen")]);
    }
    return;
  }

  if (page === "candidates") {
    await answerCallbackQuery(msg.callbackQueryId);
    const text = describeLatestCandidates(5);
    await editMessageWithButtons(text, msg.messageId, [
      [{ text: "🔄 Refresh", callback_data: "menu:candidates" }],
      [backButton("screen")[0], { text: "❌", callback_data: "menu:close" }],
    ]);
    return;
  }

  // Direct actions from Lainnya submenu — show result inline
  if (page === "briefing") {
    await answerCallbackQuery(msg.callbackQueryId);
    await editMessage("📋 Generating briefing...", msg.messageId);
    try {
      const briefing = await generateBriefing();
      await editHTMLWithButtons(briefing, msg.messageId, [[backButton("lainnya")[0], { text: "❌", callback_data: "menu:close" }]]);
    } catch (e) {
      await editMessageWithButtons(`⚠️ Error: ${e.message}`, msg.messageId, [[backButton("lainnya")[0], { text: "❌", callback_data: "menu:close" }]]);
    }
    return;
  }
  if (page === "thresholds") {
    await answerCallbackQuery(msg.callbackQueryId);
    const s = config.screening;
    const lines = [
      "📊 Thresholds",
      `  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`,
      `  minOrganic:           ${s.minOrganic}`,
      `  minHolders:           ${s.minHolders}`,
      `  minTvl:               ${s.minTvl}`,
      `  maxTvl:               ${s.maxTvl}`,
      `  minVolume:            ${s.minVolume}`,
      `  minTokenFeesSol:      ${s.minTokenFeesSol}`,
      `  maxBundlePct:         ${s.maxBundlePct}`,
      `  maxBotHoldersPct:     ${s.maxBotHoldersPct}`,
      `  maxTop10Pct:          ${s.maxTop10Pct}`,
      `  timeframe:            ${s.timeframe}`,
    ];
    const perf = getPerformanceSummary();
    if (perf) {
      lines.push(`  Based on ${perf.total_positions_closed} closed positions`);
      lines.push(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
    }
    await editMessageWithButtons(lines.join("\n"), msg.messageId, [[backButton("lainnya")[0], { text: "❌", callback_data: "menu:close" }]]);
    return;
  }
  if (page === "evolve") {
    await answerCallbackQuery(msg.callbackQueryId);
    const perf = getPerformanceSummary();
    if (!perf || perf.total_positions_closed < 5) {
      const needed = 5 - (perf?.total_positions_closed || 0);
      await editMessageWithButtons(`Need at least 5 closed positions to evolve. ${needed} more needed.`, msg.messageId, [[backButton("lainnya")[0], { text: "❌", callback_data: "menu:close" }]]);
      return;
    }
    await editMessage("⚡ Evolving thresholds...", msg.messageId);
    try {
      const lessonsData = JSON.parse(readFileSync("./lessons.json", "utf8"));
      const result = evolveThresholds(lessonsData.performance, config);
      await editMessageWithButtons(`✅ Evolved: ${JSON.stringify(result?.applied || result)}`, msg.messageId, [[backButton("lainnya")[0], { text: "❌", callback_data: "menu:close" }]]);
    } catch (e) {
      await editMessageWithButtons(`⚠️ Evolve error: ${e.message}`, msg.messageId, [[backButton("lainnya")[0], { text: "❌", callback_data: "menu:close" }]]);
    }
    return;
  }

  if (page === "close") {
    await answerCallbackQuery(msg.callbackQueryId, "Closed");
    await editMessage("Menu closed.", msg.messageId);
    return;
  }

  await answerCallbackQuery(msg.callbackQueryId);
  await renderSubMenu(page, msg);
}

function refreshPrompt() {
  if (!_ttyInterface) return;
  _ttyInterface.setPrompt(buildPrompt());
  _ttyInterface.prompt(true);
}

async function drainTelegramQueue() {
  while (_telegramQueue.length > 0 && !_managementBusy && !_screeningBusy && !busy) {
    const queued = _telegramQueue.shift();
    await telegramHandler(queued);
  }
}

async function telegramHandler(msg) {
  const text = msg?.text?.trim();
  if (!text) return;
  if (msg?.isCallback && text.startsWith("cfg:")) {
    try {
      await applySettingsMenuCallback(msg);
    } catch (e) {
      await answerCallbackQuery(msg.callbackQueryId, e.message).catch(() => {});
    }
    return;
  }

  if (msg?.isCallback && text.startsWith("deploy:")) {
    try {
      await handleDeployCallback(msg);
    } catch (e) {
      await answerCallbackQuery(msg.callbackQueryId, e.message).catch(() => {});
    }
    return;
  }

  if (msg?.isCallback && text.startsWith("menu:")) {
    try {
      await handleMenuCallback(msg);
    } catch (e) {
      await answerCallbackQuery(msg.callbackQueryId, e.message).catch(() => {});
    }
    return;
  }

  if (msg?.isCallback && text.startsWith("notif:")) {
    try {
      const parts = text.split(":");
      if (parts[2] === "management") {
        _notifyManagement = !_notifyManagement;
        await answerCallbackQuery(msg.callbackQueryId, `Mgmt ${_notifyManagement ? "ON" : "OFF"}`);
      } else if (parts[2] === "screening") {
        _notifyScreening = !_notifyScreening;
        await answerCallbackQuery(msg.callbackQueryId, `Screen ${_notifyScreening ? "ON" : "OFF"}`);
      }
      saveNotifFlags();
      await renderSubMenu("notifications", msg);
    } catch (e) {
      await answerCallbackQuery(msg.callbackQueryId, e.message).catch(() => {});
    }
    return;
  }

  if (text === "/start" || text === "/menu") {
    await sendMessageWithButtons(mainMenuText(), mainMenuKeyboard()).catch(() => {});
    return;
  }

  if (text === "/notifications") {
    await renderSubMenu("notifications", {}).catch(() => {});
    return;
  }

  if (text === "/lainnya") {
    await renderSubMenu("lainnya", {}).catch(() => {});
    return;
  }

  if (text === "/settings" || text === "/configmenu") {
    await showSettingsMenu().catch((e) => sendMessage(`Settings error: ${e.message}`).catch(() => {}));
    return;
  }

  if (text === "/help") {
    await sendMessageWithButtons(formatHelpText(), [[{ text: "◀️", callback_data: "menu:main" }, { text: "❌", callback_data: "menu:close" }]]).catch(() => {});
    return;
  }

  if (text === "/briefing") {
    try {
      const briefing = await generateBriefing();
      await sendHTMLWithButtons(briefing, [[{ text: "◀️", callback_data: "menu:lainnya" }, { text: "❌", callback_data: "menu:close" }]]);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/wallet" || text === "/status") {
    try {
      const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
      const suffix = text === "/status" && positions.total_positions
        ? `\n\nUse /positions for the numbered list.`
        : "";
      await sendMessageWithButtons(`${formatWalletStatus(wallet, positions)}${suffix}`, [[{ text: "◀️", callback_data: "menu:main" }, { text: "❌", callback_data: "menu:close" }]]).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/config") {
    await sendMessageWithButtons(formatConfigSnapshot(), [[{ text: "◀️", callback_data: "menu:settings" }, { text: "❌", callback_data: "menu:close" }]]).catch(() => {});
    return;
  }

  if (text === "/thresholds") {
    const s = config.screening;
    const lines = [
      "📊 Thresholds",
      `  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`,
      `  minOrganic:           ${s.minOrganic}`,
      `  minHolders:           ${s.minHolders}`,
      `  minTvl:               ${s.minTvl}`,
      `  maxTvl:               ${s.maxTvl}`,
      `  minVolume:            ${s.minVolume}`,
      `  minTokenFeesSol:      ${s.minTokenFeesSol}`,
      `  maxBundlePct:         ${s.maxBundlePct}`,
      `  maxBotHoldersPct:     ${s.maxBotHoldersPct}`,
      `  maxTop10Pct:          ${s.maxTop10Pct}`,
      `  timeframe:            ${s.timeframe}`,
    ];
    const perf = getPerformanceSummary();
    if (perf) {
      lines.push(`  Based on ${perf.total_positions_closed} closed positions`);
      lines.push(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
    }
    await sendMessageWithButtons(lines.join("\n"), [[{ text: "◀️", callback_data: "menu:lainnya" }, { text: "❌", callback_data: "menu:close" }]]).catch(() => {});
    return;
  }

  if (text === "/evolve") {
    const perf = getPerformanceSummary();
    if (!perf || perf.total_positions_closed < 5) {
      const needed = 5 - (perf?.total_positions_closed || 0);
      await sendMessageWithButtons(`Need at least 5 closed positions to evolve. ${needed} more needed.`, [[{ text: "◀️", callback_data: "menu:lainnya" }, { text: "❌", callback_data: "menu:close" }]]).catch(() => {});
      return;
    }
    await sendMessageWithButtons("⚡ Evolving thresholds...", [[{ text: "◀️", callback_data: "menu:lainnya" }, { text: "❌", callback_data: "menu:close" }]]).catch(() => {});
    try {
      const lessonsData = JSON.parse(readFileSync("./lessons.json", "utf8"));
      const result = evolveThresholds(lessonsData.performance, config);
      await sendMessageWithButtons(`✅ Evolved: ${JSON.stringify(result?.applied || result)}`, [[{ text: "◀️", callback_data: "menu:lainnya" }, { text: "❌", callback_data: "menu:close" }]]).catch(() => {});
    } catch (e) {
      await sendMessageWithButtons(`⚠️ Evolve error: ${e.message}`, [[{ text: "◀️", callback_data: "menu:lainnya" }, { text: "❌", callback_data: "menu:close" }]]).catch(() => {});
    }
    return;
  }

  if (text === "/positions") {
    try {
      const { positions, total_positions } = await getMyPositions({ force: true });
      if (total_positions === 0) { await sendMessageWithButtons("No open positions.", [[{ text: "◀️", callback_data: "menu:main" }, { text: "❌", callback_data: "menu:close" }]]); return; }
      const cur = config.management.solMode ? "◎" : "$";
      const lines = positions.map((p, i) => {
        const pnl = p.pnl_usd >= 0 ? `+${cur}${p.pnl_usd}` : `-${cur}${Math.abs(p.pnl_usd)}`;
        const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
        const oor = !p.in_range ? " ⚠️OOR" : "";
        return `${i + 1}. ${p.pair} | ${cur}${p.total_value_usd} | PnL: ${pnl} | fees: ${cur}${p.unclaimed_fees_usd} | ${age}${oor}`;
      });
      await sendMessageWithButtons(`📊 Open Positions (${total_positions}):\n\n${lines.join("\n")}\n\n/close <n> to close | /set <n> <note> to set instruction`, [[{ text: "◀️", callback_data: "menu:main" }, { text: "❌", callback_data: "menu:close" }]]);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/candidates") {
    await sendMessageWithButtons(describeLatestCandidates(5), [[{ text: "◀️", callback_data: "menu:screen" }, { text: "❌", callback_data: "menu:close" }]]).catch(() => {});
    return;
  }

  // /deploy with no args — show amount selection menu
  if (text === "/deploy") {
    await sendMessageWithButtons("💰 Select deploy amount:", buildDeployAmountKeyboard(true));
    return;
  }

  const deployMatch = text.match(/^\/deploy\s+(\d+)$/i);
  if (deployMatch) {
    try {
      const idx = parseInt(deployMatch[1]) - 1;
      const { candidate, result, deployAmount, binsBelow } = await deployLatestCandidate(idx);
      const coverage = result.range_coverage
        ? `Range: ${fmtPct(result.range_coverage.downside_pct)} downside | ${fmtPct(result.range_coverage.upside_pct)} upside`
        : `Strategy: ${config.strategy.strategy} | binsBelow: ${binsBelow}`;
      await sendMessage([
        `✅ Deployed ${candidate.name}`,
        `Pool: ${candidate.pool}`,
        `Amount: ${deployAmount} SOL`,
        coverage,
        `Position: ${result.position || "n/a"}`,
        result.txs?.length ? `Tx: ${result.txs[0]}` : null,
      ].filter(Boolean).join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const poolMatch = text.match(/^\/pool\s+(\d+)$/i);
  if (poolMatch) {
    try {
      const idx = parseInt(poolMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage([
        `${idx + 1}. ${pos.pair}`,
        `Pool: ${pos.pool}`,
        `Position: ${pos.position}`,
        `Range: ${pos.lower_bin} → ${pos.upper_bin} | active ${pos.active_bin}`,
        `PnL: ${pos.pnl_pct ?? "?"}% | fees: ${config.management.solMode ? "◎" : "$"}${pos.unclaimed_fees_usd ?? "?"}`,
        `Value: ${config.management.solMode ? "◎" : "$"}${pos.total_value_usd ?? "?"}`,
        `Age: ${pos.age_minutes ?? "?"}m | ${pos.in_range ? "IN RANGE" : `OOR ${pos.minutes_out_of_range ?? 0}m`}`,
        pos.instruction ? `Note: ${pos.instruction}` : null,
      ].filter(Boolean).join("\n"));
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    try {
      const idx = parseInt(closeMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage(`Closing ${pos.pair}...`);
      const result = await closePosition({ position_address: pos.position });
      if (result.success) {
        const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
        const claimNote = result.claim_txs?.length ? `\nClaim txs: ${result.claim_txs.join(", ")}` : "";
        await sendMessage(`✅ Closed ${pos.pair}\nPnL: ${config.management.solMode ? "◎" : "$"}${result.pnl_usd ?? "?"} | close txs: ${closeTxs?.join(", ") || "n/a"}${claimNote}`);
      } else {
        await sendMessage(`❌ Close failed: ${JSON.stringify(result)}`);
      }
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/closeall") {
    try {
      const { positions } = await getMyPositions({ force: true });
      if (!positions.length) { await sendMessage("No open positions."); return; }
      await sendMessage(`Closing ${positions.length} position(s)...`);
      const results = [];
      for (const pos of positions) {
        try {
          const result = await closePosition({ position_address: pos.position });
          results.push(`${pos.pair}: ${result.success ? "closed" : `failed (${result.error || "unknown"})`}`);
        } catch (error) {
          results.push(`${pos.pair}: failed (${error.message})`);
        }
      }
      await sendMessage(`Close-all finished.\n\n${results.join("\n")}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx = parseInt(setMatch[1]) - 1;
      const note = setMatch[2].trim();
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      await setPositionInstruction(positions[idx].position, note);
      await sendMessage(`✅ Note set on position ${idx + 1} (${positions[idx].pair}): "${note}"`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/pause") {
    if (hasAutonomousCycles()) {
      stopCronJobs();
      await sendMessage("⏸️ Autonomous cycles paused. Use /resume to continue.").catch(() => {});
    } else {
      await sendMessage("Autonomous cycles are already paused.").catch(() => {});
    }
    return;
  }

  if (text === "/resume") {
    if (!hasAutonomousCycles()) {
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      await sendMessage("▶️ Autonomous cycles resumed.").catch(() => {});
    } else {
      await sendMessage("Autonomous cycles are already running.").catch(() => {});
    }
    return;
  }

  if (text === "/hive" || text === "/hive pull") {
    try {
      const enabled = isHiveMindEnabled();
      const agentId = ensureAgentId();
      if (!enabled) {
        await sendMessage(`HiveMind: disabled\nAgent ID: ${agentId}\nSet hiveMindApiKey to connect.`).catch(() => {});
        return;
      }
      const isManualPull = text === "/hive pull";
      const pullMode = getHiveMindPullMode();
      const [registerResult, lessons, presets] = await Promise.all([
        registerHiveMindAgent({ reason: isManualPull ? "telegram_pull" : "telegram_status" }),
        (pullMode === "auto" || isManualPull) ? pullHiveMindLessons(12) : Promise.resolve(null),
        (pullMode === "auto" || isManualPull) ? pullHiveMindPresets() : Promise.resolve(null),
      ]);
      await sendMessage([
        "HiveMind: enabled",
        `Agent ID: ${agentId}`,
        `URL: ${config.hiveMind.url}`,
        `Pull mode: ${pullMode}`,
        `Register: ${registerResult ? "ok" : "warn"}`,
        `Shared lessons: ${Array.isArray(lessons) ? lessons.length : (pullMode === "manual" ? "manual" : 0)}`,
        `Presets: ${Array.isArray(presets) ? presets.length : (pullMode === "manual" ? "manual" : 0)}`,
        isManualPull ? "Manual pull: completed" : null,
      ].join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`HiveMind error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/screen") {
    await renderSubMenu("screen", {}).catch(() => {});
    return;
  }

  if (text === "/stop") {
    await sendMessage("🛑 Shutting down...").catch(() => {});
    setTimeout(() => process.exit(0), 500);
    return;
  }
  // Intercept custom deploy amount input — must run BEFORE busy check
  if (_pendingCustomAmount.has(msg.chat?.id)) {
    _pendingCustomAmount.delete(msg.chat?.id);
    const amount = parseFloat(text);
    if (!Number.isFinite(amount) || amount <= 0) {
      await sendMessage("❌ Invalid number. Use /deploy to try again.").catch(() => {});
      return;
    }
    await startDeployFlow(msg.chat.id, amount, null);
    return;
  }

  // Intercept custom setting value input — must run BEFORE busy check
  if (_pendingCustomSetting.has(msg.chat?.id)) {
    const key = _pendingCustomSetting.get(msg.chat?.id);
    _pendingCustomSetting.delete(msg.chat?.id);
    if (text.toLowerCase() === "/cancel") {
      await sendMessage("Cancelled.").catch(() => {});
      return;
    }
    const value = parseFloat(text);
    if (!Number.isFinite(value) || value <= 0) {
      await sendMessage("❌ Invalid number. Send /cancel to abort.").catch(() => {});
      return;
    }
    if (key === "deployAmountSol" && value < 0.001) {
      await sendMessage("❌ Minimum deploy amount is 0.001 SOL.").catch(() => {});
      return;
    }
    const oldVal = settingValue(key);
    const result = await executeTool("update_config", {
      changes: { [key]: value },
      reason: "Telegram settings custom input",
    });
    if (!result?.success) {
      await sendMessage("❌ Update failed.").catch(() => {});
    } else {
      await sendMessage(formatSettingConfirm(key, oldVal, value)).catch(() => {});
      await showSettingsMenu().catch(() => {});
    }
    return;
  }

  if (_managementBusy || _screeningBusy || busy) {
    if (_telegramQueue.length < 5) {
      _telegramQueue.push(msg);
      sendMessage(`⏳ Queued (${_telegramQueue.length} in queue): "${text.slice(0, 60)}"`).catch(() => {});
    } else {
      sendMessage("Queue is full (5 messages). Wait for the agent to finish.").catch(() => {});
    }
    return;
  }

  busy = true;
  // Run agent loop in background so polling loop stays responsive
  runAgentInBackground(text, sessionHistory);
}

async function runAgentInBackground(text, sessionHistory) {
  let liveMessage = null;
  try {
    log("telegram", `Incoming: ${text}`);
    const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
    const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
    const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
    const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
    liveMessage = await createLiveMessage("🤖 Live Update", `Request: ${text.slice(0, 240)}`);
    const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, agentModel, null, {
      interactive: true,
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    appendHistory(text, content);
    if (liveMessage) await liveMessage.finalize(stripThink(content));
    else await sendMessage(stripThink(content));
  } catch (e) {
    if (liveMessage) await liveMessage.fail(e.message).catch(() => {});
    else await sendMessage(`Error: ${e.message}`).catch(() => {});
  } finally {
    busy = false;
    refreshPrompt();
    drainTelegramQueue().catch(() => {});
  }
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}

function getLoneCandidateSkipReason({ pool, sw, n, ti } = {}) {
  if (!pool) return "missing candidate data";
  const smartWalletCount = Math.max(sw?.in_pool?.length ?? 0, Number(pool.gmgn_smart_wallets ?? 0) || 0);
  const tokenInfo = ti || {};
  const hasNarrative = !!n?.narrative;
  const globalFeesSol = Number(tokenInfo.global_fees_sol ?? pool.gmgn_total_fee_sol);
  const top10Pct = Number(tokenInfo.audit?.top_holders_pct ?? pool.gmgn_token_info_top10_pct ?? pool.gmgn_top10_holder_pct);
  const botPct = Number(tokenInfo.audit?.bot_holders_pct ?? pool.gmgn_bot_degen_pct);
  if (pool.is_wash) return "wash trading was flagged";
  if (pool.is_rugpull && smartWalletCount === 0) return "rugpull risk was flagged and no smart wallets offset it";
  if (pool.is_pvp && smartWalletCount === 0) return "PVP symbol conflict and no smart-wallet confirmation";
  if (Number.isFinite(globalFeesSol) && globalFeesSol < config.screening.minTokenFeesSol) {
    return `token fees ${globalFeesSol} SOL below minimum ${config.screening.minTokenFeesSol} SOL`;
  }
  if (Number.isFinite(top10Pct) && top10Pct > config.screening.maxTop10Pct) {
    return `top10 concentration ${top10Pct}% above maximum ${config.screening.maxTop10Pct}%`;
  }
  if (Number.isFinite(botPct) && botPct > config.screening.maxBotHoldersPct) {
    return `bot holders ${botPct}% above maximum ${config.screening.maxBotHoldersPct}%`;
  }
  if (!hasNarrative && smartWalletCount === 0) return "only candidate has no narrative and no smart-wallet confirmation";
  return null;
}

function computeBinsBelow(volatility) {
  const parsedVolatility = Number(volatility);
  if (!Number.isFinite(parsedVolatility) || parsedVolatility <= 0) {
    throw new Error(`Invalid volatility ${volatility ?? "unknown"} — refusing volatility-scaled deploy.`);
  }
  const lo = config.strategy.minBinsBelow;
  const hi = config.strategy.maxBinsBelow;
  return Math.max(lo, Math.min(hi, Math.round(lo + (parsedVolatility / 5) * (hi - lo))));
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isMain && isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });
  _ttyInterface = rl;

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 5 }),
    ]);

    setLatestCandidates(candidates);

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => { });

  startPolling(telegramHandler);

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    const latest = getLatestCandidatesMeta().candidates;
    if (!isNaN(pick) && pick >= 1 && pick <= latest.length) {
      await runBusy(async () => {
        const pool = latest[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates and deploy only if a candidate is clearly worth it. If there is only one weak candidate, report NO DEPLOY. For a valid deploy, use amount_y=${DEPLOY}, amount_x=0, bins_above=0, and bins_below from positive volatility. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        setLatestCandidates(candidates);
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBundlePct:         ${s.maxBundlePct}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel, null, { interactive: true });
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else if (isMain) {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => { });
  startPolling(telegramHandler);
  (async () => {
    try {
      await runScreeningCycle({ silent: false });
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
