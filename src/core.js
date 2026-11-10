// Calibrated visibility-shift triggers + counterfactual attribution.
// Pure functions over the dataset produced by generate.js (or any data with the same shape).
import { mulberry32 } from './generate.js';

// ---------- aggregation ----------
export function aggregate(data) {
  const { E, P, R, DAYS, ok, mention } = data;
  const M = new Float64Array(DAYS * E * P), N = new Float64Array(DAYS * E * P);
  for (let day = 0; day < DAYS; day++) for (let e = 0; e < E; e++) for (let p = 0; p < P; p++) {
    let m = 0, n = 0;
    const base = ((day * E + e) * P + p) * R;
    for (let r = 0; r < R; r++) { if (ok[base + r]) { n++; m += mention[base + r]; } }
    const j = (day * E + e) * P + p; M[j] = m; N[j] = n;
  }
  return { M, N, E, P, R, DAYS, promptTopic: data.promptTopic, T: data.T };
}

// visibility + cluster-robust sampling variance (clusters = prompt runs on one engine/day)
function engineDay(agg, day, e) {
  const { M, N, P, E } = agg;
  let sm = 0, sn = 0, k = 0;
  for (let p = 0; p < P; p++) { const j = (day * E + e) * P + p; sm += M[j]; sn += N[j]; if (N[j] > 0) k++; }
  if (sn === 0) return { V: NaN, v: NaN, n: 0 };
  const V = sm / sn;
  let ss = 0;
  for (let p = 0; p < P; p++) { const j = (day * E + e) * P + p; const r = M[j] - V * N[j]; ss += r * r; }
  return { V, v: (k / Math.max(1, k - 1)) * ss / (sn * sn), n: sn };
}

// Series: raw overall visibility (what the dashboard shows), mix-standardized overall
// (fixed equal engine weights, immune to coverage swings), and one series per engine.
export function buildSeries(agg) {
  const { E, DAYS, M, N, P } = agg;
  const raw = { id: 'raw', V: [], v: [], n: [] };
  const std = { id: 'overall', label: 'All engines (mix-standardized)', V: [], v: [] };
  const eng = Array.from({ length: E }, (_, e) => ({ id: 'engine:' + e, engine: e, V: [], v: [], n: [] }));
  for (let day = 0; day < DAYS; day++) {
    let sV = 0, sv = 0, cnt = 0;
    for (let e = 0; e < E; e++) {
      const r = engineDay(agg, day, e);
      eng[e].V.push(r.V); eng[e].v.push(r.v); eng[e].n.push(r.n);
      if (r.n > 0) { sV += r.V; sv += r.v; cnt++; }
    }
    std.V.push(sV / cnt); std.v.push(sv / (cnt * cnt));
    let sm = 0, sn = 0;
    for (let e = 0; e < E; e++) for (let p = 0; p < P; p++) { const j = (day * E + e) * P + p; sm += M[j]; sn += N[j]; }
    const Vr = sm / sn; let ss = 0, k = 0;
    for (let e = 0; e < E; e++) for (let p = 0; p < P; p++) { const j = (day * E + e) * P + p; if (N[j] > 0) k++; const r = M[j] - Vr * N[j]; ss += r * r; }
    raw.V.push(Vr); raw.v.push((k / (k - 1)) * ss / (sn * sn)); raw.n.push(sn);
  }
  return { raw, monitored: [std, ...eng] };
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const variance = (a) => { const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); };

// noise model per series from the baseline window: total day variance = tau^2 (day-level, answer-engine drift) + v_t (sampling)
export function noiseModel(series, baselineEnd) {
  const Vb = series.V.slice(0, baselineEnd), vb = series.v.slice(0, baselineEnd);
  const mu0 = mean(Vb);
  const tau2 = Math.max(0, variance(Vb) - mean(vb));
  const z = Vb.map((x, i) => (x - mu0) / Math.sqrt(tau2 + vb[i]));
  return { mu0, tau2, zBaseline: z };
}

