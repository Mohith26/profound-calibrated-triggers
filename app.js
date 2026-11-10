import { generate, dayLabel } from './src/generate.js';
import * as C from './src/core.js';

const T = { line: '#447dfc', green: '#00a442', red: '#fb2c36', amber: '#f99c00', text: '#18181a', text2: '#787878', text3: '#969696', grid: '#eeeeee', axis: '#d4d4d8' };
const FONT = 'InterVariable, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const pct1 = (x) => `${(x * 100).toFixed(1)}%`;
const pct0 = (x) => `${Math.round(x * 100)}%`;
const sgn = (x, d = 1, unit = '') => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(d)}${unit}`;
const cls = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : 'muted');
const icon = (n, c = '') => `<i data-lucide="${n}"${c ? ` class="${c}"` : ''}></i>`;
const icons = () => window.lucide && window.lucide.createIcons({ attrs: { 'stroke-width': 1.5 } });

let S = { view: { trig: true, checks: true, band: true, events: false }, showAllChecks: false };
let visChart, cusumChart;

const short = (day) => new Date(dayLabel(S.data.cfg, day) + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const platName = (id) => id === 'overall' ? 'All platforms' : S.data.engines[+id.split(':')[1]];
const enginesOf = (id) => id.startsWith('engine:') ? [+id.split(':')[1]] : [0, 1, 2, 3, 4];

function compute() {
  const seed = Math.max(1, Math.floor(+S.seedVal || 7));
  const data = generate({ seed });
  const agg = C.aggregate(data);
  const { raw, monitored } = C.buildSeries(agg);
  const cal = C.calibrate(monitored, { alpha: S.alpha });
  const det = C.detect(monitored, cal);
  const naive = C.naiveTrigger(raw, { thr: S.thr });
  Object.assign(S, { seed, data, agg, raw, monitored, cal, det, naive, cache: new Map() });
  S.scoreCal = C.scoreTriggers(det.alarms, data.cfg.events);
  S.scoreNaive = C.scoreTriggers(naive.map((f) => ({ day: f.day, series: 'raw', direction: f.direction })), data.cfg.events);
  S.checks = naive.map((f) => {
    const l1 = C.decompose(agg, { engines: [0, 1, 2, 3, 4], B: [f.day - 7, f.day - 1], A: [f.day, f.day], boot: 150, seed: 3 });
    const covered = det.alarms.find((a) => a.direction === f.direction && f.day >= a.changeDay && f.day <= a.day + 7);
    let status = 'noise';
    if (l1.mix.significant && Math.abs(l1.mix.value) > 0.5 * Math.abs(l1.delta.value)) status = 'artifact';
    else if (covered) status = 'covered';
    return { ...f, l1, status, covered };
  });
  S.selected = det.alarms.length ? { kind: 'cal', i: 0 } : naive.length ? { kind: 'naive', i: 0 } : null;
  S.series = S.selected?.kind === 'cal' ? det.alarms[0].series : 'overall';
}

function investigation(sel) {
  const key = `${sel.kind}:${sel.i}:${S.through}`;
  if (S.cache.has(key)) return S.cache.get(key);
  const t0 = performance.now();
  let r;
  if (sel.kind === 'cal') {
    const a = S.det.alarms[sel.i], engines = enginesOf(a.series);
    const B = [Math.max(0, a.changeDay - 14), a.changeDay - 1], A = [a.changeDay, Math.min(S.data.DAYS - 1, a.day + S.through)];
    const inv = C.investigate(S.data, S.agg, { engines, B, A, boot: 400, boot2: 80 });
    const items = C.actionItems(inv, S.data);
    const payload = C.agentPayload(a, inv, items, S.data, S.cal, (d) => dayLabel(S.data.cfg, d));
    payload.data_through = dayLabel(S.data.cfg, A[1]);
    r = { a, inv, items, payload, engines, B, A };
  } else {
    const f = S.checks[sel.i], B = [f.day - 7, f.day - 1], A = [f.day, f.day];
    const inv = C.investigate(S.data, S.agg, { engines: [0, 1, 2, 3, 4], B, A, boot: 300, boot2: 40 });
    r = { f, inv, items: C.actionItems(inv, S.data), engines: [0, 1, 2, 3, 4], B, A };
  }
  r.ms = performance.now() - t0;
  let n = 0; for (const [d0, d1] of [r.B, r.A]) for (let d = d0; d <= d1; d++) for (const e of r.engines) for (let p = 0; p < S.data.P; p++) n += S.agg.N[(d * S.data.E + e) * S.data.P + p];
  r.answers = n;
  S.cache.set(key, r);
  return r;
}

/* ---------------- settings panel ---------------- */
function renderSettings() {
  const { det, checks, cal } = S;
  const thr = Math.round(S.thr * 100);
  const runRow = (k, i, title, sub, ico, iconCls) => `<div class="run ${S.selected?.kind === k && S.selected.i === i ? 'sel' : ''}" data-k="${k}" data-i="${i}"><span class="t">${icon(ico, iconCls)}${title}</span><span class="s">${sub}</span></div>`;
  const runs = det.alarms.map((a, i) => {
    const d = investigation({ kind: 'cal', i }).inv.level1.delta.value;
    return runRow('cal', i, `${esc(platName(a.series))} <span class="${cls(d)} tnum">${sgn(d, 1, ' pts')}</span>`, `Run started ${short(a.day)}, 9:00 AM · change began ${short(a.changeDay)}`, 'play', '');
  }).join('');
  const show = S.showAllChecks ? checks : checks.slice(0, 4);
  const sup = show.map((f, i) => {
    const why = f.status === 'artifact' ? `Coverage artifact (${Math.round(100 * f.l1.mix.value / f.l1.delta.value)}% mix)` : f.status === 'covered' ? 'Same shift as a run above' : 'Within noise';
    return runRow('naive', i, `All platforms <span class="${cls(f.rel)} tnum">${sgn(f.rel, 1, '%')}</span>`, `${short(f.day)} · ${why} · no run`, 'circle-slash', '');
  }).join('');
  $('settings').innerHTML = `<div class="set-inner">
    <div class="set-top"><button class="icon-btn">${icon('minimize-2')}</button></div>
    <div class="agent-tile">${icon('activity')}</div>
    <div class="agent-name">Visibility Shift Responder</div>
    <p class="agent-desc">When Larkspur's Visibility Score moves by more than answer-engine noise, explain what changed and which sources to fix, then post it to #aeo-team.</p>
    <div class="byline"><span class="avatar">MG</span>Mohith · Updated 2h ago</div>

    <div class="sec">
      <div class="sec-h"><div class="left"><span class="dotted">Run triggers</span><input type="checkbox" class="switch" checked aria-label="Run triggers"></div><a class="add">${icon('plus')}Add</a></div>
      <div class="tcard">
        <div class="tcard-h">${icon('activity')}<div><div class="t">Visibility Score shifts beyond noise <span class="badge blue">New</span></div>
          <div class="s">Larkspur · All platforms and each platform · Checked daily</div></div><span class="end">${icon('trash-2', 'ic14')}</span></div>
        <div class="tform">
          <span class="k">Metric</span><span class="row"><span class="field">Visibility Score${icon('chevron-down')}</span></span>
          <span class="k">When</span><span class="row"><span class="field">Shifts beyond noise${icon('chevron-down')}</span></span>
          <span class="k">False triggers</span><span class="row"><span class="field"><select id="alpha"><option value="0.05">At most 5% / quarter</option><option value="0.1">At most 10% / quarter</option><option value="0.2">At most 20% / quarter</option></select>${icon('chevron-down')}</span></span>
          <span class="k">Threshold</span><span class="row tnum">h = ${cal.h.toFixed(2)}<span class="muted">&nbsp;· calibrated on ${cal.sims.toLocaleString()} replays</span></span>
          <span class="k">Explain with</span><span class="row"><span class="field"><select id="through"><option value="0">Data at detection</option><option value="7">Detection + 7 days</option></select>${icon('chevron-down')}</span></span>
          <span class="k">Synthetic seed</span><span class="row"><span class="field plain"><input id="seed" type="number" min="1" max="9999" value="${S.seed}"></span><button class="outline" id="regen">${icon('refresh-cw')}Regenerate</button></span>
        </div>
      </div>
      <div class="tcard paused">
        <div class="tcard-h">${icon('trending-down')}<div><div class="t">Visibility Score changes by
          <span class="field" style="height:24px"><select id="thr"><option value="0.03">3%</option><option value="0.05">5%</option><option value="0.1">10%</option></select>${icon('chevron-down')}</span></div>
          <div class="s">Against Last 7 days · Checked daily · Off, kept for comparison</div></div><span class="end"><span class="badge">Off</span></span></div>
      </div>
    </div>

    <div class="sec">
      <div class="sec-h"><div class="left"><span class="dotted">Trigger activity</span></div><span class="muted" style="font-size:13px">Last 90 days</span></div>
      <div class="runs">
        <div class="run-h"><span>Runs started · ${det.alarms.length}</span><span>calibrated</span></div>
        ${runs || '<div class="run"><span class="s">No move exceeded the threshold.</span></div>'}
        <div class="run-h"><span>Suppressed checks · ${checks.length}</span><span>"changes by ${thr}%"</span></div>
        ${sup}
        ${checks.length > 4 && !S.showAllChecks ? `<div class="more" id="moreChecks">Show all ${checks.length}</div>` : ''}
      </div>
    </div>

    <div class="sec">
      <div class="sec-h"><div class="left"><span class="dotted">Inputs</span></div><a class="add">${icon('plus')}Add</a></div>
      <div class="inputs">${['change_window', 'visibility_change_pts', 'ci95_pts', 'causes', 'idempotency_key'].map((n) => `<span class="chip">${icon('braces')}${n}</span>`).join('')}</div>
    </div>

    <div class="sec">
      <div class="sec-h"><div class="left"><span class="dotted">Instructions</span></div></div>
      <div class="instr"><h4>Role</h4><p>You explain shifts in Larkspur's AI visibility. You run only when the trigger fires, and you start from the attribution in the trigger inputs rather than re-deriving it.</p>
        <h4>Steps</h4><ol><li>Lead with the change and its 95% interval.</li><li>List causes whose interval excludes zero, largest first, each with one concrete fix.</li><li>If coverage mix explains the move, report a collector issue instead.</li><li>Post the summary to #aeo-team.</li></ol></div>
    </div>
  </div>`;
  $('alpha').value = String(S.alpha); $('thr').value = String(S.thr); $('through').value = String(S.through);
  $('alpha').onchange = (e) => { S.alpha = +e.target.value; rerun(); };
  $('thr').onchange = (e) => { S.thr = +e.target.value; rerun(); };
  $('through').onchange = (e) => { S.through = +e.target.value; renderSettings(); renderChat(); };
  $('regen').onclick = () => { S.seedVal = $('seed').value; rerun(); };
  $('seed').onkeydown = (e) => { if (e.key === 'Enter') { S.seedVal = e.target.value; rerun(); } };
  if ($('moreChecks')) $('moreChecks').onclick = () => { S.showAllChecks = true; renderSettings(); };
  $('settings').querySelectorAll('.run[data-k]').forEach((el) => el.onclick = () => {
    S.selected = { kind: el.dataset.k, i: +el.dataset.i };
    S.series = el.dataset.k === 'cal' ? S.det.alarms[+el.dataset.i].series : 'overall';
    renderSettings(); renderChat();
  });
  icons();
}

/* ---------------- chat (the run) ---------------- */
function barCell(v, ci, ext, color) {
  const pos = (x) => 50 + (x / ext) * 48;
  const l = Math.min(pos(0), pos(v)), w = Math.max(0.8, Math.abs(pos(v) - pos(0)));
  return `<div class="bar"><div class="z" style="left:${pos(0)}%"></div><div class="f" style="left:${l}%;width:${w}%;background:${color}"></div><div class="ci" style="left:${pos(ci[0])}%;width:${Math.max(0.6, pos(ci[1]) - pos(ci[0]))}%"></div></div>`;
}

function renderChat() {
  const { data } = S;
  if (!S.selected) { $('chat').innerHTML = '<div class="thread"><p class="muted">No triggered runs in this dataset.</p></div>'; return; }
  const r = investigation(S.selected);
  const { inv, items } = r, l1 = inv.level1;
  const unit = r.engines.length === 1 ? `${data.engines[r.engines[0]]} visibility` : 'all-platform visibility';
  let bubble, intro;
  if (S.selected.kind === 'cal') {
    const a = r.a;
    bubble = `<div class="bubble">Triggered by <b>Visibility Score shifts beyond noise</b> on <b>${esc(platName(a.series))}</b></div>
      <div class="bubble-meta">${short(a.day)}, 9:00 AM ${icon('copy')}</div>`;
    const cov = inv.coverage;
    const covTxt = cov.engines.length === 1 ? `${data.engines[cov.engines[0]]} run coverage was ${pct0(cov.before[0])} before and ${pct0(cov.after[0])} after` : 'run coverage was steady on every platform';
    intro = `<p><b>${esc(platName(a.series))} visibility ${l1.delta.value < 0 ? 'fell' : 'rose'} ${Math.abs(l1.delta.value * 100).toFixed(1)} points</b>, from ${pct1(l1.VB)} to ${pct1(l1.VA)}, starting ${short(a.changeDay)} (95% CI ${sgn(l1.delta.ci[0])} to ${sgn(l1.delta.ci[1])} pts). The move crossed the calibrated threshold on ${short(a.day)}, ${a.day - a.changeDay} days later. ${covTxt}, so this is not a sampling artifact.</p>
      <p>I compared ${short(r.B[0])}–${short(r.B[1])} with ${short(r.A[0])}–${short(r.A[1])}. Every number below comes from the trigger's attribution, with intervals from resampling prompts and days.</p>`;
  } else {
    const f = r.f;
    bubble = `<div class="bubble">Check: <b>Visibility Score changes by ${Math.round(S.thr * 100)}%</b> on <b>All platforms</b> (${sgn(f.rel, 1, '%')} vs last 7 days)</div>
      <div class="bubble-meta">${short(f.day)}, 9:00 AM · trigger off, no run started</div>`;
    const why = f.status === 'artifact'
      ? `Most of the move is <b>coverage mix</b>: one platform's runs failed, which changed which answers made up the average. Coverage mix accounts for ${sgn(l1.mix.value)} of the ${sgn(l1.delta.value)} pts change.`
      : f.status === 'covered' ? `This is the same shift the calibrated trigger already ran on (${esc(platName(f.covered.series))}, from ${short(f.covered.changeDay)}). Its idempotency key prevents a second run.`
        : 'No platform or topic moved by more than its own noise, so a run would only restate a random fluctuation.';
    intro = `<p><b>The calibrated trigger did not run here.</b> The dashboard number moved ${sgn(f.rel, 1, '%')} against its 7-day average (${sgn(l1.delta.value)} pts, 95% CI ${sgn(l1.delta.ci[0])} to ${sgn(l1.delta.ci[1])}). ${why}</p>`;
  }
  const rows = [{ name: '<span class="muted">Coverage mix (run failures)</span>', v: l1.mix.value, ci: l1.mix.ci, se: l1.mix.se, sig: l1.mix.significant, color: T.amber }]
    .concat(l1.cells.slice(0, 5).map((c) => ({ name: `${esc(data.engines[c.engine])} <span class="muted">· ${esc(data.topics[c.topic])}</span>`, v: c.value, ci: c.ci, se: c.se, sig: c.significant, color: c.value < 0 ? T.red : T.green })));
  const ext = Math.max(0.005, ...rows.flatMap((x) => [Math.abs(x.ci[0]), Math.abs(x.ci[1])]));
  const whereTbl = `<table class="tbl"><thead><tr><th>Platform · Topic</th><th class="r">Change</th><th class="r">95% CI</th><th class="barcell"></th></tr></thead><tbody>
    ${rows.map((x) => `<tr><td${x.sig ? '' : ' class="dim"'}>${x.name}</td><td class="r ${x.sig ? cls(x.v) : 'dim'}">${sgn(x.v)}</td><td class="r dim">${sgn(x.ci[0])} to ${sgn(x.ci[1])}</td><td class="barcell" style="opacity:${x.sig ? 1 : 0.35}">${barCell(x.v, x.ci, ext, x.color)}</td></tr>`).join('')}
  </tbody></table>`;
  const fixes = items.length ? `<ol>${items.slice(0, 5).map((it) => `<li><b>${esc(it.title)}</b> <span class="${cls(it.impact)} tnum">${sgn(it.impact, 1, ' pts')}</span> <span class="muted tnum">(95% CI ${sgn(it.ci[0])} to ${sgn(it.ci[1])})</span><span class="act">${esc(it.action)}</span></li>`).join('')}</ol>`
    : `<p class="muted">No cause clears its 95% interval, which is why no run was warranted.</p>`;
  const ex = inv.explanations[0];
  const cite = ex ? `<h3>Which sources explain it</h3><p>For ${esc(data.engines[ex.engine])} on ${esc(ex.topics.map((t) => data.topics[t]).join(' and '))}, holding every source at its old citation rate puts visibility at ${pct1(ex.model.vEmpty)}; the new citation set gives ${pct1(ex.model.vFull)}. Shapley values split that gap across sources.</p>
    <table class="tbl"><thead><tr><th>Source</th><th>Type</th><th class="r">Cited before</th><th class="r">Cited after</th><th class="r">Effect</th><th class="r">95% CI</th></tr></thead><tbody>
    ${ex.players.map((p) => `<tr><td>${esc(p.kind === 'unexplained' ? 'Not explained by citations' : p.name)}</td><td class="dim">${p.type ? p.type[0].toUpperCase() + p.type.slice(1) : '–'}</td><td class="r">${p.citeBefore != null ? pct0(p.citeBefore) : ''}</td><td class="r">${p.citeAfter != null ? pct0(p.citeAfter) : ''}</td><td class="r ${cls(p.value)}">${sgn(p.value)}</td><td class="r dim">${sgn(p.ci[0])} to ${sgn(p.ci[1])}</td></tr>`).join('')}
    </tbody></table>` : (l1.enoughDays ? '' : `<p class="muted">A one-day comparison can't separate day-to-day answer-engine drift from a real change, so no source attribution was run.</p>`);
  const c = S.scoreCal, n = S.scoreNaive, thr = Math.round(S.thr * 100);
  const perf = `<h3>How this trigger performed (last 90 days)</h3><div class="stat-row">
    <div class="stat"><div class="l">Runs started</div><div class="v">${c.fired} <small>vs ${n.fired} at ${thr}%</small></div></div>
    <div class="stat"><div class="l">Real shifts caught</div><div class="v">${c.caught}/${c.realEvents} <small>vs ${n.caught}/${n.realEvents}</small></div></div>
    <div class="stat"><div class="l">False triggers</div><div class="v">${c.falseFires} <small>vs ${n.falseFires}</small></div></div>
    <div class="stat"><div class="l">Detection delay</div><div class="v">${c.meanDelay != null ? c.meanDelay.toFixed(1) + ' days' : '–'} <small>mean</small></div></div></div>
    <p class="muted" style="font-size:13px;line-height:20px">"Real shifts" are the two citation changes planted in this synthetic dataset; the collector outage on ${short(S.data.cfg.events[0].start)}–${short(S.data.cfg.events[0].end)} is not a real shift.</p>`;
  const payload = S.selected.kind === 'cal' ? `<details class="collapse" open><summary>${icon('chevron-down')}Trigger inputs passed to this run</summary><pre class="code">${esc(JSON.stringify(r.payload, null, 2))}</pre></details>` : '';
  $('chat').innerHTML = `<div class="thread">
    <div class="bubble-row">${bubble}</div>
    <div class="worked">Analyzed ${r.answers.toLocaleString()} answers ${icon('chevron-right')}</div>
    <div class="md">${intro}
      <div class="card"><div class="card-pad">
        <div class="card-h"><div><span class="dotted">Visibility Score</span><div class="metric" id="metric"></div></div>
          <span style="display:flex;gap:6px;align-items:center"><span class="select"><span class="k">Platform</span><select id="platSel">${['overall', 0, 1, 2, 3, 4].map((x) => { const id = x === 'overall' ? 'overall' : 'engine:' + x; return `<option value="${id}">${esc(platName(id))}</option>`; }).join('')}</select>${icon('chevron-down')}</span><button class="icon-btn" id="dlBtn" title="Download CSV">${icon('download')}</button></span></div>
        <div class="chart-wrap"><canvas id="visChart"></canvas></div>
        <div class="chart-foot" id="chartFoot"></div>
      </div><div class="card-div card-pad" style="padding-top:12px;padding-bottom:12px">
        <div class="sub-label" style="margin-top:0"><span class="dotted" style="font-size:13px">Detector statistic</span><span style="color:${T.text3}" id="cusumSub"></span></div>
        <div class="chart-wrap short"><canvas id="cusumChart"></canvas></div></div></div>
      <h3>Where it moved</h3><p>Exact split of the ${sgn(l1.delta.value)} pt change in ${unit} into coverage mix and platform × topic effects. Faded rows don't pass a false-discovery test at q = ${l1.fdr}.</p>
      ${whereTbl}
      <h3>What changed and what to fix</h3>${fixes}
      ${cite}
      ${perf}
      ${payload}
    </div>
    <div class="feedback">${['copy', 'download', 'file-text', 'thumbs-up', 'thumbs-down'].map((n2) => `<button class="icon-btn">${icon(n2)}</button>`).join('')}</div>
  </div>`;
  $('platSel').value = S.series;
  $('platSel').onchange = (e) => { S.series = e.target.value; renderCharts(); };
  $('dlBtn').onclick = () => {
    const rows = ['date,dashboard_visibility,' + S.monitored.map((m) => `"${platName(m.id)}"`).join(',')];
    for (let d = 0; d < S.data.DAYS; d++) rows.push([dayLabel(S.data.cfg, d), S.raw.V[d].toFixed(4), ...S.monitored.map((m) => m.V[d].toFixed(4))].join(','));
    const u = URL.createObjectURL(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' })); const l = document.createElement('a'); l.href = u; l.download = `visibility-seed${S.seed}.csv`; l.click(); URL.revokeObjectURL(u);
  };
  icons();
  renderCharts();
  $('chat').scrollTop = 0;
}

