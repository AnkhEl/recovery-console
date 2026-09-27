import { build } from "esbuild";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import prettier from "prettier";

const compiled = await build({
  stdin: {
    contents:
      'export * from "./src/ranking.ts"; export * from "./src/coordination.ts";',
    resolveDir: process.cwd(),
    sourcefile: "ranking-entry.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const engine = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
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
const graphs = Array.from({ length: 4 }, (_, layout) => graphVariant(layout));
const sources = graphs.map(
  (graph) => new engine.CoordinatedIncidentSource(graph),
);
const graph = graphs[0];
const source = sources[0];
if (process.argv.includes("--graph-audit")) {
  for (const [layout, item] of graphs.entries()) {
    const start = item.nearestNode([28.049203, -26.105078]);
    const reachable = new Set([start]);
    const queue = [start];
    while (queue.length) {
      for (const edge of item.outgoing.get(queue.pop()) ?? []) {
        if (reachable.has(edge.to)) continue;
        reachable.add(edge.to);
        queue.push(edge.to);
      }
    }
    console.log({
      layout,
      edges: item.edges.length,
      reachableFromVehicleStart: reachable.size,
      junctionsReachable: item.objectives.filter((objective) =>
        reachable.has(objective.nodeId),
      ).length,
    });
  }
  process.exit(0);
}
const decisionSeconds = [0, 35, 65, 95];
const splits = {
  train: Array.from({ length: 32 }, (_, index) => index + 1),
  validation: Array.from({ length: 8 }, (_, index) => index + 33),
  // Seeds 61-272 were inspected during earlier exploratory gate runs.
  test: Array.from({ length: 32 }, (_, index) => index + 273),
};

function family(seed, split, variantIndex) {
  const offset = split === "test" ? 2 : 0;
  return {
    layout: offset + variantIndex,
    congestion: offset + ((seed + variantIndex) % 2),
    outage: offset + ((Math.floor(seed / 2) + variantIndex) % 2),
  };
}

function scenario(seed, pattern = { layout: 0, congestion: 0, outage: 0 }) {
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
      pattern.outage === 0
        ? []
        : pattern.outage === 1
          ? [{ start: 45, end: 105 }]
          : pattern.outage === 2
            ? [{ start: 30, end: 75 }]
            : [{ start: 80, end: 125 }],
  };
}

function labelFor(source, run, second, candidate) {
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
  const end = Math.min(180, second + engine.OBSERVATION_HORIZON_SECONDS);
  const firstAvailable = source
    .snapshot(end, counterfactual)
    .observations.filter(
      (observation) =>
        observation.unitId === candidate.unitId &&
        observation.junction.id === candidate.objectiveId &&
        observation.availableSecond > second &&
        observation.availableSecond <= end,
    )
    .sort((a, b) => a.availableSecond - b.availableSecond)[0];
  return firstAvailable
    ? (end - firstAvailable.availableSecond + 1) /
        engine.OBSERVATION_HORIZON_SECONDS
    : 0;
}

function dataset(seeds, split) {
  const cases = [];
  for (const seed of seeds) {
    for (const variantIndex of [0, 1]) {
      const pattern = family(seed, split, variantIndex);
      const run = scenario(seed, pattern);
      const source = sources[pattern.layout];
      const graph = graphs[pattern.layout];
      for (const second of decisionSeconds) {
        const view = source.snapshot(second, run);
        const candidates = engine
          .rankingCandidates(view, graph)
          .map((candidate) => ({
            ...candidate,
            utility: labelFor(source, run, second, candidate),
          }));
        cases.push({
          seed,
          pattern,
          second,
          signalLoss: view.connectivity === "signal_lost",
          candidates,
        });
      }
    }
  }
  return cases;
}

function pairs(cases) {
  const comparisons = [];
  for (const item of cases)
    for (let i = 0; i < item.candidates.length; i++)
      for (let j = i + 1; j < item.candidates.length; j++) {
        const a = item.candidates[i],
          b = item.candidates[j];
        if (a.utility === b.utility) continue;
        const preferred = a.utility > b.utility ? a : b;
        const other = preferred === a ? b : a;
        comparisons.push({
          difference: preferred.features.map(
            (value, index) => value - other.features[index],
          ),
          weight: Math.abs(a.utility - b.utility),
        });
      }
  return comparisons;
}

function train(comparisons, learningRate, l2, epochs) {
  const weights = Array(engine.FEATURE_NAMES.length).fill(0);
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradient = Array(weights.length).fill(0);
    let totalWeight = 0;
    for (const comparison of comparisons) {
      const margin = weights.reduce(
        (sum, weight, index) => sum + weight * comparison.difference[index],
        0,
      );
      const slope = comparison.weight / (1 + Math.exp(Math.min(30, margin)));
      for (let i = 0; i < gradient.length; i++)
        gradient[i] += slope * comparison.difference[i];
      totalWeight += comparison.weight;
    }
    for (let i = 0; i < weights.length; i++)
      weights[i] +=
        learningRate * (gradient[i] / totalWeight - l2 * weights[i]);
  }
  return weights;
}

function rank(candidates, score) {
  return [...candidates].sort(
    (a, b) =>
      score(b) - score(a) ||
      a.unitId.localeCompare(b.unitId) ||
      a.objectiveId.localeCompare(b.objectiveId),
  );
}

function metrics(cases, score) {
  const eligible = cases.filter((item) => item.candidates.length > 0);
  const actionable = eligible.filter((item) =>
    item.candidates.some((candidate) => candidate.utility > 0),
  );
  const bestTotal = actionable.reduce(
    (sum, item) =>
      sum + Math.max(...item.candidates.map((candidate) => candidate.utility)),
    0,
  );
  const selectedTotal = actionable.reduce(
    (sum, item) => sum + rank(item.candidates, score)[0].utility,
    0,
  );
  const top1Hits = eligible.filter(
    (item) => rank(item.candidates, score)[0].utility > 0,
  ).length;
  const top3Hits = eligible.filter((item) =>
    rank(item.candidates, score)
      .slice(0, 3)
      .some((candidate) => candidate.utility > 0),
  ).length;
  return {
    scenarios: cases.length,
    eligible: eligible.length,
    suppressedForStaleOrInvalidData: cases.length - eligible.length,
    actionable: actionable.length,
    top1Hits,
    top1ObservationRate: eligible.length ? top1Hits / eligible.length : 0,
    top1HitRateOnActionable: actionable.length
      ? top1Hits / actionable.length
      : 0,
    top3ObservationRate: eligible.length ? top3Hits / eligible.length : 0,
    normalizedRegret: bestTotal ? (bestTotal - selectedTotal) / bestTotal : 0,
  };
}

function evaluate(cases, score) {
  return {
    all: metrics(cases, score),
    signalLoss: metrics(
      cases.filter((item) => item.signalLoss),
      score,
    ),
    connected: metrics(
      cases.filter((item) => !item.signalLoss),
      score,
    ),
  };
}

function familyActionability(cases) {
  const groups = new Map();
  for (const item of cases) {
    const key = JSON.stringify(item.pattern);
    const group = groups.get(key) ?? {
      pattern: item.pattern,
      scenarios: 0,
      eligible: 0,
      actionable: 0,
    };
    group.scenarios++;
    if (item.candidates.length) {
      group.eligible++;
      if (item.candidates.some((candidate) => candidate.utility > 0))
        group.actionable++;
    }
    groups.set(key, group);
  }
  return [...groups.values()];
}

function fitCalibration(cases, score) {
  const examples = cases.flatMap((item) =>
    item.candidates.map((candidate) => ({
      score: score(candidate),
      observed: candidate.utility > 0 ? 1 : 0,
    })),
  );
  const scoreMean =
    examples.reduce((sum, example) => sum + example.score, 0) / examples.length;
  const scoreStd = Math.max(
    1e-6,
    Math.sqrt(
      examples.reduce(
        (sum, example) => sum + (example.score - scoreMean) ** 2,
        0,
      ) / examples.length,
    ),
  );
  const positiveRate =
    examples.reduce((sum, example) => sum + example.observed, 0) /
    examples.length;
  let slope = 0;
  let intercept = Math.log(
    Math.max(1e-6, positiveRate) / Math.max(1e-6, 1 - positiveRate),
  );
  for (let epoch = 0; epoch < 1000; epoch++) {
    let slopeGradient = 0;
    let interceptGradient = 0;
    for (const example of examples) {
      const standardized = (example.score - scoreMean) / scoreStd;
      const logit = Math.max(
        -30,
        Math.min(30, slope * standardized + intercept),
      );
      const error = 1 / (1 + Math.exp(-logit)) - example.observed;
      slopeGradient += error * standardized;
      interceptGradient += error;
    }
    slope -= 0.3 * (slopeGradient / examples.length + 0.01 * slope);
    intercept -= 0.3 * (interceptGradient / examples.length);
  }
  return {
    method: "platt_logistic_v1",
    scoreMean,
    scoreStd,
    slope,
    intercept,
  };
}

function calibrationMetrics(cases, score, probability) {
  const selected = cases
    .filter((item) => item.candidates.length > 0)
    .map((item) => rank(item.candidates, score)[0])
    .map((candidate) => ({
      probability: probability(candidate),
      observed: candidate.utility > 0 ? 1 : 0,
    }));
  const bins = Array.from({ length: 10 }, () => ({
    count: 0,
    probabilities: 0,
    observations: 0,
  }));
  for (const item of selected) {
    const bin = bins[Math.min(9, Math.floor(item.probability * 10))];
    bin.count++;
    bin.probabilities += item.probability;
    bin.observations += item.observed;
  }
  const expectedCalibrationError = bins.reduce(
    (sum, bin) =>
      sum + Math.abs(bin.probabilities - bin.observations) / selected.length,
    0,
  );
  const brierScore =
    selected.reduce(
      (sum, item) => sum + (item.probability - item.observed) ** 2,
      0,
    ) / selected.length;
  return {
    method: "top-choice ten equal-width probability bins",
    count: selected.length,
    expectedCalibrationError,
    brierScore,
    bins: bins.map((bin) => ({
      count: bin.count,
      meanPredicted: bin.count ? bin.probabilities / bin.count : null,
      observedRate: bin.count ? bin.observations / bin.count : null,
    })),
  };
}

function pairedSeedBootstrap(cases, baselineScore, trainedScore) {
  const seeds = [...new Set(cases.map((item) => item.seed))];
  const bySeed = new Map(
    seeds.map((seed) => {
      const eligible = cases.filter(
        (item) => item.seed === seed && item.candidates.length > 0,
      );
      const baselineHits = eligible.filter(
        (item) => rank(item.candidates, baselineScore)[0].utility > 0,
      ).length;
      const trainedHits = eligible.filter(
        (item) => rank(item.candidates, trainedScore)[0].utility > 0,
      ).length;
      return [
        seed,
        {
          difference: trainedHits - baselineHits,
          baselineHits,
          trainedHits,
          count: eligible.length,
        },
      ];
    }),
  );
  let randomState = 20260927;
  const randomIndex = (length) => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return (randomState >>> 0) % length;
  };
  const draws = [];
  const baselineDraws = [];
  const trainedDraws = [];
  for (let iteration = 0; iteration < 10000; iteration++) {
    let difference = 0;
    let baselineHits = 0;
    let trainedHits = 0;
    let count = 0;
    for (let i = 0; i < seeds.length; i++) {
      const sample = bySeed.get(seeds[randomIndex(seeds.length)]);
      difference += sample.difference;
      baselineHits += sample.baselineHits;
      trainedHits += sample.trainedHits;
      count += sample.count;
    }
    if (count) {
      draws.push(difference / count);
      baselineDraws.push(baselineHits / count);
      trainedDraws.push(trainedHits / count);
    }
  }
  draws.sort((a, b) => a - b);
  baselineDraws.sort((a, b) => a - b);
  trainedDraws.sort((a, b) => a - b);
  const actual = [...bySeed.values()].reduce(
    (totals, item) => ({
      difference: totals.difference + item.difference,
      baselineHits: totals.baselineHits + item.baselineHits,
      trainedHits: totals.trainedHits + item.trainedHits,
      count: totals.count + item.count,
    }),
    { difference: 0, baselineHits: 0, trainedHits: 0, count: 0 },
  );
  return {
    method: "paired 95% percentile bootstrap, resampling whole seeds",
    iterations: draws.length,
    seedClusters: seeds.length,
    improvement: actual.count ? actual.difference / actual.count : 0,
    lower: draws[Math.floor(draws.length * 0.025)],
    upper: draws[Math.floor(draws.length * 0.975)],
    baselineRateInterval: {
      lower: baselineDraws[Math.floor(baselineDraws.length * 0.025)],
      upper: baselineDraws[Math.floor(baselineDraws.length * 0.975)],
    },
    trainedRateInterval: {
      lower: trainedDraws[Math.floor(trainedDraws.length * 0.025)],
      upper: trainedDraws[Math.floor(trainedDraws.length * 0.975)],
    },
  };
}

