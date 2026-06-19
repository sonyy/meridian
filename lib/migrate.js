#!/usr/bin/env node
// ─── One-time paper-positions.json → SQLite migration ────────────────────
// Usage: node lib/migrate.js
// Only migrates paper positions (virtual/simulation). Core stays JSON.
// Safe to re-run (idempotent — upserts by primary key).
// ─────────────────────────────────────────────────────────────────────────

import fs from "fs";
import { repoPath } from "../repo-root.js";
import { savePositions, getTableCounts, close } from "./db.js";

function loadJSON(name) {
  const p = repoPath(name);
  if (!fs.existsSync(p)) {
    console.log(`  [SKIP] ${name} — not found`);
    return null;
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function migrate() {
  console.log("Migrate paper-positions.json → SQLite\n");

  const paper = loadJSON("paper-positions.json");
  if (!paper?.positions) {
    console.log("No paper positions found.");
    close();
    return;
  }

  const data = { positions: {} };
  let n = 0;
  for (const [id, pos] of Object.entries(paper.positions)) {
    data.positions[id] = {
      ...pos,
      pool_address: pos.pool_address || pos.pool || id,
      pool_name: pos.pool_name || (pos.pool_address || id).slice(0, 8),
      pair: pos.pair || "?-SOL",
    };
    n++;
  }

  try {
    savePositions(data);
    const counts = getTableCounts();
    console.log(`  ${counts.paper_positions} paper positions saved to meridian.db`);
    console.log("\nDone.");
  } catch (e) {
    console.error("  FAILED:", e.message);
    process.exit(1);
  }

  close();
}

migrate();