// ---------- calibration: choose CUSUM threshold h so P(any false trigger across all series in a quarter) <= alpha ----------
export function calibrate(monitored, { baselineEnd = 35, horizon = 90, k = 0.75, alpha = 0.1, sims = 2000, seed = 11 } = {}) {
  const models = monitored.map((s) => noiseModel(s, baselineEnd));
  const rng = mulberry32(seed);
  const S = models.length, maxStats = new Float64Array(sims);
  for (let i = 0; i < sims; i++) {
    const sp = new Float64Array(S), sn = new Float64Array(S);
    // re-run the plug-in estimation step too: a bootstrap baseline gives the mean/scale error the live detector inherits
    const m = new Float64Array(S), sc = new Float64Array(S);
    const bIdx = Array.from({ length: baselineEnd }, () => Math.floor(rng() * baselineEnd));
    for (let s = 0; s < S; s++) {
      const zs = bIdx.map((b) => models[s].zBaseline[b]);
      m[s] = mean(zs); sc[s] = Math.sqrt(Math.max(1e-6, variance(zs)));
    }
    let mx = 0;
    for (let t = 0; t < horizon; t++) {
      const b = Math.floor(rng() * baselineEnd); // resample whole days jointly: keeps cross-series correlation
      for (let s = 0; s < S; s++) {
        const z = (models[s].zBaseline[b] - m[s]) / sc[s];
        sp[s] = Math.max(0, sp[s] + z - k); sn[s] = Math.max(0, sn[s] - z - k);
        if (sp[s] > mx) mx = sp[s]; if (sn[s] > mx) mx = sn[s];
      }
    }
    maxStats[i] = mx;
  }
  const sorted = Array.from(maxStats).sort((a, b) => a - b);
  const h = sorted[Math.min(sims - 1, Math.ceil((1 - alpha) * sims))];
  return { h, k, alpha, horizon, sims, models, nullMax: sorted };
}

// ---------- online two-sided CUSUM with change-point estimate and re-baselining ----------
export function detect(monitored, cal, { baselineEnd = 35, learn = 10 } = {}) {
  const alarms = [], traces = [];
  monitored.forEach((s, si) => {
    const { tau2 } = cal.models[si];
    let mu0 = cal.models[si].mu0, regimeStart = 0, sp = 0, sn = 0, lastZeroP = baselineEnd - 1, lastZeroN = baselineEnd - 1, resumeAt = baselineEnd;
    const zt = new Array(s.V.length).fill(null), cp = new Array(s.V.length).fill(null), cn = new Array(s.V.length).fill(null);
    const muT = new Array(s.V.length).fill(null), sdT = new Array(s.V.length).fill(null);
    for (let t = baselineEnd; t < s.V.length; t++) {
      if (t < resumeAt) continue;
      if (t === resumeAt && t > baselineEnd) { sp = 0; sn = 0; lastZeroP = t - 1; lastZeroN = t - 1; }
      const z = (s.V[t] - mu0) / Math.sqrt(tau2 + s.v[t]);
      zt[t] = z; muT[t] = mu0; sdT[t] = Math.sqrt(tau2 + s.v[t]);
      sp = Math.max(0, sp + z - cal.k); sn = Math.max(0, sn - z - cal.k);
      if (sp === 0) lastZeroP = t; if (sn === 0) lastZeroN = t;
      cp[t] = sp; cn[t] = sn;
      if (sp > cal.h || sn > cal.h) {
        const up = sp > cal.h;
        // change-point MLE (two-segment mean shift, unknown means): argmax_tau n1*n2/(n1+n2) * (mean_after - mean_before)^2
        let best = -1, changeDay = (up ? lastZeroP : lastZeroN) + 1;
        const s0 = Math.max(regimeStart, t - 60);
        for (let tau = s0 + 5; tau <= t; tau++) {
          let a1 = 0, a2 = 0; const n1 = tau - s0, n2 = t - tau + 1;
          for (let i = s0; i < tau; i++) a1 += s.V[i];
          for (let i = tau; i <= t; i++) a2 += s.V[i];
          const d = a2 / n2 - a1 / n1;
          if ((up && d <= 0) || (!up && d >= 0)) continue;
          const st = (n1 * n2 / (n1 + n2)) * d * d;
          if (st > best) { best = st; changeDay = tau; }
        }
        alarms.push({ series: s.id, seriesIndex: si, day: t, changeDay, direction: up ? 'up' : 'down', stat: up ? sp : sn, mu0 });
        const learnEnd = Math.max(t, changeDay + learn - 1);
        if (learnEnd + 1 < s.V.length) mu0 = mean(s.V.slice(changeDay, learnEnd + 1));
        resumeAt = learnEnd + 1; regimeStart = changeDay;
      }
    }
    traces.push({ id: s.id, z: zt, cusumUp: cp, cusumDown: cn, mu: muT, sd: sdT });
  });
  alarms.sort((a, b) => a.day - b.day || a.seriesIndex - b.seriesIndex);
  return { alarms, traces };
}