function provenanceAndStaleChecks() {
  const normal = source.snapshot(65, scenario(27));
  const extended = source.snapshot(
    95,
    scenario(28, { layout: 0, congestion: 0, outage: 1 }),
  );
  const futureTimestamp = new Date(
    Date.parse(normal.displayTimestamp) + 1000,
  ).toISOString();
  const tests = {
    operatorVisibleFeatureContract:
      JSON.stringify(engine.rankingCandidates(normal, graph)) ===
      JSON.stringify(
        engine.rankingCandidates(
          {
            ...normal,
            hiddenVehiclePosition: [0, 0],
            futureTraffic: [2, 2, 2],
            internalVehicleBranchScores: [100],
            unitStatuses: { "unit-1": "on_post" },
          },
          graph,
        ),
      ),
    validObservationWindowDuringGpsLoss:
      normal.connectivity === "signal_lost" &&
      engine.adviceEligibility(normal) &&
      engine.rankingCandidates(normal, graph).length > 0,
    estimatedVehicleReportSuppressed: !engine.adviceEligibility({
      ...normal,
      lastConfirmedReport: { ...normal.lastConfirmedReport, kind: "estimate" },
    }),
    staleVehicleReportSuppressed: !engine.adviceEligibility(extended),
    futureVehicleReportSuppressed: !engine.adviceEligibility({
      ...normal,
      lastConfirmedReport: {
        ...normal.lastConfirmedReport,
        deviceTimestamp: futureTimestamp,
        serverReceiptTimestamp: futureTimestamp,
      },
    }),
    unavailableUnitExcluded: engine
      .rankingCandidates(
        {
          ...normal,
          units: normal.units.map((unit) =>
            unit.unitId === "unit-2" ? { ...unit, currentReport: null } : unit,
          ),
        },
        graph,
      )
      .every((candidate) => candidate.unitId !== "unit-2"),
    estimatedUnitExcluded: engine
      .rankingCandidates(
        {
          ...normal,
          units: normal.units.map((unit) =>
            unit.unitId === "unit-2"
              ? {
                  ...unit,
                  currentReport: { ...unit.currentReport, kind: "estimate" },
                }
              : unit,
          ),
        },
        graph,
      )
      .every((candidate) => candidate.unitId !== "unit-2"),
    futureObservationSuppressed: !engine.adviceEligibility({
      ...normal,
      observations: [
        ...normal.observations,
        {
          id: "future-observation",
          availableSecond: normal.displaySecond + 1,
        },
      ],
    }),
  };
  return { tests, passed: Object.values(tests).every(Boolean) };
}

