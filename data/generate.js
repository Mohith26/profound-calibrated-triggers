// Seeded data script: regenerates the synthetic dataset and writes a small daily summary for inspection.
// Usage: node data/generate.js [seed]   (the web demo runs the same generator in the browser)
import { writeFileSync } from 'node:fs';
import { generate, dayLabel } from '../src/generate.js';
import { aggregate, buildSeries } from '../src/core.js';

const seed = Number(process.argv[2] || 7);
const data = generate({ seed });
const { raw, monitored } = buildSeries(aggregate(data));
const rows = ['date,raw_visibility,responses,' + data.engines.map((e) => `"${e}"`).join(',')];
for (let d = 0; d < data.DAYS; d++) {
  rows.push([dayLabel(data.cfg, d), raw.V[d].toFixed(4), raw.n[d], ...monitored.slice(1).map((s) => s.V[d].toFixed(4))].join(','));
}
writeFileSync(new URL(`./daily-seed${seed}.csv`, import.meta.url), rows.join('\n') + '\n');
writeFileSync(new URL(`./events-seed${seed}.json`, import.meta.url), JSON.stringify(data.cfg.events, null, 2) + '\n');
console.log(`seed ${seed}: ${data.ok.length} runs (${data.ok.reduce((s, x) => s + x, 0)} succeeded), ${data.P} prompts x ${data.E} engines x ${data.R} runs x ${data.DAYS} days`);
