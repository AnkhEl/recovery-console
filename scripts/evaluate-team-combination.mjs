import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";

const compiled = await build({
  stdin: {
    contents:
      'export * from "./src/coordination.ts"; export * from "./src/ranking.ts"; export * from "./src/teamCoverage.ts"; export * from "./src/scenario.ts";',
    resolveDir: process.cwd(),
    sourcefile: "team-combination-evaluation-entry.ts",
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
const seeds = Array.from({ length: 32 }, (_, index) => 2001 + index);
const decisionSeconds = [0, 35, 65, 95];
const arms = [
  "noOrder",
  "singleBaseline",
  "equalBudgetBaseline",
  "teamCombination",
];

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
    id: `team-seed-${seed}`,
    name: "Offline team diagnostic",
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
function incumbentEdges(view, graph) {
  const validEdges = new Set(graph.edges.map((edge) => edge.id));
  const covered = new Map();
  const display = Date.parse(view.displayTimestamp);
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
      (display - device) / 1000 > 10 ||
      engine.distance(report.coordinates, objective.coordinates) > 20
    )
      continue;
    covered.set(
      unit.unitId,
      new Set(
        (objective.visibleApproachEdgeIds ?? []).filter((edge) =>
          validEdges.has(edge),
        ),
      ),
    );
  }
  return covered;
}
function coverageChange(view, graph, selected) {
  const existing = incumbentEdges(view, graph);
  const before = new Set([...existing.values()].flatMap((edges) => [...edges]));
  for (const candidate of selected) existing.delete(candidate.unitId);
  const after = new Set([...existing.values()].flatMap((edges) => [...edges]));
  const valid = new Set(graph.edges.map((edge) => edge.id));
  for (const candidate of selected) {
    const objective = view.objectives.find(
      (item) => item.id === candidate.objectiveId,
    );
    for (const edge of objective?.visibleApproachEdgeIds ?? [])
      if (valid.has(edge)) after.add(edge);
  }
  return after.size - before.size;
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
  const budget = selected.length;
  let team = selected;
  if (budget === 2) {
    let best = null;
    for (let i = 0; i < candidates.length; i++)
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i];
        const b = candidates[j];
        if (a.unitId === b.unitId) continue;
        const pair = [a, b].sort((x, y) => key(x).localeCompare(key(y)));
        const item = {
          pair,
          netCoverage: coverageChange(view, graph, pair),
          baselineSum: a.baselineScore + b.baselineScore,
          stableKey: pair.map(key).join("|"),
        };
        if (
          !best ||
          item.netCoverage > best.netCoverage ||
          (item.netCoverage === best.netCoverage &&
            item.baselineSum > best.baselineSum) ||
          (item.netCoverage === best.netCoverage &&
            item.baselineSum === best.baselineSum &&
            item.stableKey < best.stableKey)
        )
          best = item;
      }
    team = best.pair;
  }
  return {
    candidates,
    noOrder: [],
    singleBaseline: candidates.slice(0, 1),
    equalBudgetBaseline: selected,
    teamCombination: team,
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
  };
}
function oracleFeasibility(source, run, second, candidates, noOrderHit, cache) {
  if (noOrderHit) return { anyLegalSuccess: true, incrementalPossible: false };
  for (const candidate of candidates)
    if (cache([candidate]).hit)
      return { anyLegalSuccess: true, incrementalPossible: true };
  for (let i = 0; i < candidates.length; i++)
    for (let j = i + 1; j < candidates.length; j++) {
      if (candidates[i].unitId === candidates[j].unitId) continue;
      if (cache([candidates[i], candidates[j]]).hit)
        return { anyLegalSuccess: true, incrementalPossible: true };
    }
  return { anyLegalSuccess: false, incrementalPossible: false };
}
function summaries(cases) {
  const eligible = cases.filter((item) => item.eligible);
  const results = {
    views: cases.length,
    eligible: eligible.length,
    suppressed: cases.length - eligible.length,
    noLegalSuccess: eligible.filter((item) => !item.oracle.anyLegalSuccess)
      .length,
    incrementalOpportunity: eligible.filter(
      (item) => item.oracle.incrementalPossible,
    ).length,
    noOrderAlreadyHits: eligible.filter((item) => item.outcomes.noOrder.hit)
      .length,
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
      incrementalGains: gains,
      incumbentHitsLost: losses,
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
      const oracle = oracleFeasibility(
        source,
        run,
        second,
        policies.candidates,
        outcomes.noOrder.hit,
        cachedOutcome,
      );
      cases.push({
        seed,
        stream,
        pattern: currentPattern,
        second,
        signalLoss: view.connectivity === "signal_lost",
        eligible: policies.candidates.length > 0,
        candidateCount: policies.candidates.length,
        selections: Object.fromEntries(
          arms.map((arm) => [arm, policies[arm].map(key)]),
        ),
        outcomes,
        oracle,
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
  ["teamCombination", "noOrder"],
  ["teamCombination", "equalBudgetBaseline"],
  ["teamCombination", "singleBaseline"],
];
const results = {
  study: "team-combination-v1",
  simulatorVersion: engine.COORDINATION_SIMULATOR_VERSION,
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
              20260927 + groupIndex * 17 + comparisonIndex,
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
          [...item.selections.teamCombination].sort().join("|"),
    )
    .slice(0, 24),
  cases,
};
writeFileSync(
  "reports/team-combination-v1.results.json",
  `${JSON.stringify(results, null, 2)}\n`,
);
console.log("Wrote reports/team-combination-v1.results.json");
