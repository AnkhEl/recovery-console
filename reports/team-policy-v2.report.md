# Team-policy-v2: frozen offline diagnostic

The [pre-outcome registration](team-policy-v2.registration.md) fixed whole seed
families **3001–3064**, policy thresholds, four decision times, two streams,
four arms, deterministic same-tick order application, and paired analysis.
The [evaluator](../scripts/evaluate-team-policy-v2.mjs) and
[`coordination-simulator-v2`](../src/coordination.ts) retain their registered
SHA-256 values. Complete paired cases, action order, observation times, and
bootstrap intervals are in the [results JSON](team-policy-v2.results.json).
This is a synthetic diagnostic, not a browser policy or model evaluation.

There are **512 paired decision views**: 64 whole seeds × two streams × four
times. The unchanged common candidate eligibility admits **416** views and
suppresses **96**, all at GPS-loss decisions where reports fail the existing
freshness gate. Rates below use the eligible-view denominator; across all
512 views, including suppressed ones where incumbents can still observe,
hits were **49 no order, 50 single baseline, 50 equal-budget baseline, 51
v2**.

## Observation outcomes

A hit is any new valid simulated unit observation, including by an incumbent,
observed after the decision and available by the earlier of 90 seconds later
or replay end. “Added” and “lost” are paired comparisons with the identical
no-new-order view, so a policy cannot take credit for a sighting that an
incumbent would have made anyway.

| Stream (eligible views) | No order | Single baseline | Equal-budget two-order baseline | Team-policy-v2 |
| --- | ---: | ---: | ---: | ---: |
| Representative (224) | 19 (8.5%) | 18 (8.0%) | 19 (8.5%) | 19 (8.5%) |
| Alternate (192) | 19 (9.9%) | 21 (10.9%) | 20 (10.4%) | 21 (10.9%) |
| Combined (416) | 38 (9.1%) | 39 (9.4%) | 39 (9.4%) | 40 (9.6%) |
| GPS loss at decision (128) | 11 (8.6%) | 8 (6.3%) | 14 (10.9%) | 12 (9.4%) |

| Arm, combined eligible views | Added / lost vs no order | Net | Actual 0 / 1 / 2 order views | Total orders | Helena J5/J6 orders |
| --- | ---: | ---: | ---: | ---: | ---: |
| No order | 0 / 0 | 0 | 416 / 0 / 0 | 0 | 0 |
| Single baseline | 26 / 25 | +1 | 0 / 416 / 0 | 416 | 124 |
| Equal-budget baseline | 37 / 36 | +1 | 0 / 19 / 397 | 813 | 250 |
| Team-policy-v2 | **2 / 0** | **+2** | **387 / 29 / 0** | **29** | **0** |

On the **representative stream**, v2 added **zero** and lost **zero** hits
versus no order. On the **alternate stream**, it added **two** and lost
**zero**. During **GPS loss**, it added **one** and lost **zero**. The
single baseline lost the no-order observation in 25 views, 24 of which
retasked the unit that would have observed; the equal-budget baseline lost
36, all 36 with that retask. V2 had no such losses. This
“retasked observer” classification checks the actual no-order observer
against the arm's orders; it identifies a relinquished-post risk but does
not alone prove what caused every changed vehicle branch.

Paired 95% percentile bootstrap intervals resampled all four times and
both streams together by **whole seed family** (5,000 fixed-seed draws):

| Comparison, combined eligible views | Difference in observation rate | 95% interval |
| --- | ---: | ---: |
| V2 − no order | +0.48 percentage points | 0 to +1.21 |
| V2 − single baseline | +0.24 points | −3.85 to +4.32 |
| V2 − equal-budget baseline | +0.24 points | −4.81 to +5.31 |

The intervals include zero. On the representative stream, v2 and no
order had identical binary outcomes in every eligible view, yielding
**0 points (0 to 0)**; that degenerate interval describes this sample,
not certainty about future seeds. On the alternate stream v2 − no order
was **+1.04 points (0 to +2.60)**. At GPS-loss decisions v2 − no order
was **+0.78 points (0 to +2.34)**, while v2 − equal-budget was **−1.56
points (−8.59 to +5.47)**. These results do not establish an advantage
over the single or two-order reference.

## What the frozen rule actually selected

Only **84/416** eligible views had even one approach supported by the
registered confirmed-report or already-available unit-observation
corridors. V2 issued an order in **29** of those views and **none** in
the other 387. By decision time, support and v2 orders were:

| Decision second | Eligible views | Views with a supported approach | V2 orders |
| --- | ---: | ---: | ---: |
| 0 | 128 | 0 | 0 |
| 35 | 128 | 34 | 14 |
| 65 | 96 | 36 | 11 |
| 95 | 64 | 14 | 4 |

The simulator's initial confirmed vehicle report has zero reported
speed, so the registered **≥5 km/h** report-corridor condition yields no
support at 00:00; no previous available unit observation exists then.
Although 43 views had support on incoming edges at two or more
junctions, the combined eligibility, protected-post, baseline order,
and marginal supported-edge tests selected **no two-order pairs**. The
study therefore provides **no outcome evidence that v2 coordinates two
new orders well**. Zero Helena selections shows this rule avoids that
exploratory preference; it does not show Helena is impossible or that
zero is the best possible rate.

## Paired replay examples

Junction IDs use the app's named objectives: J1 5th Street × Park Lane,
J3 5th Street × Norwich Close, and J7 Fredman Drive × Sandown Valley
Crescent. Times are seconds into the three-minute synthetic replay.

- **Holding preserves a sighting, seed 3010 / representative / 00:00.**
  With no new order, U02's committed J7 post observes a Fredman Drive
  approach at **00:53**, available **00:55**. The single baseline's
  U03→J1 order retains it. The equal-budget second order retasks
  U02→J1, and the paired replay has no observation. V2 selects zero and
  retains U02's sighting. The protected post was still en route at the
  decision, demonstrating why protection must include committed travel.
- **Holding during GPS loss, seed 3001 / alternate / 00:35.** V2 selects
  zero. U02 at J7 observes the vehicle at **01:55**, available **01:57**
  within the **02:05** deadline. Both baselines retask U02 and miss.
  This is a simulated unit observation, not a new vehicle GPS report.
- **A useful order missed at the start, seed 3014 / representative /
  00:00.** No order and v2 both miss. The single baseline assigns
  U02→J1, producing a Park Lane observation at **01:21**, available
  **01:23** within the **01:30** deadline. V2 has no supported approach
  because the initial confirmed report has zero speed. This is the
  cost of its evidence threshold, visible without changing it.
- **A useful retask rejected during GPS loss, seed 3018 / alternate /
  01:05.** U03 is committed to J3. The single baseline retasks
  U03→J1 and observes a 5th Street approach at **02:30**, available
  **02:32** before the **02:35** deadline. No order and v2 miss. V2
  has supported J1 approaches but protects U03's existing unique J3
  coverage. The counterfactual success was unavailable to the policy
  at decision time; it shows the protection rule's opportunity cost.
- **A selected corridor can still be wrong, seed 3021 / alternate /
  00:35, GPS lost.** V2 assigns U02→J2 on a supported approach and
  misses. The single baseline's U03→J1 retask yields a Park Lane
  observation at **01:45**, available **01:47**. Approach support is
  geometric evidence from prior reports, not a reliable future-route
  forecast.
- **A v2 gain, seed 3035 / alternate / 01:05, GPS lost.** V2 assigns
  U02→J1 and receives a valid Park Lane observation at **02:04**,
  available **02:06**; no new order misses. This is one of only two
  incremental v2 hits.

Every arm's orders were applied lexically by `unitId:objectiveId`
at the decision second, after prior actions. Each arm replayed the
simulator independently from the identical view. The vehicle's
unit-responsive branches were therefore part of the measured
outcome, rather than held fixed across different orders.

## Interpretation and limits

V2 is a conservative **zero-or-one-order policy in this sample**, despite
being able to select two. Its zero observed incumbent losses reflect
both post protection and its very small order count. Its two gains,
wide paired intervals, and missed baseline successes prevent a claim
that it improves recovery coordination. There is no basis to promote
it to browser suggestions. The current browser Scenario analysis and
Team coverage views, v3 historical model, AI display gate, and disabled
AI-generated advice remain unchanged.

The corridors use reported heading and current displayed traffic,
never hidden vehicle motion or future traffic. They cannot account
for later evasive branches. Outcomes remain synthetic and depend on
one attributed road network plus synthetic connector variants.
The simulator still uses designated visible approach edges, 75 m range,
three-second dwell and seeded visibility; buildings, terrain,
obstructions and unit sight direction are absent. Improved
intervisibility and line-of-sight modelling requires a separately
versioned simulator study.

Verification: `npm run check` passed (Prettier, strict TypeScript,
repository verification and five test files); the evaluator passed
`node --check`; a result audit confirmed all 512 paired views,
64 seed families, distinct-unit budgets, lexical action order,
selection/application consistency, and every observation's deadline.
Registered evaluator and simulator hashes still match after the run.
No browser code changed, so no browser review was run for this offline
study.
