import type {
  ActivityEvent,
  Coordinates,
  InferredConnection,
  LocationReport,
  Outage,
  ResponseUnitReport,
  ResponseUnitState,
  ScenarioSnapshot,
} from "./model";
import {
  displayTimestamp,
  DURATION,
  INCIDENT,
  INITIAL_UNITS,
  REPORT_INTERVAL,
  signalLostAt,
  distance,
} from "./scenario";

export type Objective = {
  id: string;
  name: string;
  nodeId: string;
  coordinates: Coordinates;
  visibleApproachEdgeIds?: string[];
};
export type Order = {
  id: string;
  second: number;
  unitId: string;
  kind: "assign" | "retask" | "release";
  objectiveId?: string;
};
export type ScenarioRun = {
  id: string;
  name: string;
  seed: number;
  trafficSeed?: number;
  trafficPattern?: 0 | 1 | 2 | 3;
  actions: Order[];
  outages: Outage[];
  parentId?: string;
  branchSecond?: number;
};
export type TrafficSegment = {
  id: string;
  from: Coordinates;
  to: Coordinates;
  level: 0 | 1 | 2;
};
export type PlannedRoute = {
  unitId: string;
  objective: Objective;
  coordinates: Coordinates[];
  etaSeconds: number | null;
};
export type UnitObservation = {
  id: string;
  unitId: string;
  unitName: string;
  junction: Objective;
  approachName: string;
  observedSecond: number;
  availableSecond: number;
  directionDegrees: number;
};
export interface CoordinationSnapshot extends ScenarioSnapshot {
  objectives: Objective[];
  assignedUnitIds: string[];
  unitObjectives: Record<string, Objective>;
  unitStatuses: Record<
    string,
    "patrol" | "awaiting_objective" | "en_route" | "on_post"
  >;
  plannedRoutes: PlannedRoute[];
  trafficSegments: TrafficSegment[];
  observations: UnitObservation[];
  coordinationEvents: ActivityEvent[];
}

type GraphFile = {
  nodes: [string, number, number][];
  edges: [string, string, string, number][];
  junctions: {
    id: string;
    nodeId: string;
    name: string;
    visibleApproachEdgeIds: string[];
  }[];
};
type Edge = {
  id: string;
  from: string;
  to: string;
  name: string;
  speedKmh: number;
  length: number;
  physicalId: string;
};
type Motion = {
  nodeId: string;
  edge: Edge | null;
  progress: number;
  speedKmh: number;
  headingDegrees: number;
};
type UnitMotion = Motion & {
  id: string;
  name: string;
  assigned: boolean;
  objective: Objective | null;
  route: string[];
  arrivedAt: number | null;
  patrolIndex: number;
};

const hash = (value: string, seed: number) => {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < value.length; i++)
    h = Math.imul(h ^ value.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
};
const heading = (a: Coordinates, b: Coordinates) =>
  ((Math.atan2((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]) *
    180) /
    Math.PI +
    360) %
  360;
const interpolate = (
  a: Coordinates,
  b: Coordinates,
  fraction: number,
): Coordinates => [
  a[0] + (b[0] - a[0]) * fraction,
  a[1] + (b[1] - a[1]) * fraction,
];

