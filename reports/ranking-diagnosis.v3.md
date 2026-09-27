# V3 held-out observation diagnosis

This is an offline replay of the unchanged v3 held-out families (vehicle seeds 273–304, two graph/congestion/outage variants each, decisions at 0, 35, 65, and 95 seconds). The diagnostic instruments an in-memory copy of the observation loop; it does not change the simulator, ranking model, evaluation split, observation rule, display gate, or app. Vehicle truth is used here only to audit synthetic counterfactual outcomes, never as a ranking feature. The replay reproduces the saved evaluation exactly: 256 decisions, 192 eligible decisions, 33 decisions with at least one successful candidate, 8 baseline top-choice observations, and 12 model top-choice observations. The machine-readable trace aggregate and all 155 baseline/model disagreements are in [ranking-diagnosis.v3.json](ranking-diagnosis.v3.json).

## Feasibility and policy choices

| Held-out decision group | Eligible decisions | Any candidate succeeds | Baseline succeeds | Model succeeds |
| --- | ---: | ---: | ---: | ---: |
| All | 192 | 33 (17.2%) | 8 (4.2%) | 12 (6.3%) |
| Decision during vehicle GPS loss | 64 | 6 (9.4%) | 2 (3.1%) | 5 (7.8%) |
| Decision outside vehicle GPS loss | 128 | 27 (21.1%) | 6 (4.7%) | 7 (5.5%) |

Of the 159 eligible decisions with no successful candidate, no ranker could produce an observation under the fixed counterfactual and 90-second label. Of the 33 feasible decisions, the model succeeds in 12 (36.4%) and misses 21; the baseline succeeds in 8 (24.2%). The model therefore has genuine ranking misses as well as a low ceiling from scenario feasibility. Signal-loss results are based on only six feasible decisions and are too small to infer a reliable advantage.

The 64 other decisions have no candidates because the existing operator-visible report eligibility check suppresses stale input. They are not included in the 192-decision rates. The 95-second decision has only 85 seconds before the 180-second replay ends, despite the nominal 90-second horizon.

## Arrival and observation conditions

For each policy's 192 selected orders, the traffic-aware route estimate was at most 90 seconds in 189 baseline choices and all 192 model choices. The selected unit actually reached its junction by the counterfactual endpoint in 175 baseline and 184 model choices. Thus the low top-choice observation rate is not mainly explained by the selected units' route length. The categories below are **sequential primary blockers**: each failed order is assigned to its first unmet condition in observation-rule order. They are not independent counts of every condition that failed.

| Selected outcome or primary blocker | Baseline, all 192 | Model, all 192 | Baseline, 64 GPS-loss decisions | Model, 64 GPS-loss decisions |
| --- | ---: | ---: | ---: | ---: |
| Valid observation available in horizon | 8 | 12 | 2 | 5 |
| Route/arrival | 17 | 8 | 9 | 5 |
| Three-second stationary dwell | 6 | 12 | 1 | 6 |
| No visible vehicle approach while ready | 155 | 158 | 52 | 48 |
| Beyond 75 m on visible approach | 2 | 0 | 0 | 0 |
| Seeded visibility state blocks sighting | 4 | 2 | 0 | 0 |
| Two-second availability delay crosses endpoint | 0 | 0 | 0 | 0 |

Across **all 3,804 candidate orders**, rather than the two policies' selected orders, 2,498 fail at route/arrival, 89 at dwell, 1,161 at visible approach, 6 at 75 m, and 11 at visibility state; 39 succeed. Only 516 candidate runs contain any vehicle pass on the candidate junction's visible approach during the order window. In only 56 does that pass overlap a ready, stationary unit. These are candidate-run counts, so the same vehicle path can be counted under different counterfactual unit orders. The contrast matters: many raw candidates are too far away, while the policies' mostly reachable selections are blocked by vehicle approach coverage.

## Decision time and junction coverage

| Order time | Eligible | Any candidate succeeds | Baseline succeeds | Model succeeds |
| --- | ---: | ---: | ---: | ---: |
| 00:00 | 64 | 23 | 5 | 5 |
| 00:35 | 64 | 8 | 2 | 5 |
| 01:05 | 32 | 1 | 1 | 1 |
| 01:35 | 32 | 1 | 0 | 1 |

All eight junction nodes are reachable from the simulated vehicle start in both held-out graph layouts, and all configured visible-approach edge IDs exist in the base graph. Static reachability is therefore not the same as a useful observation opportunity. Candidate counterfactuals succeed at Park Lane 20 times, Norwich Close 7, Sandown Valley Crescent 6, Sandton Drive 5, and Fredman Drive 1. Grayston Drive, Helena Avenue, and 6th Street × Helena Avenue have zero successful candidates; the last two have **no vehicle pass** on a configured visible approach in any candidate window, and Grayston Drive has one such pass without a ready unit. The candidate junction set is geographically legal but includes sites the current held-out vehicle paths almost never expose to an observation.