// The status-quo style rule: fire when visibility moves >= thr (relative) vs the trailing 7-day mean.
export function naiveTrigger(raw, { thr = 0.05, from = 35, window = 7 } = {}) {
  const fires = [];
  for (let t = Math.max(from, window); t < raw.V.length; t++) {
    const ref = mean(raw.V.slice(t - window, t));
    const rel = (raw.V[t] - ref) / ref;
    if (Math.abs(rel) >= thr) fires.push({ day: t, rel, direction: rel > 0 ? 'up' : 'down' });
  }
  return fires;
}

// score triggers against planted ground truth (only meaningful on synthetic data)
// fires: [{day, series, changeDay?}] where series is 'raw' | 'overall' | 'engine:<i>'
// a fire "catches" a planted event if it points at the right series and its (estimated) change day lands near the true start
export function scoreTriggers(fires, events, tol = 10) {
  const real = events.filter((e) => e.kind !== 'coverage');
  const caught = new Map(); let falseCount = 0;
  for (const f of fires) {
    const d = f.changeDay ?? f.day, eng = f.series && f.series.startsWith('engine:') ? +f.series.split(':')[1] : null;
    const hit = real.find((e) => d >= e.start - 3 && d <= e.start + tol && f.day >= e.start && (eng === null || eng === e.engine) && (!f.direction || !e.direction || f.direction === e.direction));
    if (hit) { if (!caught.has(hit.id)) caught.set(hit.id, f.day - hit.start); } else falseCount++;
  }
  const delays = [...caught.values()];
  return { fired: fires.length, caught: caught.size, realEvents: real.length, falseFires: falseCount, caughtIds: [...caught.keys()], meanDelay: delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : null };
}

// ---------- Level 1: where did it move? exact Shapley split of a ratio change into coverage-mix and per-cell rate effects ----------
function cellSums(agg, engines, w, d0, d1, wd = null) {
  const { E, P, T, M, N, promptTopic } = agg;
  const m = new Float64Array(E * T), n = new Float64Array(E * T);
  for (let day = d0; day <= d1; day++) {
    const dw = wd ? wd[day] : 1; if (!dw) continue;
    for (const e of engines) for (let p = 0; p < P; p++) {
      if (!w[p]) continue;
      const j = (day * E + e) * P + p, c = e * T + promptTopic[p], ww = w[p] * dw;
      m[c] += ww * M[j]; n[c] += ww * N[j];
    }
  }
  return { m, n };
}