export class CoordinationGraph {
  readonly nodes = new Map<string, Coordinates>();
  readonly edges: Edge[] = [];
  readonly outgoing = new Map<string, Edge[]>();
  readonly objectives: Objective[];
  constructor(file: GraphFile) {
    for (const [id, lon, lat] of file.nodes) this.nodes.set(id, [lon, lat]);
    for (const [from, to, name, speedKmh] of file.edges) {
      const a = this.nodes.get(from),
        b = this.nodes.get(to);
      if (!a || !b) continue;
      const edge: Edge = {
        id: `${from}:${to}`,
        physicalId: [from, to].sort().join(":"),
        from,
        to,
        name,
        speedKmh,
        length: distance(a, b),
      };
      if (edge.length < 0.1) continue;
      this.edges.push(edge);
      const outgoing = this.outgoing.get(from) ?? [];
      outgoing.push(edge);
      this.outgoing.set(from, outgoing);
    }
    this.objectives = file.junctions.flatMap((junction) => {
      const coordinates = this.nodes.get(junction.nodeId);
      return coordinates ? [{ ...junction, coordinates }] : [];
    });
  }
  nearestNode(point: Coordinates): string {
    let best = "",
      bestDistance = Infinity;
    for (const [id, coordinates] of this.nodes) {
      const d = distance(point, coordinates);
      if (d < bestDistance) {
        best = id;
        bestDistance = d;
      }
    }
    return best;
  }
  route(
    from: string,
    to: string,
    second: number,
    seed: number,
    pattern: 0 | 1 | 2 | 3 = 0,
  ): string[] {
    if (from === to) return [from];
    const costs = new Map<string, number>([[from, 0]]);
    const previous = new Map<string, string>();
    const queue: [number, string][] = [[0, from]];
    while (queue.length) {
      queue.sort((a, b) => b[0] - a[0]);
      const [cost, node] = queue.pop()!;
      if (cost !== costs.get(node)) continue;
      if (node === to) break;
      for (const edge of this.outgoing.get(node) ?? []) {
        const next =
          cost +
          edge.length /
            Math.max(
              2,
              (edge.speedKmh / 3.6) *
                trafficFactor(edge.physicalId, second, seed, pattern),
            );
        if (next >= (costs.get(edge.to) ?? Infinity)) continue;
        costs.set(edge.to, next);
        previous.set(edge.to, node);
        queue.push([next, edge.to]);
      }
    }
    if (!previous.has(to)) return [];
    const path = [to];
    while (path[0] !== from) path.unshift(previous.get(path[0])!);
    return path;
  }
  edge(from: string, to: string): Edge | undefined {
    return this.outgoing.get(from)?.find((edge) => edge.to === to);
  }
}

// Both directions of one physical street segment share the same changing traffic.
export function trafficLevel(
  physicalId: string,
  second: number,
  seed: number,
  pattern: 0 | 1 | 2 | 3 = 0,
): 0 | 1 | 2 {
  const slot = Math.floor(Math.max(0, second) / 15);
  let level = (hash(`${physicalId}:initial`, seed) % 3) as 0 | 1 | 2;
  for (let i = 1; i <= slot; i++) {
    const change = (hash(`${physicalId}:${i}`, seed) % 3) - 1;
    level = Math.max(0, Math.min(2, level + change)) as 0 | 1 | 2;
  }
  if (pattern === 1) return Math.min(2, level + 1) as 0 | 1 | 2;
  if (pattern === 2) return ((level + (slot % 2)) % 3) as 0 | 1 | 2;
  if (pattern === 3)
    return ((level + (hash(`${physicalId}:wave:${slot}`, seed) % 2)) % 3) as
      0 | 1 | 2;
  return level;
}
export const trafficFactor = (
  physicalId: string,
  second: number,
  seed: number,
  pattern: 0 | 1 | 2 | 3 = 0,
) => [1, 0.75, 0.5][trafficLevel(physicalId, second, seed, pattern)];

const position = (motion: Motion, graph: CoordinationGraph): Coordinates => {
  if (!motion.edge) return graph.nodes.get(motion.nodeId)!;
  return interpolate(
    graph.nodes.get(motion.edge.from)!,
    graph.nodes.get(motion.edge.to)!,
    motion.progress,
  );
};
const move = (
  motion: Motion,
  edge: Edge,
  graph: CoordinationGraph,
  second: number,
  seed: number,
  pattern: 0 | 1 | 2 | 3 = 0,
): boolean => {
  motion.edge = edge;
  motion.headingDegrees = heading(
    graph.nodes.get(edge.from)!,
    graph.nodes.get(edge.to)!,
  );
  motion.speedKmh =
    edge.speedKmh * trafficFactor(edge.physicalId, second, seed, pattern);
  motion.progress += motion.speedKmh / 3.6 / edge.length;
  if (motion.progress < 1) return false;
  motion.nodeId = edge.to;
  motion.edge = null;
  motion.progress = 0;
  return true;
};
const report = (
  id: string,
  coordinates: Coordinates,
  second: number,
  speedKmh: number,
  headingDegrees: number,
): LocationReport => ({
  id,
  incidentId: INCIDENT.id,
  deviceTimestamp: displayTimestamp(second),
  serverReceiptTimestamp: displayTimestamp(second),
  coordinates,
  accuracyMetres: 15,
  headingDegrees,
  speedKmh: Math.round(speedKmh),
  connectivity: "connected",
  kind: "confirmed_device_report",
});