function inspectUpdateChanges(model) {
  const score = (candidate) => engine.modelScore(model, candidate);
  const top = (view, graph) => {
    const candidates = engine.rankingCandidates(view, graph);
    if (!candidates.length) return null;
    const chosen = rank(candidates, score)[0];
    return {
      unitId: chosen.unitId,
      objectiveId: chosen.objectiveId,
      probability: engine.modelProbability(model, chosen),
    };
  };
  const changed = (a, b) =>
    a?.unitId !== b?.unitId || a?.objectiveId !== b?.objectiveId;
  const summary = {
    reportUpdateCases: 0,
    reportUpdateTopChoiceChanges: 0,
    trafficUpdateCases: 0,
    trafficUpdateTopChoiceChanges: 0,
    examples: [],
  };
  for (const seed of splits.test)
    for (const variantIndex of [0, 1]) {
      const pattern = family(seed, "test", variantIndex);
      const run = scenario(seed, pattern);
      const source = sources[pattern.layout];
      const graph = graphs[pattern.layout];
      const beforeReport = source.snapshot(34, run);
      const afterReport = source.snapshot(35, run);
      const reportOnly = {
        ...beforeReport,
        displaySecond: 35,
        displayTimestamp: afterReport.displayTimestamp,
        reportAgeSeconds: afterReport.reportAgeSeconds,
        lastConfirmedReport: afterReport.lastConfirmedReport,
        units: afterReport.units,
      };
      const reportBeforeTop = top(beforeReport, graph);
      const reportAfterTop = top(reportOnly, graph);
      if (reportBeforeTop && reportAfterTop) {
        summary.reportUpdateCases++;
        if (changed(reportBeforeTop, reportAfterTop)) {
          summary.reportUpdateTopChoiceChanges++;
          if (summary.examples.length < 4)
            summary.examples.push({
              seed,
              pattern,
              update: "new confirmed report at 35s; traffic held fixed",
              before: reportBeforeTop,
              after: reportAfterTop,
            });
        }
      }
      for (const updateSecond of [15, 30, 45, 75, 105]) {
        const beforeTraffic = source.snapshot(updateSecond - 1, run);
        const afterTraffic = source.snapshot(updateSecond, run);
        const trafficOnly = {
          ...beforeTraffic,
          displaySecond: updateSecond,
          displayTimestamp: afterTraffic.displayTimestamp,
          reportAgeSeconds: beforeTraffic.reportAgeSeconds + 1,
          trafficSegments: afterTraffic.trafficSegments,
        };
        const trafficBeforeTop = top(
          { ...trafficOnly, trafficSegments: beforeTraffic.trafficSegments },
          graph,
        );
        const trafficAfterTop = top(trafficOnly, graph);
        if (trafficBeforeTop && trafficAfterTop) {
          summary.trafficUpdateCases++;
          if (changed(trafficBeforeTop, trafficAfterTop)) {
            summary.trafficUpdateTopChoiceChanges++;
            if (summary.examples.length < 4)
              summary.examples.push({
                seed,
                pattern,
                update: `current congestion changed at ${updateSecond}s; reports held fixed`,
                before: trafficBeforeTop,
                after: trafficAfterTop,
              });
          }
        }
      }
    }
  return summary;
}

