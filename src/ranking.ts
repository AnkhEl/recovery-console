import type { Coordinates } from "./model";
import type {
  CoordinationGraph,
  CoordinationSnapshot,
  Objective,
} from "./coordination";

export const RANKER_VERSION = "observation-ranker-v3";
export const OBSERVATION_HORIZON_SECONDS = 90;

export const FEATURE_NAMES = [
  "current_traffic_route_minutes",
  "junction_distance_500m",
  "heading_alignment",
  "report_age_90s",
  "signal_lost",
  "unit_report_age_10s",
  "confirmed_unit_at_current_order",
  "active_objective_order",
  "junction_approach_coverage",
  "route_congestion_fraction",
  "report_age_x_distance",
  "report_age_x_coverage",
  "junction_1",
  "junction_2",
  "junction_3",
  "junction_4",
  "junction_5",
  "junction_6",
  "junction_7",
  "junction_8",
] as const;

export type RankingCandidate = {
  unitId: string;
  unitName: string;
  objectiveId: string;
  objectiveName: string;
  action: "assign" | "retask";
  trafficRouteSeconds: number;
  features: number[];
  baselineScore: number;
};

export type RankingModel = {
  version: string;
  target: "first_available_unit_observation_within_90_seconds";
  featureNames: string[];
  weights: number[];
  calibration: {
    method: "platt_logistic_v1";
    scoreMean: number;
    scoreStd: number;
    slope: number;
    intercept: number;
  };
  trainedOn: string;
};

export type OperatorView = Pick<
  CoordinationSnapshot,
  | "displaySecond"
  | "displayTimestamp"
  | "reportAgeSeconds"
  | "connectivity"
  | "lastConfirmedReport"
  | "units"
  | "objectives"
  | "assignedUnitIds"
  | "unitObjectives"
  | "observations"
  | "trafficSegments"
>;

