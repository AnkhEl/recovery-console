import type { CoordinationGraph } from "./coordination";
import { distance, DURATION } from "./scenario";
import {
  OBSERVATION_HORIZON_SECONDS,
  rankingCandidates,
  type OperatorView,
  type RankingCandidate,
} from "./ranking";

export type TeamCoverageOption = {
  candidate: RankingCandidate;
  gainedApproachIds: string[];
  lostApproachIds: string[];
  uncertainLostApproachIds: string[];
  uncertainOverlapIds: string[];
  earliestReadySecond: number;
  earliestPossibleAvailabilitySecond: number;
  evaluationEndSecond: number;
  fitsWindow: boolean;
  recentLocalObservation: boolean;
  exploratory: boolean;
  duplicate: boolean;
};

const validReport = (
  report: OperatorView["units"][number]["currentReport"],
  displayTime: number,
) => {
  if (!report || report.kind !== "confirmed_device_report") return false;
  const device = Date.parse(report.deviceTimestamp);
  const received = Date.parse(report.serverReceiptTimestamp);
  return (
    Number.isFinite(device) &&
    Number.isFinite(received) &&
    device <= received &&
    received <= displayTime &&
    (displayTime - device) / 1000 <= 10
  );
};

function incumbentApproaches(view: OperatorView, unitId: string) {
  const objective = view.unitObjectives[unitId];
  if (!objective)
    return { confirmed: [] as string[], uncertain: [] as string[] };
  const unit = view.units.find((item) => item.unitId === unitId);
  const report = unit?.currentReport;
  const nearPost =
    report && distance(report.coordinates, objective.coordinates) <= 20;
  const confirmed = Boolean(
    nearPost && validReport(report ?? null, Date.parse(view.displayTimestamp)),
  );
  const edges = objective.visibleApproachEdgeIds ?? [];
  return {
    confirmed: confirmed ? edges : [],
    uncertain: confirmed ? [] : edges,
  };
}

export function assessTeamCandidate(
  view: OperatorView,
  candidate: RankingCandidate,
  graph: CoordinationGraph,
): TeamCoverageOption {
  const target = view.objectives.find(
    (objective) => objective.id === candidate.objectiveId,
  );
  const realEdges = new Set(graph.edges.map((edge) => edge.id));
  const otherConfirmed = new Set<string>();
  const otherUncertain = new Set<string>();
  for (const unit of view.units) {
    if (unit.unitId === candidate.unitId) continue;
    const coverage = incumbentApproaches(view, unit.unitId);
    coverage.confirmed.forEach((edge) => otherConfirmed.add(edge));
    coverage.uncertain.forEach((edge) => otherUncertain.add(edge));
  }
  const own = incumbentApproaches(view, candidate.unitId);
  const targetEdges = (target?.visibleApproachEdgeIds ?? []).filter((edge) =>
    realEdges.has(edge),
  );
  const gainedApproachIds = targetEdges.filter(
    (edge) => !otherConfirmed.has(edge) && !otherUncertain.has(edge),
  );
  const lostApproachIds = own.confirmed.filter(
    (edge) => !targetEdges.includes(edge) && !otherConfirmed.has(edge),
  );
  const uncertainLostApproachIds = own.uncertain.filter(
    (edge) => !targetEdges.includes(edge) && !otherConfirmed.has(edge),
  );
  const uncertainOverlapIds = targetEdges.filter(
    (edge) => otherUncertain.has(edge) && !otherConfirmed.has(edge),
  );
  const earliestReadySecond = Math.ceil(
    view.displaySecond + candidate.trafficRouteSeconds + 3,
  );
  const earliestPossibleAvailabilitySecond = earliestReadySecond + 2;
  const evaluationEndSecond = Math.min(
    view.displaySecond + OBSERVATION_HORIZON_SECONDS,
    DURATION,
  );
  const recentLocalObservation = view.observations.some(
    (observation) =>
      observation.junction.id === candidate.objectiveId &&
      observation.availableSecond <= view.displaySecond &&
      view.displaySecond - observation.observedSecond <= 15,
  );
  const duplicate =
    gainedApproachIds.length === 0 && uncertainOverlapIds.length === 0;
  return {
    candidate,
    gainedApproachIds,
    lostApproachIds,
    uncertainLostApproachIds,
    uncertainOverlapIds,
    earliestReadySecond,
    earliestPossibleAvailabilitySecond,
    evaluationEndSecond,
    fitsWindow: earliestPossibleAvailabilitySecond <= evaluationEndSecond,
    recentLocalObservation,
    exploratory: !recentLocalObservation,
    duplicate,
  };
}

export function teamCoverageView(view: OperatorView, graph: CoordinationGraph) {
  const assessed = rankingCandidates(view, graph)
    .map((candidate) => assessTeamCandidate(view, candidate, graph))
    .sort(
      (a, b) =>
        b.candidate.baselineScore - a.candidate.baselineScore ||
        a.candidate.unitId.localeCompare(b.candidate.unitId) ||
        a.candidate.objectiveId.localeCompare(b.candidate.objectiveId),
    );
  const eligible = assessed
    .filter(
      (option) =>
        option.fitsWindow &&
        !option.duplicate &&
        (option.gainedApproachIds.length > 0 ||
          option.uncertainOverlapIds.length > 0),
    )
    .sort(
      (a, b) =>
        Number(a.exploratory) - Number(b.exploratory) ||
        a.lostApproachIds.length - b.lostApproachIds.length ||
        a.uncertainLostApproachIds.length - b.uncertainLostApproachIds.length ||
        b.candidate.baselineScore - a.candidate.baselineScore,
    );
  const units = new Set<string>();
  const alternatives = eligible
    .filter((option) => {
      if (units.has(option.candidate.unitId)) return false;
      units.add(option.candidate.unitId);
      return true;
    })
    .slice(0, 3);
  return {
    alternatives,
    hasWellSupportedOrder: alternatives.some((option) => !option.exploratory),
    duplicateExample: assessed.find((option) => option.duplicate) ?? null,
  };
}