function splitChange(agg, engines, w, B, A, wd = null) {
  const { E, T } = agg;
  const b = cellSums(agg, engines, w, B[0], B[1], wd), a = cellSums(agg, engines, w, A[0], A[1], wd);
  let nB = 0, nA = 0, mB = 0, mA = 0;
  for (let c = 0; c < E * T; c++) { nB += b.n[c]; nA += a.n[c]; mB += b.m[c]; mA += a.m[c]; }
  const rate = new Float64Array(E * T); let mix = 0;
  for (const e of engines) for (let t = 0; t < T; t++) {
    const c = e * T + t;
    if (b.n[c] === 0 && a.n[c] === 0) continue;
    const rB = b.n[c] ? b.m[c] / b.n[c] : a.m[c] / a.n[c];
    const rA = a.n[c] ? a.m[c] / a.n[c] : rB;
    const sB = b.n[c] / nB, sA = a.n[c] / nA;
    mix += (sA - sB) * (rA + rB) / 2;
    rate[c] = (rA - rB) * (sA + sB) / 2;
  }
  return { VB: mB / nB, VA: mA / nA, delta: mA / nA - mB / nB, mix, rate };
}

function promptBootstrapWeights(agg, rng) {
  // resample prompts with replacement within each topic (prompts are the sampling unit of the tracked prompt set)
  const { P, promptTopic, T } = agg;
  const w = new Float64Array(P), byTopic = Array.from({ length: T }, () => []);
  for (let p = 0; p < P; p++) byTopic[promptTopic[p]].push(p);
  for (const list of byTopic) for (let i = 0; i < list.length; i++) w[list[Math.floor(rng() * list.length)]] += 1;
  return w;
}

// two-way (prompt x day) bootstrap: also resample days inside each window, because answer engines drift day to day
export function dayBootstrapWeights(days, windows, rng) {
  const wd = new Float64Array(days);
  for (const [d0, d1] of windows) { const L = d1 - d0 + 1; for (let i = 0; i < L; i++) wd[d0 + Math.floor(rng() * L)] += 1; }
  return wd;
}

