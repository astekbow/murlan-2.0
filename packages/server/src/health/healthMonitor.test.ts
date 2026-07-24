import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAlerts, parseCgroupLimit, DEFAULT_THRESHOLDS, type HealthSample } from './healthMonitor.ts';

const MB = 1024 * 1024;
const healthy: HealthSample = {
  lagMaxMs: 50, lagMeanMs: 5,
  heapUsedBytes: 500 * MB, heapLimitBytes: 1536 * MB,
  rssBytes: 800 * MB, rssLimitBytes: 2560 * MB,
};

test('buildAlerts: a healthy sample raises nothing', () => {
  assert.deepEqual(buildAlerts(healthy, DEFAULT_THRESHOLDS), []);
});

test('buildAlerts: an event-loop stall raises a loop alert with the duration', () => {
  const a = buildAlerts({ ...healthy, lagMaxMs: 2500 }, DEFAULT_THRESHOLDS);
  assert.equal(a.length, 1);
  assert.equal(a[0]!.kind, 'loop');
  assert.match(a[0]!.text, /2\.5s/);
});

test('buildAlerts: heap ≥ 90% of the V8 cap raises a heap alert', () => {
  const a = buildAlerts({ ...healthy, heapUsedBytes: 1400 * MB }, DEFAULT_THRESHOLDS); // 1400/1536 ≈ 91%
  assert.ok(a.some((x) => x.kind === 'heap'), 'heap alert expected');
});

test('buildAlerts: RSS ≥ 90% of the cgroup limit raises an rss alert', () => {
  const a = buildAlerts({ ...healthy, rssBytes: 2400 * MB }, DEFAULT_THRESHOLDS); // 2400/2560 ≈ 94%
  assert.ok(a.some((x) => x.kind === 'rss'), 'rss alert expected');
});

test('buildAlerts: no rss alert when the cgroup limit is unknown', () => {
  const a = buildAlerts({ ...healthy, rssBytes: 9999 * MB, rssLimitBytes: null }, DEFAULT_THRESHOLDS);
  assert.ok(!a.some((x) => x.kind === 'rss'), 'must not alert on RSS without a known limit');
});

test('buildAlerts: the context line is appended to an alert', () => {
  const a = buildAlerts({ ...healthy, lagMaxMs: 3000 }, DEFAULT_THRESHOLDS, 'Ndeshje aktive: 5');
  assert.match(a[0]!.text, /Ndeshje aktive: 5/);
});

test('parseCgroupLimit: numbers, the "max" sentinel, and garbage', () => {
  assert.equal(parseCgroupLimit('2684354560'), 2684354560); // 2560m
  assert.equal(parseCgroupLimit('max'), null);              // cgroup v2 unlimited
  assert.equal(parseCgroupLimit(''), null);
  assert.equal(parseCgroupLimit('9223372036854771712'), null); // cgroup v1 "unlimited" sentinel
  assert.equal(parseCgroupLimit('nonsense'), null);
});
