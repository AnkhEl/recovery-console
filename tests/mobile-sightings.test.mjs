import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { build } from "esbuild";

const compiled = await build({
  stdin: {
    contents:
      'export * from "./src/coordination.ts"; export * from "./src/sightLines.ts";',
    resolveDir: process.cwd(),
    sourcefile: "mobile-test-entry.ts",
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
const run = {
  id: "mobile-fixture",
  name: "Synthetic mobile fixture",
  seed: 4,
  actions: [
    {
      id: "unit-2-to-park-lane",
      second: 0,
      unitId: "unit-2",
      kind: "assign",
      objectiveId: "junction-1",
    },
  ],
  outages: [{ start: 1, end: 20 }],
};
const source = (fixture, sightLines = engine.sightLineDataset()) =>
  new engine.CoordinatedIncidentSource(graph, new Set(), sightLines, fixture);

test("connected short edges retain a continuous legal road corridor", () => {
  const road = new engine.CoordinationGraph({
    nodes: [
      ["a", 28.049, -26.105],
      ["b", 28.04905, -26.105],
      ["c", 28.0491, -26.105],
      ["d", 28.04905, -26.10495],
    ],
    edges: [
      ["a", "b", "Synthetic Road", 30],
      ["b", "a", "Synthetic Road", 30],
      ["b", "c", "Synthetic Road", 30],
      ["c", "b", "Synthetic Road", 30],
      ["b", "d", "Other Road", 30],
    ],
    junctions: [],
  });
  const first = road.edge("a", "b");
  const next = road.edge("b", "c");
  const following = engine.corridorDistanceAhead(
    road,
    first,
    0.5,
    next,
    0.5,
    45,
  );
  assert(following > 0 && following < 15);
  assert.equal(
    engine.corridorDistanceAhead(road, first, 0.5, next, 0.5, 45),
    engine.corridorDistanceAhead(
      road,
      first,
      0.5,
      road.edge("b", "c"),
      1 - 0.5,
      45,
    ),
  );
  assert.equal(
    engine.corridorDistanceAhead(
      road,
      first,
      0.5,
      road.edge("b", "d"),
      0.5,
      45,
    ),
    null,
  );
});

test("oncoming encounter becomes available during GPS loss without moving GPS", () => {
  assert.equal(
    engine.COORDINATION_SIMULATOR_VERSION,
    "coordination-simulator-v4",
  );
  const simulator = source("oncoming-clear");
  const before = simulator.snapshot(5, run);
  const available = simulator.snapshot(6, run);
  assert.deepEqual(before.mobileObservations, []);
  assert.deepEqual(
    available.mobileObservations.map((item) => [
      item.encounterType,
      item.unitId,
      item.roadName,
      item.observedSecond,
      item.availableSecond,
    ]),
    [["oncoming", "unit-2", "Park Lane", 4, 6]],
  );
  assert.deepEqual(available.observations, []);
  assert.equal(available.unitStatuses["unit-2"], "en_route");
  assert.equal(available.connectivity, "signal_lost");
  assert.equal(available.lastConfirmedReport.id, "vehicle-0");
  assert.deepEqual(available.lastConfirmedReport, before.lastConfirmedReport);
  assert.equal(available.confirmedReports.length, 1);
  assert.equal(
    available.coordinationEvents.some(
      (item) => item.kind === "mobile_unit_observation",
    ),
    true,
  );
  assert.equal("vehicleCoordinates" in available.mobileObservations[0], false);
  simulator.snapshot(2, run);
  assert.deepEqual(simulator.snapshot(6, run), available);
});

test("following-behind encounter requires the vehicle ahead for two seconds", () => {
  const simulator = source("following-clear");
  assert.deepEqual(simulator.snapshot(3, run).mobileObservations, []);
  const available = simulator.snapshot(4, run);
  assert.deepEqual(
    available.mobileObservations.map((item) => [
      item.encounterType,
      item.observedSecond,
      item.availableSecond,
    ]),
    [["following", 2, 4]],
  );
  assert.equal(available.lastConfirmedReport.id, "vehicle-0");
  assert.deepEqual(
    source("following-behind").snapshot(20, run).mobileObservations,
    [],
  );
});

test("a fleeting pass, an already separating pass, and mapped obstruction yield no sighting", () => {
  for (const fixture of ["oncoming-fleeting", "oncoming-separating"])
    assert.deepEqual(source(fixture).snapshot(20, run).mobileObservations, []);
  const parkLane = graph.edge("7602313049", "1671936783");
  const start = graph.nodes.get(parkLane.from);
  const end = graph.nodes.get(parkLane.to);
  const centre = [
    start[0] + (end[0] - start[0]) * 0.47,
    start[1] + (end[1] - start[1]) * 0.47,
  ];
  const blocked = engine.sightLineDataset();
  blocked.footprints = [
    ...blocked.footprints,
    {
      id: "synthetic-mobile-screen",
      source: "synthetic_fixture",
      buildingTag: "simulated obstruction",
      coordinates: [
        [centre[0] - 0.00003, centre[1] - 0.00003],
        [centre[0] + 0.00003, centre[1] - 0.00003],
        [centre[0] + 0.00003, centre[1] + 0.00003],
        [centre[0] - 0.00003, centre[1] + 0.00003],
        [centre[0] - 0.00003, centre[1] - 0.00003],
      ],
    },
  ];
  assert.deepEqual(
    source("oncoming-clear", blocked).snapshot(20, run).mobileObservations,
    [],
  );
});
