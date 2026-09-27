# Preregistered team-policy-v2 offline diagnostic

Registered **2026-09-27 22:14 UTC**, before any outcomes on these seeds. Whole
seed families **3001–3064 inclusive** are reserved. A search of current study
scripts and registrations, repository history, and seed fields in existing
result JSON found no earlier use of this range; an unrelated numeric route
estimate in an old JSON file is not a seed. These families were not used to
select or tune this policy. Do not alter the policy thresholds or selection
rules after inspecting outcomes. This study uses unchanged
`coordination-simulator-v2`, observation rules, transparent baseline and
browser advice state. It is not model training or an AI display-gate test.

Frozen SHA-256 values: evaluator
`de37bbb42c588cb3d04634ab431ebdf6801e9c1fb24c83456b4fdfd2e6dc2088`;
simulator
`c25a8317ea8feae11e5f1cc6e320b7bb3b34c78eac3c2c5852ef76491fa49042`;
ranker and transparent baseline
`a418901a843bd8a918066dc56018877d9ee028f469d04b6d3497ffbfcda63110`;
team timing helper
`c0f7754350fd60cd730e87cd74f21c95d204dee9f0f62a3b9bd47cfc428c9899`;
road graph
`6f2289657af8707d79d59a253e5c03788fbe94cd50ddafe0aaae4cf0a69aa370`.

## Frozen views and comparison arms

- Use decision seconds **0, 35, 65, 95** for each seed in two separate
  streams. The representative stream uses the original graph, congestion
  `seed % 2`, and extra outage pattern `floor(seed / 2) % 2`. The alternate
  stream uses graph layout `2 + seed % 2`, congestion `2 + seed % 2`, and
  extra outage pattern `2 + floor(seed / 2) % 2`. Layouts 2 and 3 add the
  same deterministic synthetic connectors as team-combination-v1. The base
  simulator's planned outage at 60–90 seconds also applies in every run.
  Extra outage patterns are: 0 none, 1 45–105, 2 30–75, 3 80–125 seconds.
  The traffic seed is `seed + congestion * 100003`.
- A prior order at second 0 assigns Unit 03 to junction 3 when
  `seed % 3 === 0`, Unit 02 to junction 7 when `seed % 3 === 1`, and no
  extra unit otherwise. All four arms receive the identical pre-decision
  run and operator-visible snapshot.
- The arms are **no new order**, the unchanged **single-order transparent
  baseline** (highest baseline score), the unchanged **equal-budget
  two-order transparent baseline** (top two baseline candidates for distinct
  units), and the fixed **team-policy-v2** below. The common candidate pool
  is `rankingCandidates` filtered by the existing
  `assessTeamCandidate(...).fitsWindow` check. Thus the current confirmed
  vehicle report must be at most **30 s** old, each candidate's confirmed
  unit report at most **10 s** old, device/receipt chronology valid, route
  finite, and
  `ceil(decisionSecond + currentTrafficRouteSeconds + 3) + 2 <= min(decisionSecond + 90, 180)`.
  Baseline ties break by unit ID and objective ID. A policy can choose two
  distinct units at most.

## Frozen v2 policy

Only current confirmed device reports, already available simulated unit
observations, current displayed traffic, graph geometry, and existing orders
enter policy selection. No hidden vehicle position, future traffic or
reports, outcome, or vehicle branch score enters it. A unit observation is
separate from vehicle GPS; it becomes usable only at or after its two-second
availability time. Corridor support below is a hypothesis, not a predicted
vehicle route or sighting.

1. **Report-supported approaches.** A confirmed vehicle report can support
   a configured directed incoming approach only if its age is **≤15 s**,
   reported speed **≥5 km/h**, and its position is **≤30 m** from its nearest
   graph node. From that node, enumerate directed paths of at most **4
   edges** and **45 s** using only currently displayed traffic and posted
   edge speeds. The first edge must differ from the report heading by
   **≤50°**. An approach is supported when its own edge is on one of those
   paths. These paths are alternatives, not probabilities. No heading
   extrapolation from a stale report is permitted.
2. **Observation-supported approaches.** A valid simulated unit observation
   may support a *different* junction's configured incoming approach only
   when it is already available and its observation time is **≤20 s** old.
   Enumerate directed paths from its observed junction of at most **2
   edges** and **30 s** at current displayed traffic and posted speeds.
   Its own junction is excluded, since a past sighting does not imply a
   return. This rule is available during vehicle GPS loss and never moves
   the last confirmed GPS marker.
3. **Committed-post protection.** An existing unit order is a committed
   post when that unit has a valid confirmed report aged **≤10 s**, a finite
   current-traffic route to its ordered junction, and
   `ceil(decisionSecond + routeSeconds + 3) + 2 <= min(decisionSecond + 90, 180)`.
   This includes a unit still travelling toward its post. Its graph-valid
   configured incoming edges remain protected even if the vehicle evidence
   currently supports none of them. For any proposed set, remove all posts
   held by retasked units and add its proposed destination edges. Reject
   the set if **any** edge in the original committed-post union disappears.
   Duplicate coverage by a remaining post can protect an edge. An
   uncommitted post cannot supply protected coverage.
4. **Select zero, one or two.** A candidate must have at least one
   report- or observation-supported incoming approach that adds an edge not
   already in committed-post coverage. Select the highest baseline-scored
   admissible candidate as the first order, or **zero** if none exists. In
   baseline score order, select a second candidate only for a different
   unit, only if the pair passes committed-post protection, and only if
   that second target has at least one supported incoming edge absent
   after the first order and retained posts. Otherwise select **one**.
   Thus configured approach count alone cannot elevate Helena or any
   other exploratory junction. This fixed greedy rule is not optimized
   against counterfactual outcomes.

For **every** arm, selected orders are sorted lexically by
`unitId:objectiveId`, appended after prior actions, and applied at the
same integer decision second. That is the deterministic action-log order.
The simulator independently replays each arm from the same decision view,
so changed evasive vehicle branches caused by unit movement are retained
in each arm's outcome.

## Frozen outcome and analysis

- A hit is any **new valid simulated unit observation**, including from an
  incumbent, with `observedSecond > decisionSecond` and
  `availableSecond <= min(decisionSecond + 90, 180)`. The no-order arm is
  the paired control. Existing observations already made before the
  decision do not count, even if they become available later.
- Report eligible-view and all-view observation rates separately for each
  stream. Count added hits, lost no-order hits, and net effect against no
  order; paired v2 differences versus no order, single baseline and
  equal-budget baseline; actual counts of **0/1/2 orders** and total
  orders; Helena J5/J6 selections; first availability and distinct observed
  junctions. A lost no-order hit is identified as a relinquished-observer
  loss when the arm orders the same unit that would have observed under no
  order; otherwise report it separately as a changed-outcome loss. This
  classification does not prove causality on its own.
- Separate representative and alternate streams, connected and GPS-loss
  decision views, and their intersections. Use **5,000 paired percentile
  bootstrap draws resampling whole seed families** for rate differences.
  Combined resampling keeps both streams and all decision times of a seed
  together. Preserve all individual cases and observation times so examples
  of beneficial holding and missed useful orders can be audited. Do not
  tune the policy on these results.
- This is a diagnostic, with no browser promotion or model training.
  Improved intervisibility and line of sight remain a later, separately
  versioned simulator limitation.
