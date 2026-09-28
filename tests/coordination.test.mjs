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
const {
  COORDINATION_SIMULATOR_VERSION,
  CoordinationGraph,
  CoordinatedIncidentSource,
  trafficLevel,
} = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
const graphFile = JSON.parse(
  readFileSync("public/coordination-graph.json", "utf8"),
);
const graph = new CoordinationGraph(graphFile);
const source = new CoordinatedIncidentSource(graph);
const run = (seed, actions = []) => ({
  id: "run-1",
  name: "Test",
  seed,
  actions,
  outages: [],
});

function shortApproachFixture(junctionId, approachId) {
  const junction = graphFile.junctions.find((item) => item.id === junctionId);
  const roadEdge = graphFile.edges.find(
    ([from, to]) => `${from}:${to}` === approachId,
  );
  assert(junction);
  assert(roadEdge);
  const node = (id) => graphFile.nodes.find((item) => item[0] === id);
  const fixture = new CoordinationGraph({
    nodes: [
      ["synthetic-vehicle-start", 28.049203, -26.105078],
      node(roadEdge[0]),
      node(junction.nodeId),
    ],
    edges: [
      ["synthetic-vehicle-start", roadEdge[0], "Synthetic feeder", 35],
      roadEdge,
    ],
    junctions: [{ ...junction, visibleApproachEdgeIds: [approachId] }],
  });
  return { fixture, source: new CoordinatedIncidentSource(fixture) };
}

const shortOrder = (seed, unitId, junctionId, second = 0, outages = []) => ({
  ...run(seed, [
    {
      id: "short-edge-order",
      second,
      unitId,
      kind: "assign",
      objectiveId: junctionId,
    },
  ]),
  outages,
});

test("short Sandown Valley Crescent and Sandton Drive traversals can be observed", () => {
  assert.equal(COORDINATION_SIMULATOR_VERSION, "coordination-simulator-v4");
  for (const { junctionId, edgeId, unitId, seed, observedSecond } of [
    {
      junctionId: "junction-7",
      edgeId: "12365616205:204103935",
      unitId: "unit-2",
      seed: 11,
      observedSecond: 39,
    },
    {
      junctionId: "junction-8",
      edgeId: "7181596116:21626257",
      unitId: "unit-3",
      seed: 2,
      observedSecond: 34,
    },
  ]) {
    const { fixture, source: shortSource } = shortApproachFixture(
      junctionId,
      edgeId,
    );
    const approach = fixture.edges.find((edge) => edge.id === edgeId);
    const factor = [1, 0.75, 0.5][
      trafficLevel(approach.physicalId, observedSecond, seed)
    ];
    assert(approach.length < (approach.speedKmh / 3.6) * factor);
    const scenario = shortOrder(seed, unitId, junctionId);
    const beforeAvailable = shortSource.snapshot(observedSecond + 1, scenario);
    const available = shortSource.snapshot(observedSecond + 2, scenario);
    assert.equal(beforeAvailable.observations.length, 0);
    assert.equal(available.simulatorVersion, COORDINATION_SIMULATOR_VERSION);
    assert.deepEqual(
      available.observations.map((item) => [
        item.unitId,
        item.junction.id,
        item.observedSecond,
        item.availableSecond,
      ]),
      [[unitId, junctionId, observedSecond, observedSecond + 2]],
    );
    assert.equal(
      available.coordinationEvents.filter(
        (event) => event.kind === "unit_observation",
      ).length,
      1,
    );
    shortSource.snapshot(observedSecond - 3, scenario);
    assert.deepEqual(
      shortSource.snapshot(observedSecond + 2, scenario),
      available,
    );
  }
});

test("a short-edge sighting during GPS loss leaves the last vehicle report fixed", () => {
  const { source: shortSource } = shortApproachFixture(
    "junction-8",
    "7181596116:21626257",
  );
  const scenario = shortOrder(2, "unit-3", "junction-8", 0, [
    { start: 20, end: 80 },
  ]);
  const beforeAvailable = shortSource.snapshot(35, scenario);
  const available = shortSource.snapshot(36, scenario);
  assert.equal(available.connectivity, "signal_lost");
  assert.equal(beforeAvailable.observations.length, 0);
  assert.equal(available.observations[0].observedSecond, 34);
  assert.equal(available.observations[0].availableSecond, 36);
  assert.deepEqual(
    available.lastConfirmedReport,
    beforeAvailable.lastConfirmedReport,
  );
  assert.equal(available.lastConfirmedReport.id, "vehicle-15");
  assert.equal(available.confirmedReports.at(-1).id, "vehicle-15");
  assert.equal(
    available.inferredConnections.some(
      (connection) => connection.toReportId === "vehicle-35",
    ),
    false,
  );
  assert.deepEqual(shortSource.snapshot(36, scenario), available);
});

