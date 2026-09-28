import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";

const mode = process.argv[2];
if (mode !== "baseline" && mode !== "compare")
  throw new Error("Use baseline before the movement change, then compare");
const source = readFileSync("src/coordination.ts", "utf8");
const anchor = "vehicle.edge = ranked[0]?.edge ?? null;";
if (source.split(anchor).length !== 2)
  throw new Error("Vehicle branch trace anchor changed");
const instrumented = source.replace(
  anchor,
  `${anchor}
  (globalThis as any).__movementTrace?.({ second: t, edgeId: vehicle.edge?.id ?? null });`,
);
const compiled = await build({
  stdin: {
    contents: 'export * from "./src/coordination.ts";',
    resolveDir: process.cwd(),
    sourcefile: "movement-entry.ts",
  },
  plugins: [
    {
      name: "offline-movement-trace",
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
const expectedVersion =
  mode === "baseline"
    ? "coordination-simulator-v3"
    : "coordination-simulator-v4";
if (engine.COORDINATION_SIMULATOR_VERSION !== expectedVersion)
  throw new Error(`Expected ${expectedVersion}`);
const graph = new engine.CoordinationGraph(
  JSON.parse(readFileSync("public/coordination-graph.json", "utf8")),
);
const sourceEngine = new engine.CoordinatedIncidentSource(graph);
const seeds = [...Array.from({ length: 16 }, (_, index) => index + 1), 27, 42];
const orders = {
  no_order: [],
  post_sandown: [
    {
      id: "post-sandown",
      second: 0,
      unitId: "unit-2",
      kind: "assign",
      objectiveId: "junction-7",
    },
  ],
  post_norwich: [
    {
      id: "post-norwich",
      second: 0,
      unitId: "unit-3",
      kind: "assign",
      objectiveId: "junction-3",
    },
  ],
  retask: [
    {
      id: "post-sandown",
      second: 0,
      unitId: "unit-2",
      kind: "assign",
      objectiveId: "junction-7",
    },
    {
      id: "retask-grayston",
      second: 60,
      unitId: "unit-2",
      kind: "retask",
      objectiveId: "junction-4",
    },
  ],
};
const cases = [];
for (const seed of seeds)
  for (const [policy, actions] of Object.entries(orders)) {
    const branches = [];
    globalThis.__movementTrace = (event) => branches.push(event);
    const snapshot = sourceEngine.snapshot(180, {
      id: `${seed}-${policy}`,
      name: policy,
      seed,
      actions,
      outages: [],
    });
    cases.push({
      seed,
      policy,
      branches,
      arrivals: snapshot.coordinationEvents
        .filter((event) => event.kind === "unit_status")
        .map((event) => ({ second: event.scenarioSecond, text: event.text })),
      postedObservations: snapshot.observations.map((event) => ({
        unitId: event.unitId,
        junctionId: event.junction.id,
        observedSecond: event.observedSecond,
        availableSecond: event.availableSecond,
      })),
      mobileObservations: (snapshot.mobileObservations ?? []).map((event) => ({
        unitId: event.unitId,
        encounterType: event.encounterType,
        roadName: event.roadName,
        observedSecond: event.observedSecond,
        availableSecond: event.availableSecond,
      })),
      confirmedPositions: snapshot.confirmedReports.map((report) => ({
        second: Number(report.id.slice("vehicle-".length)),
        coordinates: report.coordinates,
      })),
    });
  }
delete globalThis.__movementTrace;
const output = {
  simulatorVersion: engine.COORDINATION_SIMULATOR_VERSION,
  purpose:
    "Paired ordinary seeded simulator movement diagnostic, not model evaluation",
  seeds,
  policies: Object.keys(orders),
  cases,
};
const path =
  mode === "baseline"
    ? "reports/movement-v3-baseline.json"
    : "reports/movement-v4-results.json";
writeFileSync(path, JSON.stringify(output, null, 2) + "\n");
console.log(`Wrote ${cases.length} cases to ${path}`);
