import { generate, dayLabel } from './src/generate.js';
import * as C from './src/core.js';

const ENGINE_COLORS = ['#05df72', '#54a2ff', '#ff8b1a', '#a685ff', '#ff667f'];
const $ = (id) => document.getElementById(id);
const fmtPts = (x, d = 1) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(d)}`;
const pct = (x) => `${Math.round(x * 100)}%`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let S = {}; // app state
let visChart, cusumChart;

function short(day) {
  const d = new Date(dayLabel(S.data.cfg, day) + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
const seriesName = (id) => id === 'overall' ? 'All engines' : id === 'raw' ? 'All engines (raw)' : S.data.engines[+id.split(':')[1]];
const seriesEngines = (id) => id.startsWith('engine:') ? [+id.split(':')[1]] : [0, 1, 2, 3, 4];

function compute() {
  const seed = Math.max(1, Math.floor(+$('seed').value || 7));
  const alpha = +$('alpha').value, thr = +$('thr').value;
  const data = generate({ seed });
  const agg = C.aggregate(data);
  const { raw, monitored } = C.buildSeries(agg);
  const cal = C.calibrate(monitored, { alpha });
  const det = C.detect(monitored, cal);
  const naive = C.naiveTrigger(raw, { thr });
  S = { ...S, seed, alpha, thr, data, agg, raw, monitored, cal, det, naive, cache: new Map() };
  S.scoreCal = C.scoreTriggers(det.alarms, data.cfg.events);
  S.scoreNaive = C.scoreTriggers(naive.map((f) => ({ day: f.day, series: 'raw', direction: f.direction })), data.cfg.events);
  // classify each naive fire: coverage artifact / covered by a calibrated trigger / within noise
  S.naiveInfo = naive.map((f) => {
    const l1 = C.decompose(agg, { engines: [0, 1, 2, 3, 4], B: [f.day - 7, f.day - 1], A: [f.day, f.day], boot: 150, seed: 3 });
    const covered = det.alarms.find((a) => f.day >= a.changeDay && f.day <= a.day + 10);
    let status = 'noise';
    if (l1.mix.significant && Math.abs(l1.mix.value) > 0.5 * Math.abs(l1.delta.value)) status = 'artifact';
    else if (covered) status = 'covered';
    return { ...f, l1, status, covered };
  });
  if (!S.series) S.series = 'overall';
  S.selected = det.alarms.length ? { kind: 'cal', i: 0 } : naive.length ? { kind: 'naive', i: 0 } : null;
}

function renderKpis() {
  const { scoreCal: c, scoreNaive: n, cal, det } = S;
  const outage = S.naiveInfo.filter((f) => f.status === 'artifact').length;
  $('kpis').innerHTML = `
    <div class="kpi"><div class="l">Agent runs triggered (last 90 days)</div>
      <div class="v">${c.fired}<small>vs ${n.fired} with "changes by ${Math.round(S.thr * 100)}%"</small></div>
      <div class="d">${n.fired - c.fired >= 0 ? `${n.fired - c.fired} fewer runs` : `${c.fired - n.fired} more runs`} across 6 monitored series (all engines + each engine)</div></div>
    <div class="kpi"><div class="l">Real shifts caught <span class="muted">(planted ground truth)</span></div>
      <div class="v">${c.caught}/${c.realEvents}<small>vs ${n.caught}/${n.realEvents}</small></div>
      <div class="d">${c.meanDelay != null ? `Mean detection delay ${c.meanDelay.toFixed(1)} days; change day localized by MLE` : 'No real shift detected'}</div></div>
    <div class="kpi"><div class="l">False triggers</div>
      <div class="v"><span class="${c.falseFires ? 'bad' : 'good'}">${c.falseFires}</span><small>vs ${n.falseFires}</small></div>
      <div class="d">${outage ? `${outage} of the rule's fires came from a collector outage, not visibility` : 'Fires outside any planted shift'}</div></div>
    <div class="kpi"><div class="l">Calibrated threshold</div>
      <div class="v">h = ${cal.h.toFixed(2)}<small>k = ${cal.k}</small></div>
      <div class="d">P(any false trigger, all series, 90 days) ≤ ${Math.round(cal.alpha * 100)}% from ${cal.sims.toLocaleString()} bootstrap replays of the baseline</div></div>`;
}

function renderTabs() {
  const opts = [{ id: 'overall', name: 'All engines', color: '#fafafa' }, ...S.data.engines.map((e, i) => ({ id: 'engine:' + i, name: e, color: ENGINE_COLORS[i] }))];
  $('seriesTabs').innerHTML = opts.map((o) => `<button data-s="${o.id}" class="${S.series === o.id ? 'on' : ''}"><span class="dot" style="background:${o.color}"></span>${esc(o.name.replace('Google AI Overviews', 'AI Overviews'))}</button>`).join('');
  $('seriesTabs').querySelectorAll('button').forEach((b) => b.onclick = () => { S.series = b.dataset.s; renderTabs(); renderCharts(); });
}

const overlayPlugin = {
  id: 'overlay',
  beforeDatasetsDraw(chart, _a, opts) {
    const { ctx, chartArea: a, scales: { x } } = chart;
    if (!opts || !opts.items) return;
    ctx.save();
    for (const it of opts.items) {
      if (it.type === 'band') {
        const x0 = x.getPixelForValue(it.from - 0.5), x1 = x.getPixelForValue(it.to + 0.5);
        ctx.fillStyle = 'rgba(255,139,26,0.07)'; ctx.fillRect(x0, a.top, x1 - x0, a.bottom - a.top);
      } else if (it.type === 'line') {
        const px = x.getPixelForValue(it.at);
        ctx.strokeStyle = it.color; ctx.setLineDash(it.dash || []); ctx.lineWidth = it.width || 1;
        ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke(); ctx.setLineDash([]);
      }
      if (it.label) {
        const px = x.getPixelForValue(it.type === 'band' ? it.from - 0.5 : it.at);
        ctx.fillStyle = it.labelColor || '#86868b'; ctx.font = '500 11px Inter, sans-serif';
        ctx.fillText(it.label, px + 4, a.top + 12 + (it.row || 0) * 14);
      }
    }
    ctx.restore();
  },
};

function renderCharts() {
  const { data, raw, monitored, det, naive, cal } = S;
  const labels = Array.from({ length: data.DAYS }, (_, d) => short(d));
  const si = monitored.findIndex((s) => s.id === S.series);
  const s = monitored[si], tr = det.traces[si];
  const color = si === 0 ? '#54a2ff' : ENGINE_COLORS[si - 1];
  const datasets = [];
  const band = (k) => tr.mu.map((m, t) => (m == null ? null : (m + k * 1.96 * tr.sd[t]) * 100));
  datasets.push({ label: 'noise band', data: band(1), borderWidth: 0, pointRadius: 0, fill: '+1', backgroundColor: 'rgba(250,250,250,0.05)', order: 5 });
  datasets.push({ label: 'noise band lo', data: band(-1), borderWidth: 0, pointRadius: 0, fill: false, order: 5 });
  datasets.push({ label: 'baseline', data: tr.mu.map((m) => (m == null ? null : m * 100)), borderColor: 'rgba(250,250,250,0.35)', borderDash: [3, 3], borderWidth: 1, pointRadius: 0, order: 4 });
  if (si === 0) datasets.push({ label: 'Dashboard visibility (raw)', data: raw.V.map((v) => v * 100), borderColor: '#b4b4ba', borderWidth: 1.25, borderDash: [4, 3], pointRadius: 0, tension: 0.25, order: 3 });
  datasets.push({ label: seriesName(s.id), data: s.V.map((v) => v * 100), borderColor: color, borderWidth: 2, pointRadius: 0, tension: 0.25, order: 2 });
  if (si === 0) datasets.push({ label: 'naive fires', type: 'scatter', data: naive.map((f) => ({ x: labels[f.day], y: raw.V[f.day] * 100 })), pointStyle: 'triangle', pointRadius: 5, backgroundColor: '#636366', borderColor: '#a8a8ad', borderWidth: 1, order: 1 });
  const alarms = det.alarms.filter((a) => si === 0 || a.series === s.id);
  datasets.push({ label: 'calibrated triggers', type: 'scatter', data: alarms.map((a) => ({ x: labels[a.day], y: s.V[a.day] * 100 })), pointRadius: 6, pointHoverRadius: 7, backgroundColor: alarms.map((a) => a.seriesIndex === 0 ? '#54a2ff' : ENGINE_COLORS[a.seriesIndex - 1]), borderColor: '#0e0e10', borderWidth: 2, order: 0 });

  const items = [];
  for (const ev of data.cfg.events) {
    if (ev.kind === 'coverage') items.push({ type: 'band', from: ev.start, to: ev.end, label: `planted: ${data.engines[ev.engine]} outage`, labelColor: '#ff8b1a' });
    else items.push({ type: 'line', at: ev.start, color: 'rgba(255,255,255,0.18)', dash: [2, 4], label: `planted: ${ev.id}`, row: 1 });
  }
  for (const a of alarms) {
    const c = a.seriesIndex === 0 ? '#54a2ff' : ENGINE_COLORS[a.seriesIndex - 1];
    items.push({ type: 'line', at: a.changeDay, color: c, dash: [4, 3], width: 1.25 });
  }
  items.push({ type: 'line', at: 34.5, color: 'rgba(255,255,255,0.12)', label: 'monitoring starts', row: 2 });

  const yVals = s.V.map((v) => v * 100).concat(si === 0 ? raw.V.map((v) => v * 100) : []);
  const ymin = Math.floor(Math.min(...yVals) - 3), ymax = Math.ceil(Math.max(...yVals) + 3);
  const base = {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1a1a1c', borderColor: '#2e2e32', borderWidth: 1, titleColor: '#fafafa', bodyColor: '#a8a8ad', filter: (i) => !/noise band|baseline/.test(i.dataset.label) || i.dataset.label === 'baseline', callbacks: { label: (i) => `${i.dataset.label}: ${i.parsed.y.toFixed(1)}%` } } },
    scales: {
      x: { ticks: { color: '#86868b', maxTicksLimit: 10, font: { family: 'Inter', size: 11 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
      y: { min: ymin, max: ymax, ticks: { color: '#86868b', callback: (v) => v + '%', font: { family: 'Inter', size: 11 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
    },
  };
  if (visChart) visChart.destroy();
  visChart = new Chart($('visChart'), { type: 'line', data: { labels, datasets }, options: { ...base, plugins: { ...base.plugins, overlay: { items } } }, plugins: [overlayPlugin] });

  $('chartSub').textContent = si === 0
    ? `Blue: mix-standardized (equal engine weights, what the detector watches). Gray: the dashboard number, which moves when an engine's runs fail.`
    : `${seriesName(s.id)} visibility; shaded band = ±1.96 × (sampling + day-level) noise around the current baseline.`;
  $('legend').innerHTML = [
    si === 0 ? `<span><i style="background:#54a2ff"></i>Mix-standardized</span><span><i style="background:#b4b4ba"></i>Dashboard (raw, dashed)</span><span><i class="tri"></i>"Changes by ${Math.round(S.thr * 100)}%" fires</span>` : `<span><i style="background:${color}"></i>${esc(seriesName(s.id))}</span><span><i class="band"></i>Noise band</span>`,
    `<span><i class="flag" style="background:${si === 0 ? '#fafafa' : color}"></i>Calibrated trigger (dashed line = estimated change start)</span>`,
  ].join('');

  const up = tr.cusumUp.map((v) => v), dn = tr.cusumDown.map((v) => v);
  if (cusumChart) cusumChart.destroy();
  cusumChart = new Chart($('cusumChart'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'upward', data: up, borderColor: '#05df72', borderWidth: 1.5, pointRadius: 0, spanGaps: false },
      { label: 'downward', data: dn, borderColor: '#ff6568', borderWidth: 1.5, pointRadius: 0, spanGaps: false },
      { label: 'threshold h', data: labels.map(() => cal.h), borderColor: 'rgba(250,250,250,0.5)', borderDash: [5, 4], borderWidth: 1, pointRadius: 0 },
    ] },
    options: { ...base, scales: { x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, display: false } }, y: { min: 0, suggestedMax: cal.h * 1.4, ticks: { color: '#86868b', maxTicksLimit: 4, font: { family: 'Inter', size: 11 } }, grid: { color: 'rgba(255,255,255,0.05)' } } }, plugins: { ...base.plugins, tooltip: { ...base.plugins.tooltip, callbacks: { label: (i) => `${i.dataset.label}: ${i.parsed.y?.toFixed(2)}` } } } },
  });
  $('cusumSub').textContent = `· ${seriesName(s.id)} · gaps = re-baselining for 10 days after a trigger`;
}