if (process.argv.includes("--inspect-updates")) {
  const model = JSON.parse(
    readFileSync("src/generated/ranking-model.v3.json", "utf8"),
  );
  console.log(JSON.stringify(inspectUpdateChanges(model), null, 2));
  process.exit(0);
}

console.log("Generating synthetic counterfactual labels...");
const trainCases = dataset(splits.train, "train");
const validationCases = dataset(splits.validation, "validation");
const testCases = dataset(splits.test, "test");
const comparisons = pairs(trainCases);
if (!comparisons.length) throw new Error("No informative training pairs");

let selected = null;
for (const learningRate of [0.3, 1, 3])
  for (const l2 of [0, 0.01, 0.1])
    for (const epochs of [80, 200]) {
      const weights = train(comparisons, learningRate, l2, epochs);
      const validation = metrics(validationCases, (candidate) =>
        weights.reduce(
          (sum, weight, index) => sum + weight * candidate.features[index],
          0,
        ),
      );
      const key = [
        -validation.top1ObservationRate,
        validation.normalizedRegret,
      ];
      if (
        !selected ||
        key[0] < selected.key[0] ||
        (key[0] === selected.key[0] && key[1] < selected.key[1])
      )
        selected = {
          key,
          weights,
          learningRate,
          l2,
          epochs,
          validation,
        };
    }

