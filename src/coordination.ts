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
import {
  sightLineBlocked,
  sightLineDataset,
  type SightLineDataset,
  type SightLineFootprint,
} from "./sightLines";

export const COORDINATION_SIMULATOR_VERSION = "coordination-simulator-v4";

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
  planId?: string;
  planName?: string;
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
  sightLineAssessment: "no_mapped_blockage_visibility_uncertain";
};
export type MobileEncounterType = "oncoming" | "following";
export type MobileObservation = {
  id: string;
  unitId: string;
  unitName: string;
  encounterType: MobileEncounterType;
  roadName: string;
  observedSecond: number;
  availableSecond: number;
  sightLineAssessment: "no_mapped_blockage_visibility_uncertain";
};
export type MobileFixture =
  | "none"
  | "oncoming-clear"
  | "following-clear"
  | "oncoming-fleeting"
  | "oncoming-separating"
  | "following-behind";
export interface CoordinationSnapshot extends ScenarioSnapshot {
  simulatorVersion: typeof COORDINATION_SIMULATOR_VERSION;
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
  mobileObservations: MobileObservation[];
  mobileFixture: MobileFixture;
  sightLineFootprints: SightLineFootprint[];
  sightLineObserverPoints: Record<string, Coordinates>;
  sightLineFixture: SightLineDataset["fixture"];
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
type MotionSegment = {
  edge: Edge | null;
  nodeId: string;
  start: number;
  end: number;
  startProgress: number;
  endProgress: number;
  speedKmh: number;
  edgeSequence?: number;
};
type MotionSample = {
  edge: Edge | null;
  progress: number;
  coordinates: Coordinates;
  speedKmh: number;
  headingDegrees: number;
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
const MOTION_EPSILON = 1e-9;
const segmentPosition = (
  segment: MotionSegment,
  fraction: number,
  graph: CoordinationGraph,
): Coordinates => {
  if (!segment.edge) return graph.nodes.get(segment.nodeId)!;
  const along =
    segment.end <= segment.start
      ? segment.endProgress
      : segment.startProgress +
        ((Math.max(segment.start, Math.min(segment.end, fraction)) -
          segment.start) /
          (segment.end - segment.start)) *
          (segment.endProgress - segment.startProgress);
  return interpolate(
    graph.nodes.get(segment.edge.from)!,
    graph.nodes.get(segment.edge.to)!,
    along,
  );
};
const motionAt = (
  segments: MotionSegment[],
  fraction: number,
  graph: CoordinationGraph,
): MotionSample => {
  const segment =
    segments.find((item) => fraction < item.end - MOTION_EPSILON) ??
    segments.at(-1)!;
  const progress = segment.edge
    ? segment.startProgress +
      ((Math.max(segment.start, Math.min(segment.end, fraction)) -
        segment.start) /
        Math.max(MOTION_EPSILON, segment.end - segment.start)) *
        (segment.endProgress - segment.startProgress)
    : 0;
  return {
    edge: segment.edge,
    progress,
    coordinates: segmentPosition(segment, fraction, graph),
    speedKmh: segment.speedKmh,
    headingDegrees: segment.edge
      ? heading(
          graph.nodes.get(segment.edge.from)!,
          graph.nodes.get(segment.edge.to)!,
        )
      : 0,
  };
};

const headingDifference = (first: number, second: number) =>
  Math.abs(((first - second + 540) % 360) - 180);

// Distance from a moving follower to another point ahead on the same legal,
// nearly straight road corridor. This crosses connected short graph edges.
export const corridorDistanceAhead = (
  graph: CoordinationGraph,
  fromEdge: Edge,
  fromProgress: number,
  toEdge: Edge,
  toProgress: number,
  maximum: number,
): number | null => {
  if (fromEdge.name !== toEdge.name) return null;
  const firstHeading = heading(
    graph.nodes.get(fromEdge.from)!,
    graph.nodes.get(fromEdge.to)!,
  );
  const lastHeading = heading(
    graph.nodes.get(toEdge.from)!,
    graph.nodes.get(toEdge.to)!,
  );
  if (headingDifference(firstHeading, lastHeading) > 25) return null;
  if (fromEdge.id === toEdge.id) {
    const metres = (toProgress - fromProgress) * fromEdge.length;
    return metres > 0 && metres <= maximum ? metres : null;
  }
  const fixed =
    (1 - fromProgress) * fromEdge.length + toProgress * toEdge.length;
  if (fixed > maximum) return null;
  const queue: { nodeId: string; metres: number; priorHeading: number }[] = [
    { nodeId: fromEdge.to, metres: 0, priorHeading: firstHeading },
  ];
  const best = new Map<string, number>();
  while (queue.length) {
    queue.sort((a, b) => b.metres - a.metres);
    const current = queue.pop()!;
    if (current.nodeId === toEdge.from) return fixed + current.metres;
    if (current.metres >= (best.get(current.nodeId) ?? Infinity)) continue;
    best.set(current.nodeId, current.metres);
    for (const edge of graph.outgoing.get(current.nodeId) ?? []) {
      if (edge.name !== fromEdge.name || edge.id === fromEdge.id) continue;
      const nextHeading = heading(
        graph.nodes.get(edge.from)!,
        graph.nodes.get(edge.to)!,
      );
      if (
        headingDifference(current.priorHeading, nextHeading) > 25 ||
        headingDifference(firstHeading, nextHeading) > 25
      )
        continue;
      const metres = current.metres + edge.length;
      if (fixed + metres <= maximum)
        queue.push({ nodeId: edge.to, metres, priorHeading: nextHeading });
    }
  }
  return null;
};

const mobileEncounter = (
  graph: CoordinationGraph,
  unit: MotionSample,
  vehicle: MotionSample,
): MobileEncounterType | null => {
  if (
    !unit.edge ||
    !vehicle.edge ||
    unit.speedKmh < 5 ||
    vehicle.speedKmh < 5 ||
    distance(unit.coordinates, vehicle.coordinates) > 45
  )
    return null;
  const angle = headingDifference(unit.headingDegrees, vehicle.headingDegrees);
  if (angle <= 25) {
    const ahead = corridorDistanceAhead(
      graph,
      unit.edge,
      unit.progress,
      vehicle.edge,
      vehicle.progress,
      45,
    );
    return ahead !== null && ahead >= 8 ? "following" : null;
  }
  if (angle >= 155) {
    const reverseVehicleEdge = graph.edge(vehicle.edge.to, vehicle.edge.from);
    if (!reverseVehicleEdge) return null;
    const closingDistance = corridorDistanceAhead(
      graph,
      unit.edge,
      unit.progress,
      reverseVehicleEdge,
      1 - vehicle.progress,
      35,
    );
    return closingDistance !== null ? "oncoming" : null;
  }
  return null;
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
    private readonly sightLines: SightLineDataset = sightLineDataset(),
    private readonly mobileFixture: MobileFixture = "none",
  ) {}

  snapshot(
    second: number,
    run: ScenarioRun,
    outages: Outage[] = run.outages ?? [],
  ): CoordinationSnapshot {
    const effectiveOutages =
      this.mobileFixture === "none"
        ? outages
        : [...outages, { start: 1, end: 20 }];
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
    if (this.mobileFixture !== "none") {
      const forward = this.graph.edge("7602313049", "1671936783");
      const reverse = this.graph.edge("1671936783", "7602313049");
      if (!forward || !reverse)
        throw new Error("Mobile fixture requires bidirectional Park Lane");
      const unit = units.find((candidate) => candidate.id === "unit-2")!;
      const unitMetres =
        this.mobileFixture === "oncoming-fleeting"
          ? 55
          : this.mobileFixture === "oncoming-separating"
            ? 65
            : this.mobileFixture === "following-behind"
              ? 45
              : 25;
      const vehicleMetres =
        this.mobileFixture === "oncoming-fleeting"
          ? 67
          : this.mobileFixture === "oncoming-separating"
            ? 55
            : this.mobileFixture === "following-behind"
              ? 25
              : this.mobileFixture === "following-clear"
                ? 45
                : 95;
      unit.nodeId = forward.from;
      unit.edge = forward;
      unit.progress = unitMetres / forward.length;
      unit.speedKmh = forward.speedKmh;
      unit.headingDegrees = heading(
        this.graph.nodes.get(forward.from)!,
        this.graph.nodes.get(forward.to)!,
      );
      const vehicleEdge = this.mobileFixture.startsWith("oncoming")
        ? reverse
        : forward;
      vehicle.nodeId = vehicleEdge.from;
      vehicle.edge = vehicleEdge;
      vehicle.progress =
        vehicleEdge === reverse
          ? 1 - vehicleMetres / reverse.length
          : vehicleMetres / forward.length;
      vehicle.speedKmh = vehicleEdge.speedKmh;
      vehicle.headingDegrees = heading(
        this.graph.nodes.get(vehicleEdge.from)!,
        this.graph.nodes.get(vehicleEdge.to)!,
      );
    }
    const confirmedReports: LocationReport[] = [];
    const inferredConnections: InferredConnection[] = [];
    const observations: UnitObservation[] = [];
    const mobileObservations: MobileObservation[] = [];
    const mobileWindows = new Map<
      string,
      { mode: MobileEncounterType | null; duration: number; reported: boolean }
    >();
    const arrivals: ActivityEvent[] = [];
    const seen = new Set<string>();
    let vehicleEdgeSequence = this.mobileFixture === "none" ? 0 : 1;
    let lastReportSecond = -1;
    let sinceReport: Coordinates[] = [];
    let latestUnitReports: ResponseUnitState[] = [];
    let incomingVehicleEdge: Edge | null = null;
    for (let t = 0; t <= displaySecond; t++) {
      const unitSegments = new Map<string, MotionSegment[]>();
      const vehicleSegments: MotionSegment[] = [];
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
          const segments: MotionSegment[] = [];
          let elapsed = 0;
          let steps = 0;
          while (elapsed < 1 - MOTION_EPSILON) {
            if (++steps > 256)
              throw new Error("Unit movement exceeded 256 edges in one tick");
            if (!unit.edge) {
              if (unit.objective?.nodeId === unit.nodeId) {
                unit.speedKmh = 0;
                if (unit.arrivedAt === null) {
                  unit.arrivedAt = t - 1 + elapsed;
                  const eventSecond = Math.max(1, Math.ceil(unit.arrivedAt));
                  arrivals.push({
                    id: `arrival-${unit.id}-${eventSecond}`,
                    incidentId: INCIDENT.id,
                    kind: "unit_status",
                    scenarioSecond: eventSecond,
                    displayTimestamp: displayTimestamp(eventSecond),
                    text: `${unit.name} reached ${unit.objective.name} (simulated).`,
                  });
                }
              } else {
                if (unit.objective && (!unit.route.length || t % 15 === 0))
                  unit.route = this.graph.route(
                    unit.nodeId,
                    unit.objective.nodeId,
                    t,
                    trafficSeed,
                    trafficPattern,
                  );
                if (unit.objective)
                  unit.edge =
                    this.graph.edge(unit.nodeId, unit.route[1]) ?? null;
                else {
                  const options = this.graph.outgoing.get(unit.nodeId) ?? [];
                  unit.edge =
                    options[
                      hash(
                        `${unit.id}:patrol:${unit.nodeId}:${unit.patrolIndex++}`,
                        seed,
                      ) % options.length
                    ] ?? null;
                }
              }
            }
            if (!unit.edge) {
              segments.push({
                edge: null,
                nodeId: unit.nodeId,
                start: elapsed,
                end: 1,
                startProgress: 0,
                endProgress: 0,
                speedKmh: 0,
              });
              unit.speedKmh = 0;
              break;
            }
            const edge = unit.edge;
            const speedKmh =
              edge.speedKmh *
              trafficFactor(edge.physicalId, t, trafficSeed, trafficPattern);
            const metresPerSecond = speedKmh / 3.6;
            const travelTime = Math.min(
              1 - elapsed,
              ((1 - unit.progress) * edge.length) / metresPerSecond,
            );
            const endProgress = Math.min(
              1,
              unit.progress + (travelTime * metresPerSecond) / edge.length,
            );
            segments.push({
              edge,
              nodeId: unit.nodeId,
              start: elapsed,
              end: elapsed + travelTime,
              startProgress: unit.progress,
              endProgress,
              speedKmh,
            });
            elapsed += travelTime;
            unit.headingDegrees = heading(
              this.graph.nodes.get(edge.from)!,
              this.graph.nodes.get(edge.to)!,
            );
            unit.speedKmh = speedKmh;
            unit.progress = endProgress;
            if (endProgress >= 1 - MOTION_EPSILON) {
              unit.nodeId = edge.to;
              unit.edge = null;
              unit.progress = 0;
              if (unit.route[0] !== unit.nodeId) unit.route.shift();
              if (unit.objective?.nodeId === unit.nodeId) {
                unit.arrivedAt = t - 1 + elapsed;
                const eventSecond = Math.max(1, Math.ceil(unit.arrivedAt));
                arrivals.push({
                  id: `arrival-${unit.id}-${eventSecond}`,
                  incidentId: INCIDENT.id,
                  kind: "unit_status",
                  scenarioSecond: eventSecond,
                  displayTimestamp: displayTimestamp(eventSecond),
                  text: `${unit.name} reached ${unit.objective.name} (simulated).`,
                });
              }
            }
          }
          unitSegments.set(unit.id, segments);
        }
        let elapsed = 0;
        let steps = 0;
        while (elapsed < 1 - MOTION_EPSILON) {
          if (++steps > 256)
            throw new Error("Vehicle movement exceeded 256 edges in one tick");
          if (!vehicle.edge) {
            const options = (
              this.graph.outgoing.get(vehicle.nodeId) ?? []
            ).filter((edge) => edge.to !== incomingVehicleEdge?.from);
            const choices = options.length
              ? options
              : (this.graph.outgoing.get(vehicle.nodeId) ?? []);
            const vehiclePoint = position(vehicle, this.graph);
            const localUnits = units.filter(
              (unit) =>
                distance(
                  motionAt(unitSegments.get(unit.id)!, elapsed, this.graph)
                    .coordinates,
                  vehiclePoint,
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
                      120 -
                        distance(
                          motionAt(
                            unitSegments.get(unit.id)!,
                            elapsed,
                            this.graph,
                          ).coordinates,
                          destination,
                        ),
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
          if (!vehicle.edge) {
            vehicleSegments.push({
              edge: null,
              nodeId: vehicle.nodeId,
              start: elapsed,
              end: 1,
              startProgress: 0,
              endProgress: 0,
              speedKmh: 0,
            });
            vehicle.speedKmh = 0;
            break;
          }
          const edge = vehicle.edge;
          const speedKmh =
            edge.speedKmh *
            trafficFactor(edge.physicalId, t, trafficSeed, trafficPattern);
          const metresPerSecond = speedKmh / 3.6;
          const travelTime = Math.min(
            1 - elapsed,
            ((1 - vehicle.progress) * edge.length) / metresPerSecond,
          );
          const endProgress = Math.min(
            1,
            vehicle.progress + (travelTime * metresPerSecond) / edge.length,
          );
          vehicleSegments.push({
            edge,
            nodeId: vehicle.nodeId,
            start: elapsed,
            end: elapsed + travelTime,
            startProgress: vehicle.progress,
            endProgress,
            speedKmh,
            edgeSequence: vehicleEdgeSequence,
          });
          elapsed += travelTime;
          vehicle.headingDegrees = heading(
            this.graph.nodes.get(edge.from)!,
            this.graph.nodes.get(edge.to)!,
          );
          vehicle.speedKmh = speedKmh;
          vehicle.progress = endProgress;
          if (endProgress >= 1 - MOTION_EPSILON) {
            vehicle.nodeId = edge.to;
            vehicle.edge = null;
            vehicle.progress = 0;
            incomingVehicleEdge = edge;
            sinceReport.push(this.graph.nodes.get(edge.to)!);
          }
        }
      }
      // Keep every directed traversal, including multiple short edges in one tick.
      for (const traversal of vehicleSegments) {
        const vehicleApproachEdge = traversal.edge;
        if (!vehicleApproachEdge) continue;
        const crossingSecond = t - 1 + traversal.end;
        const observedSecond = Math.ceil(crossingSecond - MOTION_EPSILON);
        const vehiclePoint = segmentPosition(
          traversal,
          traversal.end,
          this.graph,
        );
        for (const unit of units) {
          const objective = unit.objective;
          const unitAtCrossing = motionAt(
            unitSegments.get(unit.id)!,
            traversal.end,
            this.graph,
          );
          if (
            !objective ||
            unitAtCrossing.edge ||
            unit.nodeId !== objective.nodeId ||
            unit.arrivedAt === null ||
            crossingSecond - unit.arrivedAt < 3
          )
            continue;
          if (
            vehicleApproachEdge.to !== objective.nodeId ||
            !objective.visibleApproachEdgeIds?.includes(vehicleApproachEdge.id)
          )
            continue;
          if (distance(vehiclePoint, objective.coordinates) > 75) continue;
          if (
            hash(
              `visibility:${objective.id}:${Math.floor(crossingSecond / 15)}`,
              seed,
            ) %
              5 ===
            0
          )
            continue;
          const observer =
            this.sightLines.observerPoints[objective.id] ??
            objective.coordinates;
          // This uses internal synthetic vehicle motion only to decide whether
          // the unit could observe it. Neither the ray nor hidden position is
          // included in the operator snapshot or activity feed.
          if (
            sightLineBlocked(observer, vehiclePoint, this.sightLines.footprints)
          )
            continue;
          const key = `${unit.id}:${traversal.edgeSequence}`;
          if (seen.has(key)) continue;
          seen.add(key);
          observations.push({
            id: `observation-${key}-${observedSecond}`,
            unitId: unit.id,
            unitName: unit.name,
            junction: objective,
            approachName: vehicleApproachEdge.name,
            observedSecond,
            availableSecond: observedSecond + 2,
            directionDegrees: heading(
              this.graph.nodes.get(vehicleApproachEdge.from)!,
              this.graph.nodes.get(vehicleApproachEdge.to)!,
            ),
            sightLineAssessment: "no_mapped_blockage_visibility_uncertain",
          });
        }
      }
      if (t > 0)
        for (let step = 0; step < 20; step++) {
          const fractions = [
            step / 20,
            (step + 0.5) / 20,
            (step + 1) / 20 - 1e-8,
          ];
          const worldSecond = t - 1 + (step + 0.5) / 20;
          for (const unit of units) {
            const unitPath = unitSegments.get(unit.id)!;
            const checked = fractions.map((fraction) => {
              const unitHere = motionAt(unitPath, fraction, this.graph);
              const vehicleHere = motionAt(
                vehicleSegments,
                fraction,
                this.graph,
              );
              const mode = mobileEncounter(this.graph, unitHere, vehicleHere);
              if (!mode || !unitHere.edge) return null;
              if (
                hash(
                  `mobile-visibility:${unit.id}:${unitHere.edge.name}:${Math.floor(worldSecond / 15)}`,
                  seed,
                ) %
                  5 ===
                  0 ||
                sightLineBlocked(
                  unitHere.coordinates,
                  vehicleHere.coordinates,
                  this.sightLines.footprints,
                )
              )
                return null;
              return mode;
            });
            const mode =
              checked[0] &&
              checked.every((candidate) => candidate === checked[0])
                ? checked[0]
                : null;
            const current = mobileWindows.get(unit.id) ?? {
              mode: null,
              duration: 0,
              reported: false,
            };
            if (!mode) {
              current.mode = null;
              current.duration = 0;
              current.reported = false;
            } else {
              if (current.mode !== mode) {
                current.mode = mode;
                current.duration = 0;
                current.reported = false;
              }
              current.duration += 0.05;
              const required = mode === "oncoming" ? 1.5 : 2;
              if (
                !current.reported &&
                current.duration + MOTION_EPSILON >= required
              ) {
                const observedSecond = Math.ceil(
                  t - 1 + (step + 1) / 20 - MOTION_EPSILON,
                );
                const unitAtEnd = motionAt(
                  unitPath,
                  (step + 0.5) / 20,
                  this.graph,
                );
                mobileObservations.push({
                  id: `mobile-observation-${unit.id}-${mode}-${observedSecond}`,
                  unitId: unit.id,
                  unitName: unit.name,
                  encounterType: mode,
                  roadName: unitAtEnd.edge!.name,
                  observedSecond,
                  availableSecond: observedSecond + 2,
                  sightLineAssessment:
                    "no_mapped_blockage_visibility_uncertain",
                });
                current.reported = true;
              }
            }
            mobileWindows.set(unit.id, current);
          }
        }
      if (t % REPORT_INTERVAL === 0) {
        if (!signalLostAt(t, effectiveOutages) || t === 0) {
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
      simulatorVersion: COORDINATION_SIMULATOR_VERSION,
      displaySecond,
      displayTimestamp: displayTimestamp(displaySecond),
      reportAgeSeconds: displaySecond - lastReportSecond,
      connectivity: signalLostAt(displaySecond, effectiveOutages)
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
      mobileObservations: mobileObservations.filter(
        (observation) => observation.availableSecond <= displaySecond,
      ),
      mobileFixture: this.mobileFixture,
      sightLineFootprints: this.sightLines.footprints,
      sightLineObserverPoints: this.sightLines.observerPoints,
      sightLineFixture: this.sightLines.fixture,
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
            text: `${observation.unitName} simulated observation at ${observation.junction.name}: vehicle approached on ${observation.approachName}, heading about ${Math.round(observation.directionDegrees)}°. Observed ${observation.observedSecond}s into replay; available ${observation.availableSecond}s into replay. No mapped obstruction on the simulated sight line; real-world visibility uncertain because footprints are incomplete. Approximate approach only.`,
          })),
        ...mobileObservations
          .filter((observation) => observation.availableSecond <= displaySecond)
          .map((observation) => ({
            id: observation.id,
            incidentId: INCIDENT.id,
            kind: "mobile_unit_observation" as const,
            scenarioSecond: observation.availableSecond,
            displayTimestamp: displayTimestamp(observation.availableSecond),
            text: `${observation.unitName} simulated mobile sighting on ${observation.roadName}: ${observation.encounterType === "oncoming" ? "opposite-direction encounter" : "unit following behind the vehicle"}. Observed ${observation.observedSecond}s into replay; available ${observation.availableSecond}s into replay. Approximate road corridor only; no vehicle GPS report or precise vehicle position. No mapped obstruction; real-world visibility uncertain.`,
          })),
      ],
    };
  }
}