const zFor = (twoSidedAlpha) => { // inverse normal via bisection on erf approximation
  const cdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
  let lo = 0, hi = 10; for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (1 - cdf(mid) > twoSidedAlpha / 2) lo = mid; else hi = mid; } return (lo + hi) / 2;
};
function erf(x) { // Abramowitz-Stegun 7.1.26
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
export { zFor };

export function decompose(agg, { engines, B, A, boot = 400, seed = 5, fdr = 0.1, minDays = 3 }) {
  const ones = new Float64Array(agg.P).fill(1);
  const est = splitChange(agg, engines, ones, B, A);
  const rng = mulberry32(seed);
  const reps = [];
  for (let i = 0; i < boot; i++) { const w = promptBootstrapWeights(agg, rng); reps.push(splitChange(agg, engines, w, B, A, dayBootstrapWeights(agg.DAYS, [B, A], rng))); }
  const se = (f) => Math.sqrt(variance(reps.map(f)));
  const cellsUsed = [];
  for (const e of engines) for (let t = 0; t < agg.T; t++) cellsUsed.push(e * agg.T + t);
  const cells = cellsUsed.map((c) => {
    const s = se((r) => r.rate[c]);
    const pval = s > 0 ? 2 * (1 - 0.5 * (1 + erf(Math.abs(est.rate[c]) / s / Math.SQRT2))) : 1;
    return { cell: c, engine: Math.floor(c / agg.T), topic: c % agg.T, value: est.rate[c], se: s, p: pval, ci: [est.rate[c] - 1.96 * s, est.rate[c] + 1.96 * s], significant: false };
  });
  // Benjamini-Hochberg at q = fdr across the cells of this series (many engine x topic cells are tested at once)
  const byP = [...cells].sort((a, b) => a.p - b.p);
  let kmax = 0; byP.forEach((c, i) => { if (c.p <= ((i + 1) / byP.length) * fdr) kmax = i + 1; });
  // with fewer than minDays per window the day-level resampling degenerates and cell tests would be anti-conservative
  const enoughDays = (A[1] - A[0] + 1) >= minDays && (B[1] - B[0] + 1) >= minDays;
  if (enoughDays) byP.slice(0, kmax).forEach((c) => { c.significant = true; });
  cells.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const mixSe = se((r) => r.mix), dSe = se((r) => r.delta);
  return {
    B, A, engines, VB: est.VB, VA: est.VA,
    delta: { value: est.delta, se: dSe, ci: [est.delta - 1.96 * dSe, est.delta + 1.96 * dSe] },
    mix: { value: est.mix, se: mixSe, ci: [est.mix - 1.96 * mixSe, est.mix + 1.96 * mixSe], significant: Math.abs(est.mix) > 1.96 * mixSe },
    cells, fdr, enoughDays,
    checkSum: est.mix + Array.from(est.rate).reduce((s, x) => s + x, 0) - est.delta,
  };
}

export function coverage(data, engine, d0, d1) {
  const { E, P, R, ok } = data; let k = 0, n = 0;
  for (let day = d0; day <= d1; day++) for (let p = 0; p < P; p++) for (let r = 0; r < R; r++) { n++; k += ok[((day * E + engine) * P + p) * R + r]; }
  return k / n;
}

// ---------- Level 2: why? counterfactual Shapley over citation-set changes ----------
export function ridgeLogistic(X, y, wts, { lambda = 1, iters = 25, init = null } = {}) {
  const n = X.length, d = X[0].length;
  let beta = init ? Float64Array.from(init) : new Float64Array(d);
  for (let it = 0; it < iters; it++) {
    const H = Array.from({ length: d }, () => new Float64Array(d)), g = new Float64Array(d);
    for (let i = 0; i < n; i++) {
      if (!wts[i]) continue;
      const xi = X[i]; let z = 0; for (let j = 0; j < d; j++) z += xi[j] * beta[j];
      const p = 1 / (1 + Math.exp(-z)), w = wts[i] * p * (1 - p), r = wts[i] * (y[i] - p);
      for (let j = 0; j < d; j++) { if (!xi[j]) continue; g[j] += xi[j] * r; const a = w * xi[j]; for (let l = j; l < d; l++) H[j][l] += a * xi[l]; }
    }
    for (let j = 0; j < d; j++) { for (let l = 0; l < j; l++) H[j][l] = H[l][j]; if (j > 0) { H[j][j] += lambda; g[j] -= lambda * beta[j]; } else H[j][j] += 1e-6; }
    const step = solveSPD(H, g);
    let mx = 0; for (let j = 0; j < d; j++) { beta[j] += step[j]; mx = Math.max(mx, Math.abs(step[j])); }
    if (mx < 1e-7) break;
  }
  return beta;
}

export function solveSPD(A, b) { // Cholesky
  const n = b.length, L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = A[i][j]; for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
    if (i === j) L[i][i] = Math.sqrt(Math.max(s, 1e-12)); else L[i][j] = s / L[j][j];
  }
  const yv = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * yv[k]; yv[i] = s / L[i][i]; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = yv[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
  return x;
}

// exact Shapley values for a small player set given a value function over bitmask coalitions
export function shapley(nPlayers, v) {
  const vals = new Float64Array(1 << nPlayers);
  for (let S = 0; S < (1 << nPlayers); S++) vals[S] = v(S);
  const fact = [1]; for (let i = 1; i <= nPlayers; i++) fact[i] = fact[i - 1] * i;
  const phi = new Float64Array(nPlayers);
  for (let i = 0; i < nPlayers; i++) for (let S = 0; S < (1 << nPlayers); S++) {
    if (S & (1 << i)) continue;
    let s = 0; for (let x = S; x; x &= x - 1) s++;
    phi[i] += fact[s] * fact[nPlayers - s - 1] / fact[nPlayers] * (vals[S | (1 << i)] - vals[S]);
  }
  return { phi, vEmpty: vals[0], vFull: vals[(1 << nPlayers) - 1] };
}

export function explainGroup(data, { engine, topics, B, A, K = 5, boot = 80, seed = 9, lambda = 1 }) {
  const { E, P, R, D, ok, mention, cites, promptTopic } = data;
  const tIndex = new Map(topics.map((t, i) => [t, i]));
  const rows = []; // {p, day, t, mask, post, y}
  for (const [d0, d1, post] of [[B[0], B[1], 0], [A[0], A[1], 1]]) {
    for (let day = d0; day <= d1; day++) for (let p = 0; p < P; p++) {
      if (!tIndex.has(promptTopic[p])) continue;
      for (let r = 0; r < R; r++) { const k = ((day * E + engine) * P + p) * R + r; if (ok[k]) rows.push({ p, day, t: tIndex.get(promptTopic[p]), mask: cites[k], post, y: mention[k] }); }
    }
  }
  const nT = topics.length, dim = 1 + (nT - 1) + D + 1;
  const X = rows.map((r) => { const x = new Float64Array(dim); x[0] = 1; if (r.t > 0) x[r.t] = 1; for (let d = 0; d < D; d++) if (r.mask & (1 << d)) x[nT + d] = 1; x[dim - 1] = r.post; return x; });
  const y = rows.map((r) => r.y);

  const fitOnce = (w, init) => {
    const beta = ridgeLogistic(X, y, w, { lambda, init, iters: init ? 8 : 25 });
    // before-period citation rates per topic (the counterfactual "what if the citation set had not changed")
    const cnt = Array.from({ length: nT }, () => new Float64Array(D)), tot = new Float64Array(nT);
    const cntA = new Float64Array(D), cntB = new Float64Array(D); let totA = 0, totB = 0;
    rows.forEach((r, i) => {
      if (!w[i]) return;
      if (r.post === 0) { tot[r.t] += w[i]; totB += w[i]; for (let d = 0; d < D; d++) if (r.mask & (1 << d)) { cnt[r.t][d] += w[i]; cntB[d] += w[i]; } }
      else { totA += w[i]; for (let d = 0; d < D; d++) if (r.mask & (1 << d)) cntA[d] += w[i]; }
    });
    const pB = cnt.map((c, t) => Array.from(c, (x) => x / Math.max(1, tot[t])));
    const citeB = Array.from(cntB, (x) => x / totB), citeA = Array.from(cntA, (x) => x / totA);
    return { beta, pB, citeB, citeA };
  };

  const ones = rows.map(() => 1);
  const full = fitOnce(ones, null);
  // players: top-K domains by |citation-rate change|, "other citation shifts", and "unexplained (engine-side)"
  const order = Array.from({ length: D }, (_, d) => d).sort((a, b) => Math.abs(full.citeA[b] - full.citeB[b]) - Math.abs(full.citeA[a] - full.citeB[a]));
  const top = order.slice(0, K).filter((d) => Math.abs(full.citeA[d] - full.citeB[d]) >= 0.03);
  const playerOf = new Int32Array(D).fill(top.length); top.forEach((d, i) => { playerOf[d] = i; });
  const nPl = top.length + 2, OTHER = top.length, UNEXPL = top.length + 1;

  const attribute = (fit, w) => {
    const { beta, pB } = fit;
    const aRows = []; let wsum = 0;
    rows.forEach((r, i) => {
      if (r.post !== 1 || !w[i]) return;
      let base = beta[0] + (r.t > 0 ? beta[r.t] : 0);
      const delta = new Float64Array(nPl), vr = new Float64Array(nPl);
      for (let d = 0; d < D; d++) {
        const x = (r.mask & (1 << d)) ? 1 : 0, b = beta[nT + d], q = pB[r.t][d];
        base += b * q;
        delta[playerOf[d]] += b * (x - q);
        vr[playerOf[d]] += b * b * q * (1 - q); // variance of the citation term when it is drawn from the before-period rates
      }
      delta[UNEXPL] = beta[dim - 1];
      aRows.push({ base, delta, vr, w: w[i] }); wsum += w[i];
    });
    // E[sigmoid(z + noise)] ~ sigmoid(z / sqrt(1 + pi*var/8)) (probit-matching approximation) for players held at before-period rates
    const v = (S) => { let s = 0; for (const a of aRows) { let z = a.base, va = 0; for (let j = 0; j < nPl; j++) { if (S & (1 << j)) z += a.delta[j]; else va += a.vr[j]; } s += a.w / (1 + Math.exp(-z / Math.sqrt(1 + Math.PI * va / 8))); } return s / wsum; };
    return shapley(nPl, v);
  };

  const est = attribute(full, ones);
  const rng = mulberry32(seed), reps = [];
  const byTopic = new Map(); for (let p = 0; p < P; p++) if (tIndex.has(promptTopic[p])) { const t = promptTopic[p]; if (!byTopic.has(t)) byTopic.set(t, []); byTopic.get(t).push(p); }
  for (let b = 0; b < boot; b++) {
    const mult = new Float64Array(P);
    for (const list of byTopic.values()) for (let i = 0; i < list.length; i++) mult[list[Math.floor(rng() * list.length)]] += 1;
    const wd = dayBootstrapWeights(data.DAYS, [B, A], rng);
    const w = rows.map((r) => mult[r.p] * wd[r.day]);
    const fit = fitOnce(w, full.beta);
    reps.push(attribute(fit, w).phi);
  }
  const obsB = mean(rows.filter((r) => r.post === 0).map((r) => r.y)), obsA = mean(rows.filter((r) => r.post === 1).map((r) => r.y));
  const players = [];
  for (let j = 0; j < nPl; j++) {
    const s = Math.sqrt(variance(reps.map((ph) => ph[j])));
    const pl = { value: est.phi[j], se: s, ci: [est.phi[j] - 1.96 * s, est.phi[j] + 1.96 * s] };
    if (j < top.length) { const d = top[j]; Object.assign(pl, { kind: 'domain', domain: d, name: data.domains[d].name, type: data.domains[d].type, citeBefore: full.citeB[d], citeAfter: full.citeA[d], beta: full.beta[nT + d] }); }
    else if (j === OTHER) Object.assign(pl, { kind: 'other', name: 'Other citation shifts' });
    else Object.assign(pl, { kind: 'unexplained', name: 'Not explained by citations (engine-side)', beta: full.beta[dim - 1] });
    players.push(pl);
  }
  players.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return { engine, topics, B, A, n: rows.length, observed: { before: obsB, after: obsA, delta: obsA - obsB }, model: { vEmpty: est.vEmpty, vFull: est.vFull }, players };
}

// ---------- full pipeline for one trigger: windows, attribution, ranked actions, agent payload ----------
export function fnv1a(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); }

