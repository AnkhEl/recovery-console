import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { build } from "esbuild";

const compiled = await build({
  stdin: {
    contents:
      'export * from "./src/coordination.ts"; export * from "./src/sightLines.ts";',
    resolveDir: process.cwd(),
    sourcefile: "sight-lines-entry.ts",
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
const graph = new engine.CoordinationGraph(graphFile);
const scenario = {
  id: "sight-line-demo",
  name: "Synthetic sight-line demo",
  seed: 27,
  actions: [
    {
      id: "post-unit-2",
      second: 0,
      unitId: "unit-2",
      kind: "assign",
      objectiveId: "junction-7",
    },
  ],
  outages: [],
};

test("a mapped polygon blocks a sight line, while clear and remote lines remain unblocked", () => {
  const footprint = {
    id: "synthetic-test",
    buildingTag: "simulated obstruction",
    source: "synthetic_fixture",
    coordinates: [
      [0.4, -0.1],
      [0.6, -0.1],
      [0.6, 0.1],
      [0.4, 0.1],
      [0.4, -0.1],
    ],
  };
  assert(engine.sightLineBlocked([0, 0], [1, 0], [footprint]));
  assert(engine.sightLineBlocked([0.5, 0], [1, 0], [footprint]));
  assert(!engine.sightLineBlocked([0, 0.5], [1, 0.5], [footprint]));
});

test("the frozen footprint extract has no crossing of a configured straight approach", () => {
  const footprints = engine.sightLineDataset().footprints;
  assert.equal(footprints.length, 34);
  for (const objective of graph.objectives)
    for (const id of objective.visibleApproachEdgeIds) {
      const edge = graph.edges.find((candidate) => candidate.id === id);
      assert(edge);
      assert.equal(
        engine.sightLineBlocked(
          objective.coordinates,
          graph.nodes.get(edge.from),
          footprints,
        ),
        false,
        `${objective.name}: ${id}`,
      );
    }
});

test("synthetic mapped obstruction removes the seed 27 GPS-loss sighting", () => {
  const clearSource = new engine.CoordinatedIncidentSource(
    graph,
    new Set(),
    engine.sightLineDataset("clear"),
  );
  const blockedSource = new engine.CoordinatedIncidentSource(
    graph,
    new Set(),
    engine.sightLineDataset("blocked"),
  );
  const before = clearSource.snapshot(62, scenario);
  const clear = clearSource.snapshot(63, scenario);
  const blocked = blockedSource.snapshot(63, scenario);
  assert.equal(before.observations.length, 0);
  assert.deepEqual(
    clear.observations.map((item) => [
      item.unitId,
      item.observedSecond,
      item.availableSecond,
      item.sightLineAssessment,
    ]),
    [["unit-2", 61, 63, "no_mapped_blockage_visibility_uncertain"]],
  );
  assert.deepEqual(blocked.observations, []);
  assert.deepEqual(clear.lastConfirmedReport, blocked.lastConfirmedReport);
  assert.equal(clear.lastConfirmedReport.id, "vehicle-55");
  assert.equal(clear.connectivity, "signal_lost");
  assert.deepEqual(clearSource.snapshot(63, scenario), clear);
  assert.deepEqual(blockedSource.snapshot(63, scenario), blocked);
  clearSource.snapshot(20, scenario);
  blockedSource.snapshot(20, scenario);
  assert.deepEqual(clearSource.snapshot(63, scenario), clear);
  assert.deepEqual(blockedSource.snapshot(63, scenario), blocked);
});
