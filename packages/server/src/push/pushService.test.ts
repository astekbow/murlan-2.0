import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryPushSubscriptions } from './pushRepository.ts';
import { PushService } from './pushService.ts';
import type { PushProvider, WebPushSubscription, PushPayload } from './pushProvider.ts';

class CapturingProvider implements PushProvider {
  readonly name = 'capture';
  sent: Array<{ endpoint: string; payload: PushPayload }> = [];
  gone = new Set<string>(); // endpoints to report as dead
  async send(sub: WebPushSubscription, payload: PushPayload) {
    if (this.gone.has(sub.endpoint)) return { ok: false, gone: true };
    this.sent.push({ endpoint: sub.endpoint, payload });
    return { ok: true };
  }
}

const sub = (endpoint: string): WebPushSubscription => ({ endpoint, p256dh: 'k', auth: 'a' });

test('notify delivers to every device a user has, and turn nudges carry a coalescing tag', async () => {
  const repo = new InMemoryPushSubscriptions();
  const provider = new CapturingProvider();
  const svc = new PushService(repo, provider);

  await svc.subscribe('u1', sub('https://push/aaa'));
  await svc.subscribe('u1', sub('https://push/bbb'));
  await svc.subscribe('u2', sub('https://push/ccc'));

  const sent = await svc.notifyTurn('u1');
  assert.equal(sent, 2); // both of u1's devices, not u2's
  assert.equal(provider.sent.length, 2);
  assert.ok(provider.sent.every((s) => s.payload.tag === 'murlan-turn'));
  assert.ok(provider.sent.every((s) => s.endpoint !== 'https://push/ccc'));
});

test('a dead subscription (provider reports gone) is pruned', async () => {
  const repo = new InMemoryPushSubscriptions();
  const provider = new CapturingProvider();
  const svc = new PushService(repo, provider);
  await svc.subscribe('u1', sub('https://push/dead'));
  provider.gone.add('https://push/dead');

  const sent = await svc.notify('u1', { title: 't', body: 'b' });
  assert.equal(sent, 0);
  assert.deepEqual(await repo.listByUser('u1'), []); // pruned
});

test('re-subscribing the same endpoint replaces (does not duplicate) the device', async () => {
  const repo = new InMemoryPushSubscriptions();
  const svc = new PushService(repo, new CapturingProvider());
  await svc.subscribe('u1', sub('https://push/same'));
  await svc.subscribe('u1', sub('https://push/same'));
  assert.equal((await repo.listByUser('u1')).length, 1);
});

test('unsubscribe removes the endpoint', async () => {
  const repo = new InMemoryPushSubscriptions();
  const svc = new PushService(repo, new CapturingProvider());
  await svc.subscribe('u1', sub('https://push/x'));
  await svc.unsubscribe('https://push/x');
  assert.equal((await repo.listByUser('u1')).length, 0);
});
