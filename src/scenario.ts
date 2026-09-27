import type {
  Coordinates,
  Incident,
  IncidentDataSource,
  InferredConnection,
  LocationReport,
  Outage,
  ResponseUnitReport,
  ResponseUnitState,
  ScenarioSnapshot,
} from "./model";
export const DURATION = 180;
export const REPORT_INTERVAL = 5;
export const PLANNED_OUTAGE: Outage = { start: 60, end: 90 };
export const INITIAL_UNITS = [
  { id: "unit-1", name: "Unit 01", offset: 0.12, direction: 1 },
  { id: "unit-2", name: "Unit 02", offset: 0.72, direction: -1 },
  { id: "unit-3", name: "Unit 03", offset: 0.92, direction: -1 },
] as const;
export const INCIDENT: Incident = {
  id: "INC-0042",
  title: "Vehicle recovery",
  vehicleLabel: "White SUV · DEMO 042 GP",
  area: "Sandton, Johannesburg",
  openedAt: "2026-09-26T12:32:00.000Z",
  source: "simulator",
};
export interface Route {
  points: Coordinates[];
  cumulative: number[];
  length: number;
}
export function distance(a: Coordinates, b: Coordinates): number {
  const r = Math.PI / 180,
    dy = (b[1] - a[1]) * r,
    dx = (b[0] - a[0]) * r;
  const h =
    Math.sin(dy / 2) ** 2 +
    Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dx / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
export function makeRoute(
  coordinates: Coordinates[],
  maxDistance = 2400,
): Route {
  if (coordinates.length < 2)
    throw new Error("Route needs at least two coordinates");
  const points: Coordinates[] = [coordinates[0]],
    cumulative = [0];
  for (let i = 1; i < coordinates.length; i++) {
    const previous = points.at(-1)!,
      d = distance(previous, coordinates[i]),
      total = cumulative.at(-1)!;
    if (d < 0.01) continue;
    if (total + d > maxDistance) {
      const f = (maxDistance - total) / d;
      points.push([
        previous[0] + (coordinates[i][0] - previous[0]) * f,
        previous[1] + (coordinates[i][1] - previous[1]) * f,
      ]);
      cumulative.push(maxDistance);
      break;
    }
    points.push(coordinates[i]);
    cumulative.push(total + d);
  }
  return { points, cumulative, length: cumulative.at(-1)! };
}
export function pointAt(route: Route, fraction: number): Coordinates {
  const metres = Math.max(0, Math.min(1, fraction)) * route.length;
  let i = 1;
  while (i < route.cumulative.length - 1 && route.cumulative[i] < metres) i++;
  const f =
    (metres - route.cumulative[i - 1]) /
    (route.cumulative[i] - route.cumulative[i - 1]);
  return [
    route.points[i - 1][0] + (route.points[i][0] - route.points[i - 1][0]) * f,
    route.points[i - 1][1] + (route.points[i][1] - route.points[i - 1][1]) * f,
  ];
}
export function headingAt(route: Route, fraction: number): number {
  const a = pointAt(route, Math.max(0, fraction - 0.0001)),
    b = pointAt(route, Math.min(1, fraction + 0.0001)),
    r = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * r) * Math.cos(b[1] * r);
  const x =
    Math.cos(a[1] * r) * Math.sin(b[1] * r) -
    Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[0] - a[0]) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
