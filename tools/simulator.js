/**
 * tools/simulator.js
 * Tool-layer wrappers for the paper position simulator.
 * Core logic lives in paper-positions.js.
 */

import {
  openPaperPosition,
  getPaperPosition,
  closePaperPosition,
  listPaperPositions,
} from "../paper-positions.js";

export async function open_paper_position(args) {
  return openPaperPosition(args);
}

export async function get_paper_position({ id }) {
  return getPaperPosition(id);
}

export async function close_paper_position({ id, reason }) {
  return closePaperPosition(id, reason ?? null);
}

export async function list_paper_positions() {
  return listPaperPositions();
}