const model = {
  version: engine.RANKER_VERSION,
  target: "first_available_unit_observation_within_90_seconds",
  featureNames: [...engine.FEATURE_NAMES],
  weights: selected.weights.map((weight) => Number(weight.toFixed(8))),
  calibration: fitCalibration(validationCases, (candidate) =>
    selected.weights.reduce(
      (sum, weight, index) => sum + weight * candidate.features[index],
      0,
    ),
  ),
  trainedOn:
    "synthetic vehicle seeds 1-32; validation seeds 33-40; graph layouts and congestion/outage families 0-1",
};
const modelScore = (candidate) => engine.modelScore(model, candidate);
const baselineScore = (candidate) => candidate.baselineScore;
const baseline = evaluate(testCases, baselineScore);
const trained = evaluate(testCases, modelScore);
const topChoiceImprovement = pairedSeedBootstrap(
  testCases,
  baselineScore,
  modelScore,
);
const calibration = calibrationMetrics(testCases, modelScore, (candidate) =>
  engine.modelProbability(model, candidate),
);
const signalLossCalibration = calibrationMetrics(
  testCases.filter((item) => item.signalLoss),
  modelScore,
  (candidate) => engine.modelProbability(model, candidate),
);
const signalLossImprovement = pairedSeedBootstrap(
  testCases.filter((item) => item.signalLoss),
  baselineScore,
  modelScore,
);
const provenanceAndStaleData = provenanceAndStaleChecks();
const updateInspections = inspectUpdateChanges(model);
const displayGate = {
  thresholds: {
    minimumTopChoiceObservationRateImprovement: 0.05,
    confidenceIntervalLowerMustExceedZero: true,
    maximumTopChoiceCalibrationError: 0.1,
    provenanceAndStaleDataChecksMustPass: true,
  },
  topChoiceImprovement,
  calibrationError: calibration.expectedCalibrationError,
  provenanceAndStaleDataChecksPassed: provenanceAndStaleData.passed,
  passed:
    topChoiceImprovement.improvement >= 0.05 &&
    topChoiceImprovement.lower > 0 &&
    calibration.expectedCalibrationError <= 0.1 &&
    provenanceAndStaleData.passed,
};
const digest = createHash("sha256")
  .update(JSON.stringify({ model, splits, decisionSeconds }))
  .digest("hex");
