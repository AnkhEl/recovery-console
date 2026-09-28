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
  throw new Error("Historical v3 diagnosis requires simulator v1");
const graphFile = JSON.parse(
  readFileSync("public/coordination-graph.json", "utf8"),
);
const model = JSON.parse(
  readFileSync("src/generated/ranking-model.v3.json", "utf8"),
);
const evaluation = JSON.parse(
  readFileSync("reports/ranking-evaluation.v3.json", "utf8"),
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
  const readyFrames = frames.filter(
    (frame) => ready(frame) && frame.second + 2 <= end,
  );
  const vehicleApproachFrames = frames.filter((frame) => frame.visibleApproach);
  const approachFrames = readyFrames.filter((frame) => frame.visibleApproach);
  const rangeFrames = approachFrames.filter((frame) => frame.inRange);
  const clearFrames = rangeFrames.filter((frame) => frame.clearVisibility);
  const delayFrames = frames.filter(
    (frame) =>
      ready(frame) &&
      frame.visibleApproach &&
      frame.inRange &&
      frame.clearVisibility &&
      frame.second + 2 > end,
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
              : delayFrames.length
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
      delayed: delayFrames.length,
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
const summary = {
  experiment: "v3 held-out diagnostic; simulator source instrumented in memory",
  decisions: {
    total: 0,
    eligible: 0,
    signalLossEligible: 0,
    actionable: 0,
    signalLossActionable: 0,
  },
  byDecisionSecond: Object.fromEntries(
    evaluation.decisionSeconds.map((second) => [
      second,
      {
        total: 0,
        eligible: 0,
        actionable: 0,
        signalLossEligible: 0,
        signalLossActionable: 0,
        baselineHits: 0,
        modelHits: 0,
      },
    ]),
  ),
  candidateOutcomes: {
    total: 0,
    successful: 0,
    vehicleApproachSeen: 0,
    readyWithApproach: 0,
    blockers: {},
    byJunction: {},
  },
  selected: Object.fromEntries(
    policies.map((policy) => [
      policy,
      {
        all: {
          etaWithin90: 0,
          actualArrivedByEnd: 0,
          success: 0,
          blockers: {},
        },
        signalLoss: {
          etaWithin90: 0,
          actualArrivedByEnd: 0,
          success: 0,
          blockers: {},
        },
      },
    ]),
  ),
  disagreements: [],
};
for (const seed of evaluation.splits.test)
  for (const variantIndex of [0, 1]) {
    const pattern = family(seed, variantIndex);
    const source = sources[pattern.layout];
    const graph = graphs[pattern.layout];
    const run = scenario(seed, pattern);
    for (const second of evaluation.decisionSeconds) {
      summary.decisions.total++;
      const timeCounts = summary.byDecisionSecond[second];
      timeCounts.total++;
      const view = source.snapshot(second, run);
      const candidates = engine.rankingCandidates(view, graph);
      if (!candidates.length) continue;
      summary.decisions.eligible++;
      timeCounts.eligible++;
      const signalLoss = view.connectivity === "signal_lost";
      if (signalLoss) {
        summary.decisions.signalLossEligible++;
        timeCounts.signalLossEligible++;
      }
      const baseline = rank(candidates, (item) => item.baselineScore)[0];
      const modelChoice = rank(candidates, (item) =>
        engine.modelScore(model, item),
      )[0];
      const selected = new Map();
      for (const [policy, candidate] of [
        ["baseline", baseline],
        ["model", modelChoice],
      ]) {
        const key = `${candidate.unitId}:${candidate.objectiveId}`;
        if (!selected.has(key))
          selected.set(key, outcome(source, run, second, candidate, true));
        const result = selected.get(key);
        for (const group of ["all", ...(signalLoss ? ["signalLoss"] : [])]) {
          const counts = summary.selected[policy][group];
          if (candidate.trafficRouteSeconds <= 90) counts.etaWithin90++;
          if (result.actualArrivalSecond !== null) counts.actualArrivedByEnd++;
          if (result.success) counts.success++;
          else
            counts.blockers[result.blocker] =
              (counts.blockers[result.blocker] ?? 0) + 1;
        }
        if (result.success) timeCounts[`${policy}Hits`]++;
      }
      let anySuccess = false;
      for (const candidate of candidates) {
        const key = `${candidate.unitId}:${candidate.objectiveId}`;
        const result =
          selected.get(key) ?? outcome(source, run, second, candidate, true);
        const junction = (summary.candidateOutcomes.byJunction[
          candidate.objectiveId
        ] ??= {
          name: candidate.objectiveName,
          candidates: 0,
          successes: 0,
          vehicleApproachSeen: 0,
          readyWithApproach: 0,
        });
        summary.candidateOutcomes.total++;
        junction.candidates++;
        if (result.frames.vehicleApproach) {
          summary.candidateOutcomes.vehicleApproachSeen++;
          junction.vehicleApproachSeen++;
        }
        if (result.frames.approach) {
          summary.candidateOutcomes.readyWithApproach++;
          junction.readyWithApproach++;
        }
        if (result.success) {
          summary.candidateOutcomes.successful++;
          junction.successes++;
          anySuccess = true;
        } else
          summary.candidateOutcomes.blockers[result.blocker] =
            (summary.candidateOutcomes.blockers[result.blocker] ?? 0) + 1;
      }
      if (anySuccess) {
        summary.decisions.actionable++;
        timeCounts.actionable++;
        if (signalLoss) {
          summary.decisions.signalLossActionable++;
          timeCounts.signalLossActionable++;
        }
      }
      if (
        baseline.unitId !== modelChoice.unitId ||
        baseline.objectiveId !== modelChoice.objectiveId
      )
        summary.disagreements.push({
          seed,
          pattern,
          orderSecond: second,
          signalLoss,
          lastConfirmedReport: view.lastConfirmedReport.id,
          lastConfirmedAgeSeconds: view.reportAgeSeconds,
          anyCandidateSuccess: anySuccess,
          baseline: {
            unitId: baseline.unitId,
            junction: baseline.objectiveName,
            ...selected.get(`${baseline.unitId}:${baseline.objectiveId}`),
          },
          model: {
            unitId: modelChoice.unitId,
            junction: modelChoice.objectiveName,
            probability: engine.modelProbability(model, modelChoice),
            ...selected.get(`${modelChoice.unitId}:${modelChoice.objectiveId}`),
          },
        });
    }
  }
if (
  summary.decisions.total !== evaluation.heldOut.trained.all.scenarios ||
  summary.decisions.eligible !== evaluation.heldOut.trained.all.eligible ||
  summary.decisions.actionable !== evaluation.heldOut.trained.all.actionable ||
  summary.selected.baseline.all.success !==
    evaluation.heldOut.baseline.all.top1Hits ||
  summary.selected.model.all.success !== evaluation.heldOut.trained.all.top1Hits
)
  throw new Error("Diagnostic did not reproduce the v3 held-out evaluation");
for (const policy of policies)
  for (const group of ["all", "signalLoss"])
    for (const stage of stages)
      summary.selected[policy][group].blockers[stage] ??= 0;
writeFileSync(
  "reports/ranking-diagnosis.v3.json",
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    decisions: summary.decisions,
    baseline: summary.selected.baseline,
    model: summary.selected.model,
    disagreements: summary.disagreements.length,
  }),
);
