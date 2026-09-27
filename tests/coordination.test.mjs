import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: ["src/coordination.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { CoordinationGraph, CoordinatedIncidentSource, trafficLevel } =
  await import(
    `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
  );
const graph = new CoordinationGraph(
  JSON.parse(readFileSync("public/coordination-graph.json", "utf8")),
);
const source = new CoordinatedIncidentSource(graph);
const run = (seed, actions = []) => ({
  id: "run-1",
  name: "Test",
  seed,
  actions,
  outages: [],
});

test("assignment moves a unit from its own position and changes its route", () => {
  const baseline = source.snapshot(60, run(42));
  const ordered = source.snapshot(
    60,
    run(42, [
      {
        id: "order-1",
        second: 5,
        unitId: "unit-2",
        kind: "assign",
        objectiveId: "junction-4",
      },
    ]),
  );
  const initial = source.snapshot(0, run(42));
  assert.notDeepEqual(
    initial.units[1].currentReport.coordinates,
    initial.lastConfirmedReport.coordinates,
  );
  assert.notDeepEqual(
    ordered.units[1].currentReport.coordinates,
    baseline.units[1].currentReport.coordinates,
  );
  assert.equal(
    ordered.unitObjectives["unit-2"].name,
    "5th Street × Grayston Drive",
  );
  assert(
    ordered.plannedRoutes.find((route) => route.unitId === "unit-2")
      .etaSeconds > 0,
  );
});

test("traffic is seeded, time-varying, and shared by opposite directions", () => {
  const edge = graph.edges.find((candidate) =>
    graph.edge(candidate.to, candidate.from),
  );
  assert(edge);
  assert.equal(
    trafficLevel(edge.physicalId, 30, 42),
    trafficLevel(graph.edge(edge.to, edge.from).physicalId, 30, 42),
  );
  assert.deepEqual(
    source.snapshot(75, run(42)).trafficSegments,
    source.snapshot(75, run(42)).trafficSegments,
  );
  assert.notDeepEqual(
    source.snapshot(0, run(42)).trafficSegments,
    source.snapshot(75, run(42)).trafficSegments,
  );
});

test("scrubbing and alternative action logs reproduce separate deterministic runs", () => {
  const original = run(42);
  const alternative = run(42, [
    {
      id: "branch-order",
      second: 0,
      unitId: "unit-3",
      kind: "assign",
      objectiveId: "junction-3",
    },
  ]);
  const originalEnd = source.snapshot(180, original);
  const alternativeEnd = source.snapshot(180, alternative);
  source.snapshot(20, alternative);
  assert.deepEqual(source.snapshot(180, original), originalEnd);
  assert.deepEqual(source.snapshot(180, alternative), alternativeEnd);
  assert.notDeepEqual(
    alternativeEnd.lastConfirmedReport.coordinates,
    originalEnd.lastConfirmedReport.coordinates,
  );
});

test("a unit observation during GPS loss does not move the confirmed GPS marker", () => {
  const scenario = run(27, [
    {
      id: "observe",
      second: 0,
      unitId: "unit-2",
      kind: "assign",
      objectiveId: "junction-7",
    },
  ]);
  const beforeAvailable = source.snapshot(62, scenario);
  const available = source.snapshot(63, scenario);
  const withoutOrder = source.snapshot(63, run(27));
  assert.equal(withoutOrder.observations.length, 0);
  assert.equal(beforeAvailable.connectivity, "signal_lost");
  assert.equal(beforeAvailable.observations.length, 0);
  assert.equal(available.observations.length, 1);
  assert.equal(available.observations[0].observedSecond, 61);
  assert.equal(available.observations[0].availableSecond, 63);
  assert.equal(
    available.coordinationEvents.some(
      (event) => event.kind === "unit_observation",
    ),
    true,
  );
  assert.equal(
    available.coordinationEvents.some((event) =>
      /Vehicle chose/.test(event.text),
    ),
    false,
  );
  assert.deepEqual(
    available.lastConfirmedReport.coordinates,
    beforeAvailable.lastConfirmedReport.coordinates,
  );
  assert.equal(
    available.lastConfirmedReport.deviceTimestamp,
    beforeAvailable.lastConfirmedReport.deviceTimestamp,
  );
  assert.equal(
    available.inferredConnections.some(
      (connection) => connection.toReportId === "vehicle-60",
    ),
    false,
  );
});