export function signalLostAt(time: number, outages: Outage[] = []): boolean {
  return [PLANNED_OUTAGE, ...outages].some(
    (o) => time >= o.start && time < o.end,
  );
}
export function reportTimesThrough(
  time: number,
  outages: Outage[] = [],
): number[] {
  const times: number[] = [];
  for (
    let t = 0;
    t <=
    Math.floor(Math.min(DURATION, time) / REPORT_INTERVAL) * REPORT_INTERVAL;
    t += REPORT_INTERVAL
  ) {
    if (
      t === 0 ||
      !signalLostAt(t, outages) ||
      outages.some((o) => o.start === t && !(t >= 60 && t < 90))
    )
      times.push(t);
  }
  return times;
}
export function displayTimestamp(second: number): string {
  return new Date(Date.parse(INCIDENT.openedAt) + second * 1000).toISOString();
}
export function deviceReport(route: Route, second: number): LocationReport {
  return {
    id: `vehicle-${second}`,
    incidentId: INCIDENT.id,
    deviceTimestamp: displayTimestamp(second),
    serverReceiptTimestamp: displayTimestamp(second),
    coordinates: pointAt(route, second / DURATION),
    accuracyMetres: 15,
    headingDegrees: headingAt(route, second / DURATION),
    speedKmh: Math.round((route.length / DURATION) * 3.6),
    connectivity: "connected",
    kind: "confirmed_device_report",
  };
}
export function routeBetweenReports(
  route: Route,
  fromSecond: number,
  toSecond: number,
): Coordinates[] {
  const startMetres = (fromSecond / DURATION) * route.length;
  const endMetres = (toSecond / DURATION) * route.length;
  return [
    pointAt(route, fromSecond / DURATION),
    ...route.points.filter(
      (_, index) =>
        route.cumulative[index] > startMetres + 0.001 &&
        route.cumulative[index] < endMetres - 0.001,
    ),
    pointAt(route, toSecond / DURATION),
  ];
}
export function inferredConnections(
  route: Route,
  reportSeconds: number[],
): InferredConnection[] {
  const connections: InferredConnection[] = [];
  for (let index = 1; index < reportSeconds.length; index++) {
    const fromSecond = reportSeconds[index - 1];
    const toSecond = reportSeconds[index];
    if (toSecond - fromSecond !== REPORT_INTERVAL) continue;
    connections.push({
      kind: "inferred_route_between_reports",
      fromReportId: `vehicle-${fromSecond}`,
      toReportId: `vehicle-${toSecond}`,
      coordinates: routeBetweenReports(route, fromSecond, toSecond),
    });
  }
  return connections;
}
export class SimulatedIncidentSource implements IncidentDataSource {
  readonly incident = INCIDENT;
  constructor(
    private readonly route: Route,
    private readonly unavailableUnitIds: ReadonlySet<string> = new Set(),
  ) {}
  snapshot(second: number, manualOutages: Outage[] = []): ScenarioSnapshot {
    const displaySecond = Math.max(0, Math.min(DURATION, second));
    const reportSeconds = reportTimesThrough(displaySecond, manualOutages);
    const confirmedReports = reportSeconds.map((time) =>
      deviceReport(this.route, time),
    );
    const reportSecond = reportSeconds.at(-1)!;
    const lastConfirmedReport = confirmedReports.at(-1)!;
    const unitSecond =
      Math.floor(displaySecond / REPORT_INTERVAL) * REPORT_INTERVAL;
    const units: ResponseUnitState[] = INITIAL_UNITS.map((u) => {
      const unitFraction = Math.max(
        0.02,
        Math.min(0.98, u.offset + u.direction * (unitSecond / DURATION) * 0.13),
      );
      const currentReport: ResponseUnitReport = {
        ...deviceReport(this.route, unitSecond),
        id: `${u.id}-${unitSecond}`,
        unitId: u.id,
        unitName: u.name,
        coordinates: pointAt(this.route, unitFraction),
        accuracyMetres: 12,
        headingDegrees:
          (headingAt(this.route, unitFraction) + (u.direction < 0 ? 180 : 0)) %
          360,
        speedKmh: Math.round((this.route.length * 0.13 * 3.6) / DURATION),
      };
      return {
        unitId: u.id,
        unitName: u.name,
        currentReport: this.unavailableUnitIds.has(u.id) ? null : currentReport,
      };
    });
    return {
      displaySecond,
      displayTimestamp: displayTimestamp(displaySecond),
      reportAgeSeconds: Math.floor(displaySecond - reportSecond),
      connectivity: signalLostAt(displaySecond, manualOutages)
        ? "signal_lost"
        : "connected",
      lastConfirmedReport,
      units,
      confirmedReports,
      inferredConnections: inferredConnections(this.route, reportSeconds),
    };
  }
}
export function elapsed(time: number): string {
  return `${String(Math.floor(time / 60)).padStart(2, "0")}:${String(Math.floor(time) % 60).padStart(2, "0")}`;
}
export function clock(time: number): string {
  return new Date(displayTimestamp(time)).toLocaleTimeString("en-GB", {
    timeZone: "Africa/Johannesburg",
    hour12: false,
  });
}
