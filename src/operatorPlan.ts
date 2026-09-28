import type {
  CoordinationGraph,
  CoordinationSnapshot,
  Order,
  ScenarioRun,
} from "./coordination";
import { currentTrafficRoute, OBSERVATION_HORIZON_SECONDS } from "./ranking";
import { distance, DURATION } from "./scenario";
import { validUnitPosition } from "./unitPosition";

export type PlanChoice = { unitId: string; objectiveId: string };
export type PlanDraft = {
  runId: string;
  second: number;
  name: string;
  choices: [PlanChoice, PlanChoice];
  revisionPlanId: string | null;
};
export type PlanItem = {
  unitId: string;
  unitName: string;
  objectiveId: string;
  objectiveName: string;
  kind: "assign" | "retask";
  unitReportAgeSeconds: number;
  routeSeconds: number;
  earliestReadySecond: number;
  earliestInformationSecond: number;
};
export type PlanCoverage = {
  before: number;
  after: number;
  gained: string[];
  lostConfirmed: string[];
  lostUncertain: string[];
  targetOverlap: string[];
  incumbentOverlap: string[];
};
export type PlanReview = {
  draft: PlanDraft;
  items: [PlanItem, PlanItem];
  coverage: PlanCoverage;
  evaluationEndSecond: number;
  vehicleReportAgeSeconds: number;
  signalLost: boolean;
  issues: string[];
  basis: string;
};

export const comparisonDeadline = (decisionSecond: number) =>
  Math.min(decisionSecond + OBSERVATION_HORIZON_SECONDS, DURATION);

export function comparisonObservations(
  view: Pick<CoordinationSnapshot, "observations">,
  decisionSecond: number,
  throughSecond: number,
) {
  const end = Math.min(throughSecond, comparisonDeadline(decisionSecond));
  return view.observations.filter(
    (observation) =>
      observation.observedSecond > decisionSecond &&
      observation.availableSecond <= end,
  );
}

export function plansInRun(run: ScenarioRun) {
  const grouped = new Map<
    string,
    { id: string; name: string; second: number; orders: Order[] }
  >();
  for (const order of run.actions) {
    if (!order.planId) continue;
    const current = grouped.get(order.planId) ?? {
      id: order.planId,
      name: order.planName ?? "Operator plan",
      second: order.second,
      orders: [],
    };
    current.orders.push(order);
    grouped.set(order.planId, current);
  }
  return [...grouped.values()].sort((a, b) => a.second - b.second);
}

export function linkedPlanOrders(
  items: readonly PlanItem[],
  second: number,
  planId: string,
  planName: string,
): Order[] {
  return [...items]
    .sort(
      (a, b) =>
        a.unitId.localeCompare(b.unitId) ||
        a.objectiveId.localeCompare(b.objectiveId),
    )
    .map((item, index) => ({
      id: `${planId}-order-${index + 1}`,
      second,
      unitId: item.unitId,
      kind: item.kind,
      objectiveId: item.objectiveId,
      planId,
      planName,
    }));
}

export function planBaseRun(
  run: ScenarioRun,
  second: number,
  revisionPlanId: string | null,
): ScenarioRun {
  return {
    ...run,
    actions: run.actions
      .filter(
        (order) =>
          order.second < second ||
          (order.second === second && order.planId !== revisionPlanId),
      )
      .filter((order) => order.second <= second),
    outages: run.outages
      .filter((outage) => outage.start <= second)
      .map((outage) => ({
        ...outage,
        end: outage.end > second ? Infinity : outage.end,
      })),
  };
}

const reportAge = (timestamp: string, display: string) =>
  (Date.parse(display) - Date.parse(timestamp)) / 1000;

function validUnitReport(
  unit: CoordinationSnapshot["units"][number] | undefined,
  display: string,
) {
  const report = unit?.currentReport;
  if (!report || !validUnitPosition(unit)) return false;
  const receipt = Date.parse(report.serverReceiptTimestamp);
  const now = Date.parse(display);
  return (
    Number.isFinite(receipt) &&
    receipt <= now &&
    reportAge(report.deviceTimestamp, display) >= 0 &&
    reportAge(report.deviceTimestamp, display) <= 10
  );
}

