// Storage for browser Web Push subscriptions (endpoint + keys), keyed by user.
// Interface + in-memory impl (the Prisma impl mirrors it). Standalone — userId is
// a soft string id (no FK), like the suspicion/move-log tables.

import type { WebPushSubscription } from './pushProvider.ts';

export interface PushSubscriptionRecord extends WebPushSubscription {
  id: string;
  userId: string;
  createdAt: number;
}

export interface PushSubscriptionRepository {
  /** Upsert by endpoint (a device re-subscribing replaces its row). */
  add(userId: string, sub: WebPushSubscription): Promise<void>;
  /** Remove one subscription by endpoint (logout / unsubscribe). */
  removeByEndpoint(endpoint: string): Promise<void>;
  /** All subscriptions for a user (a user may have several devices). */
  listByUser(userId: string): Promise<PushSubscriptionRecord[]>;
}

export class InMemoryPushSubscriptions implements PushSubscriptionRepository {
  private byEndpoint = new Map<string, PushSubscriptionRecord>();
  private seq = 0;

  async add(userId: string, sub: WebPushSubscription): Promise<void> {
    const existing = this.byEndpoint.get(sub.endpoint);
    this.byEndpoint.set(sub.endpoint, {
      id: existing?.id ?? `psub_${(this.seq += 1)}`,
      userId,
      endpoint: sub.endpoint,
      p256dh: sub.p256dh,
      auth: sub.auth,
      createdAt: existing?.createdAt ?? Date.now(),
    });
  }

  async removeByEndpoint(endpoint: string): Promise<void> {
    this.byEndpoint.delete(endpoint);
  }

  async listByUser(userId: string): Promise<PushSubscriptionRecord[]> {
    return [...this.byEndpoint.values()].filter((s) => s.userId === userId).map((s) => ({ ...s }));
  }
}
