# Preregistered synthetic opportunity audit

Registered **2026-09-27 13:37 UTC**, before executing the reserved seed family. This is a diagnostic study, not a new model evaluation, gate calculation, or training set. Its results will not be used to retune the v3 model or claim that the AI display gate passed.

## Frozen fixtures

- Vehicle seeds: **401–432 inclusive**, all 32 whole seed families. These seeds are outside the v3 training (1–32), validation (33–40), exploratory (61–272), and held-out (273–304) families. No adjacent replay ticks are split between families.
- Two fixtures per seed, using the existing held-out family formula: variant index 0/1; layout `2 + variantIndex`; congestion `2 + ((seed + variantIndex) % 2)`; outage `2 + ((floor(seed / 2) + variantIndex) % 2)`. The existing synthetic prior-order rule (`seed % 3`) and traffic-seed formula remain unchanged.
- Fixed decision times: **0, 35, 65, 95 seconds**. There are 32 × 2 × 4 = **256** decision views before report-eligibility filtering. No time is selected after seeing results.
- Counterfactual endpoint: `min(180, orderSecond + 90)` seconds, as in v3. Thus 95-second orders have an effective 85-second remainder in the 180-second run. This truncation will be reported, not adjusted.
- Candidate set: the existing `rankingCandidates` function, including its operator-visible provenance and stale-data eligibility checks. Each candidate is one unit, one junction, and one order time. A successful candidate requires a valid simulated unit observation **available** after the order and by the endpoint. The hidden simulated vehicle path is used only for offline outcome diagnosis.
- Transparent baseline and trained v3 model: score existing candidates using their unchanged scoring functions; break ties by unit ID and junction ID as in the v3 evaluation. No retraining, probability refit, or advice display.

Frozen source SHA-256 values at registration:

| Source | SHA-256 |
| --- | --- |
| `src/coordination.ts` | `98f9f023f3e01a610461065e6b832b6e193c8565f67e3e34909e43526cf83fbe` |
| `src/ranking.ts` | `a418901a843bd8a918066dc56018877d9ee028f469d04b6d3497ffbfcda63110` |
| `src/generated/ranking-model.v3.json` | `03879561dd025d000f6a4f95f47f625186b8b9fc148926fbd9d9f2a49076d982` |
| `public/coordination-graph.json` | `6f2289657af8707d79d59a253e5c03788fbe94cd50ddafe0aaae4cf0a69aa370` |
| `scripts/train-ranking.mjs` (fixture formula reference) | `4248416fc7344d9839a72322454b2462420eed10672d57e5c6aab065ec5f1746` |

## Measures and analysis fixed before execution

1. Count all 256 views, ineligible views, eligible decisions, number of candidate orders, and decisions with **any** successful candidate. An eligible decision with none is an impossible case for any ranker under this fixed counterfactual and horizon.
2. Among feasible decisions, count baseline and model top-choice success and their misses separately. A miss here is a ranking error in a feasible candidate set. On impossible decisions, a failed top choice is not called a ranking error. Report descriptive rates only; do not calculate a new display gate or treat this family as a replacement held-out model test.
3. For every candidate, trace the first unmet observation stage in this fixed order: route/arrival by endpoint; three-second stationary dwell; designated visible vehicle approach while the unit is ready; vehicle within 75 m on that approach; clear seeded visibility; two-second availability by endpoint; success. A stage count is a **sequential primary blocker**, not an independent causal effect. Also report a cumulative funnel (arrival, dwell, approach, range, visibility, available observation) and whether the vehicle used that approach at any time, including before unit readiness.
4. Cross-tabulate feasibility, policy choices, candidate stage blockers, and the cumulative funnel by **decision time**, by **candidate junction**, and by **GPS outage state at decision time**. Also report the time × outage cross-tab. An observation during a GPS outage remains a simulated unit observation; it does not become a vehicle device report.
5. Explicitly inspect the three v3 zero-success junctions: junction 4 (5th Street × Grayston Drive), junction 5 (5th Street × Helena Avenue), and junction 6 (6th Street × Helena Avenue). Report candidate counts, visible approach passes, ready-unit overlap, and successes for each; a zero in this family is evidence of this simulator's sampled trajectories, not proof a real junction is useless.
6. Contrast reserved-family findings with v3 descriptively, keeping denominators and outage definitions explicit. Do not adjust seeds, times, junctions, simulator geometry, observation conditions, or thresholds after seeing outcomes. Any scenario-design proposal is a separate future study with a representative, unselected evaluation stream retained.

Implementation will instrument an in-memory copy of the unchanged observation loop and write a machine-readable aggregate plus a narrative report. The instrumented truth trace is never passed to the browser ranker.