export function assessOperatorPlan(
  view: CoordinationSnapshot,
  graph: CoordinationGraph,
  draft: PlanDraft,
  baseRun: ScenarioRun,
): PlanReview {
  const issues: string[] = [];
  const [a, b] = draft.choices;
  if (!a.unitId || !b.unitId || a.unitId === b.unitId)
    issues.push("Choose two distinct units.");
  if (!a.objectiveId || !b.objectiveId || a.objectiveId === b.objectiveId)
    issues.push("Choose two distinct named junctions.");
  if (draft.second !== view.displaySecond)
    issues.push("Return to the selected plan time.");
  if (!draft.name.trim()) issues.push("Name this plan.");
  const end = Math.min(draft.second + 90, DURATION);
  const validEdges = new Set(graph.edges.map((edge) => edge.id));
  const items = draft.choices.map((choice) => {
    const unit = view.units.find((item) => item.unitId === choice.unitId);
    const objective = view.objectives.find(
      (item) => item.id === choice.objectiveId,
    );
    const sameSecond = baseRun.actions.some(
      (order) =>
        order.second === draft.second && order.unitId === choice.unitId,
    );
    if (sameSecond)
      issues.push(
        `${unit?.unitName ?? choice.unitId} already has an unrelated order at this second.`,
      );
    if (!unit || !validUnitReport(unit, view.displayTimestamp))
      issues.push(
        `${unit?.unitName ?? choice.unitId ?? "A unit"} needs a confirmed report no older than 10 seconds.`,
      );
    if (!objective)
      issues.push(
        `${choice.objectiveId || "A destination"} is not a named junction.`,
      );
    if (objective && view.unitObjectives[choice.unitId]?.id === objective.id)
      issues.push(
        `${unit?.unitName ?? choice.unitId} is already ordered to this junction.`,
      );
    const route =
      objective && unit && validUnitPosition(unit)
        ? currentTrafficRoute(
            graph,
            unit.currentReport!.coordinates,
            objective,
            view.trafficSegments,
          )
        : { seconds: Infinity, congestedFraction: 0 };
    if (objective && unit && !Number.isFinite(route.seconds))
      issues.push(`No legal route is available for ${unit.unitName}.`);
    const earliestReadySecond = Math.ceil(draft.second + route.seconds + 3);
    const earliestInformationSecond = earliestReadySecond + 2;
    if (Number.isFinite(route.seconds) && earliestInformationSecond > end)
      issues.push(
        `${unit?.unitName ?? choice.unitId} cannot be ready within the remaining evaluation window.`,
      );
    return {
      unitId: choice.unitId,
      unitName: unit?.unitName ?? choice.unitId,
      objectiveId: choice.objectiveId,
      objectiveName: objective?.name ?? "Choose junction",
      kind: view.assignedUnitIds.includes(choice.unitId)
        ? ("retask" as const)
        : ("assign" as const),
      unitReportAgeSeconds: unit?.currentReport
        ? reportAge(unit.currentReport.deviceTimestamp, view.displayTimestamp)
        : Infinity,
      routeSeconds: route.seconds,
      earliestReadySecond,
      earliestInformationSecond,
    };
  }) as [PlanItem, PlanItem];

  const incumbent = view.units.flatMap((unit) => {
    const objective = view.unitObjectives[unit.unitId];
    if (!objective) return [];
    const report = unit.currentReport;
    const confirmed =
      validUnitReport(unit, view.displayTimestamp) &&
      Boolean(
        report && distance(report.coordinates, objective.coordinates) <= 20,
      );
    return [
      {
        unitId: unit.unitId,
        confirmed,
        edges: (objective.visibleApproachEdgeIds ?? []).filter((id) =>
          validEdges.has(id),
        ),
      },
    ];
  });
  const originalConfirmed = new Set(
    incumbent.filter((post) => post.confirmed).flatMap((post) => post.edges),
  );
  const originalUncertain = new Set(
    incumbent.filter((post) => !post.confirmed).flatMap((post) => post.edges),
  );
  const before = new Set([...originalConfirmed, ...originalUncertain]);
  const selectedUnits = new Set(draft.choices.map((choice) => choice.unitId));
  const retained = new Set(
    incumbent
      .filter((post) => !selectedUnits.has(post.unitId))
      .flatMap((post) => post.edges),
  );
  const targets = draft.choices.map(
    (choice) =>
      new Set(
        (
          view.objectives.find(
            (objective) => objective.id === choice.objectiveId,
          )?.visibleApproachEdgeIds ?? []
        ).filter((id) => validEdges.has(id)),
      ),
  );
  const after = new Set([...retained, ...targets[0], ...targets[1]]);
  const lost = [...before].filter((id) => !after.has(id));
  const coverage: PlanCoverage = {
    before: before.size,
    after: after.size,
    gained: [...after].filter((id) => !before.has(id)).sort(),
    lostConfirmed: lost.filter((id) => originalConfirmed.has(id)).sort(),
    lostUncertain: lost.filter((id) => !originalConfirmed.has(id)).sort(),
    targetOverlap: [...targets[0]].filter((id) => targets[1].has(id)).sort(),
    incumbentOverlap: [...new Set([...targets[0], ...targets[1]])]
      .filter((id) => retained.has(id))
      .sort(),
  };
  const basis = JSON.stringify({
    runId: draft.runId,
    second: draft.second,
    draft,
    baseActions: baseRun.actions,
    baseOutages: baseRun.outages,
    vehicleReport: view.lastConfirmedReport,
    connectivity: view.connectivity,
    units: view.units,
    assignments: view.assignedUnitIds,
    objectives: view.objectives,
    unitObjectives: view.unitObjectives,
    traffic: view.trafficSegments.map((segment) => [segment.id, segment.level]),
    observations: view.observations,
    items,
    coverage,
    issues,
  });
  return {
    draft,
    items,
    coverage,
    evaluationEndSecond: end,
    vehicleReportAgeSeconds: view.reportAgeSeconds,
    signalLost: view.connectivity === "signal_lost",
    issues,
    basis,
  };
}

