// ============================================================================
// MURLAN — Push service (re-engagement notifications)
// ----------------------------------------------------------------------------
// Subscribes/unsubscribes devices and delivers notifications through the
// PushProvider seam. Outbound re-engagement only (turn / match / reward nudges);
// never touches money, scoring, or the rules engine. Dead subscriptions (the
// provider reports `gone`) are pruned so the table self-heals.
// ============================================================================

import type { PushProvider, WebPushSubscription, PushPayload } from './pushProvider.ts';
import type { PushSubscriptionRepository } from './pushRepository.ts';

export class PushService {
  constructor(
    private readonly repo: PushSubscriptionRepository,
    private readonly provider: PushProvider,
  ) {}

  subscribe(userId: string, sub: WebPushSubscription): Promise<void> {
    return this.repo.add(userId, sub);
  }

  unsubscribe(endpoint: string): Promise<void> {
    return this.repo.removeByEndpoint(endpoint);
  }

  /** Send a payload to every device a user has registered; prune dead endpoints. */
  async notify(userId: string, payload: PushPayload): Promise<number> {
    const subs = await this.repo.listByUser(userId);
    let sent = 0;
    for (const sub of subs) {
      const res = await this.provider.send(sub, payload).catch(() => ({ ok: false, gone: false }));
      if (res.ok) sent += 1;
      else if (res.gone) await this.repo.removeByEndpoint(sub.endpoint).catch(() => undefined);
    }
    return sent;
  }

  /** "It's your turn" nudge — fired when the turn passes to an away player. */
  notifyTurn(userId: string): Promise<number> {
    return this.notify(userId, {
      title: 'Radha jote në Murlan',
      body: 'Po të presin në tavolinë — kthehu para se të skadojë koha!',
      url: '/',
      tag: 'murlan-turn', // coalesce: a newer turn nudge replaces the old one
    });
  }
}