export class CoordinatedIncidentSource {
  readonly incident = INCIDENT;
  constructor(
    readonly graph: CoordinationGraph,
    private readonly unavailableUnitIds: ReadonlySet<string> = new Set(),
  ) {}

  snapshot(
    second: number,
    run: ScenarioRun,
    outages: Outage[] = run.outages ?? [],
  ): CoordinationSnapshot {
    const displaySecond = Math.max(0, Math.min(DURATION, Math.floor(second)));
    const seed = run.seed;
    const trafficSeed = run.trafficSeed ?? seed;
    const trafficPattern = run.trafficPattern ?? 0;
    const vehicle: Motion = {
      nodeId: this.graph.nearestNode([28.049203, -26.105078]),
      edge: null,
      progress: 0,
      speedKmh: 0,
      headingDegrees: 0,
    };
    const unitStarts: Coordinates[] = [
      [28.0467, -26.10415],
      [28.05135, -26.10365],
      [28.04625, -26.1053],
    ];
    const units: UnitMotion[] = INITIAL_UNITS.map((definition, index) => ({
      id: definition.id,
      name: definition.name,
      nodeId: this.graph.nearestNode(unitStarts[index]),
      edge: null,
      progress: 0,
      speedKmh: 0,
      headingDegrees: 0,
      assigned: index === 0,
      objective: null,
      route: [],
      arrivedAt: null,
      patrolIndex: index,
    }));
    const confirmedReports: LocationReport[] = [];
    const inferredConnections: InferredConnection[] = [];
    const observations: UnitObservation[] = [];
    const arrivals: ActivityEvent[] = [];
    const seen = new Set<string>();
    let vehicleEdgeSequence = 0;
    let lastReportSecond = -1;
    let sinceReport: Coordinates[] = [];
    let latestUnitReports: ResponseUnitState[] = [];
    let incomingVehicleEdge: Edge | null = null;
    for (let t = 0; t <= displaySecond; t++) {
      for (const order of run.actions.filter((action) => action.second === t)) {
        const unit = units.find((candidate) => candidate.id === order.unitId);
        if (!unit) continue;
        if (order.kind === "release") {
          unit.assigned = false;
          unit.objective = null;
          unit.route = [];
          unit.arrivedAt = null;
        } else {
          const objective =
            order.objectiveId === "last-confirmed"
              ? {
                  id: "last-confirmed",
                  name: "Last confirmed vehicle position",
                  nodeId: this.graph.nearestNode(
                    confirmedReports.at(-1)?.coordinates ??
                      position(vehicle, this.graph),
                  ),
                  coordinates:
                    confirmedReports.at(-1)?.coordinates ??
                    position(vehicle, this.graph),
                }
              : this.graph.objectives.find(
                  (candidate) => candidate.id === order.objectiveId,
                );
          if (!objective) continue;
          unit.assigned = true;
          unit.objective = objective;
          unit.route = [];
          unit.arrivedAt = null;
        }
      }
      if (t > 0) {
        for (const unit of units) {
          if (!unit.edge) {
            if (unit.objective && unit.nodeId === unit.objective.nodeId) {
              unit.speedKmh = 0;
              if (unit.arrivedAt === null) {
                unit.arrivedAt = t;
                arrivals.push({
                  id: `arrival-${unit.id}-${t}`,
                  incidentId: INCIDENT.id,
                  kind: "unit_status",
                  scenarioSecond: t,
                  displayTimestamp: displayTimestamp(t),
                  text: `${unit.name} reached ${unit.objective.name} (simulated).`,
                });
              }
            } else {
              if (unit.objective && (!unit.route.length || t % 15 === 0)) {
                unit.route = this.graph.route(
                  unit.nodeId,
                  unit.objective.nodeId,
                  t,
                  trafficSeed,
                  trafficPattern,
                );
              }
              let next: Edge | undefined;
              if (unit.objective)
                next = this.graph.edge(unit.nodeId, unit.route[1]);
              else {
                const options = this.graph.outgoing.get(unit.nodeId) ?? [];
                next =
                  options[
                    hash(
                      `${unit.id}:patrol:${unit.nodeId}:${unit.patrolIndex++}`,
                      seed,
                    ) % options.length
                  ];
              }
              if (next) unit.edge = next;
              else unit.speedKmh = 0;
            }
          }
          if (
            unit.edge &&
            move(unit, unit.edge, this.graph, t, trafficSeed, trafficPattern)
          ) {
            if (unit.route[0] !== unit.nodeId) unit.route.shift();
            if (unit.objective?.nodeId === unit.nodeId) {
              unit.arrivedAt = t;
              arrivals.push({
                id: `arrival-${unit.id}-${t}`,
                incidentId: INCIDENT.id,
                kind: "unit_status",
                scenarioSecond: t,
                displayTimestamp: displayTimestamp(t),
                text: `${unit.name} reached ${unit.objective.name} (simulated).`,
              });
            }
          }
        }
        if (!vehicle.edge) {
          const options = (
            this.graph.outgoing.get(vehicle.nodeId) ?? []
          ).filter((edge) => edge.to !== incomingVehicleEdge?.from);
          const choices = options.length
            ? options
            : (this.graph.outgoing.get(vehicle.nodeId) ?? []);
          const localUnits = units.filter(
            (unit) =>
              distance(
                position(unit, this.graph),
                position(vehicle, this.graph),
              ) <= 120,
          );
          const ranked = choices
            .map((edge) => {
              const traffic = trafficFactor(
                edge.physicalId,
                t,
                trafficSeed,
                trafficPattern,
              );
              const destination = this.graph.nodes.get(edge.to)!;
              const proximity = localUnits.reduce(
                (sum, unit) =>
                  sum +
                  Math.max(
                    0,
                    120 - distance(position(unit, this.graph), destination),
                  ) /
                    120,
                0,
              );
              const variety =
                (hash(`visit:${edge.to}:${Math.floor(t / 20)}`, seed) % 17) /
                100;
              return { edge, score: traffic - proximity * 1.4 + variety };
            })
            .sort((a, b) => b.score - a.score);
          vehicle.edge = ranked[0]?.edge ?? null;
          if (vehicle.edge) vehicleEdgeSequence++;
        }
        if (vehicle.edge) {
          const current = vehicle.edge;
          if (
            move(vehicle, current, this.graph, t, trafficSeed, trafficPattern)
          ) {
            incomingVehicleEdge = current;
            sinceReport.push(this.graph.nodes.get(current.to)!);
          }
        }
      }
      // A unit must already be stationary at its ordered junction. The vehicle must
      // approach on a connected edge whose final segment is locally visible.
      if (vehicle.edge)
        for (const unit of units) {
          const objective = unit.objective;
          if (
            !objective ||
            unit.edge ||
            unit.nodeId !== objective.nodeId ||
            unit.arrivedAt === null ||
            t - unit.arrivedAt < 3
          )
            continue;
          if (
            vehicle.edge.to !== objective.nodeId ||
            !objective.visibleApproachEdgeIds?.includes(vehicle.edge.id)
          )
            continue;
          if (
            distance(position(vehicle, this.graph), objective.coordinates) > 75
          )
            continue;
          if (
            hash(`visibility:${objective.id}:${Math.floor(t / 15)}`, seed) %
              5 ===
            0
          )
            continue;
          const key = `${unit.id}:${vehicleEdgeSequence}`;
          if (seen.has(key)) continue;
          seen.add(key);
          observations.push({
            id: `observation-${key}-${t}`,
            unitId: unit.id,
            unitName: unit.name,
            junction: objective,
            approachName: vehicle.edge.name,
            observedSecond: t,
            availableSecond: t + 2,
            directionDegrees: vehicle.headingDegrees,
          });
        }
      if (t % REPORT_INTERVAL === 0) {
        if (!signalLostAt(t, outages) || t === 0) {
          const current = report(
            `vehicle-${t}`,
            position(vehicle, this.graph),
            t,
            vehicle.speedKmh,
            vehicle.headingDegrees,
          );
          const prior = confirmedReports.at(-1);
          if (prior && t - lastReportSecond === REPORT_INTERVAL)
            inferredConnections.push({
              kind: "inferred_route_between_reports",
              fromReportId: prior.id,
              toReportId: current.id,
              coordinates: [
                prior.coordinates,
                ...sinceReport,
                current.coordinates,
              ],
            });
          confirmedReports.push(current);
          lastReportSecond = t;
          sinceReport = [];
        }
        latestUnitReports = units.map((unit) => ({
          unitId: unit.id,
          unitName: unit.name,
          currentReport: this.unavailableUnitIds.has(unit.id)
            ? null
            : ({
                ...report(
                  `${unit.id}-${t}`,
                  position(unit, this.graph),
                  t,
                  unit.speedKmh,
                  unit.headingDegrees,
                ),
                unitId: unit.id,
                unitName: unit.name,
                accuracyMetres: 12,
              } as ResponseUnitReport),
        }));
      }
    }
    const lastConfirmedReport = confirmedReports.at(-1)!;
    const unitObjectives: Record<string, Objective> = {};
    const unitStatuses: CoordinationSnapshot["unitStatuses"] = {};
    const plannedRoutes: PlannedRoute[] = [];
    for (const unit of units)
      unitStatuses[unit.id] = unit.objective
        ? unit.arrivedAt === null
          ? "en_route"
          : "on_post"
        : unit.assigned
          ? "awaiting_objective"
          : "patrol";
    for (const unit of units)
      if (unit.objective) {
        unitObjectives[unit.id] = unit.objective;
        const start = unit.edge?.to ?? unit.nodeId;
        const path = this.graph.route(
          start,
          unit.objective.nodeId,
          displaySecond,
          trafficSeed,
          trafficPattern,
        );
        const confirmedStart = latestUnitReports.find(
          (report) => report.unitId === unit.id,
        )?.currentReport?.coordinates;
        const coordinates = [
          confirmedStart ?? position(unit, this.graph),
          ...path.map((id) => this.graph.nodes.get(id)!),
        ];
        let etaSeconds = 0;
        if (unit.edge)
          etaSeconds +=
            ((1 - unit.progress) * unit.edge.length) /
            Math.max(2, unit.speedKmh / 3.6);
        for (let i = 1; i < path.length; i++) {
          const edge = this.graph.edge(path[i - 1], path[i]);
          if (edge)
            etaSeconds +=
              edge.length /
              Math.max(
                2,
                (edge.speedKmh / 3.6) *
                  trafficFactor(
                    edge.physicalId,
                    displaySecond,
                    trafficSeed,
                    trafficPattern,
                  ),
              );
        }
        plannedRoutes.push({
          unitId: unit.id,
          objective: unit.objective,
          coordinates,
          etaSeconds: path.length ? Math.ceil(etaSeconds) : null,
        });
      }
    const trafficSegments: TrafficSegment[] = [];
    const dedup = new Set<string>();
    const focus = [
      lastConfirmedReport.coordinates,
      ...latestUnitReports.flatMap((unit) =>
        unit.currentReport ? [unit.currentReport.coordinates] : [],
      ),
    ];
    for (const edge of this.graph.edges) {
      if (dedup.has(edge.physicalId)) continue;
      dedup.add(edge.physicalId);
      const from = this.graph.nodes.get(edge.from)!,
        to = this.graph.nodes.get(edge.to)!;
      if (
        !focus.some(
          (point) => Math.min(distance(point, from), distance(point, to)) < 240,
        )
      )
        continue;
      trafficSegments.push({
        id: edge.physicalId,
        from,
        to,
        level: trafficLevel(
          edge.physicalId,
          displaySecond,
          trafficSeed,
          trafficPattern,
        ),
      });
    }
    return {
      displaySecond,
      displayTimestamp: displayTimestamp(displaySecond),
      reportAgeSeconds: displaySecond - lastReportSecond,
      connectivity: signalLostAt(displaySecond, outages)
        ? "signal_lost"
        : "connected",
      lastConfirmedReport,
      units: latestUnitReports,
      confirmedReports,
      inferredConnections,
      objectives: this.graph.objectives,
      assignedUnitIds: units
        .filter((unit) => unit.assigned)
        .map((unit) => unit.id),
      unitObjectives,
      unitStatuses,
      plannedRoutes,
      trafficSegments,
      observations: observations.filter(
        (observation) => observation.availableSecond <= displaySecond,
      ),
      coordinationEvents: [
        ...arrivals,
        ...observations
          .filter((observation) => observation.availableSecond <= displaySecond)
          .map((observation) => ({
            id: observation.id,
            incidentId: INCIDENT.id,
            kind: "unit_observation" as const,
            scenarioSecond: observation.availableSecond,
            displayTimestamp: displayTimestamp(observation.availableSecond),
            text: `${observation.unitName} simulated observation at ${observation.junction.name}: vehicle approached on ${observation.approachName}, heading about ${Math.round(observation.directionDegrees)}°. Observed ${observation.observedSecond}s into replay; available ${observation.availableSecond}s into replay. Approximate approach only.`,
          })),
      ],
    };
  }
}