export function compareRunBasis(
  reference: ScenarioRun,
  candidate: ScenarioRun,
  decisionSecond: number,
  throughSecond: number,
): string[] {
  const reasons: string[] = [];
  if (
    reference.seed !== candidate.seed ||
    (reference.trafficSeed ?? reference.seed) !==
      (candidate.trafficSeed ?? candidate.seed) ||
    (reference.trafficPattern ?? 0) !== (candidate.trafficPattern ?? 0)
  )
    reasons.push("Seed or traffic setup differs.");
  if (JSON.stringify(reference.outages) !== JSON.stringify(candidate.outages))
    reasons.push("Manual signal schedule differs.");
  const normalized = (run: ScenarioRun, predicate: (order: Order) => boolean) =>
    run.actions
      .filter(predicate)
      .map((order) => [
        order.second,
        order.unitId,
        order.kind,
        order.objectiveId,
      ]);
  if (
    JSON.stringify(
      normalized(reference, (order) => order.second < decisionSecond),
    ) !==
    JSON.stringify(
      normalized(candidate, (order) => order.second < decisionSecond),
    )
  )
    reasons.push("Prior unit orders differ.");
  if (
    JSON.stringify(
      normalized(
        reference,
        (order) => order.second === decisionSecond && !order.planId,
      ),
    ) !==
    JSON.stringify(
      normalized(
        candidate,
        (order) => order.second === decisionSecond && !order.planId,
      ),
    )
  )
    reasons.push("Unrelated orders at the decision time differ.");
  if (
    JSON.stringify(
      normalized(
        reference,
        (order) =>
          order.second > decisionSecond && order.second <= throughSecond,
      ),
    ) !==
    JSON.stringify(
      normalized(
        candidate,
        (order) =>
          order.second > decisionSecond && order.second <= throughSecond,
      ),
    )
  )
    reasons.push("Later unit orders differ before the comparison time.");
  return reasons;
}
