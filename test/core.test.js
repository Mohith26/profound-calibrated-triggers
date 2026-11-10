import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, mulberry32, normal } from '../src/generate.js';
import * as C from '../src/core.js';

const data = generate({ seed: 7 });
const agg = C.aggregate(data);
const { raw, monitored } = C.buildSeries(agg);
const cal = C.calibrate(monitored, { alpha: 0.1 });
const det = C.detect(monitored, cal);

test('generator is deterministic for a seed', () => {
  const again = generate({ seed: 7 });
  assert.deepEqual(Array.from(again.mention.slice(0, 5000)), Array.from(data.mention.slice(0, 5000)));
  assert.deepEqual(Array.from(again.cites.slice(-5000)), Array.from(data.cites.slice(-5000)));
  const other = generate({ seed: 8 });
  assert.notDeepEqual(Array.from(other.mention.slice(0, 5000)), Array.from(data.mention.slice(0, 5000)));
});

test('exact Shapley: efficiency and symmetry on a known game', () => {
  // v(S) = (|S|)^2 over 3 symmetric players: each gets v(N)/3
  const pc = (S) => { let c = 0; for (let x = S; x; x &= x - 1) c++; return c; };
  const r = C.shapley(3, (S) => pc(S) ** 2);
  r.phi.forEach((p) => assert.ok(Math.abs(p - 3) < 1e-12));
  // additive game: Shapley equals each player's own weight
  const w = [0.5, -2, 3, 0.25];
  const r2 = C.shapley(4, (S) => w.reduce((s, x, i) => s + (S & (1 << i) ? x : 0), 0));
  r2.phi.forEach((p, i) => assert.ok(Math.abs(p - w[i]) < 1e-12));
});

test('ridge logistic recovers known coefficients', () => {
  const rng = mulberry32(3), X = [], y = [], truth = [-0.4, 1.5, -1.0];
  for (let i = 0; i < 6000; i++) {
    const x = [1, rng() < 0.5 ? 1 : 0, normal(rng)];
    const z = x.reduce((s, v, j) => s + v * truth[j], 0);
    X.push(Float64Array.from(x)); y.push(rng() < 1 / (1 + Math.exp(-z)) ? 1 : 0);
  }
  const b = C.ridgeLogistic(X, y, y.map(() => 1), { lambda: 0.01 });
  truth.forEach((t, j) => assert.ok(Math.abs(b[j] - t) < 0.12, `coef ${j}: ${b[j]} vs ${t}`));
});

test('Level-1 split is exact: mix + sum(rate effects) == observed change', () => {
  const r = C.decompose(agg, { engines: [0, 1, 2, 3, 4], B: [30, 39], A: [40, 43], boot: 50 });
  assert.ok(Math.abs(r.checkSum) < 1e-12);
});

test('collector outage (E1) is attributed to coverage mix, not to visibility', () => {
  const r = C.decompose(agg, { engines: [0, 1, 2, 3, 4], B: [33, 39], A: [40, 43], boot: 200 });
  assert.ok(r.mix.significant, 'mix effect should be significant');
  assert.ok(Math.abs(r.mix.value) / Math.abs(r.delta.value) > 0.8, 'mix should explain most of the raw move');
});

test('calibrated triggers stay silent on the outage and catch both real shifts with accurate change points', () => {
  const s = C.scoreTriggers(det.alarms, data.cfg.events);
  assert.equal(s.caught, 2);
  assert.equal(s.falseFires, 0);
  assert.ok(!det.alarms.some((a) => a.day >= 40 && a.day <= 45), 'no trigger during the outage');
  const e2 = det.alarms.find((a) => a.series === 'engine:1'), e3 = det.alarms.find((a) => a.series === 'engine:0');
  assert.ok(Math.abs(e2.changeDay - 55) <= 3 && Math.abs(e3.changeDay - 72) <= 3);
});

test('naive 5% rule fires on the outage and on noise', () => {
  const fires = C.naiveTrigger(raw, { thr: 0.05 });
  assert.ok(fires.some((f) => f.day >= 40 && f.day <= 43));
  const s = C.scoreTriggers(fires.map((f) => ({ day: f.day, series: 'raw', direction: f.direction })), data.cfg.events);
  assert.ok(s.falseFires >= 5);
});

test('false-trigger budget holds on data with no planted events', () => {
  let withAlarm = 0; const n = 12;
  for (let seed = 200; seed < 200 + n; seed++) {
    const d = generate({ seed, events: [] }); const a = C.aggregate(d); const { monitored: m } = C.buildSeries(a);
    if (C.detect(m, C.calibrate(m, { alpha: 0.1, sims: 800 })).alarms.length) withAlarm++;
  }
  assert.ok(withAlarm / n <= 0.25, `false-trigger rate ${withAlarm}/${n}`);
});

test('attribution names the planted causes with CIs that exclude zero', () => {
  const e2 = det.alarms.find((a) => a.series === 'engine:1');
  const inv2 = C.investigate(data, agg, { engines: [1], B: [e2.changeDay - 14, e2.changeDay - 1], A: [e2.changeDay, e2.day + 7], boot: 200, boot2: 40 });
  const items2 = C.actionItems(inv2, data);
  const top2 = items2.slice(0, 2).map((i) => i.domain).sort();
  assert.deepEqual(top2, ['pipelinehq.com', 'stackreviews.com']);
  items2.slice(0, 2).forEach((i) => assert.ok(i.impact < 0 && i.ci[1] < 0));

  const e3 = det.alarms.find((a) => a.series === 'engine:0');
  const inv3 = C.investigate(data, agg, { engines: [0], B: [e3.changeDay - 14, e3.changeDay - 1], A: [e3.changeDay, Math.min(89, e3.day + 7)], boot: 200, boot2: 40 });
  const items3 = C.actionItems(inv3, data);
  assert.equal(items3[0].domain, 'larkspur.io');
  assert.ok(items3[0].impact > 0 && items3[0].ci[0] > 0);
});

test('agent payload has a stable idempotency key per change', () => {
  const a = det.alarms[0];
  const inv = C.investigate(data, agg, { engines: [1], B: [a.changeDay - 14, a.changeDay - 1], A: [a.changeDay, a.day], boot: 50, boot2: 10 });
  const p1 = C.agentPayload(a, inv, C.actionItems(inv, data), data, cal, (d) => String(d));
  const p2 = C.agentPayload({ ...a, day: a.day + 3 }, inv, [], data, cal, (d) => String(d));
  assert.equal(p1.idempotency_key, p2.idempotency_key);
  assert.match(p1.idempotency_key, /^[0-9a-f]{8}$/);
});