The fixed time grid also concentrates opportunity at 00:00 and 00:35. A full 90-second window at 01:05 still yields only one feasible case in 32 eligible decisions, so truncation at 01:35 is not the only cause. The 90-second horizon is meaningful for some runs (33 feasible decisions), but sparse enough that a 5-percentage-point absolute improvement means roughly ten additional successful choices out of 192; the model produced four. No observation constraint or threshold was relaxed in this diagnosis.

## Concrete replay disagreements

The examples below are synthetic counterfactual replays. “Arrival” means the unit reached its ordered junction; “observation” is the later valid unit sighting available to the operator. GPS-loss examples use the last confirmed vehicle report as model input, not the hidden vehicle position.

| Seed / held-out fixture / order | Transparent baseline choice and outcome | V3 model choice and outcome |
| --- | --- | --- |
| 273 / layout 2, congestion 3, outage 2 / 00:00 | Unit 03 → 5th Street × Park Lane; arrives 01:08; observation at 01:11, available 01:13. | Unit 03 → Grayston Drive × Sandton Drive; arrives 00:01; no visible approach while ready. |
| 273 / layout 3, congestion 2, outage 3 / 00:00 | Unit 03 → 5th Street × Park Lane; arrives 01:10; no visible approach while ready. | Unit 03 → Grayston Drive × Sandton Drive; arrives 00:01; observation at 01:04, available 01:06. |
| 276 / layout 2, congestion 2, outage 2 / 00:35, GPS lost | Unit 01 → 6th Street × Helena Avenue; arrives 01:02; no visible approach. | Unit 03 → 5th Street × Park Lane; arrives 01:08; observation at 01:59, available 02:01. The decision was during GPS loss; this particular observation occurred after that fixture's early outage ended. |
| 291 / layout 3, congestion 2, outage 2 / 00:35, GPS lost | Unit 02 → 5th Street × Norwich Close; arrives 01:36, after the vehicle's relevant approach; no observation. | Unit 02 → 5th Street × Park Lane; arrives 01:16; observation at 01:26, available 01:28. |

The first two fixtures deliberately keep the seed and order time but change held-out layout, congestion, and outage pattern. They show why one junction can be right in one synthetic future and wrong in another. The model's probability for its first two choices is about 3.3%, consistent with its low confidence. Its choices differ from the baseline in 155 of 192 eligible decisions: nine disagreements favor the model, five favor the baseline, one succeeds for both, and 140 fail for both. The other two shared choices account for each policy's remaining successes.

Decision-time GPS loss and observation-time GPS loss are distinct. In the second seed-273 example, the unit observes the vehicle at 01:04 **during the scheduled 01:00–01:30 device outage**. That valid simulated unit observation does not create a vehicle device report or move the last confirmed GPS marker. The 64-case signal-loss stratum above groups decisions made while GPS was lost; its successful observations can occur during or after the outage.

## Diagnosis and proposed next experiment

The principal cause of the low **overall** rate is sparse feasible opportunity: 159/192 decisions cannot succeed under any candidate. The model is also weak **within** those opportunities, missing 21/33 feasible decisions. Later decision times, unit travel time for many raw candidates, and little overlap between vehicle approaches and posted units explain the scarcity. Range, visibility state, and the two-second availability delay contribute relatively few first failures. GPS loss reduces the feasible fraction further (6/64), but a unit observation can still be valid during loss when all independent observation conditions are met; this audit does not treat hidden simulator position as a report or sighting.

For the next experiment, first build a **pre-registered opportunity audit**, keeping the current rules, 90-second target, family-level split, and display gate fixed. Record the proportion of feasible cases and the stage funnel by decision time, junction, and outage state on a newly reserved synthetic seed family before training. If those fixtures remain as sparse as v3, propose a separate, explicitly versioned scenario-design study that samples more decision moments with realistic unit/vehicle approach overlap, while retaining a representative unselected stream and evaluating both strata. Compare any new model to the unchanged transparent baseline on untouched held-out families, with the original overall gate and uncertainty estimate. This would test whether better ranking is possible without presenting an opportunity-enriched score as the original operational rate. Do not change the simulator or retrain until this proposal is reviewed.

The v3 display gate still fails: model 6.25% versus baseline 4.17%, an absolute +2.08 percentage points with paired 95% seed-bootstrap interval −1.56 to +5.73 points; the required improvement is at least +5 points with the interval excluding zero. AI-generated options remain disabled. The full gate and calibration result are in [ranking-evaluation.v3.json](ranking-evaluation.v3.json).
