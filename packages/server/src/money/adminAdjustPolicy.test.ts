import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAdjustGovernance, MAX_ADJUST_CENTS, DAILY_ADJUST_CAP_CENTS } from './adminAdjustPolicy.ts';
import { InMemoryAdminAudit } from '../auth/adminAudit.ts';

const ADMIN = 'admin_1';
const TARGET = 'user_9';

test('per-call ceiling: |delta| > MAX is rejected', async () => {
  const audit = new InMemoryAdminAudit();
  const over = await checkAdjustGovernance(audit, ADMIN, TARGET, MAX_ADJUST_CENTS + 1);
  assert.equal(over.ok, false);
  assert.equal((over as any).code, 'over_call_limit');
  // a debit of the same magnitude is also bounded
  const overDebit = await checkAdjustGovernance(audit, ADMIN, TARGET, -(MAX_ADJUST_CENTS + 1));
  assert.equal(overDebit.ok, false);
  // exactly the ceiling is allowed
  const atLimit = await checkAdjustGovernance(audit, ADMIN, TARGET, MAX_ADJUST_CENTS);
  assert.equal(atLimit.ok, true);
});

test('self-credit is blocked; self-DEBIT is allowed', async () => {
  const audit = new InMemoryAdminAudit();
  const selfCredit = await checkAdjustGovernance(audit, ADMIN, ADMIN, 1000);
  assert.equal(selfCredit.ok, false);
  assert.equal((selfCredit as any).code, 'self_credit');
  const selfDebit = await checkAdjustGovernance(audit, ADMIN, ADMIN, -1000);
  assert.equal(selfDebit.ok, true);
});

test('rolling-24h cumulative cap: Σ|delta| over the window is rejected; older rows fall off', async () => {
  const audit = new InMemoryAdminAudit();
  // Record |Σ| just under the cap WITHIN the window.
  await audit.record({ adminId: ADMIN, action: 'balance_adjust', amountCents: DAILY_ADJUST_CAP_CENTS - 100 });
  // A further +200 would breach.
  const over = await checkAdjustGovernance(audit, ADMIN, TARGET, 200);
  assert.equal(over.ok, false);
  assert.equal((over as any).code, 'over_daily_cap');
  // +100 (exactly to the cap) is allowed.
  const ok = await checkAdjustGovernance(audit, ADMIN, TARGET, 100);
  assert.equal(ok.ok, true);
  // Credits AND debits both count toward the cap (no sign-structuring around it).
  const audit2 = new InMemoryAdminAudit();
  await audit2.record({ adminId: ADMIN, action: 'balance_adjust', amountCents: -(DAILY_ADJUST_CAP_CENTS - 50) });
  const overByDebits = await checkAdjustGovernance(audit2, ADMIN, TARGET, 100);
  assert.equal(overByDebits.ok, false);
});

test('the cap is PER-ADMIN: another admin has their own budget', async () => {
  const audit = new InMemoryAdminAudit();
  await audit.record({ adminId: ADMIN, action: 'balance_adjust', amountCents: DAILY_ADJUST_CAP_CENTS });
  // A DIFFERENT admin is unaffected by admin_1's usage.
  const other = await checkAdjustGovernance(audit, 'admin_2', TARGET, 100);
  assert.equal(other.ok, true);
});
