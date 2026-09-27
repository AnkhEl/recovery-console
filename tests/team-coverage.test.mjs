import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { build } from "esbuild";

const compiled = await build({
  stdin: {
    contents:
      'export * from "./src/coordination.ts"; export * from "./src/ranking.ts"; export * from "./src/teamCoverage.ts"; export * from "./src/scenarioAnalysis.ts";',
    resolveDir: process.cwd(),
    sourcefile: "team-coverage-test-entry.ts",
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
const run = {
  id: "team-review",
  name: "Team review",
  seed: 27,
  actions: [
    {
      id: "u2-j7",
      second: 0,
      unitId: "unit-2",
      kind: "assign",
      objectiveId: "junction-7",
    },
    {
      id: "u3-j8",
      second: 0,
      unitId: "unit-3",
      kind: "assign",
      objectiveId: "junction-8",
    },
  ],
  outages: [],
};

test("seed 27 team view separates configured coverage from route evidence", () => {
  const view = source.snapshot(63, run);
  const team = engine.teamCoverageView(view, graph);
  assert.equal(view.connectivity, "signal_lost");
  assert.equal(team.hasWellSupportedOrder, false);
  const duplicate = team.duplicateExample;
  assert.equal(duplicate.candidate.unitId, "unit-3");
  assert.equal(duplicate.candidate.objectiveId, "junction-7");
  assert.equal(duplicate.gainedApproachIds.length, 0);
  assert.equal(duplicate.lostApproachIds.length, 2);
  assert.equal(duplicate.fitsWindow, false);
  assert.equal(duplicate.evaluationEndSecond, 153);
  const helena = team.alternatives.find(
    (option) =>
      option.candidate.unitId === "unit-1" &&
      option.candidate.objectiveId === "junction-6",
  );
  assert(helena);
  assert.equal(helena.gainedApproachIds.length, 3);
  assert.equal(helena.lostApproachIds.length, 0);
  assert.equal(helena.earliestReadySecond, 108);
  assert.equal(helena.earliestPossibleAvailabilitySecond, 110);
  assert.equal(helena.exploratory, true);
  assert.equal(helena.recentLocalObservation, false);
});

test("stale incumbent makes duplicate coverage uncertain, not confirmed", () => {
  const view = source.snapshot(63, run);
  const candidate = engine
    .rankingCandidates(view, graph)
    .find(
      (item) => item.unitId === "unit-3" && item.objectiveId === "junction-7",
    );
  const staleView = {
    ...view,
    units: view.units.map((unit) =>
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
  const assessed = engine.assessTeamCandidate(staleView, candidate, graph);
  assert.equal(assessed.duplicate, false);
  assert.equal(assessed.gainedApproachIds.length, 0);
  assert.equal(assessed.uncertainOverlapIds.length, 3);
  assert.equal(assessed.lostApproachIds.length, 2);
});

test("timing uses the shorter of 90 seconds and replay remainder", () => {
  const atStart = source.snapshot(0, { ...run, actions: [] });
  const atEnd = source.snapshot(95, { ...run, actions: [] });
  const candidate = engine.rankingCandidates(atStart, graph)[0];
  assert.equal(
    engine.assessTeamCandidate(
      atStart,
      { ...candidate, trafficRouteSeconds: 85 },
      graph,
    ).fitsWindow,
    true,
  );
  assert.equal(
    engine.assessTeamCandidate(
      atStart,
      { ...candidate, trafficRouteSeconds: 86 },
      graph,
    ).fitsWindow,
    false,
  );
  assert.equal(
    engine.assessTeamCandidate(
      atEnd,
      { ...candidate, trafficRouteSeconds: 80 },
      graph,
    ).evaluationEndSecond,
    180,
  );
  assert.equal(
    engine.assessTeamCandidate(
      atEnd,
      { ...candidate, trafficRouteSeconds: 80 },
      graph,
    ).fitsWindow,
    true,
  );
  assert.equal(
    engine.assessTeamCandidate(
      atEnd,
      { ...candidate, trafficRouteSeconds: 81 },
      graph,
    ).fitsWindow,
    false,
  );
});

test("orders, observations, and traffic refresh reviewed team options", () => {
  const view = source.snapshot(63, run);
  const earlier = source.snapshot(63, {
    ...run,
    actions: run.actions.slice(0, 1),
  });
  assert.notDeepEqual(
    engine.teamCoverageView(earlier, graph),
    engine.teamCoverageView(view, graph),
  );
  const helena = engine
    .teamCoverageView(view, graph)
    .alternatives.find(
      (option) => option.candidate.objectiveId === "junction-6",
    );
  const review = engine.createScenarioReview(
    view,
    helena.candidate,
    run.id,
    helena,
  );
  assert.equal(
    engine.revalidateScenarioReview(review, view, graph, run.id).status,
    "current",
  );
  assert.equal(
    engine.revalidateScenarioReview(
      review,
      { ...view, observations: [] },
      graph,
      run.id,
    ).status,
    "refreshed",
  );
  assert.equal(
    engine.revalidateScenarioReview(
      review,
      {
        ...view,
        trafficSegments: view.trafficSegments.map((segment) => ({
          ...segment,
          level: 2,
        })),
      },
      graph,
      run.id,
    ).status,
    "refreshed",
  );
});
