import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { build } from "esbuild";

const compiled = await build({
  stdin: {
    contents:
      'export * from "./src/coordination.ts"; export * from "./src/operatorPlan.ts";',
    resolveDir: process.cwd(),
    sourcefile: "operator-plan-test-entry.ts",
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
const original = {
  id: "original",
  name: "Original run",
  seed: 27,
  actions: [],
  outages: [],
};
const draft = {
  runId: original.id,
  second: 0,
  name: "Plan A",
  choices: [
    { unitId: "unit-3", objectiveId: "junction-3" },
    { unitId: "unit-2", objectiveId: "junction-7" },
  ],
  revisionPlanId: null,
};

test("operator plan review uses current reports and combined configured coverage", () => {
  const view = source.snapshot(0, original);
  const review = engine.assessOperatorPlan(view, graph, draft, original);
  assert.deepEqual(review.issues, []);
  assert.equal(review.coverage.before, 0);
  assert.equal(review.coverage.after, 6);
  assert.equal(review.coverage.gained.length, 6);
  assert.deepEqual(review.coverage.lostConfirmed, []);
  assert.deepEqual(review.coverage.targetOverlap, []);
  assert.equal(review.evaluationEndSecond, 90);
  assert.equal(review.items[0].earliestInformationSecond, 46);
  assert.equal(review.items[1].routeSeconds, 0);
  assert.equal(review.items[1].earliestInformationSecond, 5);
  assert.equal(review.vehicleReportAgeSeconds, 0);
  assert.equal("futureObservations" in review, false);
  const orders = engine.linkedPlanOrders(review.items, 0, "plan-a", "Plan A");
  assert.deepEqual(
    orders.map((order) => order.unitId),
    ["unit-2", "unit-3"],
  );
  assert(
    orders.every((order) => order.second === 0 && order.planId === "plan-a"),
  );
});

test("both distinct choices and both current unit reports are required", () => {
  const view = source.snapshot(0, original);
  const duplicate = engine.assessOperatorPlan(
    view,
    graph,
    {
      ...draft,
      choices: [
        { unitId: "unit-2", objectiveId: "junction-7" },
        { unitId: "unit-2", objectiveId: "junction-7" },
      ],
    },
    original,
  );
  assert(duplicate.issues.some((issue) => /distinct units/.test(issue)));
  assert(
    duplicate.issues.some((issue) => /distinct named junctions/.test(issue)),
  );
  const stale = {
    ...view,
    units: view.units.map((unit) =>
      unit.unitId === "unit-3" ? { ...unit, currentReport: null } : unit,
    ),
  };
  const checked = engine.assessOperatorPlan(stale, graph, draft, original);
  assert(
    checked.issues.some((issue) =>
      /Unit 03 needs a confirmed report/.test(issue),
    ),
  );
});

test("revision removes only linked old orders and preserves unrelated earlier and same-second actions", () => {
  const run = {
    ...original,
    id: "plan-run",
    actions: [
      {
        id: "earlier",
        second: 0,
        unitId: "unit-1",
        kind: "retask",
        objectiveId: "junction-5",
      },
      {
        id: "old-1",
        second: 35,
        unitId: "unit-2",
        kind: "assign",
        objectiveId: "junction-7",
        planId: "old",
      },
      {
        id: "old-2",
        second: 35,
        unitId: "unit-3",
        kind: "assign",
        objectiveId: "junction-3",
        planId: "old",
      },
      {
        id: "unrelated",
        second: 35,
        unitId: "unit-1",
        kind: "retask",
        objectiveId: "junction-6",
      },
      {
        id: "later",
        second: 70,
        unitId: "unit-1",
        kind: "retask",
        objectiveId: "junction-5",
      },
    ],
  };
  const base = engine.planBaseRun(run, 35, "old");
  assert.deepEqual(
    base.actions.map((order) => order.id),
    ["earlier", "unrelated"],
  );
  const review = engine.assessOperatorPlan(
    source.snapshot(35, base),
    graph,
    {
      runId: run.id,
      second: 35,
      name: "Revised",
      choices: [
        { unitId: "unit-2", objectiveId: "junction-7" },
        { unitId: "unit-3", objectiveId: "junction-3" },
      ],
      revisionPlanId: "old",
    },
    base,
  );
  assert(!review.issues.some((issue) => /unrelated order/.test(issue)));
  const conflicting = engine.assessOperatorPlan(
    source.snapshot(35, base),
    graph,
    {
      runId: run.id,
      second: 35,
      name: "Conflicting",
      choices: [
        { unitId: "unit-1", objectiveId: "junction-5" },
        { unitId: "unit-2", objectiveId: "junction-7" },
      ],
      revisionPlanId: "old",
    },
    base,
  );
  assert(conflicting.issues.some((issue) => /unrelated order/.test(issue)));
});

test("comparison explains incompatible prior state and later actions", () => {
  const planA = {
    ...original,
    id: "a",
    actions: [
      {
        id: "a1",
        second: 0,
        unitId: "unit-2",
        kind: "assign",
        objectiveId: "junction-7",
        planId: "a",
      },
      {
        id: "a2",
        second: 0,
        unitId: "unit-3",
        kind: "assign",
        objectiveId: "junction-3",
        planId: "a",
      },
    ],
  };
  const planB = {
    ...original,
    id: "b",
    actions: [
      {
        id: "b1",
        second: 0,
        unitId: "unit-2",
        kind: "assign",
        objectiveId: "junction-1",
        planId: "b",
      },
      {
        id: "b2",
        second: 0,
        unitId: "unit-3",
        kind: "assign",
        objectiveId: "junction-3",
        planId: "b",
      },
    ],
  };
  assert.deepEqual(engine.compareRunBasis(original, planA, 0, 90), []);
  assert.deepEqual(engine.compareRunBasis(planA, planB, 0, 90), []);
  assert(
    engine
      .compareRunBasis(original, planA, 35, 90)
      .includes("Prior unit orders differ."),
  );
  assert(
    engine
      .compareRunBasis(
        original,
        { ...planB, outages: [{ start: 40, end: 80 }] },
        0,
        90,
      )
      .includes("Manual signal schedule differs."),
  );
  assert(
    engine
      .compareRunBasis(
        original,
        {
          ...planB,
          actions: [
            ...planB.actions,
            {
              id: "later",
              second: 40,
              unitId: "unit-1",
              kind: "retask",
              objectiveId: "junction-5",
            },
          ],
        },
        0,
        90,
      )
      .includes("Later unit orders differ before the comparison time."),
  );
});

test("seed 27 plans replay deterministically and GPS loss retains the confirmed marker", () => {
  const view = source.snapshot(0, original);
  const review = engine.assessOperatorPlan(view, graph, draft, original);
  const planA = {
    ...original,
    id: "a",
    actions: engine.linkedPlanOrders(review.items, 0, "a", "Plan A"),
  };
  const planB = {
    ...original,
    id: "b",
    actions: [
      {
        id: "b1",
        second: 0,
        unitId: "unit-2",
        kind: "assign",
        objectiveId: "junction-1",
        planId: "b",
      },
      {
        id: "b2",
        second: 0,
        unitId: "unit-3",
        kind: "assign",
        objectiveId: "junction-3",
        planId: "b",
      },
    ],
  };
  const at55 = source.snapshot(55, planA);
  const at63 = source.snapshot(63, planA);
  assert.equal(at63.connectivity, "signal_lost");
  assert.deepEqual(at63.lastConfirmedReport, at55.lastConfirmedReport);
  assert.deepEqual(
    at63.observations.map((item) => [
      item.unitId,
      item.observedSecond,
      item.availableSecond,
    ]),
    [["unit-2", 61, 63]],
  );
  assert.equal(source.snapshot(90, original).observations.length, 0);
  assert.equal(source.snapshot(90, planB).observations.length, 0);
  const finish = source.snapshot(90, planA);
  source.snapshot(18, planA);
  assert.deepEqual(source.snapshot(90, planA), finish);
});

test("comparison window separates partial from completed seed 27 outcomes", () => {
  const review = engine.assessOperatorPlan(
    source.snapshot(0, original),
    graph,
    draft,
    original,
  );
  const planA = {
    ...original,
    actions: engine.linkedPlanOrders(review.items, 0, "a", "Plan A"),
  };
  assert.equal(engine.comparisonDeadline(0), 90);
  assert.equal(engine.comparisonDeadline(95), 180);
  const completeView = source.snapshot(90, planA);
  assert.equal(engine.comparisonObservations(completeView, 0, 62).length, 0);
  assert.deepEqual(
    engine
      .comparisonObservations(completeView, 0, 63)
      .map((item) => [item.observedSecond, item.availableSecond]),
    [[61, 63]],
  );
  assert.equal(engine.comparisonObservations(completeView, 0, 90).length, 1);
  assert.equal(
    engine.comparisonObservations(source.snapshot(90, original), 0, 90).length,
    0,
  );
});

test("retasking an incumbent can remove an otherwise available observation", () => {
  const control = {
    ...original,
    seed: 3010,
    trafficSeed: 3010,
    trafficPattern: 0,
    outages: [{ start: 45, end: 105 }],
    actions: [
      {
        id: "prior-unit-2-post",
        second: 0,
        unitId: "unit-2",
        kind: "assign",
        objectiveId: "junction-7",
      },
    ],
  };
  const retask = {
    ...control,
    id: "retask-run",
    actions: [
      ...control.actions,
      {
        id: "retask-unit-2",
        second: 0,
        unitId: "unit-2",
        kind: "retask",
        objectiveId: "junction-1",
        planId: "retask-plan",
      },
      {
        id: "assign-unit-3",
        second: 0,
        unitId: "unit-3",
        kind: "assign",
        objectiveId: "junction-1",
        planId: "retask-plan",
      },
    ],
  };
  assert.deepEqual(engine.compareRunBasis(control, retask, 0, 90), []);
  assert.deepEqual(
    engine
      .comparisonObservations(source.snapshot(90, control), 0, 90)
      .map((item) => [
        item.unitId,
        item.junction.id,
        item.observedSecond,
        item.availableSecond,
      ]),
    [["unit-2", "junction-7", 53, 55]],
  );
  assert.equal(
    engine.comparisonObservations(source.snapshot(90, retask), 0, 90).length,
    0,
  );
});
