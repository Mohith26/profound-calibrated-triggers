# Calibrated visibility-shift triggers (concept demo for Profound)

**Live demo:** https://mohith26.github.io/profound-calibrated-triggers/

Unofficial concept demo by Mohith Gajjela. Not affiliated with Profound. All data is synthetic: the brand (Larkspur), its competitors and most cited sources are fictional, and the dataset comes from a seeded generator in this repo.

## What it is

Profound Agents can run on a trigger such as "when your visibility changes by 5%". Answer engines are stochastic, though. The same prompt asked three times on the same day gives different answers, and a collector outage on one engine changes the engine mix behind the dashboard number. A fixed percentage threshold therefore fires on noise and on sampling artifacts, and when it does fire, the Agent starts with nothing more than "visibility moved".

This demo is a drop-in replacement for that trigger:

1. **Fire only on real shifts, with a stated false-trigger budget.** Each monitored series (all engines, mix-standardized, plus one series per engine) gets a two-sided CUSUM detector. Every day's value is standardized by its own noise: a cluster-robust sampling variance (prompts are clusters) plus a day-level drift term estimated from the baseline. The threshold `h` is not hand-tuned. It is calibrated by bootstrap replays of the baseline (whole days resampled jointly across series, with the baseline mean and scale re-estimated in every replay), so that P(any false trigger across all series in a 90-day quarter) ≤ α.
2. **Say when it started.** On a trigger, the change day is estimated by maximum likelihood (two-segment mean shift).
3. **Say where it moved.** The change in visibility between the before and after windows is split *exactly* into a coverage-mix term (which engine/topic cells got answered) and one rate term per engine × topic cell (a two-factor Shapley split of share × rate). Uncertainty comes from a two-way bootstrap over prompts and days, and cells are tested with Benjamini-Hochberg at q = 0.1.
4. **Say why, and what to fix.** For the significant cells, a ridge logistic model links "brand mentioned" to the set of cited domains (plus topic and a post-period term). The counterfactual question is: "what would visibility be if each source's citation rate had stayed at its before-period level?" Exact Shapley values over the top moving sources, plus "other citation shifts" and "not explained by citations (engine-side)", split that gap. A probit-matching correction handles the nonlinearity. Bootstrap refits give confidence intervals. Results become a ranked "what changed and what to fix" list.
5. **Hand the Agent a payload, once.** The trigger emits a structured JSON payload (change window, CI, ranked causes with CIs, suggested actions) with an idempotency key derived from the series, change day and direction, so repeated detections of the same shift do not start duplicate runs.

## What the synthetic data contains (seed 7)

72 tracked prompts (6 topics × 12) × 5 engines × 3 runs/day × 90 days = 97,200 runs, with prompt effects, correlated within-day noise, and 15 cited domains whose presence shifts the brand-mention probability. Three events are planted (`src/generate.js`, `data/events-seed7.json`):

- **E1** Google AI Overviews runs fail about 90% of the time for 4 days (a collector outage). Real visibility does not change.
- **E2** Perplexity stops citing a review site (`stackreviews.com`) on Pricing and Small-business prompts, and a competitor's page replaces it.
- **E3** ChatGPT starts citing the brand's own docs (`larkspur.io`) on Integrations and Migration prompts.

On seed 7 at a 10% quarterly budget, the calibrated trigger fires twice. It catches E2 and E3, estimates the change days exactly, makes no false triggers, and stays silent during the outage. The "changes by 5%" rule fires 11 times, and 10 of those are false (2 come from the outage). The attribution names `stackreviews.com` (left) and `pipelinehq.com` (entered) for E2, and `larkspur.io` (entered) for E3, with intervals that exclude zero. Try other seeds with the seed box; results vary, which is the point of showing them honestly.

## Run it

```bash
# demo (any static server; ES modules need http, not file://)
python3 -m http.server 8000   # then open http://localhost:8000

# tests (Node 18+, no dependencies)
node --test test/*.test.js

# regenerate the committed daily summary for a seed
node data/generate.js 7
```

Deep links work for review, for example `#series=engine:1&sel=naive:1`.

## Layout

- `src/generate.js`: seeded synthetic dataset (fictional brand, engines, topics, sources, planted events)
- `src/core.js`: aggregation, noise model, calibration, CUSUM detector, change-point MLE, exact Level-1 split, ridge logistic (IRLS), exact Shapley, counterfactual attribution, action items, agent payload
- `test/core.test.js`: 10 tests (Shapley axioms, logistic recovery, exact split identity, outage attributed to mix, detection plus change-point accuracy, false-trigger budget on event-free data, planted causes recovered with CIs excluding zero, idempotency key stability)
- `index.html`, `app.js`, `styles.css`: the concept screen (Chart.js from a CDN, no build step)

## Honest limitations

- The data is synthetic and the generator matches the model's assumptions (citations shift mention probability additively on the logit scale). Real answer engines will violate this. The "not explained by citations" term is there to absorb that, but it is only as good as the citation features.
- The calibration bootstraps a 35-day baseline with days treated as independent. Real series have weekly seasonality and autocorrelation, which would call for a block bootstrap or a seasonal baseline. On 40 event-free seeds the observed false-trigger rate was below the target, so it errs conservative. The cost is detection delay (about 6 to 7 days here).
- Re-baselining after a trigger uses the 10 days following the estimated change point. A second shift inside that window is missed.
- Counterfactual attribution is associational. It says how much of the move is accounted for by citation-set changes under the fitted model, not that a source *caused* it. Correlated sources share credit in the way Shapley splits it.
- One-day comparison windows (as used to explain a naive fire) cannot resample day-level noise, so cells are not tested there.
- I have no access to Profound's real data model or runtime. "Payload to the Agent" is a guess at a reasonable interface.