const distance = (a: Coordinates, b: Coordinates) => {
  const radians = Math.PI / 180;
  const dy = (b[1] - a[1]) * radians;
  const dx = (b[0] - a[0]) * radians;
  const h =
    Math.sin(dy / 2) ** 2 +
    Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin(dx / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

const reportIsAvailable = (
  report: {
    kind: string;
    deviceTimestamp: string;
    serverReceiptTimestamp: string;
  },
  displayMillis: number,
  maxAgeSeconds: number,
) => {
  const device = Date.parse(report.deviceTimestamp);
  const received = Date.parse(report.serverReceiptTimestamp);
  return (
    report.kind === "confirmed_device_report" &&
    Number.isFinite(device) &&
    Number.isFinite(received) &&
    device <= received &&
    received <= displayMillis &&
    (displayMillis - device) / 1000 <= maxAgeSeconds
  );
};

export function adviceEligibility(view: OperatorView) {
  const displayMillis = Date.parse(view.displayTimestamp);
  if (!Number.isFinite(displayMillis)) return false;
  if (
    view.reportAgeSeconds < 0 ||
    view.reportAgeSeconds > 30 ||
    !reportIsAvailable(view.lastConfirmedReport, displayMillis, 30)
  )
    return false;
  if (
    view.observations.some(
      (observation) => observation.availableSecond > view.displaySecond,
    )
  )
    return false;
  return view.units.some(
    (unit) =>
      unit.currentReport &&
      reportIsAvailable(unit.currentReport, displayMillis, 10),
  );
}

const bearing = (from: Coordinates, to: Coordinates) =>
  ((Math.atan2(
    (to[0] - from[0]) * Math.cos((from[1] * Math.PI) / 180),
    to[1] - from[1],
  ) *
    180) /
    Math.PI +
    360) %
  360;

// Directed road geometry plus only congestion displayed at this replay time.
export function currentTrafficRoute(
  graph: CoordinationGraph,
  from: Coordinates,
  objective: Objective,
  traffic: OperatorView["trafficSegments"],
): { seconds: number; congestedFraction: number } {
  const start = graph.nearestNode(from);
  if (start === objective.nodeId) return { seconds: 0, congestedFraction: 0 };
  const visibleLevels = new Map(traffic.map((item) => [item.id, item.level]));
  const costs = new Map<string, number>([[start, 0]]);
  const previous = new Map<string, { from: string; level: number }>();
  const queue: [number, string][] = [[0, start]];
  while (queue.length) {
    queue.sort((a, b) => b[0] - a[0]);
    const [cost, node] = queue.pop()!;
    if (cost !== costs.get(node)) continue;
    if (node === objective.nodeId) {
      let total = 0;
      let congested = 0;
      let cursor = node;
      while (cursor !== start) {
        const step = previous.get(cursor)!;
        total++;
        if (step.level > 0) congested++;
        cursor = step.from;
      }
      return { seconds: cost, congestedFraction: congested / total };
    }
    for (const edge of graph.outgoing.get(node) ?? []) {
      // Unknown segments retain posted speed; no future traffic is inferred.
      const level = visibleLevels.get(edge.physicalId) ?? 0;
      const factor = [1, 0.75, 0.5][level];
      const next =
        cost + edge.length / Math.max(2, (edge.speedKmh / 3.6) * factor);
      if (next >= (costs.get(edge.to) ?? Infinity)) continue;
      costs.set(edge.to, next);
      previous.set(edge.to, { from: node, level });
      queue.push([next, edge.to]);
    }
  }
  return { seconds: Infinity, congestedFraction: 0 };
}

export function rankingCandidates(
  snapshot: OperatorView,
  graph: CoordinationGraph,
): RankingCandidate[] {
  if (!adviceEligibility(snapshot)) return [];
  const displayMillis = Date.parse(snapshot.displayTimestamp);
  const lastReport = snapshot.lastConfirmedReport;
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  const vehicleReliability = Math.max(0, 1 - snapshot.reportAgeSeconds / 30);
  const headingKnown = lastReport.speedKmh > 0;
  return snapshot.units.flatMap((unit) => {
    const unitReport = unit.currentReport;
    if (!unitReport || !reportIsAvailable(unitReport, displayMillis, 10))
      return [];
    return snapshot.objectives.flatMap((objective) => {
      if (snapshot.unitObjectives[unit.unitId]?.id === objective.id) return [];
      const route = currentTrafficRoute(
        graph,
        unitReport.coordinates,
        objective,
        snapshot.trafficSegments,
      );
      if (!Number.isFinite(route.seconds)) return [];
      const gpsDistance = distance(
        lastReport.coordinates,
        objective.coordinates,
      );
      const unitAge = Math.max(
        0,
        (displayMillis - Date.parse(unitReport.deviceTimestamp)) / 1000,
      );
      const coverage = Math.min(
        1,
        (objective.visibleApproachEdgeIds?.filter((id) => edgeIds.has(id))
          .length ?? 0) / 3,
      );
      const direction = bearing(lastReport.coordinates, objective.coordinates);
      const headingAlignment = headingKnown
        ? Math.cos(((direction - lastReport.headingDegrees) * Math.PI) / 180)
        : 0;
      const activeObjective = snapshot.unitObjectives[unit.unitId];
      const confirmedAtCurrentOrder = Boolean(
        activeObjective &&
        distance(unitReport.coordinates, activeObjective.coordinates) <= 20,
      );
      const features = [
        Math.min(route.seconds / 60, 3),
        Math.min(gpsDistance / 500, 3),
        headingAlignment,
        Math.min(snapshot.reportAgeSeconds / 90, 2),
        snapshot.connectivity === "signal_lost" ? 1 : 0,
        unitAge / 10,
        confirmedAtCurrentOrder ? 1 : 0,
        activeObjective ? 1 : 0,
        coverage,
        route.congestedFraction,
        (snapshot.reportAgeSeconds / 30) * Math.min(gpsDistance / 500, 3),
        (snapshot.reportAgeSeconds / 30) * coverage,
        ...Array.from({ length: 8 }, (_, index) =>
          objective.id === `junction-${index + 1}` ? 1 : 0,
        ),
      ];
      // Transparent baseline: legal-route ETA using visible congestion, report
      // age, junction approach coverage, and last confirmed GPS context.
      const baselineScore =
        -route.seconds / 90 -
        (gpsDistance / 250) * vehicleReliability +
        0.35 * coverage * (1 + snapshot.reportAgeSeconds / 30) +
        0.2 * headingAlignment * vehicleReliability -
        0.1 * (unitAge / 10);
      return [
        {
          unitId: unit.unitId,
          unitName: unit.unitName,
          objectiveId: objective.id,
          objectiveName: objective.name,
          action: snapshot.assignedUnitIds.includes(unit.unitId)
            ? ("retask" as const)
            : ("assign" as const),
          trafficRouteSeconds: route.seconds,
          features,
          baselineScore,
        },
      ];
    });
  });
}

export function modelScore(model: RankingModel, candidate: RankingCandidate) {
  if (
    model.version !== RANKER_VERSION ||
    model.featureNames.join("|") !== FEATURE_NAMES.join("|") ||
    model.weights.length !== FEATURE_NAMES.length
  )
    throw new Error("Ranking model version or feature contract mismatch");
  return model.weights.reduce(
    (score, weight, index) => score + weight * candidate.features[index],
    0,
  );
}

export function modelProbability(
  model: RankingModel,
  candidate: RankingCandidate,
) {
  const calibration = model.calibration;
  if (
    calibration.method !== "platt_logistic_v1" ||
    !Number.isFinite(calibration.scoreStd) ||
    calibration.scoreStd <= 0
  )
    throw new Error("Ranking model calibration contract mismatch");
  const standardized =
    (modelScore(model, candidate) - calibration.scoreMean) /
    calibration.scoreStd;
  const logit = calibration.slope * standardized + calibration.intercept;
  return 1 / (1 + Math.exp(-logit));
}
