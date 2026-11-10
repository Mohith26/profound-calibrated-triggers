// Seeded synthetic answer-engine dataset for a fictional brand ("Larkspur", a CRM).
// Every response is one run of one tracked prompt on one engine on one day.
// The generator plants three ground-truth events so detectors can be scored:
//   E1 coverage outage  : Google AI Overviews runs fail ~90% for 4 days (no real visibility change)
//   E2 citation loss     : Perplexity stops citing a review site on Pricing + Small-business prompts
//   E3 citation gain     : ChatGPT starts citing the brand's own docs on Integrations + Migration prompts

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normal(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const logit = (p) => Math.log(p / (1 - p));

export const ENGINES = ['ChatGPT', 'Perplexity', 'Google AI Overviews', 'Gemini', 'Copilot'];
export const TOPICS = ['CRM pricing', 'Integrations', 'Small-business CRM', 'Enterprise CRM', 'CRM migration', 'Sales automation'];

// type drives the "what to fix" copy; beta is the effect of being cited on the brand being mentioned (logit scale)
export const DOMAINS = [
  { name: 'larkspur.io', type: 'owned', base: 0.10, beta: 1.8 },
  { name: 'stackreviews.com', type: 'review', base: 0.38, beta: 1.3 },
  { name: 'softwarecompare.net', type: 'review', base: 0.25, beta: 0.6 },
  { name: 'relaycrm.com', type: 'competitor', base: 0.22, beta: -0.9 },
  { name: 'pipelinehq.com', type: 'competitor', base: 0.15, beta: -1.0 },
  { name: 'orbitcrm.io', type: 'competitor', base: 0.12, beta: -0.7 },
  { name: 'reddit.com', type: 'community', base: 0.30, beta: 0.4 },
  { name: 'youtube.com', type: 'video', base: 0.14, beta: 0.2 },
  { name: 'wikipedia.org', type: 'reference', base: 0.12, beta: 0.1 },
  { name: 'techledger.com', type: 'news', base: 0.10, beta: 0.3 },
  { name: 'smbplaybook.com', type: 'blog', base: 0.10, beta: 0.25 },
  { name: 'salesopsweekly.com', type: 'blog', base: 0.08, beta: -0.2 },
  { name: 'integrationhub.dev', type: 'directory', base: 0.09, beta: 0.35 },
  { name: 'crmfaq.org', type: 'blog', base: 0.07, beta: 0.0 },
  { name: 'foundermag.com', type: 'news', base: 0.06, beta: -0.15 },
];

export const DEFAULT_CONFIG = {
  seed: 7,
  days: 90,
  startDate: '2026-08-01',
  promptsPerTopic: 12,
  runsPerPrompt: 3,
  baseFailure: 0.03,
  engineAlpha: [-0.35, -0.15, -1.6, -0.5, -0.6],
  promptSd: 0.7,
  dayNoiseSd: 0.55, // shared by all runs of a prompt on an engine on a day (answer engines are correlated within a day)
  events: [
    { id: 'E1', kind: 'coverage', label: 'AI Overviews run failures (collector outage)', engine: 2, start: 40, end: 43, failure: 0.9 },
    { id: 'E2', kind: 'citation_loss', direction: 'down', label: 'Perplexity drops stackreviews.com on Pricing + Small-business', engine: 1, topics: [0, 2], start: 55, domain: 1, to: 0.05, alsoDomain: 4, alsoAdd: 0.45 },
    { id: 'E3', kind: 'citation_gain', direction: 'up', label: 'ChatGPT starts citing larkspur.io docs on Integrations + Migration', engine: 0, topics: [1, 4], start: 72, domain: 0, to: 0.75 },
  ],
};

export function generate(overrides = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...overrides };
  const rng = mulberry32(cfg.seed);
  const E = ENGINES.length, T = TOPICS.length, D = DOMAINS.length;
  const P = T * cfg.promptsPerTopic, R = cfg.runsPerPrompt, DAYS = cfg.days;
  const promptTopic = new Int32Array(P);
  const promptGamma = new Float64Array(P);
  for (let p = 0; p < P; p++) { promptTopic[p] = Math.floor(p / cfg.promptsPerTopic); promptGamma[p] = cfg.promptSd * normal(rng); }

  // base citation probability per engine x topic x domain (logit jitter around the domain base rate)
  const pi = new Float64Array(E * T * D);
  for (let e = 0; e < E; e++) for (let t = 0; t < T; t++) for (let d = 0; d < D; d++) {
    pi[(e * T + t) * D + d] = sigmoid(logit(DOMAINS[d].base) + 0.45 * normal(rng));
  }
  // prompt-level citation jitter (some prompts pull particular sources more)
  const promptCiteJitter = new Float64Array(P * D);
  for (let i = 0; i < P * D; i++) promptCiteJitter[i] = 0.35 * normal(rng);

  const N = DAYS * E * P * R;
  const ok = new Uint8Array(N), mention = new Uint8Array(N), cites = new Uint32Array(N);
  const idx = (day, e, p, r) => ((day * E + e) * P + p) * R + r;

  for (let day = 0; day < DAYS; day++) {
    for (let e = 0; e < E; e++) {
      let fail = cfg.baseFailure;
      for (const ev of cfg.events) if (ev.kind === 'coverage' && ev.engine === e && day >= ev.start && day <= ev.end) fail = ev.failure;
      for (let p = 0; p < P; p++) {
        const t = promptTopic[p];
        const u = cfg.dayNoiseSd * normal(rng);
        for (let r = 0; r < R; r++) {
          const k = idx(day, e, p, r);
          if (rng() < fail) { ok[k] = 0; continue; }
          ok[k] = 1;
          let mask = 0, z = cfg.engineAlpha[e] + promptGamma[p] + u;
          for (let d = 0; d < D; d++) {
            let q = pi[(e * T + t) * D + d];
            for (const ev of cfg.events) {
              if (ev.kind === 'coverage' || ev.engine !== e || day < ev.start || !ev.topics.includes(t)) continue;
              if (d === ev.domain) q = ev.to;
              if (ev.alsoDomain === d) q = Math.min(0.95, q + ev.alsoAdd);
            }
            const qq = sigmoid(logit(Math.min(0.97, Math.max(0.02, q))) + promptCiteJitter[p * D + d]);
            if (rng() < qq) { mask |= 1 << d; z += DOMAINS[d].beta; }
          }
          cites[k] = mask;
          mention[k] = rng() < sigmoid(z) ? 1 : 0;
        }
      }
    }
  }
  return { cfg, E, T, D, P, R, DAYS, promptTopic, ok, mention, cites, engines: ENGINES, topics: TOPICS, domains: DOMAINS };
}

export function dayLabel(cfg, day) {
  const d = new Date(cfg.startDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + day);
  return d.toISOString().slice(0, 10);
}
