import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";

// Instrument an in-memory copy of the unchanged simulator. No diagnostic state
// or hidden vehicle position is passed into the browser ranker.
const original = readFileSync("src/coordination.ts", "utf8");
const anchor = "          const objective = unit.objective;\n          if (";
if (original.split(anchor).length !== 2)
  throw new Error("Observation-loop instrumentation anchor changed");
const instrumented = original.replace(
  anchor,
  `          const objective = unit.objective;
          if (objective && (globalThis as any).__recoveryTrace) {
            (globalThis as any).__recoveryTrace({
              second: t,
              unitId: unit.id,
              objectiveId: objective.id,
              arrivedAt: unit.arrivedAt,
              atObjective: unit.nodeId === objective.nodeId,
              unitMoving: Boolean(unit.edge),
              visibleApproach:
                vehicle.edge.to === objective.nodeId &&
                Boolean(objective.visibleApproachEdgeIds?.includes(vehicle.edge.id)),
              inRange:
                distance(position(vehicle, this.graph), objective.coordinates) <= 75,
              clearVisibility:
                hash("visibility:" + objective.id + ":" + Math.floor(t / 15), seed) % 5 !== 0,
            });
          }
          if (`,
);
const compiled = await build({
  stdin: {
    contents:
      'export * from "./src/ranking.ts"; export * from "./src/coordination.ts";',
    resolveDir: process.cwd(),
    sourcefile: "diagnose-entry.ts",
  },
  plugins: [
    {
      name: "in-memory-observation-trace",
      setup(esbuild) {
        esbuild.onLoad({ filter: /coordination\.ts$/ }, () => ({
          contents: instrumented,
          loader: "ts",
        }));
      },
    },
  ],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const engine = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
if (engine.COORDINATION_SIMULATOR_VERSION !== "coordination-simulator-v1")
  throw new Error("Historical opportunity audit requires simulator v1");
const graphFile = JSON.parse(
  readFileSync("public/coordination-graph.json", "utf8"),
);
const model = JSON.parse(
  readFileSync("src/generated/ranking-model.v3.json", "utf8"),
);
// Frozen in reports/opportunity-audit.registration.md before this audit ran.
const auditSeeds = Array.from({ length: 32 }, (_, index) => index + 401);
const decisionSeconds = [0, 35, 65, 95];
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
  const connectors = options.slice(0, 2 + layout * 2);
  const edges = [...graphFile.edges];
  for (const connector of connectors) {
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
const graphs = [0, 1, 2, 3].map(graphVariant);
const sources = graphs.map(
  (graph) => new engine.CoordinatedIncidentSource(graph),
);
function family(seed, variantIndex) {
  return {
    layout: 2 + variantIndex,
    congestion: 2 + ((seed + variantIndex) % 2),
    outage: 2 + ((Math.floor(seed / 2) + variantIndex) % 2),
  };
}
function scenario(seed, pattern) {
  const prior =
    seed % 3 === 0
      ? { unitId: "unit-3", objectiveId: "junction-3" }
      : seed % 3 === 1
        ? { unitId: "unit-2", objectiveId: "junction-7" }
        : null;
  return {
    id: `synthetic-seed-${seed}`,
    name: "Synthetic ranking experiment",
    seed,
    trafficSeed: seed + pattern.congestion * 100003,
    trafficPattern: pattern.congestion,
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
      pattern.outage === 2
        ? [{ start: 30, end: 75 }]
        : [{ start: 80, end: 125 }],
  };
}
const rank = (candidates, score) =>
  [...candidates].sort(
    (a, b) =>
      score(b) - score(a) ||
      a.unitId.localeCompare(b.unitId) ||
      a.objectiveId.localeCompare(b.objectiveId),
  );
function outcome(source, run, second, candidate, trace = false) {
  const end = Math.min(180, second + 90);
  const counterfactual = {
    ...run,
    actions: [
      ...run.actions,
      {
        id: `candidate-${candidate.unitId}-${candidate.objectiveId}-${second}`,
        second,
        unitId: candidate.unitId,
        objectiveId: candidate.objectiveId,
        kind: candidate.action,
      },
    ],
  };
  const frames = [];
  globalThis.__recoveryTrace = trace
    ? (frame) => {
        if (
          frame.second >= second &&
          frame.second <= end &&
          frame.unitId === candidate.unitId &&
          frame.objectiveId === candidate.objectiveId
        )
          frames.push(frame);
      }
    : null;
  const result = source.snapshot(end, counterfactual);
  globalThis.__recoveryTrace = null;
  const observation = result.observations
    .filter(
      (item) =>
        item.unitId === candidate.unitId &&
        item.junction.id === candidate.objectiveId &&
        item.availableSecond > second &&
        item.availableSecond <= end,
    )
    .sort((a, b) => a.availableSecond - b.availableSecond)[0];
  if (!trace) return { success: Boolean(observation) };
  const arrival = result.coordinationEvents
    .filter(
      (event) =>
        event.id.startsWith(`arrival-${candidate.unitId}-`) &&
        event.scenarioSecond >= second &&
        event.scenarioSecond <= end &&
        event.text.includes(candidate.objectiveName),
    )
    .sort((a, b) => a.scenarioSecond - b.scenarioSecond)[0];
  const ready = (frame) =>
    frame.atObjective &&
    !frame.unitMoving &&
    frame.arrivedAt !== null &&
    frame.second - frame.arrivedAt >= 3;
  const readyFrames = frames.filter(ready);
  const vehicleApproachFrames = frames.filter((frame) => frame.visibleApproach);
  const approachFrames = readyFrames.filter((frame) => frame.visibleApproach);
  const rangeFrames = approachFrames.filter((frame) => frame.inRange);
  const clearFrames = rangeFrames.filter((frame) => frame.clearVisibility);
  const availableFrames = clearFrames.filter(
    (frame) => frame.second + 2 <= end,
  );
  const blocker = observation
    ? "success"
    : !arrival
      ? "route_arrival"
      : !readyFrames.length
        ? "three_second_dwell"
        : !approachFrames.length
          ? "visible_approach"
          : !rangeFrames.length
            ? "75m_range"
            : !clearFrames.length
              ? "visibility_state"
              : !availableFrames.length
                ? "two_second_availability"
                : "unclassified";
  return {
    success: Boolean(observation),
    observedSecond: observation?.observedSecond ?? null,
    availableSecond: observation?.availableSecond ?? null,
    actualArrivalSecond: arrival?.scenarioSecond ?? null,
    estimatedRouteSeconds: candidate.trafficRouteSeconds,
    blocker,
    frames: {
      vehicleApproach: vehicleApproachFrames.length,
      ready: readyFrames.length,
      approach: approachFrames.length,
      range: rangeFrames.length,
      clear: clearFrames.length,
      available: availableFrames.length,
    },
  };
}
const policies = ["baseline", "model"];
const stages = [
  "route_arrival",
  "three_second_dwell",
  "visible_approach",
  "75m_range",
  "visibility_state",
  "two_second_availability",
  "unclassified",
];
function stratum() {
  return {
    decisions: {
      total: 0,
      eligible: 0,
      impossible: 0,
      feasible: 0,
      baselineSuccess: 0,
      baselineMiss: 0,
      modelSuccess: 0,
      modelMiss: 0,
    },
    candidates: {
      total: 0,
      vehicleApproachSeen: 0,
      funnel: {
        arrived: 0,
        dwelled: 0,
        visibleApproach: 0,
        within75m: 0,
        clearVisibility: 0,
        observationAvailable: 0,
      },
      primaryBlockers: Object.fromEntries(stages.map((stage) => [stage, 0])),
    },
    selected: Object.fromEntries(
      policies.map((policy) => [
        policy,
        {
          total: 0,
          success: 0,
          primaryBlockers: Object.fromEntries(
            stages.map((stage) => [stage, 0]),
          ),
        },
      ]),
    ),
  };
}
function addCandidate(group, result) {
  const counts = group.candidates;
  counts.total++;
  if (result.frames.vehicleApproach) counts.vehicleApproachSeen++;
  if (result.actualArrivalSecond !== null) counts.funnel.arrived++;
  if (result.frames.ready) counts.funnel.dwelled++;
  if (result.frames.approach) counts.funnel.visibleApproach++;
  if (result.frames.range) counts.funnel.within75m++;
  if (result.frames.clear) counts.funnel.clearVisibility++;
  if (result.success) counts.funnel.observationAvailable++;
  else counts.primaryBlockers[result.blocker]++;
}
function addSelection(group, policy, result) {
  const counts = group.selected[policy];
  counts.total++;
  if (result.success) counts.success++;
  else counts.primaryBlockers[result.blocker]++;
}
const summary = {
  study: "preregistered opportunity audit, not a model evaluation",
  registration: "reports/opportunity-audit.registration.md",
  seeds: auditSeeds,
  decisionSeconds,
  all: stratum(),
  byDecisionSecond: Object.fromEntries(
    decisionSeconds.map((second) => [second, stratum()]),
  ),
  byOutageState: { signal_lost: stratum(), connected: stratum() },
  byTimeAndOutage: Object.fromEntries(
    decisionSeconds.map((second) => [
      second,
      { signal_lost: stratum(), connected: stratum() },
    ]),
  ),
  byJunction: Object.fromEntries(
    graphFile.junctions.map((junction) => [
      junction.id,
      {
        name: junction.name,
        decisionsWithCandidate: 0,
        feasibleDecisionJunctionPairs: 0,
        ...stratum(),
      },
    ]),
  ),
  disagreements: [],
};
for (const seed of auditSeeds)
  for (const variantIndex of [0, 1]) {
    const pattern = family(seed, variantIndex);
    const source = sources[pattern.layout];
    const graph = graphs[pattern.layout];
    const run = scenario(seed, pattern);
    for (const second of decisionSeconds) {
      const view = source.snapshot(second, run);
      const outage =
        view.connectivity === "signal_lost" ? "signal_lost" : "connected";
      const groups = [
        summary.all,
        summary.byDecisionSecond[second],
        summary.byOutageState[outage],
        summary.byTimeAndOutage[second][outage],
      ];
      for (const group of groups) group.decisions.total++;
      const candidates = engine.rankingCandidates(view, graph);
      if (!candidates.length) continue;
      for (const group of groups) group.decisions.eligible++;
      const baseline = rank(candidates, (item) => item.baselineScore)[0];
      const modelChoice = rank(candidates, (item) =>
        engine.modelScore(model, item),
      )[0];
      const outcomes = new Map();
      const successfulJunctions = new Set();
      const candidateJunctions = new Set();
      for (const candidate of candidates) {
        const result = outcome(source, run, second, candidate, true);
        outcomes.set(`${candidate.unitId}:${candidate.objectiveId}`, result);
        candidateJunctions.add(candidate.objectiveId);
        if (result.success) successfulJunctions.add(candidate.objectiveId);
        for (const group of [
          ...groups,
          summary.byJunction[candidate.objectiveId],
        ])
          addCandidate(group, result);
      }
      for (const junctionId of candidateJunctions) {
        const junction = summary.byJunction[junctionId];
        junction.decisionsWithCandidate++;
        if (successfulJunctions.has(junctionId))
          junction.feasibleDecisionJunctionPairs++;
      }
      const feasible = successfulJunctions.size > 0;
      for (const group of groups)
        group.decisions[feasible ? "feasible" : "impossible"]++;
      for (const [policy, candidate] of [
        ["baseline", baseline],
        ["model", modelChoice],
      ]) {
        const result = outcomes.get(
          `${candidate.unitId}:${candidate.objectiveId}`,
        );
        for (const group of [
          ...groups,
          summary.byJunction[candidate.objectiveId],
        ])
          addSelection(group, policy, result);
        if (feasible)
          for (const group of groups)
            group.decisions[
              `${policy}${result.success ? "Success" : "Miss"}`
            ]++;
      }
      if (
        baseline.unitId !== modelChoice.unitId ||
        baseline.objectiveId !== modelChoice.objectiveId
      )
        summary.disagreements.push({
          seed,
          pattern,
          orderSecond: second,
          outage,
          feasible,
          baseline: {
            unitId: baseline.unitId,
            junction: baseline.objectiveName,
            ...outcomes.get(`${baseline.unitId}:${baseline.objectiveId}`),
          },
          model: {
            unitId: modelChoice.unitId,
            junction: modelChoice.objectiveName,
            ...outcomes.get(`${modelChoice.unitId}:${modelChoice.objectiveId}`),
          },
        });
    }
  }
if (summary.all.decisions.total !== 256)
  throw new Error("Registered audit did not produce 256 decision views");
for (const group of [
  summary.all,
  ...Object.values(summary.byDecisionSecond),
  ...Object.values(summary.byOutageState),
  ...Object.values(summary.byJunction),
]) {
  const funnel = group.candidates.funnel;
  if (
    funnel.observationAvailable > funnel.clearVisibility ||
    funnel.clearVisibility > funnel.within75m ||
    funnel.within75m > funnel.visibleApproach ||
    funnel.visibleApproach > funnel.dwelled ||
    funnel.dwelled > funnel.arrived
  )
    throw new Error("Candidate funnel is not monotone");
}
writeFileSync(
  "reports/opportunity-audit.results.json",
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    all: summary.all,
    byDecisionSecond: summary.byDecisionSecond,
    byOutageState: summary.byOutageState,
    byJunction: summary.byJunction,
  }),
);
