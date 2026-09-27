import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { build } from "esbuild";
const compiled = await build({
  entryPoints: ["src/scenario.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const scenario = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
const route = scenario.makeRoute(
  JSON.parse(readFileSync("public/route.json", "utf8")).coordinates,
);
const source = new scenario.SimulatedIncidentSource(route);
test("route geometry and replay reports are valid", () => {
  assert.equal(route.length, 2400);
  for (let t = 0; t <= 180; t++) {
    const s = source.snapshot(t);
    assert(s.lastConfirmedReport.coordinates.every(Number.isFinite));
    assert(
      s.units.every((u) => u.currentReport?.coordinates.every(Number.isFinite)),
    );
    assert(
      Date.parse(s.lastConfirmedReport.deviceTimestamp) <=
        Date.parse(s.displayTimestamp),
    );
    assert.equal(s.lastConfirmedReport.kind, "confirmed_device_report");
  }
  assert.equal(scenario.clock(180), "14:35:00");
});
test("each unit report follows its own simulated direction", () => {
  for (const second of [0, 45, 120, 180]) {
    const snapshot = source.snapshot(second);
    for (const definition of scenario.INITIAL_UNITS) {
      const report = snapshot.units.find(
        (unit) => unit.unitId === definition.id,
      )?.currentReport;
      assert(report);
      const fraction = Math.max(
        0.02,
        Math.min(
          0.98,
          definition.offset +
            definition.direction * (second / scenario.DURATION) * 0.13,
        ),
      );
      const expected =
        (scenario.headingAt(route, fraction) +
          (definition.direction < 0 ? 180 : 0)) %
        360;
      const difference = Math.abs(
        ((report.headingDegrees - expected + 540) % 360) - 180,
      );
      assert(difference < 0.001);
      assert.equal(report.speedKmh, 6);
      assert.deepEqual(report.coordinates, scenario.pointAt(route, fraction));
    }
  }
});
test("scheduled outage retains last confirmed coordinates and ages report", () => {
  const before = source.snapshot(59),
    lost = source.snapshot(89),
    resumed = source.snapshot(90);
  assert.deepEqual(
    lost.lastConfirmedReport.coordinates,
    before.lastConfirmedReport.coordinates,
  );
  assert.equal(
    lost.lastConfirmedReport.deviceTimestamp,
    scenario.displayTimestamp(55),
  );
  assert.equal(lost.reportAgeSeconds, 34);
  assert.equal(lost.connectivity, "signal_lost");
  assert.equal(resumed.connectivity, "connected");
  assert.equal(resumed.reportAgeSeconds, 0);
  assert.notDeepEqual(
    resumed.lastConfirmedReport.coordinates,
    lost.lastConfirmedReport.coordinates,
  );
});
test("road turns use inferred route vertices, never invented device reports", () => {
  for (const [fromSecond, toSecond, routePointIndex] of [
    [0, 5, 2],
    [20, 25, 10],
    [175, 180, 85],
  ]) {
    const snapshot = source.snapshot(toSecond);
    const connection = snapshot.inferredConnections.find(
      (candidate) =>
        candidate.fromReportId === `vehicle-${fromSecond}` &&
        candidate.toReportId === `vehicle-${toSecond}`,
    );
    assert(connection, `Missing inferred path for ${fromSecond}–${toSecond}`);
    assert.equal(connection.kind, "inferred_route_between_reports");
    assert.deepEqual(
      connection.coordinates[0],
      scenario.pointAt(route, fromSecond / 180),
    );
    assert.deepEqual(
      connection.coordinates.at(-1),
      scenario.pointAt(route, toSecond / 180),
    );
    assert(
      connection.coordinates.some(
        (coordinates) =>
          JSON.stringify(coordinates) ===
          JSON.stringify(route.points[routePointIndex]),
      ),
      "The inferred path should follow the road through the turn",
    );
    assert.equal(
      snapshot.confirmedReports.some(
        (report) =>
          JSON.stringify(report.coordinates) ===
          JSON.stringify(route.points[routePointIndex]),
      ),
      false,
      "A route vertex must not become a confirmed device report",
    );
  }
});
test("missing reports leave points and inferred paths separated", () => {
  const snapshot = source.snapshot(120);
  assert.deepEqual(
    snapshot.confirmedReports
      .map((report) => report.id)
      .filter((id) =>
        ["vehicle-55", "vehicle-60", "vehicle-85", "vehicle-90"].includes(id),
      ),
    ["vehicle-55", "vehicle-90"],
  );
  assert.equal(snapshot.inferredConnections.length, 17);
  assert.equal(
    snapshot.inferredConnections.some(
      (connection) =>
        connection.fromReportId === "vehicle-55" &&
        connection.toReportId === "vehicle-90",
    ),
    false,
  );
  assert(
    snapshot.inferredConnections.every(
      (connection) =>
        Number(connection.toReportId.split("-")[1]) -
          Number(connection.fromReportId.split("-")[1]) ===
        5,
    ),
  );
});
test("manual loss retains existing report and resumes at next report tick", () => {
  const outages = [{ start: 30, end: 45 }];
  assert.equal(
    source.snapshot(44, outages).lastConfirmedReport.deviceTimestamp,
    scenario.displayTimestamp(30),
  );
  assert.equal(source.snapshot(44, outages).reportAgeSeconds, 14);
  assert.equal(
    source.snapshot(45, outages).lastConfirmedReport.deviceTimestamp,
    scenario.displayTimestamp(45),
  );
  const resumed = source.snapshot(45, outages);
  assert(resumed.confirmedReports.some((report) => report.id === "vehicle-45"));
  assert.equal(
    resumed.inferredConnections.some(
      (connection) => connection.toReportId === "vehicle-45",
    ),
    false,
  );
  assert.equal(
    source.snapshot(50, outages).inferredConnections.at(-1).toReportId,
    "vehicle-50",
  );
});
test("scrubbing rebuilds only connections supported at display time", () => {
  const advanced = source.snapshot(180);
  const rewound = source.snapshot(2);
  const replayed = source.snapshot(180);
  assert.equal(rewound.confirmedReports.length, 1);
  assert.equal(rewound.inferredConnections.length, 0);
  assert.deepEqual(replayed.inferredConnections, advanced.inferredConnections);
});
test("missing unit report is explicit and does not retain prior coordinates", () => {
  const missingSource = new scenario.SimulatedIncidentSource(
    route,
    new Set(["unit-2"]),
  );
  for (const t of [0, 45, 90]) {
    const unit = missingSource
      .snapshot(t)
      .units.find((candidate) => candidate.unitId === "unit-2");
    assert.equal(unit.currentReport, null);
  }
});