test("short-edge proximity alone does not create an observation", () => {
  const { fixture, source: shortSource } = shortApproachFixture(
    "junction-8",
    "7181596116:21626257",
  );
  const posted = shortOrder(2, "unit-3", "junction-8");
  assert.equal(shortSource.snapshot(90, run(2)).observations.length, 0);
  assert.equal(
    shortSource.snapshot(90, shortOrder(2, "unit-3", "junction-8", 34))
      .observations.length,
    0,
  );
  const noVisibleApproach = new CoordinationGraph({
    nodes: [...fixture.nodes].map(([id, [lon, lat]]) => [id, lon, lat]),
    edges: fixture.edges.map((edge) => [
      edge.from,
      edge.to,
      edge.name,
      edge.speedKmh,
    ]),
    junctions: [
      {
        id: "junction-8",
        nodeId: "21626257",
        name: "Grayston Drive × Sandton Drive",
        visibleApproachEdgeIds: [],
      },
    ],
  });
  assert.equal(
    new CoordinatedIncidentSource(noVisibleApproach).snapshot(90, posted)
      .observations.length,
    0,
  );
  // Seed 6 traverses the nominated edge, but its visibility state at 53s is blocked.
  const blocked = shortApproachFixture(
    "junction-7",
    "12365616205:204103935",
  ).source.snapshot(55, shortOrder(6, "unit-2", "junction-7"));
  assert.equal(blocked.lastConfirmedReport.id, "vehicle-55");
  assert.equal(blocked.observations.length, 0);
});

test("an incoming edge remains out of observation range until its final 75 m", () => {
  const junction = graphFile.junctions.find((item) => item.id === "junction-8");
  const junctionNode = graphFile.nodes.find(
    (item) => item[0] === junction.nodeId,
  );
  const fixture = new CoordinationGraph({
    nodes: [["synthetic-vehicle-start", 28.049203, -26.105078], junctionNode],
    edges: [
      [
        "synthetic-vehicle-start",
        junction.nodeId,
        "Synthetic long approach",
        35,
      ],
    ],
    junctions: [
      {
        ...junction,
        visibleApproachEdgeIds: [`synthetic-vehicle-start:${junction.nodeId}`],
      },
    ],
  });
  const approach = fixture.edge("synthetic-vehicle-start", junction.nodeId);
  assert(approach.length - (5 * approach.speedKmh) / 3.6 > 75);
  const longSource = new CoordinatedIncidentSource(fixture);
  const scenario = shortOrder(2, "unit-3", "junction-8");
  assert.equal(longSource.snapshot(5, scenario).observations.length, 0);
  assert.equal(longSource.snapshot(90, scenario).observations.length, 1);
});

test("movement carries remaining travel across short connected edges within one tick", () => {
  const start = [28.04625, -26.1053];
  const tiny = new CoordinationGraph({
    nodes: [
      ["a", ...start],
      ["b", start[0] + 0.00002, start[1]],
      ["c", start[0] + 0.00004, start[1]],
    ],
    edges: [
      ["a", "b", "Synthetic short road", 30],
      ["b", "c", "Synthetic short road", 30],
    ],
    junctions: [
      {
        id: "short-objective",
        nodeId: "c",
        name: "Synthetic short-edge objective",
        visibleApproachEdgeIds: [],
      },
    ],
  });
  const shortSource = new CoordinatedIncidentSource(tiny);
  const ordered = run(4, [
    {
      id: "short-order",
      second: 0,
      unitId: "unit-3",
      kind: "assign",
      objectiveId: "short-objective",
    },
  ]);
  const atOne = shortSource.snapshot(1, ordered);
  assert.equal(atOne.unitStatuses["unit-3"], "on_post");
  assert.deepEqual(
    atOne.coordinationEvents
      .filter((event) => event.kind === "unit_status")
      .map((event) => event.scenarioSecond),
    [1],
  );
  assert.equal(
    shortSource.snapshot(0, ordered).unitStatuses["unit-3"],
    "en_route",
  );
  assert.deepEqual(shortSource.snapshot(1, ordered), atOne);
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
  const scenario = run(413, [
    {
      id: "observe",
      second: 0,
      unitId: "unit-2",
      kind: "assign",
      objectiveId: "junction-7",
    },
  ]);
  const beforeAvailable = source.snapshot(63, scenario);
  const available = source.snapshot(64, scenario);
  const withoutOrder = source.snapshot(64, run(413));
  assert.equal(withoutOrder.observations.length, 0);
  assert.equal(beforeAvailable.connectivity, "signal_lost");
  assert.equal(beforeAvailable.observations.length, 0);
  assert.equal(available.observations.length, 1);
  assert.equal(available.observations[0].observedSecond, 62);
  assert.equal(available.observations[0].availableSecond, 64);
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