/* ---------------- charts (AEI chart styling) ---------------- */
// faint dot grid behind the plot area, as in Answer Engine Insights charts
const dotGrid = {
  id: 'dotGrid',
  beforeDraw(chart) {
    const { ctx, chartArea: a } = chart; if (!a) return;
    ctx.save(); ctx.fillStyle = '#ececec';
    for (let x = a.left + 4; x < a.right; x += 8) for (let y = a.top + 4; y < a.bottom; y += 8) ctx.fillRect(x, y, 1, 1);
    ctx.restore();
  },
};
const overlay = {
  id: 'overlay',
  beforeDatasetsDraw(chart, _a, o) {
    if (!o || !o.items) return;
    const { ctx, chartArea: a, scales: { x } } = chart; ctx.save();
    for (const it of o.items) {
      if (it.type === 'band') { const x0 = x.getPixelForValue(it.from - 0.5), x1 = x.getPixelForValue(it.to + 0.5); ctx.fillStyle = it.color; ctx.fillRect(x0, a.top, x1 - x0, a.bottom - a.top); }
      else { const px = x.getPixelForValue(it.at); ctx.strokeStyle = it.color; ctx.setLineDash(it.dash || []); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke(); ctx.setLineDash([]); }
      if (it.label) { ctx.fillStyle = T.text3; ctx.font = `11px ${FONT}`; ctx.fillText(it.label, x.getPixelForValue(it.type === 'band' ? it.from - 0.5 : it.at) + 4, a.top + 10); }
    }
    ctx.restore();
  },
};

