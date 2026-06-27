import test from 'node:test';
import assert from 'node:assert/strict';
import { FairnessCoordinator } from './fairnessCoordinator.ts';
import type { FairShuffle } from '../fair/provablyFair.ts';

const stubShuffle = (id: string): FairShuffle => ({ id } as unknown as FairShuffle);

test('client seeds: record/read/drop', () => {
  const f = new FairnessCoordinator();
  assert.equal(f.clientSeed('u'), undefined);
  f.recordClientSeed('u', 'abc');
  assert.equal(f.clientSeed('u'), 'abc');
  f.dropClientSeed('u');
  assert.equal(f.clientSeed('u'), undefined);
});

test('server seed: commit/read/abandon', () => {
  const f = new FairnessCoordinator();
  f.commitServerSeed('r', 'srv');
  assert.equal(f.pendingServerSeed('r'), 'srv');
  f.abandonServerSeed('r');
  assert.equal(f.pendingServerSeed('r'), undefined);
});

test('recordDeal: stores the shuffle AND consumes the pending server seed in one step', () => {
  const f = new FairnessCoordinator();
  f.commitServerSeed('r', 'srv');
  const sh = stubShuffle('r');
  f.recordDeal('r', sh);
  assert.equal(f.shuffle('r'), sh);
  assert.equal(f.pendingServerSeed('r'), undefined); // pending seed consumed
});

test('reveal: shuffle then clearShuffle drops it', () => {
  const f = new FairnessCoordinator();
  f.recordDeal('r', stubShuffle('r'));
  assert.ok(f.shuffle('r'));
  f.clearShuffle('r');
  assert.equal(f.shuffle('r'), undefined);
});

test('seeds do not bleed across rooms/users', () => {
  const f = new FairnessCoordinator();
  f.commitServerSeed('r1', 's1');
  f.commitServerSeed('r2', 's2');
  f.recordClientSeed('u1', 'c1');
  assert.equal(f.pendingServerSeed('r1'), 's1');
  assert.equal(f.pendingServerSeed('r2'), 's2');
  assert.equal(f.clientSeed('u2'), undefined);
});
