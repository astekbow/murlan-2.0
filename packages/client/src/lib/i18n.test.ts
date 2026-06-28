import { test } from 'vitest';
import assert from 'node:assert/strict';
import { translate, plural } from './i18n.ts';

test('translate returns the requested language', () => {
  assert.equal(translate('auth.login', 'sq'), 'HYR');
  assert.equal(translate('auth.login', 'en'), 'LOG IN');
  assert.equal(translate('nav.clubs', 'en'), 'CLUBS');
  assert.equal(translate('nav.clubs', 'sq'), 'KLUBET');
});

test('translate falls back to the key for unknown ids (never blank)', () => {
  assert.equal(translate('does.not.exist', 'en'), 'does.not.exist');
  assert.equal(translate('does.not.exist', 'sq'), 'does.not.exist');
});

test('every catalog entry has both sq and en (no blanks)', () => {
  // Probe a representative spread; each must be a non-empty string in both langs.
  for (const key of ['auth.tagline', 'settings.title', 'lobby.findMatch', 'nav.support', 'common.save', 'wallet.deposit', 'wallet.balance']) {
    assert.ok(translate(key, 'sq').length > 0, `${key} sq`);
    assert.ok(translate(key, 'en').length > 0, `${key} en`);
    assert.notEqual(translate(key, 'en'), key, `${key} should be translated, not the raw key`);
  }
});

test('translate interpolates {placeholders} from vars (unknown tokens left intact)', () => {
  assert.match(translate('wallet.selfExcludedUntil', 'en', { date: '2026-07-01' }), /2026-07-01/);
  assert.match(translate('wallet.selfExcludedUntil', 'sq', { date: '2026-07-01' }), /2026-07-01/);
  assert.match(translate('wallet.selfExcludedUntil', 'en'), /\{date\}/); // missing var → literal token, no crash
});

test('plural picks one vs other by count and binds {n}', () => {
  assert.equal(plural('common.gamesN', 1, 'en'), '1 game');
  assert.equal(plural('common.gamesN', 3, 'en'), '3 games');
  assert.equal(plural('common.gamesN', 0, 'en'), '0 games'); // 0 → other
  assert.equal(plural('common.gamesN', 1, 'sq'), '1 lojë');
  assert.equal(plural('common.gamesN', 2, 'sq'), '2 lojëra');
});
