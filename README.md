# Meridian

Autonomous Meteora DLMM liquidity management agent for Solana. LLM-driven screening, management, and self-learning.

## What It Does

- **Pool Screening**: Scan Meteora DLMM pools by thresholds (fee/TVL, organic, mcap, holders)
- **Position Management**: Monitor, claim fees, close positions autonomously
- **Self-Learning**: Study top LPers, evolve screening thresholds from performance
- **Multi-Interface**: Web UI + Discord listener + Telegram chat + CLI

## How It Works

Two specialized agents on independent cron schedules:

| Agent | Interval | Role |
|-------|----------|------|
| **Screening** | Every 30 min | Find best pools → deploy |
| **Management** | Every 10 min | Evaluate positions → act |

## Tech Stack

| Layer | Tech | Purpose |
|-------|------|---------|
| Runtime | Node.js 22+ (ESM) | Main daemon |
| LLM | OpenRouter | AI reasoning |
| Solana | @meteora-ag/dlmm | On-chain operations |
| Storage | JSON + SQLite | State management |

## Getting Started

```bash
git clone git@github.com:yunus-0x/meridian.git
cd meridian
npm install
npm run setup  # First-run wizard

# Run
npm start      # Daemon with REPL + cron
npm run dev    # Development mode
npm run pm2:start  # PM2 for always-on
```

## Config

Set `.env`:

```env
WALLET_PRIVATE_KEY=your_base58_private_key
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
OPENROUTER_API_KEY=sk-or-...
TELEGRAM_BOT_TOKEN=123456:ABC...
DRY_RUN=true
```

## Commands

```bash
# Portfolio & Status
/status /positions /balance /pool <addr>

# Learning & Intelligence
/lessons /study-pool <pool> /evolve /pool-compare <pair>

# Management
/screen /manage /close <n> /claim <position>
```

## Architecture

```
index.js (daemon)
└─ agentLoop (ReAct: LLM ↔ tool)
   ├─ SCREENER: finds pools, deploys
   └─ MANAGER: evaluates positions, acts
```

**Key Invariants:**
- Lazy SDK load (dynamic import)
- ONCE_PER_SESSION locks for critical operations
- Position cache with force:true for safety
- Deterministic rules + optional LLM decisions

## Warnings

⚠️ Autonomous trading — real financial risk. Always start with `DRY_RUN=true`.

**Disclaimer:** Not financial advice. You can lose funds. Use responsibly.