export function investigate(data, agg, { engines, B, A, label, boot = 400, boot2 = 80 }) {
  const level1 = decompose(agg, { engines, B, A, boot });
  // group significant cells by engine and explain the top group(s) with the citation model
  const sig = level1.cells.filter((c) => c.significant);
  const groups = new Map();
  for (const c of sig) { if (!groups.has(c.engine)) groups.set(c.engine, []); groups.get(c.engine).push(c); }
  const explanations = [];
  for (const [engine, cells] of [...groups.entries()].slice(0, 2)) {
    const topics = cells.map((c) => c.topic).sort((a, b) => a - b);
    const ex = explainGroup(data, { engine, topics, B, A, boot: boot2 });
    // scale: within-group rate points -> points of the monitored visibility (sum of these cells' Level-1 rate effects / group rate change)
    const share = cells.reduce((s, c) => s + c.value, 0) / ex.observed.delta;
    explanations.push({ ...ex, cells, groupShare: share });
  }
  const covB = engines.map((e) => coverage(data, e, B[0], B[1])), covA = engines.map((e) => coverage(data, e, A[0], A[1]));
  return { label, level1, explanations, coverage: { engines, before: covB, after: covA } };
}

export function actionItems(inv, data) {
  const items = [];
  const eName = (e) => data.engines[e];
  const tNames = (ts) => ts.map((t) => data.topics[t]).join(' + ');
  const { level1, coverage: cov } = inv;
  if (level1.mix.significant && Math.abs(level1.mix.value) >= 0.005) {
    let worst = 0; cov.engines.forEach((e, i) => { if (cov.after[i] - cov.before[i] < cov.after[worst] - cov.before[worst]) worst = i; });
    items.push({ kind: 'coverage', impact: level1.mix.value, ci: level1.mix.ci,
      title: `Sampling artifact: ${eName(cov.engines[worst])} run coverage fell ${pct(cov.before[worst])} to ${pct(cov.after[worst])}`,
      action: 'Not a real visibility change. Hold downstream agents and check collector health for this engine.' });
  }
  for (const ex of inv.explanations) {
    const scale = ex.groupShare; // converts within-group rate points to overall visibility points
    for (const pl of ex.players) {
      const impact = pl.value * scale, ci = [pl.ci[0] * scale, pl.ci[1] * scale];
      const sig = ci[0] > 0 || ci[1] < 0;
      if (!sig || Math.abs(impact) < 0.005) continue; // hide sub-half-point items
      const where = `${eName(ex.engine)} · ${tNames(ex.topics)}`;
      let title, action;
      if (pl.kind === 'domain') {
        const entered = pl.citeAfter > pl.citeBefore, helps = pl.beta > 0;
        const move = `cited in ${pct(pl.citeBefore)} → ${pct(pl.citeAfter)} of answers`;
        title = `${pl.name} ${entered ? 'entered' : 'left'} the citation set (${where}; ${move})`;
        if (pl.type === 'owned') action = entered ? 'Your own page is now being cited. Keep it fresh, keep the URL stable, and copy its format to weaker topics.' : 'Your site dropped out. Check crawlability, robots.txt, and recent URL changes on the cited pages.';
        else if (pl.type === 'review') action = entered ? `Strengthen your ${pl.name} listing while it is being cited.` : `Refresh your ${pl.name} listing (pricing, reviews, comparison pages) to get back into these answers.`;
        else if (pl.type === 'competitor') action = entered ? `Publish a direct comparison page answering what ${pl.name} claims, and get third-party reviews to cover it.` : `${pl.name} lost ground here; reinforce your pages on these topics.`;
        else action = entered === helps ? `Positive source shift; keep presence on ${pl.name}.` : `Increase presence on ${pl.name} for these topics.`;
      } else if (pl.kind === 'unexplained') {
        title = `Shift not explained by citation changes (${where})`;
        action = 'Likely an engine-side model or ranking change. Re-check in 7 days before acting.';
      } else { title = `Smaller citation shifts (${where})`; action = 'Several minor sources moved; review the citation table for these topics.'; }
      items.push({ kind: pl.kind, impact, ci, title, action, domain: pl.name, engine: ex.engine, topics: ex.topics });
    }
  }
  items.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  return items;
}

const pct = (x) => `${Math.round(x * 100)}%`;

export function agentPayload(alarm, inv, items, data, cal, dayLabel) {
  const l1 = inv.level1;
  return {
    trigger: 'visibility_shift',
    idempotency_key: fnv1a(`${alarm.series}|${alarm.changeDay}|${alarm.direction}`),
    series: alarm.series === 'overall' ? 'all_engines_mix_standardized' : data.engines[+alarm.series.split(':')[1]],
    change_started: dayLabel(alarm.changeDay),
    detected: dayLabel(alarm.day),
    direction: alarm.direction,
    visibility_change_pts: round(l1.delta.value * 100), ci95_pts: l1.delta.ci.map((x) => round(x * 100)),
    false_trigger_budget: `${Math.round(cal.alpha * 100)}% per quarter (all series)`, cusum_threshold: round(cal.h),
    coverage_mix_pts: round(l1.mix.value * 100),
    causes: items.slice(0, 5).map((it) => ({ cause: it.title, impact_pts: round(it.impact * 100), ci95_pts: it.ci.map((x) => round(x * 100)), suggested_action: it.action })),
  };
}
const round = (x) => Math.round(x * 100) / 100;
