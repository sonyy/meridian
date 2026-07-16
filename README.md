# Meridian

Autonomous Meteora DLMM liquidity management agent for Solana. LLM-driven screening, management, and autonomous trading.

## What It Does

- **Pool Screening**: Continuous scanning of Meteora pools by thresholds
- **Position Management**: Automated monitoring/close/redeploy based on PnL
- **Self-Learning**: Evolves thresholds from closed position performance
- **Multi-Interface**: Web UI + Discord listener + Telegram chat + CLI
- **Two Agents**: SCREENING (30min) + MANAGEMENT (10min) cycles

## Tech Stack

| Layer | Tech | Purpose |
|-------|------|---------|
| Runtime | Node.js 22+ (ESM) | Main daemon |
| LLM | OpenRouter (GPT-4/Claude) | AI reasoning |
| Storage | JSON files | Per-pool memory & lessons |
| Solana | @meteora-ag/dlmm | On-chain operations |
| Database | SQLite | Positions registry |

## Architecture

```
index.js (daemon)
└─ agentLoop (ReAct: LLM ↔ tool)
   ├─ SCREENER: finds pools, deploys
   └─ MANAGER: evaluates positions, acts
```

**Critical invariants:**
- Lazy SDK load (@meteora-ag/dlmm dynamic import)
- ONCE_PER_SESSION locks for DEPLOY / SWAP / CLOSE
- Position-cache TTL (5 min) + force: true for safety
- Deterministic management (5 hard rules) + optional LLM

## Getting Started

```bash
git clone git@github.com:sonyy/meridian.git
cd meridian
npm install
npm run setup  # First-run wizard
```

Set `.env` (.gitignored):

```env
WALLET_PRIVATE_KEY=your_base58_private_key
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
OPENROUTER_API_KEY=sk-or-...
TELEGRAM_BOT_TOKEN=123456:ABC...      # optional
DRY_RUN=true                             # set false for live
```

Copy and edit:

```bash
cp user-config.example.json user-config.json
```

### Entry Points

```bash
npm start          # Full daemon (REPL + cron + Telegram)
npm run pm2:start  # PM2 for always-on (VPS)
node cli.js <cmd>  # One-shot CLI operations
```

### Commands

```
# Portfolio & Status
/status /positions /balance /pool <addr>

# Learning & Intelligence
/lessons /study-pool <pool> /evolve /pool-compare <pair>

# Management
/screen /manage /close <n> /claim <position>

# Discord listener (standalone)
cd discord-listener && npm start
```

## Development

```bash
npm run dev    # Hot reload
node cli.js positions
node cli.js screen --dry-run
```

## Warnings

- This software carries real financial risk
- Use DRY_RUN=true to verify before live execution
- Secrets in `.env`; config in `user-config.json`

**Disclaimer:** Autonomous trading — lose funds possible. Not financial advice.