const report = {
  experiment: engine.RANKER_VERSION,
  configurationSha256: digest,
  target: model.target,
  label:
    "First valid unit observation available to the operator within 90 seconds after one candidate order; no observation has utility zero; earlier observations have higher utility.",
  baseline:
    "Transparent legal-route ETA using currently visible simulated congestion, last confirmed report and its age, reported heading, unit-report age, and junction approach coverage; unknown road congestion is assumed free-flow.",
  informationBoundary:
    "Browser inference uses only confirmed vehicle and unit reports and their ages, currently displayed simulated traffic, active operator orders, and road-graph geometry. Available observations are checked for future-dated provenance but are not model features. Future hidden vehicle truth is used only to generate offline labels.",
  splits,
  decisionSeconds,
  outageCases:
    "Scheduled vehicle GPS loss 60-90s in all runs; training/validation outage families are scheduled-only and extended 45-105s; held-out families add early 30-75s or late 80-125s loss.",
  familyHoldout: {
    trainingAndValidation: {
      graphLayouts: [0, 1],
      congestionPatterns: [0, 1],
      outagePatterns: [0, 1],
    },
    test: {
      graphLayouts: [2, 3],
      congestionPatterns: [2, 3],
      outagePatterns: [2, 3],
    },
    graphLayoutMethod:
      "Deterministic short synthetic connector edges added to the same attributed OSM base graph; all original road edges and observation approaches remain. These are alternate topology fixtures, not mapped roads or independent city maps.",
  },
  priorExploratoryEvaluation:
    "Seeds 61-272 were inspected under superseded gate runs and are excluded from this family-held-out evaluation.",
  trainCases: trainCases.length,
  informativePairs: comparisons.length,
  selectedHyperparameters: {
    learningRate: selected.learningRate,
    l2: selected.l2,
    epochs: selected.epochs,
    validation: selected.validation,
  },
  heldOut: {
    familyActionability: familyActionability(testCases),
    baseline,
    trained,
    topChoiceImprovement,
    signalLossImprovement,
    calibration,
    signalLossCalibration,
    provenanceAndStaleData,
    updateInspections,
  },
  displayGate,
};
mkdirSync("src/generated", { recursive: true });
mkdirSync("reports", { recursive: true });
writeFileSync(
  "src/generated/ranking-model.v3.json",
  await prettier.format(JSON.stringify(model), { parser: "json" }),
);
writeFileSync(
  "reports/ranking-evaluation.v3.json",
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    model: model.version,
    heldOutEligible: trained.all.eligible,
    baselineTopChoiceRate: baseline.all.top1ObservationRate,
    modelTopChoiceRate: trained.all.top1ObservationRate,
    displayGate,
  }),
);
