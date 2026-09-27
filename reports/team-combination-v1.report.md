# Team-combination-v1: offline coordination diagnostic

The [registration](team-combination-v1.registration.md) fixed whole seed families **2001–2032**, two separately reported streams, four decision times, four paired arms, observation outcomes, and whole-seed uncertainty before the first run. The study used unchanged `coordination-simulator-v2` and the existing transparent single-candidate baseline. Complete cases and aggregates are in [the results JSON](team-combination-v1.results.json). No model was trained, no browser suggestions changed, and AI-generated advice remains disabled.

The representative stream uses the original road graph; the alternate stream varies graph connectors, synthetic congestion, and GPS outage patterns. Each has 128 views (32 seeds × four times). The same seed contributes to both streams, so combined uncertainty resamples whole seeds. Of 256 views, **208** passed the shared report and earliest-availability eligibility checks; **48** were suppressed, all during GPS loss. A policy can issue at most two orders, to distinct units. The two two-order arms issued exactly the same **405** orders across eligible views, while the single-order reference issued **208**.

## Overall observations and incremental value

A hit is any *new* valid simulated unit observation, including one made by an incumbent, observed after the decision and available by `min(decision time + 90 seconds, 03:00)`. The no-new-order arm uses the same prior run and is the control. “Added” counts a policy hit when no order missed; “lost” counts a no-order hit removed by that policy; net is added minus lost. Rates use the same eligible-view denominator within each row.

| Stream | Eligible | No order | Single baseline | Two-order baseline | Team combination | Team added / lost vs no order |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Representative | 112 | 10 (8.9%) | 14 (12.5%) | 9 (8.0%) | 10 (8.9%) | 8 / 8; net 0 |
| Alternate | 96 | 4 (4.2%) | 17 (17.7%) | 16 (16.7%) | 18 (18.8%) | 16 / 2; net +14 |
| Combined | 208 | 14 (6.7%) | 31 (14.9%) | 25 (12.0%) | 28 (13.5%) | 24 / 10; net +14 |
| GPS loss at decision | 64 | 6 (9.4%) | 11 (17.2%) | 6 (9.4%) | 6 (9.4%) | 5 / 5; net 0 |

Across **all 256 views**, including the 48 where no new order was eligible, the no-order, single, two-order baseline, and team policies hit **18, 35, 29, and 32** times respectively (7.0%, 13.7%, 11.3%, 12.5%). Ineligible views still permit observations by incumbents; they are not silently removed from that overall count.

The team policy's paired improvement over the equal-budget baseline was **+1.44 percentage points** combined (95% whole-seed bootstrap interval **−0.48 to +3.43**), **+0.89** on the representative stream (**−1.83 to +3.70**), and **+2.08** on the alternate stream (**0 to +5.21**). These intervals do **not** establish a reliable advantage. The representative team's net effect versus no order was **0 points** (interval **−9.26 to +9.17**). Combined, its net effect versus no order was **+6.73 points** (**+1.42 to +12.25**), driven by the alternate stream. During GPS loss, team minus equal-budget baseline and team minus no order were both **0 points** (intervals **−4.69 to +4.69** and **−9.38 to +9.38**, respectively). The single-order baseline beat the team policy by **1.44 points** combined (team minus single interval **−4.88 to +1.90**).

The single-order arm added **21** hits and lost **4** incumbent hits relative to no order; the equal-budget baseline added **24** and lost **13**; the team policy added **24** and lost **10**. Issuing more orders can remove an observation an incumbent would otherwise make, or change the evasive vehicle's synthetic route. Overall hit counts alone conceal that trade-off.

## Feasibility and policy disagreements

Among 208 eligible views, **148** had no hit under the no-order arm or any legal single or distinct-unit pair. **14** already had a no-order hit, and **46** had an incremental observation opportunity found by the offline oracle. On the representative stream those counts were **82 impossible, 10 no-order hits, 20 incremental opportunities**; on the alternate stream **66, 4, 26**. At GPS-loss decisions, **49 of 64** eligible views had no legal success, **6** already had a no-order hit, and **9** had an incremental opportunity. The oracle used counterfactual outcomes only after policies were fixed; no policy received hidden state or oracle choices.

The two two-order arms chose genuinely different *sets* in **115/208** eligible views. The team policy won the paired binary outcome in **four** such views and lost in **one**; most disagreements changed neither hit. Examples (junction numbers use the eight named objectives in the app):

| Seed / stream / time | Equal-budget baseline | Team combination | No order → baseline → team |
| --- | --- | --- | --- |
| 2005 / representative / 00:00 | U03→J1, U02→J1 | U01→J5, U03→J1 | hit → miss → hit |
| 2028 / representative / 01:05, GPS lost | U03→J1, U01→J5 | U01→J5, U02→J4 | miss → hit → miss |
| 2030 / alternate / 00:00 | U03→J1, U02→J1 | U02→J1, U03→J3 | miss → miss → hit |

The first example is **preservation of an incumbent hit**, not a newly created observation. The second is a real team-policy miss during signal loss. These policies were evaluated as simultaneous synthetic orders for a fair two-order budget; the browser still requires separate operator confirmation and recomputation after each order.

## Diagnosis and limits

The team policy eliminated same-junction pairs in this sample, versus **76** such pairs selected by the equal-budget baseline. Yet it selected Helena junctions J5/J6 **186 times out of 405 orders**, versus **118/405** for the equal-budget baseline; on the representative stream the counts were **98/214 versus 62/214**. Maximizing configured approach union can overvalue junctions without evidence that this synthetic vehicle will traverse them. This agrees with the earlier reserved-family opportunity audit's caution about Helena, but the old audit outcomes were never policy inputs. The representative result and GPS-loss result do not justify promoting this combination policy in the browser.

All results describe synthetic counterfactuals on one attributed road network and graph variants. They do not estimate real recovery performance. The vehicle may respond differently to each policy's unit positions; paired runs share the seed and pre-decision view, not an artificially fixed future path. The 90-second earliest-availability filter uses current traffic and cannot guarantee arrival under future changes. Stronger **intervisibility and line-of-sight modelling** remains a later simulator limitation: v2 uses designated approach edges, 75 m range, three-second dwell, and seeded visibility, without buildings, terrain, street obstructions, or unit sight direction. Any such change needs a separately versioned simulator and fresh evaluation. The transparent baseline, v3 historical model, AI display gate, and app advice state were unchanged.
