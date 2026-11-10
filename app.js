import { generate, dayLabel } from './src/generate.js';
import * as C from './src/core.js';

// neutral monogram tiles (no third-party logos)
const TILES = [
  { t: 'C', bg: '#18181a' }, { t: 'P', bg: '#1f7a80' }, { t: 'AO', bg: '#5f6368' }, { t: 'G', bg: '#6d5dfc' }, { t: 'Co', bg: '#2b6cb0' },
];
const BLUE = '#447dfc', GREEN = '#49a24e', RED = '#e74341', ORANGE = '#e8890c', INK = '#18181a';
const MONO = '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const $ = (id) => document.getElementById(id);
const fmtPts = (x, d = 1) => `${x > 0 ? '+' : x < 0 ? '-' : ''}${Math.abs(x * 100).toFixed(d)}`;
const pct = (x) => `${Math.round(x * 100)}%`;
const pct1 = (x) => `${(x * 100).toFixed(1)}%`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const ICON_CHEV = '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>';

let S = { view: { trig: true, naive: true, raw: true, events: true } };
let visChart, cusumChart;

function short(day) {
  const d = new Date(dayLabel(S.data.cfg, day) + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
const seriesName = (id) => id === 'overall' ? 'All engines' : S.data.engines[+id.split(':')[1]];
const seriesEngines = (id) => id.startsWith('engine:') ? [+id.split(':')[1]] : [0, 1, 2, 3, 4];
const miniTile = (id) => tileFor(id).replace('class="tile"', 'class="tile sm"');
const tileFor = (id) => id === 'overall' ? `<span class="tile" style="background:#f0f0f0;color:${INK}">All</span>` : (() => { const t = TILES[+id.split(':')[1]]; return `<span class="tile" style="background:${t.bg}">${t.t}</span>`; })();

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
  S.naiveInfo = naive.map((f) => {
    const l1 = C.decompose(agg, { engines: [0, 1, 2, 3, 4], B: [f.day - 7, f.day - 1], A: [f.day, f.day], boot: 150, seed: 3 });
    const covered = det.alarms.find((a) => a.direction === f.direction && f.day >= a.changeDay && f.day <= a.day + 7);
    let status = 'noise';
    if (l1.mix.significant && Math.abs(l1.mix.value) > 0.5 * Math.abs(l1.delta.value)) status = 'artifact';
    else if (covered) status = 'covered';
    return { ...f, l1, status, covered };
  });
  S.answers = data.ok.reduce((s, x) => s + x, 0);
  if (!S.series) S.series = 'overall';
  S.selected = det.alarms.length ? { kind: 'cal', i: 0 } : naive.length ? { kind: 'naive', i: 0 } : null;
}

function renderKpis() {
  const { scoreCal: c, scoreNaive: n, cal } = S;
  const outage = S.naiveInfo.filter((f) => f.status === 'artifact').length;
  const rule = `"changes by ${Math.round(S.thr * 100)}%"`;
  $('kpis').innerHTML = `
    <div class="kpi"><span class="dotted">Agent runs triggered</span>
      <div class="v">${c.fired}<span class="cmp">vs ${n.fired} with ${rule}</span></div>
      <div class="d">Last 90 days, across 6 monitored series (all engines + each engine)</div></div>
    <div class="kpi"><span class="dotted">Real shifts caught</span>
      <div class="v">${c.caught}/${c.realEvents}<span class="cmp">vs ${n.caught}/${n.realEvents}</span></div>
      <div class="d">${c.meanDelay != null ? `Planted ground truth · mean detection delay ${c.meanDelay.toFixed(1)} days` : 'Planted ground truth · none detected'}</div></div>
    <div class="kpi"><span class="dotted">False triggers</span>
      <div class="v"><span class="${c.falseFires ? 'bad' : ''}">${c.falseFires}</span><span class="cmp">vs ${n.falseFires}</span></div>
      <div class="d">${outage ? `${outage} of the rule's fires came from a collector outage, not visibility` : 'Fires outside any planted shift'}</div></div>
    <div class="kpi"><span class="dotted">Calibrated threshold</span>
      <div class="v"><span class="mono" style="font-size:24px">h = ${cal.h.toFixed(2)}</span><span class="cmp">k = ${cal.k}</span></div>
      <div class="d">P(any false trigger in a quarter) ≤ ${Math.round(cal.alpha * 100)}%, from ${cal.sims.toLocaleString()} bootstrap replays</div></div>`;
  $('exportLabel').textContent = `Export ${S.answers.toLocaleString()} answers`;
}

function last7(series) {
  const V = series.V, n = V.length;
  return { cur: mean(V.slice(n - 7)), prev: mean(V.slice(n - 14, n - 7)) };
}

function renderRank() {
  const { monitored, det } = S;
  const row = (s, idx, num) => {
    const { cur, prev } = last7(s);
    const d = cur - prev;
    const al = det.alarms.filter((a) => a.series === s.id);
    const st = al.length ? `<span class="status fired"><i></i>Trigger fired ${al.map((a) => short(a.day)).join(', ')}</span>` : `<span class="status"><i></i>No trigger</span>`;
    return `<div class="rk ${S.series === s.id ? 'sel' : ''}" data-s="${s.id}"><span class="n">${num}</span>${tileFor(s.id)}
      <span class="nm">${esc(seriesName(s.id))}<small>${st}</small></span><span class="val">${pct1(cur)}</span><span class="dl ${d >= 0 ? 'good' : 'bad'}">${d >= 0 ? '+' : '-'}${Math.abs(d * 100).toFixed(1)}%</span></div>`;
  };
  const engines = monitored.slice(1).map((s, i) => ({ s, i })).sort((a, b) => last7(b.s).cur - last7(a.s).cur);
  $('rank').innerHTML = row(monitored[0], 0, '') + engines.map((e, k) => row(e.s, e.i + 1, `${k + 1}.`)).join('');
  const rule = Math.round(S.thr * 100);
  $('triggers').innerHTML = `
    <div class="trg-h"><span class="dotted">Run triggers</span><span class="toggle on-static"><span class="tr"></span></span></div>
    <div class="trg"><svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg><div><div>When visibility shifts beyond noise</div>
      <div class="muted small">6 series · ≤${Math.round(S.alpha * 100)}% false triggers per quarter · h = <span class="mono">${S.cal.h.toFixed(2)}</span></div></div><span class="pill fire"><i></i>On</span></div>
    <div class="trg off"><svg viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="m7 14 4-4 4 4 5-5"/></svg><div><div>When visibility changes by ${rule}%</div>
      <div class="muted small">Compared only · would have run ${S.naive.length} times</div></div><span class="pill sup"><i></i>Off</span></div>
    <div class="trg-h" style="margin-top:16px"><span class="dotted">Inputs</span></div>
    <div class="muted small" style="line-height:1.55">Each run receives the change window, a 95% CI, ranked causes with CIs, and an idempotency key so one shift never starts two runs.</div>`;
  $('rank').querySelectorAll('.rk').forEach((r) => r.onclick = () => { S.series = r.dataset.s; renderRank(); renderCharts(); });
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
        ctx.fillStyle = 'rgba(232,137,12,0.08)'; ctx.fillRect(x0, a.top, x1 - x0, a.bottom - a.top);
      } else if (it.type === 'line') {
        const px = x.getPixelForValue(it.at);
        ctx.strokeStyle = it.color; ctx.setLineDash(it.dash || []); ctx.lineWidth = it.width || 1;
        ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke(); ctx.setLineDash([]);
      }
      if (it.label) {
        const px = x.getPixelForValue(it.type === 'band' ? it.from - 0.5 : it.at);
        ctx.fillStyle = it.labelColor || '#959595'; ctx.font = `11px ${MONO}`;
        ctx.fillText(it.label, px + 5, a.top + 12 + (it.row || 0) * 14);
      }
    }
    ctx.restore();
  },
};

function renderCharts() {
  const { data, raw, monitored, det, naive, cal, view } = S;
  const labels = Array.from({ length: data.DAYS }, (_, d) => short(d));
  const si = monitored.findIndex((s) => s.id === S.series);
  const s = monitored[si], tr = det.traces[si];
  const all = si === 0;
  const { cur, prev } = last7(s);
  $('chartTitle').textContent = all ? 'Visibility Score · all engines (mix-standardized)' : `Visibility Score · ${seriesName(s.id)}`;
  $('bigNum').innerHTML = `${pct1(cur)} <span class="delta ${cur >= prev ? 'good' : 'bad'}">${cur >= prev ? '+' : '-'}${Math.abs((cur - prev) * 100).toFixed(1)}%</span><span class="ctx">last 7 days vs prev. 7</span>`;

  const datasets = [];
  const band = (k) => tr.mu.map((m, t) => (m == null ? null : (m + k * 1.96 * tr.sd[t]) * 100));
  datasets.push({ label: 'noise band', data: band(1), borderWidth: 0, pointRadius: 0, fill: '+1', backgroundColor: 'rgba(68,125,252,0.07)', order: 6 });
  datasets.push({ label: 'noise band lo', data: band(-1), borderWidth: 0, pointRadius: 0, fill: false, order: 6 });
  datasets.push({ label: 'Baseline', data: tr.mu.map((m) => (m == null ? null : m * 100)), borderColor: '#c8c8cc', borderDash: [3, 3], borderWidth: 1, pointRadius: 0, order: 5 });
  if (all && view.raw) datasets.push({ label: 'Dashboard (raw)', data: raw.V.map((v) => v * 100), borderColor: '#b4b4b4', borderDash: [4, 3], borderWidth: 1.25, pointRadius: 0, tension: 0, order: 4 });
  datasets.push({ label: seriesName(s.id), data: s.V.map((v) => v * 100), borderColor: BLUE, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: BLUE, tension: 0, order: 3 });
  if (all && view.naive) datasets.push({ label: `"Changes by ${Math.round(S.thr * 100)}%" fire`, type: 'scatter', data: naive.map((f) => ({ x: labels[f.day], y: raw.V[f.day] * 100 })), pointStyle: 'triangle', pointRadius: 5, backgroundColor: '#ffffff', borderColor: '#959595', borderWidth: 1.5, order: 1 });
  const alarms = det.alarms.filter((a) => all || a.series === s.id);
  if (view.trig) datasets.push({ label: 'Calibrated trigger', type: 'scatter', data: alarms.map((a) => ({ x: labels[a.day], y: s.V[a.day] * 100 })), pointRadius: 6, pointHoverRadius: 7, backgroundColor: INK, borderColor: '#ffffff', borderWidth: 2, order: 0 });

  const items = [];
  if (view.events) for (const ev of data.cfg.events) {
    if (ev.kind === 'coverage') items.push({ type: 'band', from: ev.start, to: ev.end, label: `planted: ${data.engines[ev.engine]} outage`, labelColor: ORANGE });
    else items.push({ type: 'line', at: ev.start, color: 'rgba(0,0,0,0.14)', dash: [2, 4], label: `planted: ${ev.id}`, row: 1 });
  }
  if (view.trig) for (const a of alarms) items.push({ type: 'line', at: a.changeDay, color: 'rgba(24,24,26,0.55)', dash: [4, 3], width: 1 });
  items.push({ type: 'line', at: 34.5, color: 'rgba(0,0,0,0.10)', label: 'monitoring starts', row: 2 });

  const yVals = s.V.map((v) => v * 100).concat(all && view.raw ? raw.V.map((v) => v * 100) : []);
  const ymin = Math.floor(Math.min(...yVals) - 2), ymax = Math.ceil(Math.max(...yVals) + 3);
  const tooltip = { backgroundColor: '#ffffff', borderColor: '#e8e8e8', borderWidth: 1, titleColor: INK, bodyColor: '#787878', padding: 10, cornerRadius: 10, boxPadding: 4, titleFont: { family: 'Inter', weight: '500' }, bodyFont: { family: MONO, size: 12 } };
  const base = {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: { ...tooltip, filter: (i) => !/noise band/.test(i.dataset.label), callbacks: { label: (i) => ` ${i.dataset.label}: ${i.parsed.y.toFixed(1)}%` } } },
    scales: {
      x: { ticks: { color: '#959595', maxTicksLimit: 10, font: { family: 'Inter', size: 12 }, maxRotation: 0 }, grid: { drawOnChartArea: false, drawTicks: true, tickLength: 6, color: '#d4d4d8' }, border: { color: '#d4d4d8' } },
      y: { min: ymin, max: ymax, ticks: { color: '#787878', maxTicksLimit: 6, callback: (v) => v.toFixed(1) + '%', font: { family: MONO, size: 11.5 } }, grid: { color: '#e5e5e5', drawTicks: false }, border: { display: false, dash: [4, 4] } },
    },
  };
  if (visChart) visChart.destroy();
  visChart = new Chart($('visChart'), { type: 'line', data: { labels, datasets }, options: { ...base, plugins: { ...base.plugins, overlay: { items } } }, plugins: [overlayPlugin] });

  // checkboxes + toggle, Profound-style chart footer
  $('chartFoot').innerHTML = `
    <label><input type="checkbox" data-v="trig" ${view.trig ? 'checked' : ''}/>Calibrated triggers</label>
    ${all ? `<label><input type="checkbox" data-v="naive" ${view.naive ? 'checked' : ''}/>"Changes by ${Math.round(S.thr * 100)}%" fires</label>
    <label><input type="checkbox" data-v="raw" ${view.raw ? 'checked' : ''}/>Dashboard (raw)</label>` : `<span class="lg"><i style="width:14px;height:10px;background:rgba(68,125,252,0.12);border-radius:2px"></i>±1.96σ noise band around baseline</span>`}
    <label class="toggle"><input type="checkbox" data-v="events" ${view.events ? 'checked' : ''}/><span class="tr"></span>Show planted events</label>`;
  $('chartFoot').querySelectorAll('input').forEach((el) => el.onchange = () => { S.view[el.dataset.v] = el.checked; renderCharts(); });

  if (cusumChart) cusumChart.destroy();
  cusumChart = new Chart($('cusumChart'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Upward', data: tr.cusumUp, borderColor: GREEN, borderWidth: 1.5, pointRadius: 0, tension: 0 },
      { label: 'Downward', data: tr.cusumDown, borderColor: RED, borderWidth: 1.5, pointRadius: 0, tension: 0 },
      { label: 'Threshold h', data: labels.map(() => cal.h), borderColor: 'rgba(24,24,26,0.5)', borderDash: [5, 4], borderWidth: 1, pointRadius: 0 },
    ] },
    options: { ...base, scales: { x: { ...base.scales.x, ticks: { display: false }, grid: { display: false }, border: { color: '#e5e5e5' } }, y: { min: 0, suggestedMax: cal.h * 1.4, ticks: { color: '#787878', maxTicksLimit: 3, font: { family: MONO, size: 11 } }, grid: { color: '#ececec', drawTicks: false }, border: { display: false, dash: [4, 4] } } }, plugins: { ...base.plugins, tooltip: { ...tooltip, callbacks: { label: (i) => ` ${i.dataset.label}: ${i.parsed.y?.toFixed(2)}` } } } },
  });
  $('cusumSub').textContent = `two-sided CUSUM in z-units · ${seriesName(s.id)} · gaps = 10-day re-baselining after a trigger`;
}

function renderLog() {
  const { det, naiveInfo } = S;
  const head = `<div class="tr-h"><span>Date</span><span>Series</span><span>Change</span><span>Why</span><span>Status</span></div>`;
  const calRows = det.alarms.map((a, i) => {
    const d = investigationFor({ kind: 'cal', i }).inv.level1.delta.value;
    return `<div class="tr-r ${S.selected?.kind === 'cal' && S.selected.i === i ? 'sel' : ''}" data-k="cal" data-i="${i}">
      <span>${short(a.day)}</span><span style="display:flex;gap:8px;align-items:center">${miniTile(a.series)}${esc(seriesName(a.series))}</span>
      <span class="mono ${d < 0 ? 'bad' : 'good'}">${fmtPts(d)} pts</span>
      <span class="why">Started ${short(a.changeDay)} · detected ${a.day - a.changeDay} day${a.day - a.changeDay === 1 ? '' : 's'} later</span>
      <span class="pill fire"><i></i>Agent run</span></div>`;
  }).join('') || `<div class="tr-r"><span></span><span class="why">No move exceeded the calibrated threshold.</span></div>`;
  const showAll = S.showAllNaive || naiveInfo.length <= 6 || (S.selected?.kind === 'naive' && S.selected.i >= 5);
  const naiveRows = naiveInfo.filter((_, i) => showAll || i < 5).map((f, i) => {
    const pill = f.status === 'artifact' ? '<span class="pill art"><i></i>Coverage artifact</span>' : f.status === 'covered' ? '<span class="pill cov"><i></i>Duplicate of a trigger</span>' : '<span class="pill sup"><i></i>Within noise</span>';
    const why = f.status === 'artifact' ? `Coverage mix explains ${Math.round(100 * f.l1.mix.value / f.l1.delta.value)}% of the move` : f.status === 'covered' ? 'Same shift a trigger already handled' : 'No cell clears its confidence interval';
    return `<div class="tr-r ${S.selected?.kind === 'naive' && S.selected.i === i ? 'sel' : ''}" data-k="naive" data-i="${i}">
      <span>${short(f.day)}</span><span style="display:flex;gap:8px;align-items:center">${miniTile('overall')}All engines (dashboard)</span>
      <span class="mono ${f.rel < 0 ? 'bad' : 'good'}">${f.rel > 0 ? '+' : '-'}${Math.abs(f.rel * 100).toFixed(1)}%</span>
      <span class="why">${why}</span>${pill}</div>`;
  }).join('') + (showAll ? '' : `<div class="more"><button class="link" id="moreNaive">Show all ${naiveInfo.length} fires</button></div>`);
  $('logTable').innerHTML = head +
    `<div class="grp">${ICON_CHEV}Calibrated trigger <span class="muted">· ${det.alarms.length} Agent run${det.alarms.length === 1 ? '' : 's'}</span></div><div class="grp-body">${calRows}</div>` +
    `<div class="grp">${ICON_CHEV}"Changes by ${Math.round(S.thr * 100)}%" rule <span class="muted">· ${naiveInfo.length} fires, all suppressed by the calibrated trigger</span></div><div class="grp-body">${naiveRows}</div>`;
  if ($('moreNaive')) $('moreNaive').onclick = () => { S.showAllNaive = true; renderLog(); };
  $('logTable').querySelectorAll('.tr-r[data-k]').forEach((r) => r.onclick = () => { S.selected = { kind: r.dataset.k, i: +r.dataset.i }; renderLog(); renderInspector(); document.getElementById('inspector').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
}

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
  const pos = (x) => 50 + (x / ext) * 47;
  return rows.map((r) => {
    const c = r.color || (r.value < 0 ? RED : GREEN);
    const l = Math.min(pos(0), pos(r.value)), w = Math.abs(pos(r.value) - pos(0));
    return `<div class="bar ${r.sig ? '' : 'dim'}"><div class="n" title="${esc(r.plain)}">${r.name}</div>
      <div class="track"><div class="zero" style="left:${pos(0)}%"></div><div class="fill" style="left:${l}%;width:${Math.max(0.6, w)}%;background:${c}"></div>
      <div class="ci" style="left:${pos(r.ci[0])}%;width:${Math.max(0.5, pos(r.ci[1]) - pos(r.ci[0]))}%"></div></div>
      <div class="v">${fmtPts(r.value)} <span>±${(1.96 * r.se * 100).toFixed(1)}</span></div></div>`;
  }).join('');
}

function highlightJSON(obj) {
  return esc(JSON.stringify(obj, null, 2))
    .replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="k">$1</span>$2')
    .replace(/(:\s*)(&quot;.*?&quot;)/g, '$1<span class="s">$2</span>')
    .replace(/(:\s*|\[\s*|,\s*\n\s*)(-?\d+(?:\.\d+)?)/g, '$1<span class="n">$2</span>');
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
    head = `<div><div class="kicker"><span class="pill fire"><i></i>Agent run</span>Trigger fired · idempotency key <span class="mono" style="color:#18181a">${r.payload.idempotency_key}</span></div>
      <h2>${esc(seriesName(a.series))} visibility ${pct1(l1.VB)} → ${pct1(l1.VA)} <span class="delta ${l1.delta.value < 0 ? 'bad' : 'good'}">${fmtPts(l1.delta.value)} pts</span></h2>
      <div class="meta">Change started <b>${short(a.changeDay)}</b> (estimated) · detected <b>${short(a.day)}</b> · compared ${short(r.B[0])}–${short(r.B[1])} with ${short(r.A[0])}–${short(r.A[1])}<br/>
      95% CI <span class="mono">${fmtPts(l1.delta.ci[0])} to ${fmtPts(l1.delta.ci[1])} pts</span> (bootstrap over prompts and days)</div></div>`;
  } else {
    const f = r.f;
    const verdict = f.status === 'artifact' ? '<span class="pill art"><i></i>Suppressed: coverage artifact</span>' : f.status === 'covered' ? '<span class="pill cov"><i></i>Suppressed: duplicate of a trigger</span>' : '<span class="pill sup"><i></i>Suppressed: within noise</span>';
    head = `<div><div class="kicker">${verdict}"Changes by ${Math.round(S.thr * 100)}%" would run the Agent here</div>
      <h2>Dashboard visibility on ${short(f.day)} <span class="delta ${f.rel < 0 ? 'bad' : 'good'}">${f.rel > 0 ? '+' : '-'}${Math.abs(f.rel * 100).toFixed(1)}%</span><span class="muted" style="font-size:14px">vs 7-day average</span></h2>
      <div class="meta">Compared ${short(r.B[0])}–${short(r.B[1])} with ${short(f.day)} · change <span class="mono">${fmtPts(l1.delta.value)} pts</span>, 95% CI <span class="mono">${fmtPts(l1.delta.ci[0])} to ${fmtPts(l1.delta.ci[1])}</span><br/>
      ${f.status === 'covered' ? `The calibrated trigger already caught this shift (${esc(seriesName(f.covered.series))}, started ${short(f.covered.changeDay)}); its idempotency key prevents a second run.` : 'The calibrated detector did not cross its threshold on any series.'}</div></div>`;
  }

  const cov = inv.coverage;
  const covTxt = cov.engines.map((e, i) => `${data.engines[e]} ${pct(cov.before[i])}→${pct(cov.after[i])}`).join(' · ');
  const barRows = [{ name: 'Coverage mix <span>(run failures)</span>', plain: 'Shift in which engines/topics got answered', value: l1.mix.value, ci: l1.mix.ci, se: l1.mix.se, sig: l1.mix.significant, color: ORANGE }]
    .concat(l1.cells.slice(0, 7).map((c) => ({ name: `${esc(data.engines[c.engine])} <span>· ${esc(data.topics[c.topic])}</span>`, plain: `${data.engines[c.engine]} · ${data.topics[c.topic]}`, value: c.value, ci: c.ci, se: c.se, sig: c.significant })));

  const itemsHTML = items.length ? items.slice(0, 6).map((it, i) => `<div class="item"><div class="k">${i + 1}.</div><div class="it">${esc(it.title)}</div>
      <div class="imp ${it.impact < 0 ? 'bad' : 'good'}">${fmtPts(it.impact)} pts<small>95% CI ${fmtPts(it.ci[0])} to ${fmtPts(it.ci[1])}</small></div><div class="act">${esc(it.action)}</div></div>`).join('')
    : `<div class="empty">No cause clears its 95% interval. The move is consistent with answer-engine sampling noise, so no Agent run is warranted.</div>`;

  const ex = inv.explanations[0];
  const citeHTML = ex ? `<div class="sec-t"><span class="dotted">Citation-set counterfactual</span><span class="muted">${esc(data.engines[ex.engine])} · ${esc(ex.topics.map((t) => data.topics[t]).join(' + '))}</span></div>
    <div class="tblwrap"><table class="cite"><thead><tr><th>Source</th><th>Type</th><th class="r">Before</th><th class="r">After</th><th class="r">Shapley</th><th class="r">95% CI</th></tr></thead><tbody>
    ${ex.players.map((p) => `<tr><td>${esc(p.kind === 'unexplained' ? 'Unexplained (engine-side)' : p.name)}</td><td class="muted">${p.type || '—'}</td><td class="r">${p.citeBefore != null ? pct(p.citeBefore) : ''}</td><td class="r">${p.citeAfter != null ? pct(p.citeAfter) : ''}</td>
      <td class="r m ${p.value < 0 ? 'bad' : 'good'}">${fmtPts(p.value)}</td><td class="r m muted">${fmtPts(p.ci[0])} to ${fmtPts(p.ci[1])}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="note">Before/After = share of answers citing the source. Group visibility ${pct1(ex.observed.before)} → ${pct1(ex.observed.after)}. Model counterfactual with the old citation set: ${pct1(ex.model.vEmpty)}; with the new one: ${pct1(ex.model.vFull)}. Shapley values (points of this group's visibility) split that gap exactly across sources.</div>`
    : `<div class="sec-t"><span class="dotted">Citation-set counterfactual</span></div><div class="empty">${l1.enoughDays ? `Runs only for engine × topic cells whose change is significant (Benjamini–Hochberg, q = ${l1.fdr}). None here.` : 'A one-day comparison window cannot separate day-to-day answer-engine drift from a real cell change, so cells are not tested and no citation counterfactual is run. The calibrated detector waits for evidence instead.'}</div>`;

  const payloadHTML = S.selected.kind === 'cal'
    ? `<div class="sec-t"><span class="dotted">Agent run input</span><span class="muted">payload handed to the run</span></div><pre class="payload">${highlightJSON(r.payload)}</pre>`
    : `<div class="sec-t"><span class="dotted">Agent run input</span></div><div class="empty">Not sent. Under the current rule this would start an Agent run with only "visibility changed ${(r.f.rel * 100).toFixed(1)}%" as context.</div>`;

  el.innerHTML = `<div class="ins-head">${head}</div>
    <div class="ins-grid">
      <div><div class="sec-t"><span class="dotted">Where it moved</span><span class="muted">exact split, ${unit}</span></div><div class="bars">${barsHTML(barRows)}</div>
        <div class="note">Mix + cell effects sum exactly to the observed change (two-factor Shapley on share × rate). Dark bars pass Benjamini–Hochberg at q = ${l1.fdr}. Run coverage: ${esc(covTxt)}.</div></div>
      <div><div class="sec-t"><span class="dotted">What changed and what to fix</span></div><div class="items">${itemsHTML}</div></div>
    </div>
    <div class="two"><div>${citeHTML}</div><div>${payloadHTML}</div></div>`;
}

function exportCSV() {
  const { data, raw, monitored } = S;
  const rows = ['date,dashboard_visibility,all_engines_standardized,' + data.engines.map((e) => `"${e}"`).join(',')];
  for (let d = 0; d < data.DAYS; d++) rows.push([dayLabel(data.cfg, d), raw.V[d].toFixed(4), ...monitored.map((s) => s.V[d].toFixed(4))].join(','));
  const url = URL.createObjectURL(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }));
  const a = document.createElement('a'); a.href = url; a.download = `visibility-seed${S.seed}.csv`; a.click(); URL.revokeObjectURL(url);
}

function renderAll() { renderKpis(); renderRank(); renderCharts(); renderLog(); renderInspector(); }

async function boot() {
  Chart.defaults.font.family = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  Chart.defaults.color = '#787878';
  try { await document.fonts.ready; } catch (e) { /* render anyway */ }
  // optional deep link: #series=engine:1&sel=naive:2&seed=7
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('seed')) $('seed').value = h.get('seed');
  compute();
  if (h.get('series')) S.series = h.get('series');
  if (h.get('sel')) { const [kind, i] = h.get('sel').split(':'); S.selected = { kind, i: +i }; }
  renderAll();
  const rerun = () => { compute(); renderAll(); };
  $('regen').onclick = rerun;
  $('seed').onkeydown = (e) => { if (e.key === 'Enter') rerun(); };
  $('alpha').onchange = rerun;
  $('thr').onchange = rerun;
  $('through').onchange = () => { renderLog(); renderInspector(); };
  $('export').onclick = exportCSV;
  document.querySelectorAll('.utabs a').forEach((a) => a.addEventListener('click', () => { document.querySelectorAll('.utabs a').forEach((b) => b.classList.remove('on')); a.classList.add('on'); }));
}
boot();
