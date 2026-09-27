import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { build } from "esbuild";

const compiled = await build({
  stdin: {
    contents:
      'export * from "./src/ranking.ts"; export * from "./src/coordination.ts";',
    resolveDir: process.cwd(),
    sourcefile: "ranking-test-entry.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const engine = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
const graph = new engine.CoordinationGraph(
  JSON.parse(readFileSync("public/coordination-graph.json", "utf8")),
);
const source = new engine.CoordinatedIncidentSource(graph);
const model = JSON.parse(
  readFileSync("src/generated/ranking-model.v3.json", "utf8"),
);
const run = {
  id: "test",
  name: "test",
  seed: 27,
  actions: [],
  outages: [],
};

test("ranker uses only operator-visible input and excludes unavailable units", () => {
  const snapshot = source.snapshot(65, run);
  const visible = {
    displaySecond: snapshot.displaySecond,
    displayTimestamp: snapshot.displayTimestamp,
    reportAgeSeconds: snapshot.reportAgeSeconds,
    connectivity: snapshot.connectivity,
    lastConfirmedReport: snapshot.lastConfirmedReport,
    units: snapshot.units,
    objectives: snapshot.objectives,
    assignedUnitIds: snapshot.assignedUnitIds,
    unitObjectives: snapshot.unitObjectives,
    observations: snapshot.observations,
    trafficSegments: snapshot.trafficSegments,
  };
  assert.deepEqual(
    engine.rankingCandidates(snapshot, graph),
    engine.rankingCandidates(visible, graph),
  );
  assert.deepEqual(
    engine.rankingCandidates(visible, graph),
    engine.rankingCandidates(
      {
        ...visible,
        hiddenVehiclePosition: [0, 0],
        futureTraffic: [2, 2, 2],
        internalBranchScores: [100],
        unitStatuses: { "unit-1": "on_post" },
      },
      graph,
    ),
  );
  const missing = {
    ...visible,
    units: visible.units.map((unit) =>
      unit.unitId === "unit-2" ? { ...unit, currentReport: null } : unit,
    ),
  };
  assert(
    engine
      .rankingCandidates(missing, graph)
      .every((candidate) => candidate.unitId !== "unit-2"),
  );
  const estimatedUnit = {
    ...visible,
    units: visible.units.map((unit) =>
      unit.unitId === "unit-2"
        ? {
            ...unit,
            currentReport: { ...unit.currentReport, kind: "estimate" },
          }
        : unit,
    ),
  };
  assert(
    engine
      .rankingCandidates(estimatedUnit, graph)
      .every((candidate) => candidate.unitId !== "unit-2"),
  );
  const staleUnit = {
    ...visible,
    units: visible.units.map((unit) =>
      unit.unitId === "unit-2"
        ? {
            ...unit,
            currentReport: {
              ...unit.currentReport,
              deviceTimestamp: source.snapshot(0, run).displayTimestamp,
              serverReceiptTimestamp: source.snapshot(0, run).displayTimestamp,
            },
          }
        : unit,
    ),
  };
  assert(
    engine
      .rankingCandidates(staleUnit, graph)
      .every((candidate) => candidate.unitId !== "unit-2"),
  );
  assert.equal(engine.adviceEligibility(snapshot), true);
  assert.equal(
    engine.adviceEligibility({
      ...visible,
      lastConfirmedReport: {
        ...visible.lastConfirmedReport,
        kind: "estimate",
      },
    }),
    false,
  );
  assert.equal(
    engine.adviceEligibility(
      source.snapshot(95, { ...run, outages: [{ start: 45, end: 105 }] }),
    ),
    false,
  );
});

test("versioned model scores deterministically and rejects feature drift", () => {
  const candidate = engine.rankingCandidates(source.snapshot(0, run), graph)[0];
  const score = engine.modelScore(model, candidate);
  assert(Number.isFinite(score));
  assert.equal(score, engine.modelScore(model, candidate));
  const probability = engine.modelProbability(model, candidate);
  assert(probability >= 0 && probability <= 1);
  assert.throws(() =>
    engine.modelScore({ ...model, version: "unknown" }, candidate),
  );
});
