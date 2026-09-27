import { build } from "esbuild";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const compiled = await build({
  stdin: {
    contents:
      'export * from "./src/coordination.ts"; export * from "./src/ranking.ts"; export * from "./src/teamCoverage.ts"; export * from "./src/scenario.ts";',
    resolveDir: process.cwd(),
    sourcefile: "team-policy-v2-evaluation-entry.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const engine = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
if (engine.COORDINATION_SIMULATOR_VERSION !== "coordination-simulator-v2")
  throw new Error("This registered study requires coordination-simulator-v2");
const graphFile = JSON.parse(
  readFileSync("public/coordination-graph.json", "utf8"),
);
const hash = (value) => {
  let result = 2166136261;
  for (const char of value)
    result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return result >>> 0;
};
function graphVariant(layout) {
  if (layout === 0) return new engine.CoordinationGraph(graphFile);
  const existing = new Set(
    graphFile.edges.map(([from, to]) => [from, to].sort().join(":")),
  );
  const options = [];
  for (let i = 0; i < graphFile.nodes.length; i++)
    for (let j = i + 1; j < graphFile.nodes.length; j++) {
      const a = graphFile.nodes[i];
      const b = graphFile.nodes[j];
      const physical = [a[0], b[0]].sort().join(":");
      if (existing.has(physical)) continue;
      const dy = (a[2] - b[2]) * 111195;
      const dx = (a[1] - b[1]) * 111195 * Math.cos((a[2] * Math.PI) / 180);
      const metres = Math.hypot(dx, dy);
      if (metres < 35 || metres > 70) continue;
      options.push({
        from: a[0],
        to: b[0],
        order: hash(`${physical}:${layout}`),
      });
    }
  options.sort((a, b) => a.order - b.order);
  const edges = [...graphFile.edges];
  for (const connector of options.slice(0, 2 + layout * 2)) {
    edges.push([
      connector.from,
      connector.to,
      "Synthetic alternate connector",
      25,
    ]);
    edges.push([
      connector.to,
      connector.from,
      "Synthetic alternate connector",
      25,
    ]);
  }
  return new engine.CoordinationGraph({ ...graphFile, edges });
}
const graphs = [0, 2, 3].map(graphVariant);
const sources = new Map(
  graphs.map((graph, index) => [
    [0, 2, 3][index],
    new engine.CoordinatedIncidentSource(graph),
  ]),
);
const graphByLayout = new Map(
  graphs.map((graph, index) => [[0, 2, 3][index], graph]),
);
const seeds = Array.from({ length: 64 }, (_, index) => 3001 + index);
const decisionSeconds = [0, 35, 65, 95];
const arms = [
  "noOrder",
  "singleBaseline",
  "equalBudgetBaseline",
  "teamPolicyV2",
];
const THRESHOLDS = Object.freeze({
  vehicleReportAgeSeconds: 15,
  unitReportAgeSeconds: 10,
  unitObservationAgeSeconds: 20,
  minimumVehicleSpeedKmh: 5,
  vehicleReportToNodeMetres: 30,
  firstEdgeHeadingToleranceDegrees: 50,
  vehicleCorridorMaximumEdges: 4,
  vehicleCorridorMaximumSeconds: 45,
  observationCorridorMaximumEdges: 2,
  observationCorridorMaximumSeconds: 30,
});

function pattern(seed, stream) {
  return stream === "representative"
    ? {
        layout: 0,
        congestion: seed % 2,
        outage: Math.floor(seed / 2) % 2,
      }
    : {
        layout: 2 + (seed % 2),
        congestion: 2 + (seed % 2),
        outage: 2 + (Math.floor(seed / 2) % 2),
      };
}
function scenario(seed, currentPattern) {
  const prior =
    seed % 3 === 0
      ? { unitId: "unit-3", objectiveId: "junction-3" }
      : seed % 3 === 1
        ? { unitId: "unit-2", objectiveId: "junction-7" }
        : null;
  return {
    id: `team-policy-v2-seed-${seed}`,
    name: "Offline team policy diagnostic",
    seed,
    trafficSeed: seed + currentPattern.congestion * 100003,
    trafficPattern: currentPattern.congestion,
    actions: prior
      ? [
          {
            id: `prior-${seed}`,
            second: 0,
            unitId: prior.unitId,
            objectiveId: prior.objectiveId,
            kind: "assign",
          },
        ]
      : [],
    outages:
      currentPattern.outage === 0
        ? []
        : currentPattern.outage === 1
          ? [{ start: 45, end: 105 }]
          : currentPattern.outage === 2
            ? [{ start: 30, end: 75 }]
            : [{ start: 80, end: 125 }],
  };
}
const compareCandidate = (a, b) =>
  b.baselineScore - a.baselineScore ||
  a.unitId.localeCompare(b.unitId) ||
  a.objectiveId.localeCompare(b.objectiveId);
const key = (candidate) => `${candidate.unitId}:${candidate.objectiveId}`;
const edgeSeconds = (edge, levels) =>
  edge.length /
  Math.max(
    2,
    (edge.speedKmh / 3.6) * [1, 0.75, 0.5][levels.get(edge.physicalId) ?? 0],
  );
const bearing = (a, b) =>
  ((Math.atan2((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]) *
    180) /
    Math.PI +
    360) %
  360;
const headingDifference = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// These are operator-visible corridor hypotheses, not vehicle route forecasts.
function supportedApproaches(view, graph) {
  const valid = new Set(graph.edges.map((edge) => edge.id));
  const approaches = new Set(
    view.objectives.flatMap((objective) =>
      (objective.visibleApproachEdgeIds ?? []).filter((id) => valid.has(id)),
    ),
  );
  const levels = new Map(
    view.trafficSegments.map((item) => [item.id, item.level]),
  );
  const support = new Map();
  const add = (id, source) => {
    if (!approaches.has(id)) return;
    const sources = support.get(id) ?? new Set();
    sources.add(source);
    support.set(id, sources);
  };
  const report = view.lastConfirmedReport;
  const start = graph.nearestNode(report.coordinates);
  if (
    report.kind === "confirmed_device_report" &&
    view.reportAgeSeconds <= THRESHOLDS.vehicleReportAgeSeconds &&
    report.speedKmh >= THRESHOLDS.minimumVehicleSpeedKmh &&
    engine.distance(report.coordinates, graph.nodes.get(start)) <=
      THRESHOLDS.vehicleReportToNodeMetres
  ) {
    const queue = [{ node: start, edges: 0, seconds: 0 }];
    while (queue.length) {
      const current = queue.shift();
      if (current.edges >= THRESHOLDS.vehicleCorridorMaximumEdges) continue;
      for (const edge of graph.outgoing.get(current.node) ?? []) {
        if (
          current.edges === 0 &&
          headingDifference(
            bearing(graph.nodes.get(edge.from), graph.nodes.get(edge.to)),
            report.headingDegrees,
          ) > THRESHOLDS.firstEdgeHeadingToleranceDegrees
        )
          continue;
        const seconds = current.seconds + edgeSeconds(edge, levels);
        if (seconds > THRESHOLDS.vehicleCorridorMaximumSeconds) continue;
        add(edge.id, "vehicle_report_corridor");
        queue.push({ node: edge.to, edges: current.edges + 1, seconds });
      }
    }
  }
  for (const observation of view.observations) {
    if (
      observation.availableSecond > view.displaySecond ||
      observation.observedSecond > view.displaySecond ||
      view.displaySecond - observation.observedSecond >
        THRESHOLDS.unitObservationAgeSeconds
    )
      continue;
    const queue = [{ node: observation.junction.nodeId, edges: 0, seconds: 0 }];
    while (queue.length) {
      const current = queue.shift();
      if (current.edges >= THRESHOLDS.observationCorridorMaximumEdges) continue;
      for (const edge of graph.outgoing.get(current.node) ?? []) {
        const seconds = current.seconds + edgeSeconds(edge, levels);
        if (seconds > THRESHOLDS.observationCorridorMaximumSeconds) continue;
        // A past sighting at this junction is not evidence of a return.
        for (const objective of view.objectives)
          if (
            objective.id !== observation.junction.id &&
            objective.visibleApproachEdgeIds?.includes(edge.id)
          )
            add(edge.id, "available_unit_observation_corridor");
        queue.push({ node: edge.to, edges: current.edges + 1, seconds });
      }
    }
  }
  return support;
}

function committedPosts(view, graph) {
  const posts = new Map();
  const end = Math.min(
    view.displaySecond + engine.OBSERVATION_HORIZON_SECONDS,
    180,
  );
  const display = Date.parse(view.displayTimestamp);
  const valid = new Set(graph.edges.map((edge) => edge.id));
  for (const unit of view.units) {
    const objective = view.unitObjectives[unit.unitId];
    const report = unit.currentReport;
    if (!objective || !report || report.kind !== "confirmed_device_report")
      continue;
    const device = Date.parse(report.deviceTimestamp);
    const receipt = Date.parse(report.serverReceiptTimestamp);
    if (
      !Number.isFinite(device) ||
      !Number.isFinite(receipt) ||
      device > receipt ||
      receipt > display ||
      (display - device) / 1000 > THRESHOLDS.unitReportAgeSeconds
    )
      continue;
    const route = engine.currentTrafficRoute(
      graph,
      report.coordinates,
      objective,
      view.trafficSegments,
    );
    if (
      !Number.isFinite(route.seconds) ||
      Math.ceil(view.displaySecond + route.seconds + 3) + 2 > end
    )
      continue;
    posts.set(
      unit.unitId,
      new Set(
        (objective.visibleApproachEdgeIds ?? []).filter((id) => valid.has(id)),
      ),
    );
  }
  return posts;
}

function coveredEdges(posts, selected, view, graph) {
  const selectedUnits = new Set(selected.map((candidate) => candidate.unitId));
  const covered = new Set();
  for (const [unitId, edges] of posts)
    if (!selectedUnits.has(unitId)) for (const id of edges) covered.add(id);
  const valid = new Set(graph.edges.map((edge) => edge.id));
  for (const candidate of selected) {
    const objective = view.objectives.find(
      (item) => item.id === candidate.objectiveId,
    );
    for (const id of objective?.visibleApproachEdgeIds ?? [])
      if (valid.has(id)) covered.add(id);
  }
  return covered;
}

function admissibleSelection(posts, selected, view, graph) {
  const before = coveredEdges(posts, [], view, graph);
  const after = coveredEdges(posts, selected, view, graph);
  return [...before].every((id) => after.has(id));
}
function selectPolicies(view, graph) {
  const candidates = engine
    .rankingCandidates(view, graph)
    .filter(
      (candidate) =>
        engine.assessTeamCandidate(view, candidate, graph).fitsWindow,
    )
    .sort(compareCandidate);
  const selected = [];
  const used = new Set();
  for (const candidate of candidates) {
    if (used.has(candidate.unitId)) continue;
    selected.push(candidate);
    used.add(candidate.unitId);
    if (selected.length === 2) break;
  }
  const support = supportedApproaches(view, graph);
  const posts = committedPosts(view, graph);
  const originalCoverage = coveredEdges(posts, [], view, graph);
  const supportedFor = (candidate) => {
    const objective = view.objectives.find(
      (item) => item.id === candidate.objectiveId,
    );
    return (objective?.visibleApproachEdgeIds ?? []).filter((id) =>
      support.has(id),
    );
  };
  const team = [];
  const first = candidates.find(
    (candidate) =>
      admissibleSelection(posts, [candidate], view, graph) &&
      supportedFor(candidate).some((id) => !originalCoverage.has(id)),
  );
  if (first) {
    team.push(first);
    const firstCoverage = coveredEdges(posts, team, view, graph);
    const second = candidates.find(
      (candidate) =>
        candidate.unitId !== first.unitId &&
        admissibleSelection(posts, [first, candidate], view, graph) &&
        supportedFor(candidate).some((id) => !firstCoverage.has(id)),
    );
    if (second) team.push(second);
  }
  return {
    candidates,
    noOrder: [],
    singleBaseline: candidates.slice(0, 1),
    equalBudgetBaseline: selected,
    teamPolicyV2: team,
    supportedApproachIds: [...support.keys()].sort(),
    committedPostUnitIds: [...posts.keys()].sort(),
  };
}
function outcome(source, run, second, candidates) {
  const end = Math.min(180, second + engine.OBSERVATION_HORIZON_SECONDS);
  const orders = [...candidates]
    .sort((a, b) => key(a).localeCompare(key(b)))
    .map((candidate, index) => ({
      id: `study-${second}-${index}-${key(candidate)}`,
      second,
      unitId: candidate.unitId,
      objectiveId: candidate.objectiveId,
      kind: candidate.action,
    }));
  const observations = source
    .snapshot(end, { ...run, actions: [...run.actions, ...orders] })
    .observations.filter(
      (item) => item.observedSecond > second && item.availableSecond <= end,
    );
  return {
    hit: observations.length > 0,
    firstAvailableSecond: observations.length
      ? Math.min(...observations.map((item) => item.availableSecond))
      : null,
    distinctJunctions: new Set(observations.map((item) => item.junction.id))
      .size,
    orders: candidates.length,
    appliedOrders: orders.map((order) => ({
      unitId: order.unitId,
      objectiveId: order.objectiveId,
      kind: order.kind,
    })),
    observations: observations.map((item) => ({
      unitId: item.unitId,
      junctionId: item.junction.id,
      approachName: item.approachName,
      observedSecond: item.observedSecond,
      availableSecond: item.availableSecond,
    })),
  };
}
function summaries(cases) {
  const eligible = cases.filter((item) => item.eligible);
  const results = {
    views: cases.length,
    eligible: eligible.length,
    suppressed: cases.length - eligible.length,
    noOrderAlreadyHits: eligible.filter((item) => item.outcomes.noOrder.hit)
      .length,
    signalLossViews: eligible.filter((item) => item.signalLoss).length,
    arms: {},
  };
  for (const arm of arms) {
    const hits = eligible.filter((item) => item.outcomes[arm].hit).length;
    const orders = eligible.reduce(
      (sum, item) => sum + item.outcomes[arm].orders,
      0,
    );
    const gains = eligible.filter(
      (item) => item.outcomes[arm].hit && !item.outcomes.noOrder.hit,
    ).length;
    const losses = eligible.filter(
      (item) => !item.outcomes[arm].hit && item.outcomes.noOrder.hit,
    ).length;
    const lostWithRetaskedObserver = eligible.filter(
      (item) =>
        !item.outcomes[arm].hit &&
        item.outcomes.noOrder.hit &&
        item.outcomes[arm].appliedOrders.some((order) =>
          item.outcomes.noOrder.observations.some(
            (observation) => observation.unitId === order.unitId,
          ),
        ),
    ).length;
    const first = eligible
      .map((item) => item.outcomes[arm].firstAvailableSecond)
      .filter((second) => second !== null);
    results.arms[arm] = {
      hits,
      rate: eligible.length ? hits / eligible.length : null,
      allViewRate: cases.length
        ? cases.filter((item) => item.outcomes[arm].hit).length / cases.length
        : null,
      orders,
      meanOrders: eligible.length ? orders / eligible.length : null,
      orderDistribution: [0, 1, 2].map(
        (count) =>
          eligible.filter((item) => item.outcomes[arm].orders === count).length,
      ),
      helenaOrders: eligible.reduce(
        (sum, item) =>
          sum +
          item.outcomes[arm].appliedOrders.filter(
            (order) =>
              order.objectiveId === "junction-5" ||
              order.objectiveId === "junction-6",
          ).length,
        0,
      ),
      incrementalGains: gains,
      incumbentHitsLost: losses,
      lostWithRetaskedObserver,
      lostWithoutRetaskedObserver: losses - lostWithRetaskedObserver,
      netIncrementalHits: gains - losses,
      netIncrementalRate: eligible.length
        ? (gains - losses) / eligible.length
        : null,
      meanFirstAvailableSecond: first.length
        ? first.reduce((a, b) => a + b, 0) / first.length
        : null,
      distinctObservedJunctions: eligible.reduce(
        (sum, item) => sum + item.outcomes[arm].distinctJunctions,
        0,
      ),
    };
  }
  return results;
}
function bootstrap(cases, armA, armB, seedValue) {
  const eligible = cases.filter((item) => item.eligible);
  const grouped = new Map(
    [...new Set(eligible.map((item) => item.seed))].map((seed) => [
      seed,
      eligible.filter((item) => item.seed === seed),
    ]),
  );
  const groups = [...grouped.values()];
  if (!groups.length) return null;
  let state = seedValue;
  const randomIndex = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % groups.length;
  };
  const draws = [];
  for (let draw = 0; draw < 5000; draw++) {
    let difference = 0;
    let count = 0;
    for (let i = 0; i < groups.length; i++)
      for (const item of groups[randomIndex()]) {
        difference +=
          Number(item.outcomes[armA].hit) - Number(item.outcomes[armB].hit);
        count++;
      }
    draws.push(difference / count);
  }
  draws.sort((a, b) => a - b);
  const observed =
    eligible.reduce(
      (sum, item) =>
        sum + Number(item.outcomes[armA].hit) - Number(item.outcomes[armB].hit),
      0,
    ) / eligible.length;
  return {
    observedDifference: observed,
    lower95: draws[Math.floor(0.025 * draws.length)],
    upper95: draws[Math.floor(0.975 * draws.length)],
    seedClusters: groups.length,
  };
}
const cases = [];
for (const seed of seeds) {
  for (const stream of ["representative", "alternate"]) {
    const currentPattern = pattern(seed, stream);
    const graph = graphByLayout.get(currentPattern.layout);
    const source = sources.get(currentPattern.layout);
    const run = scenario(seed, currentPattern);
    for (const second of decisionSeconds) {
      const view = source.snapshot(second, run);
      const policies = selectPolicies(view, graph);
      const cache = new Map();
      const cachedOutcome = (selected) => {
        const id = selected.map(key).sort().join("|");
        if (!cache.has(id))
          cache.set(id, outcome(source, run, second, selected));
        return cache.get(id);
      };
      const outcomes = Object.fromEntries(
        arms.map((arm) => [arm, cachedOutcome(policies[arm])]),
      );
      cases.push({
        seed,
        stream,
        pattern: currentPattern,
        second,
        signalLoss: view.connectivity === "signal_lost",
        eligible: policies.candidates.length > 0,
        candidateCount: policies.candidates.length,
        supportedApproachIds: policies.supportedApproachIds,
        committedPostUnitIds: policies.committedPostUnitIds,
        selections: Object.fromEntries(
          arms.map((arm) => [arm, policies[arm].map(key)]),
        ),
        outcomes,
      });
    }
  }
  console.log(`Completed seed family ${seed}`);
}
const groups = {
  all: cases,
  representative: cases.filter((item) => item.stream === "representative"),
  alternate: cases.filter((item) => item.stream === "alternate"),
  signalLoss: cases.filter((item) => item.signalLoss),
  connected: cases.filter((item) => !item.signalLoss),
  representativeSignalLoss: cases.filter(
    (item) => item.stream === "representative" && item.signalLoss,
  ),
  alternateSignalLoss: cases.filter(
    (item) => item.stream === "alternate" && item.signalLoss,
  ),
};
const comparisons = [
  ["singleBaseline", "noOrder"],
  ["equalBudgetBaseline", "noOrder"],
  ["teamPolicyV2", "noOrder"],
  ["teamPolicyV2", "equalBudgetBaseline"],
  ["teamPolicyV2", "singleBaseline"],
];
const results = {
  study: "team-policy-v2",
  simulatorVersion: engine.COORDINATION_SIMULATOR_VERSION,
  policyThresholds: THRESHOLDS,
  seedRange: [seeds[0], seeds.at(-1)],
  decisionSeconds,
  groups: Object.fromEntries(
    Object.entries(groups).map(([name, items], groupIndex) => [
      name,
      {
        summary: summaries(items),
        pairedIntervals: Object.fromEntries(
          comparisons.map(([a, b], comparisonIndex) => [
            `${a}_minus_${b}`,
            bootstrap(
              items,
              a,
              b,
              20260928 + groupIndex * 17 + comparisonIndex,
            ),
          ]),
        ),
      },
    ]),
  ),
  disagreements: cases
    .filter(
      (item) =>
        item.eligible &&
        [...item.selections.equalBudgetBaseline].sort().join("|") !==
          [...item.selections.teamPolicyV2].sort().join("|"),
    )
    .slice(0, 24),
  cases,
};
if (existsSync("reports/team-policy-v2.results.json"))
  throw new Error(
    "team-policy-v2 results already exist; refusing to overwrite",
  );
writeFileSync(
  "reports/team-policy-v2.results.json",
  `${JSON.stringify(results, null, 2)}\n`,
);
console.log("Wrote reports/team-policy-v2.results.json");
