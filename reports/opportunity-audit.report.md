# Reserved-family opportunity audit

The method and synthetic seed family were fixed in [the registration](opportunity-audit.registration.md) before execution. This report uses seeds **401–432**, two existing fixture variants per seed, and decision times **00:00, 00:35, 01:05, 01:35**. The simulator, observation rules, 90-second target, transparent baseline, v3 model, and AI display gate were unchanged. An in-memory trace of hidden synthetic vehicle motion was used only to diagnose counterfactual outcomes; the rankers received their existing operator-visible inputs. Full aggregates and disagreements are in [the results JSON](opportunity-audit.results.json). This is **not** a new held-out model evaluation or gate test.

## Opportunity versus ranking

| Decision-time GPS state | All views | Eligible | No candidate can succeed | At least one can succeed | Baseline finds success | Model finds success |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| All | 256 | 192 | 156 | 36 | 16 | 18 |
| Signal lost | 128 | 64 | 52 | 12 | 7 | 10 |
| Connected | 128 | 128 | 104 | 24 | 9 | 8 |

The 64 ineligible views are suppressed by the existing report freshness check; all occur during GPS loss. **156/192 eligible decisions (81.3%) are impossible for any candidate** under their fixed counterfactual and window. In the other 36, a successful candidate exists but the baseline misses it 20 times and the model misses it 18 times. Those are ranking misses, distinct from the 156 impossible decisions. These descriptive counts are from a diagnostic seed family and must not be substituted into the v3 display gate.

## Observation-condition funnel

Each row below counts **candidate orders**, not unique vehicles or decisions. The funnel is cumulative: a candidate reaches each stage only after satisfying the previous stage during its counterfactual replay. “Visible approach seen” is a separate diagnostic count of any qualifying edge traversal, even before the unit is ready. “Available” requires the valid simulated observation to become available to the operator by the endpoint.

| Candidate group | Orders | Visible approach seen at any time | Unit arrived | Three-second dwell | Approach while ready | Within 75 m | Clear visibility | Available observation |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| All | 3,810 | 492 | 1,401 | 1,294 | 58 | 52 | 48 | 44 |
| Decision during GPS loss | 1,158 | 143 | 415 | 375 | 17 | 16 | 16 | 16 |
| Decision while connected | 2,652 | 349 | 986 | 919 | 41 | 36 | 32 | 28 |

The **first unmet** condition is route/arrival for 2,409 candidates, dwell for 107, visible approach while ready for 1,236, 75 m range for 6, visibility state for 4, and the two-second availability deadline for 4. These sequential blockers plus 44 successes account for all 3,810 orders. Across all candidate choices, travel is the largest filter. Among the 1,294 candidates that reach the three-second dwell stage, only 58 overlap a visible vehicle approach; approach timing is the dominant later filter. A vehicle may use a junction approach before the unit is posted, as the 492 versus 58 counts show.

## Decision time

| Order time | Eligible / all views | Impossible | Feasible | Baseline / model successes | Candidate orders | Arrived → dwelled → approach → 75 m → clear → available |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 00:00 | 64 / 64 | 49 | 15 | 5 / 3 | 1,494 | 613 → 589 → 29 → 25 → 21 → 18 |
| 00:35 | 64 / 64 | 53 | 11 | 5 / 8 | 1,158 | 397 → 365 → 16 → 14 → 14 → 13 |
| 01:05 | 32 / 64 | 25 | 7 | 5 / 5 | 579 | 212 → 187 → 10 → 10 → 10 → 10 |
| 01:35 | 32 / 64 | 29 | 3 | 1 / 2 | 579 | 179 → 153 → 3 → 3 → 3 → 3 |

At 01:35, the 180-second replay endpoint leaves an effective **85-second** window; this was registered and not adjusted. Opportunity still declines from 15 feasible decisions at 00:00 to seven at 01:05, which has the full 90 seconds. The fixed decision grid and unit/vehicle timing both matter.

The time × outage cross-tab has these eligible/feasible pairs: 00:00 connected **64/15**; 00:35 connected **32/6** and signal lost **32/5**; 01:05 signal lost **32/7** (another 32 lost-signal views are stale); 01:35 connected **32/3** (all 32 lost-signal views are stale). The machine-readable report includes the full funnel for each pair. The outage grouping describes **GPS state when the decision was made**. It does not require the later observation to occur during that outage, and a valid unit observation never becomes a vehicle device report.

## Junctions

| Junction | Candidate orders | Vehicle visible-approach passes | Unit ready during approach | Available observations | Feasible decision–junction pairs |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1: 5th Street × Park Lane | 492 | 222 | 42 | 31 | 26 |
| 2: 5th Street × Fredman Drive | 492 | 134 | 0 | 0 | 0 |
| 3: 5th Street × Norwich Close | 426 | 69 | 10 | 8 | 8 |
| 4: 5th Street × Grayston Drive | 492 | 5 | 0 | 0 | 0 |
| 5: 5th Street × Helena Avenue | 492 | 0 | 0 | 0 | 0 |
| 6: 6th Street × Helena Avenue | 492 | 0 | 0 | 0 | 0 |
| 7: Fredman Drive × Sandown Valley Crescent | 432 | 47 | 3 | 3 | 3 |
| 8: Grayston Drive × Sandton Drive | 492 | 15 | 3 | 2 | 2 |

The three junctions with no v3 candidate successes—**4, 5, and 6—remain at zero** in this reserved family. Junctions 5 and 6 receive no configured visible approach in any candidate window. Junction 4 receives five such passes, but none overlaps a ready unit. Junction 2 also has zero success here despite 134 approach passes; none overlaps a ready unit. These are properties of the sampled synthetic trajectories and response timing, not evidence that any real road junction is unsuitable.

For completeness, the cumulative junction funnels are: J1 **252 → 238 → 42 → 36 → 34 → 31**; J2 **268 → 241 → 0 → 0 → 0 → 0**; J3 **113 → 91 → 10 → 10 → 9 → 8**; J4 **139 → 131 → 0 → 0 → 0 → 0**; J5 **188 → 181 → 0 → 0 → 0 → 0**; J6 **184 → 176 → 0 → 0 → 0 → 0**; J7 **132 → 120 → 3 → 3 → 3 → 3**; J8 **125 → 116 → 3 → 3 → 2 → 2**, in the same arrival-through-availability order as the table above.

## Interpretation and separate scenario-design proposal

The reserved family is similar to v3 in feasibility (**36/192** versus **33/192** eligible decisions with any successful candidate). The two policies' hit counts differ from v3, but this audit is not an independent replacement for the registered v3 model evaluation, and no new gate decision is inferred. The bottleneck remains the overlap among reachable unit posts, vehicle branch paths, and the observation horizon. It is still possible for either ranker to miss a feasible choice.

**Proposed future scenario-design study, requiring separate approval:** version a second synthetic fixture stream that varies vehicle starting corridors and unit patrol starting nodes across connected parts of the existing road graph, using a published seed-to-start rule fixed before outcomes are inspected. Keep the existing representative seed/time-grid stream intact and report it separately; use the varied stream to test whether more of the eight junctions receive plausible approach opportunities without conditioning fixture inclusion on hidden future vehicle paths. Preserve the same observation rule, 90-second target, operator-visible feature boundary, and transparent baseline. Any later model training would need fresh whole-family splits and the original display gate evaluated on a representative, unselected stream. No simulator, ranker, or UI change is part of this audit.

The v3 AI display gate remains failed and AI-generated options remain disabled. Every assignment or retask remains an explicit operator decision.