function renderCharts() {
  const { data, raw, monitored, det, naive, cal, view } = S;
  const labels = Array.from({ length: data.DAYS }, (_, d) => short(d));
  const si = monitored.findIndex((s) => s.id === S.series), s = monitored[si], tr = det.traces[si], all = si === 0;
  const V = s.V, cur = mean(V.slice(-7)), prev = mean(V.slice(-14, -7));
  $('metric').innerHTML = `${pct1(cur)} <span class="d ${cls(cur - prev)}">${sgn(cur - prev, 1, '%')}</span><span class="ctx">last 7 days vs prev. period</span>`;
  const ds = [];
  if (view.band) {
    const band = (k) => tr.mu.map((m, t) => (m == null ? null : (m + k * 1.96 * tr.sd[t]) * 100));
    ds.push({ label: 'band', data: band(1), borderWidth: 0, pointRadius: 0, fill: '+1', backgroundColor: 'rgba(68,125,252,0.07)' });
    ds.push({ label: 'band2', data: band(-1), borderWidth: 0, pointRadius: 0, fill: false });
  }
  ds.push({ label: platName(s.id), data: V.map((v) => v * 100), borderColor: T.line, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: T.line, pointHoverBorderColor: '#fff', pointHoverBorderWidth: 2, tension: 0 });
  if (all && view.checks) ds.push({ label: `Changes by ${Math.round(S.thr * 100)}%`, type: 'scatter', data: naive.map((f) => ({ x: labels[f.day], y: V[f.day] * 100 })), pointRadius: 3.5, backgroundColor: '#fff', borderColor: T.text3, borderWidth: 1.5 });
  const alarms = det.alarms.filter((a) => all || a.series === s.id);
  if (view.trig) ds.push({ label: 'Trigger fired', type: 'scatter', data: alarms.map((a) => ({ x: labels[a.day], y: V[a.day] * 100 })), pointRadius: 5, pointHoverRadius: 6, backgroundColor: T.line, borderColor: '#fff', borderWidth: 2 });
  const items = [];
  if (view.trig) alarms.forEach((a) => items.push({ type: 'line', at: a.changeDay, color: '#c8c8cc', dash: [3, 3] }));
  if (view.events) data.cfg.events.forEach((e) => e.kind === 'coverage' ? items.push({ type: 'band', from: e.start, to: e.end, color: 'rgba(249,156,0,0.10)', label: 'Outage' }) : items.push({ type: 'line', at: e.start, color: 'rgba(0,0,0,0.15)', dash: [2, 3], label: e.id }));
  const vals = V.map((v) => v * 100), lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.12;
  const tick = { color: T.text2, font: { family: FONT, size: 12 } };
  const tooltip = { backgroundColor: 'rgba(24,24,26,0.9)', titleColor: '#fff', bodyColor: '#fff', padding: 10, cornerRadius: 8, displayColors: true, boxWidth: 8, boxHeight: 8, usePointStyle: true, titleFont: { family: FONT, weight: '500', size: 13 }, bodyFont: { family: FONT, size: 13 } };
  const base = {
    responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: { ...tooltip, filter: (i) => !/band/.test(i.dataset.label), callbacks: { label: (i) => ` ${i.dataset.label}  ${i.parsed.y.toFixed(1)}%` } } },
    scales: {
      x: { ticks: { ...tick, maxTicksLimit: 7, maxRotation: 0, padding: 6 }, grid: { drawOnChartArea: false, drawTicks: true, tickLength: 6, color: T.axis }, border: { color: T.axis } },
      y: { min: +(lo - pad).toFixed(1), max: +(hi + pad).toFixed(1), ticks: { ...tick, count: 6, callback: (v) => v.toFixed(1) + '%' }, grid: { color: '#e8e8e8', drawTicks: false }, border: { display: false, dash: [3, 3] } },
    },
  };
  if (visChart) visChart.destroy();
  visChart = new Chart($('visChart'), { type: 'line', data: { labels, datasets: ds }, options: { ...base, plugins: { ...base.plugins, overlay: { items } } }, plugins: [dotGrid, overlay] });
  $('chartFoot').innerHTML = `<label><input type="checkbox" class="cb" data-v="trig" ${view.trig ? 'checked' : ''}>Trigger fired</label>
    ${all ? `<label><input type="checkbox" class="cb" data-v="checks" ${view.checks ? 'checked' : ''}>"Changes by ${Math.round(S.thr * 100)}%" checks</label>` : ''}
    <label><input type="checkbox" class="cb" data-v="band" ${view.band ? 'checked' : ''}>Noise band</label>
    <label class="sw"><input type="checkbox" class="switch" data-v="events" ${view.events ? 'checked' : ''}>Show planted events</label>`;
  $('chartFoot').querySelectorAll('input').forEach((el) => el.onchange = () => { S.view[el.dataset.v] = el.checked; renderCharts(); });
  if (cusumChart) cusumChart.destroy();
  cusumChart = new Chart($('cusumChart'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Upward', data: tr.cusumUp, borderColor: T.green, borderWidth: 1.5, pointRadius: 0, tension: 0 },
      { label: 'Downward', data: tr.cusumDown, borderColor: T.red, borderWidth: 1.5, pointRadius: 0, tension: 0 },
      { label: 'Threshold h', data: labels.map(() => cal.h), borderColor: T.text3, borderDash: [4, 3], borderWidth: 1, pointRadius: 0 },
    ] },
    options: { ...base, scales: { x: { display: false }, y: { min: 0, suggestedMax: cal.h * 1.35, ticks: { ...tick, maxTicksLimit: 3, font: { family: FONT, size: 11 } }, grid: { color: '#eeeeee', drawTicks: false }, border: { display: false, dash: [3, 3] } } }, plugins: { ...base.plugins, tooltip: { ...tooltip, callbacks: { label: (i) => ` ${i.dataset.label}  ${i.parsed.y?.toFixed(2)}` } } } },
  });
  $('cusumSub').textContent = `${platName(s.id)} · two-sided CUSUM; a run starts when it crosses h = ${cal.h.toFixed(2)}`;
}

function rerun() { compute(); renderSettings(); renderChat(); }

async function boot() {
  Chart.defaults.font.family = FONT;
  try { await document.fonts.ready; } catch (e) { /* ignore */ }
  const h = new URLSearchParams(location.hash.slice(1));
  Object.assign(S, { alpha: 0.1, thr: 0.05, through: 0, seedVal: h.get('seed') || 7 });
  compute();
  if (h.get('sel')) { const [k, i] = h.get('sel').split(':'); S.selected = { kind: k, i: +i }; S.series = k === 'cal' ? S.det.alarms[+i].series : 'overall'; }
  if (h.get('series')) S.series = h.get('series');
  renderSettings(); renderChat(); icons();
  $('runHistoryBtn').onclick = () => document.querySelector('.runs')?.scrollIntoView({ behavior: 'smooth' });
}
boot();
