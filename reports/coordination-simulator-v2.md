# Coordination simulator v2: short directed-edge observation sampling

The current simulator is `coordination-simulator-v2`. The earlier, unversioned observation sampler is identified here as `coordination-simulator-v1`. The version constant is included in each coordination snapshot and in the app's simulation label.

## Change

In v1, `move()` cleared `vehicle.edge` when a directed edge finished during a one-second simulation tick. The subsequent observation loop ran only if `vehicle.edge` was still set. A vehicle could therefore fully traverse a short designated incoming edge without that traversal being considered for a unit observation.

V2 retains the **actual directed edge traversed during the tick** for the observation check, even when the vehicle reaches its endpoint and `move()` clears its current edge. The check still requires an ordered unit to have completed its three-second stationary dwell at the junction, the traversed edge to be one of that junction's configured visible incoming approaches, the vehicle's simulated position on that traversal to be within 75 m, clear seeded visibility, and two more seconds before the observation is available to the operator. An edge on a nearby road or a unit merely close to the vehicle does not qualify. Existing per-unit/per-edge deduplication remains.

The vehicle branch policy, graph, unit and vehicle start positions, movement speed, traffic, GPS outage schedule, confirmed-report generation, timestamps, observed GPS marker, and operator-order behavior are unchanged. A unit observation during GPS loss stays a separate simulated unit report; it does not create a vehicle device report or move the last confirmed vehicle GPS position.

Focused fixtures use the graph's actual short incoming edges at Fredman Drive × Sandown Valley Crescent (7.63 m) and Grayston Drive × Sandton Drive (8.73 m). In selected seeds, each is fully crossed within one tick and was missed by v1; v2 produces one observation at 40 s/35 s respectively, available at 42 s/37 s. Tests also cover no order, insufficient dwell, an approach absent from the configured visible set, out-of-range motion before the final 75 m, blocked visibility, the two-second availability delay, deterministic replay after scrubbing, and a GPS-loss sighting with an unchanged last confirmed vehicle report.

## Unit 03's zero-second route in the v3 example

The synthetic Unit 03 start coordinate `[28.04625, -26.1053]` snaps to graph node `21626257` at `[28.0462866, -26.105317]`, about 4.1 m away. That node **is** the Grayston Drive × Sandton Drive objective. At 00:00, the unit's confirmed report is at that node. `currentTrafficRoute()` correctly returns zero seconds when the report's nearest graph node equals the objective node. The v3 candidate is a retask because Unit 03 has a prior order to Norwich Close in that fixture, but it is already physically at Sandton Drive. There is no route-construction or feature-extraction defect to fix. Whether a future scenario should start Unit 03 elsewhere is a separate design decision; this calculation was not changed.

## Model and evaluation boundary

The saved `observation-ranker-v3` weights and `ranking-evaluation.v3.json` remain untouched historical results from **v1**. V2 can change counterfactual labels and observation rates, including which candidate succeeds. The earlier held-out rate, calibration, uncertainty interval, and gate decision have **not** been re-evaluated under v2. This fix does not establish that the existing model performs better, is calibrated under v2, or passes the agreed display gate. AI-generated advice remains disabled. The v3 training script now refuses to overwrite the v3 artifacts while the current simulator version is v2; any later experiment requires a separately versioned model and report.