function renderLog() {
  const { det, naiveInfo, monitored } = S;
  const rows = [];
  rows.push(`<div class="log-h">Calibrated trigger · ${det.alarms.length} Agent run${det.alarms.length === 1 ? '' : 's'}</div>`);
  if (!det.alarms.length) rows.push(`<div class="empty" style="padding:6px 10px">No move exceeded the calibrated threshold.</div>`);
  det.alarms.forEach((a, i) => {
    const d = investigationFor({ kind: 'cal', i }).inv.level1.delta.value; // same number the inspector shows
    rows.push(`<div class="row ${S.selected?.kind === 'cal' && S.selected.i === i ? 'sel' : ''}" data-k="cal" data-i="${i}">
      <div class="t">${esc(seriesName(a.series))} ${a.direction === 'up' ? 'up' : 'down'} ${fmtPts(d)} pts</div><span class="pill fire">Agent run</span>
      <div class="m">Started ${short(a.changeDay)} · detected ${short(a.day)} (${a.day - a.changeDay} day${a.day - a.changeDay === 1 ? '' : 's'} later)</div></div>`);
  });
  rows.push(`<div class="log-h">"Changes by ${Math.round(S.thr * 100)}%" rule · ${naiveInfo.length} fires, all suppressed here</div>`);
  naiveInfo.forEach((f, i) => {
    const pill = f.status === 'artifact' ? '<span class="pill art">Coverage artifact</span>' : f.status === 'covered' ? '<span class="pill sup">Same shift as a trigger</span>' : '<span class="pill sup">Within noise</span>';
    rows.push(`<div class="row ${S.selected?.kind === 'naive' && S.selected.i === i ? 'sel' : ''}" data-k="naive" data-i="${i}">
      <div class="t">All engines ${f.rel > 0 ? '+' : '−'}${Math.abs(f.rel * 100).toFixed(1)}% vs 7-day avg</div>${pill}
      <div class="m">${short(f.day)} · raw ${pct(S.raw.V[f.day])} · ${f.status === 'artifact' ? 'coverage mix explains ' + Math.round(100 * f.l1.mix.value / f.l1.delta.value) + '% of the move' : f.status === 'covered' ? 'already handled by one trigger, no duplicate run' : 'no cell clears its confidence interval'}</div></div>`);
  });
  $('log').innerHTML = rows.join('');
  $('log').querySelectorAll('.row').forEach((r) => r.onclick = () => { S.selected = { kind: r.dataset.k, i: +r.dataset.i }; renderLog(); renderInspector(); });
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

function investigationFor(sel) {
  const key = `${sel.kind}:${sel.i}:${$('through').value}`;
  if (S.cache.has(key)) return S.cache.get(key);
  let res;
  if (sel.kind === 'cal') {
    const a = S.det.alarms[sel.i];
    const engines = seriesEngines(a.series);
    const B = [Math.max(0, a.changeDay - 14), a.changeDay - 1];
    const A = [a.changeDay, Math.min(S.data.DAYS - 1, a.day + +$('through').value)];
    const inv = C.investigate(S.data, S.agg, { engines, B, A, boot: 400, boot2: 80 });
    const items = C.actionItems(inv, S.data);
    const payload = C.agentPayload(a, inv, items, S.data, S.cal, (d) => dayLabel(S.data.cfg, d));
    payload.data_through = dayLabel(S.data.cfg, A[1]);
    res = { a, inv, items, payload, engines, B, A };
  } else {
    const f = S.naiveInfo[sel.i];
    const B = [f.day - 7, f.day - 1], A = [f.day, f.day];
    const inv = C.investigate(S.data, S.agg, { engines: [0, 1, 2, 3, 4], B, A, boot: 300, boot2: 40 });
    res = { f, inv, items: C.actionItems(inv, S.data), engines: [0, 1, 2, 3, 4], B, A };
  }
  S.cache.set(key, res);
  return res;
}

function barsHTML(rows) {
  const ext = Math.max(0.005, ...rows.flatMap((r) => [Math.abs(r.ci[0]), Math.abs(r.ci[1]), Math.abs(r.value)]));
  const pos = (x) => 50 + (x / ext) * 48;
  return rows.map((r) => {
    const c = r.color || (r.value < 0 ? '#ff6568' : '#05df72');
    const l = Math.min(pos(0), pos(r.value)), w = Math.abs(pos(r.value) - pos(0));
    return `<div class="bar ${r.sig ? '' : 'dim'}"><div class="n" title="${esc(r.plain)}">${r.name}</div>
      <div class="track"><div class="zero" style="left:${pos(0)}%"></div><div class="fill" style="left:${l}%;width:${Math.max(0.6, w)}%;background:${c}"></div>
      <div class="ci" style="left:${pos(r.ci[0])}%;width:${Math.max(0.5, pos(r.ci[1]) - pos(r.ci[0]))}%"></div></div>
      <div class="v"><b>${fmtPts(r.value)}</b> <span class="muted">±${(1.96 * r.se * 100).toFixed(1)}</span></div></div>`;
  }).join('');
}

function renderInspector() {
  const el = $('inspector');
  if (!S.selected) { el.innerHTML = '<div class="empty">Nothing fired in this dataset.</div>'; return; }
  const r = investigationFor(S.selected);
  const { inv, items } = r, l1 = inv.level1, data = S.data;
  const unit = r.engines.length === 1 ? `pts of ${data.engines[r.engines[0]]} visibility` : 'pts of all-engine visibility';
  let head;
  if (S.selected.kind === 'cal') {
    const a = r.a;
    head = `<div><div class="crumb">Trigger fired · Agent run · key <span class="mono" style="color:var(--tx2)">${r.payload.idempotency_key}</span></div>
      <h2>${esc(seriesName(a.series))} visibility ${l1.delta.value < 0 ? 'fell' : 'rose'} ${Math.abs(l1.delta.value * 100).toFixed(1)} pts</h2>
      <div class="meta">Change started ${short(a.changeDay)} (estimated) · detected ${short(a.day)} · compared ${short(r.B[0])}–${short(r.B[1])} with ${short(r.A[0])}–${short(r.A[1])}<br/>
      95% CI ${fmtPts(l1.delta.ci[0])} to ${fmtPts(l1.delta.ci[1])} pts (bootstrap over prompts and days) · ${(l1.VB * 100).toFixed(1)}% → ${(l1.VA * 100).toFixed(1)}%</div></div>
      <span class="pill fire" style="font-size:12px;padding:4px 10px">Fired</span>`;
  } else {
    const f = r.f;
    const verdict = f.status === 'artifact' ? 'Suppressed: coverage artifact' : f.status === 'covered' ? 'Suppressed: duplicate of a trigger' : 'Suppressed: within noise';
    head = `<div><div class="crumb">"Changes by ${Math.round(S.thr * 100)}%" rule would run the Agent here</div>
      <h2>Dashboard visibility ${f.rel > 0 ? 'rose' : 'fell'} ${Math.abs(f.rel * 100).toFixed(1)}% vs its 7-day average on ${short(f.day)}</h2>
      <div class="meta">Compared ${short(r.B[0])}–${short(r.B[1])} with ${short(f.day)} · change ${fmtPts(l1.delta.value)} pts, 95% CI ${fmtPts(l1.delta.ci[0])} to ${fmtPts(l1.delta.ci[1])}<br/>
      ${f.status === 'covered' ? `The calibrated trigger already caught this shift (${esc(seriesName(f.covered.series))}, started ${short(f.covered.changeDay)}); the idempotency key prevents a second run.` : 'The calibrated detector did not cross its threshold on any series.'}</div></div>
      <span class="pill ${f.status === 'artifact' ? 'art' : 'sup'}" style="font-size:12px;padding:4px 10px">${verdict}</span>`;
  }

  const cov = inv.coverage;
  const covTxt = cov.engines.map((e, i) => `${data.engines[e]} ${pct(cov.before[i])}→${pct(cov.after[i])}`).join(' · ');
  const barRows = [{ name: '<b>Coverage mix</b> (run failures)', plain: 'Shift in which engines/topics got answered', value: l1.mix.value, ci: l1.mix.ci, se: l1.mix.se, sig: l1.mix.significant, color: '#ff8b1a' }]
    .concat(l1.cells.slice(0, 8).map((c) => ({ name: `<b>${esc(data.engines[c.engine])}</b> · ${esc(data.topics[c.topic])}`, plain: `${data.engines[c.engine]} · ${data.topics[c.topic]}`, value: c.value, ci: c.ci, se: c.se, sig: c.significant })));

  const itemsHTML = items.length ? items.slice(0, 6).map((it, i) => `<div class="item"><div class="k">${i + 1}</div><div class="it">${esc(it.title)}</div>
      <div class="imp ${it.impact < 0 ? 'bad' : 'good'}">${fmtPts(it.impact)} pts<small>95% CI ${fmtPts(it.ci[0])} to ${fmtPts(it.ci[1])}</small></div><div class="act">${esc(it.action)}</div></div>`).join('')
    : `<div class="empty">No cause clears its 95% interval. The move is consistent with answer-engine sampling noise, so no Agent run is warranted.</div>`;

  const ex = inv.explanations[0];
  const citeHTML = ex ? `<div class="sec-t">Citation-set counterfactual · ${esc(data.engines[ex.engine])} · ${esc(ex.topics.map((t) => data.topics[t]).join(' + '))}</div>
    <table class="cite"><thead><tr><th>Source</th><th>Type</th><th class="r">Before</th><th class="r">After</th><th class="r">Shapley</th><th class="r">95% CI</th></tr></thead><tbody>
    ${ex.players.map((p) => `<tr><td>${esc(p.name)}</td><td class="muted">${p.type || '—'}</td><td class="r">${p.citeBefore != null ? pct(p.citeBefore) : ''}</td><td class="r">${p.citeAfter != null ? pct(p.citeAfter) : ''}</td>
      <td class="r ${p.value < 0 ? 'bad' : 'good'}">${fmtPts(p.value)}</td><td class="r muted">${fmtPts(p.ci[0])} to ${fmtPts(p.ci[1])}</td></tr>`).join('')}
    </tbody></table>
    <div class="note">Observed group visibility ${(ex.observed.before * 100).toFixed(1)}% → ${(ex.observed.after * 100).toFixed(1)}%. Model counterfactual with the old citation set: ${(ex.model.vEmpty * 100).toFixed(1)}%; with the new one: ${(ex.model.vFull * 100).toFixed(1)}%. Shapley values (in points of this group's visibility) split that gap exactly across sources; Before/After = share of answers citing the source.</div>`
    : `<div class="sec-t">Citation-set counterfactual</div><div class="empty">${l1.enoughDays ? `Runs only for engine × topic cells whose change is significant (Benjamini–Hochberg, q = ${l1.fdr}). None here.` : 'A one-day comparison window cannot separate day-to-day answer-engine drift from a real cell change, so cells are not tested and no citation counterfactual is run. The calibrated detector waits for evidence instead.'}</div>`;

  const payloadHTML = S.selected.kind === 'cal'
    ? `<div class="sec-t">Payload handed to the Agent run</div><pre class="payload mono">${esc(JSON.stringify(r.payload, null, 2))}</pre>`
    : `<div class="sec-t">Payload</div><div class="empty">Not sent. Under the current rule this would start an Agent run with only "visibility changed ${(r.f.rel * 100).toFixed(1)}%" as context.</div>`;

  el.innerHTML = `<div class="ins-head">${head}</div>
    <div class="ins-grid">
      <div><div class="sec-t">Where it moved · exact split (${unit})</div><div class="bars">${barsHTML(barRows)}</div>
        <div class="note">Mix + cell effects sum exactly to the observed change (two-factor Shapley on share × rate). Bright bars pass Benjamini–Hochberg at q = ${l1.fdr}. Run coverage: ${esc(covTxt)}.</div></div>
      <div><div class="sec-t">What changed and what to fix</div><div class="items">${itemsHTML}</div></div>
    </div>
    <div class="two"><div>${citeHTML}</div><div>${payloadHTML}</div></div>`;
}

function renderAll() { renderKpis(); renderTabs(); renderCharts(); renderLog(); renderInspector(); }

async function boot() {
  Chart.defaults.font.family = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  Chart.defaults.color = '#86868b';
  try { await document.fonts.ready; } catch (e) { /* render anyway */ }
  // optional deep link: #series=engine:1&sel=naive:2&seed=7
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('seed')) $('seed').value = h.get('seed');
  compute();
  if (h.get('series')) S.series = h.get('series');
  if (h.get('sel')) { const [kind, i] = h.get('sel').split(':'); S.selected = { kind, i: +i }; }
  renderAll();
  $('regen').onclick = () => { compute(); renderAll(); };
  $('seed').onkeydown = (e) => { if (e.key === 'Enter') { compute(); renderAll(); } };
  $('alpha').onchange = () => { compute(); renderAll(); };
  $('thr').onchange = () => { compute(); renderAll(); };
  $('through').onchange = () => renderInspector();
}
boot();
