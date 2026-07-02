// ============================================================================
// MURLAN — Bot decision WORKER (runs decideBotMove off the main event loop)
// ----------------------------------------------------------------------------
// Entry file for a worker_threads thread spawned by BotWorkerPool. The Hard/Medium
// PIMC search is a synchronous CPU burst (~40-130ms per decision); on the main
// thread it would block EVERY room's sockets and timers for its full duration.
// Here it runs on a spare core instead, so bot-heavy tables scale with the host's
// cores while the event loop stays free for real players.
//
// Protocol (structured-clone messages, matched by id):
//   in : { id: number, view: BotView, tier: BotTier }
//   out: { id: number, ok: true, move: BotMove } | { id: number, ok: false, error: string }
//
// decideBotMove is PURE plain-data-in/plain-data-out (rng defaults to Math.random
// inside this thread), so cloning the view/move across the thread boundary is safe.
// ============================================================================

import { parentPort } from 'node:worker_threads';
import { decideBotMove, type BotTier, type BotView } from './botDecision.ts';

const port = parentPort;
if (port) {
  port.on('message', (msg: { id: number; view: BotView; tier: BotTier }) => {
    try {
      port.postMessage({ id: msg.id, ok: true, move: decideBotMove(msg.view, msg.tier) });
    } catch (err) {
      port.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
