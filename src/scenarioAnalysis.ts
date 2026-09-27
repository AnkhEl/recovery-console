import type { CoordinationGraph } from "./coordination";
import {
  rankingCandidates,
  type OperatorView,
  type RankingCandidate,
} from "./ranking";

export type ScenarioReview = {
  candidate: RankingCandidate;
  runId: string;
  displaySecond: number;
  basis: string;
};

const candidateKey = (candidate: RankingCandidate) =>
  `${candidate.unitId}:${candidate.objectiveId}`;

// Show distinct units as alternatives. This is a ranking, not a joint plan.
export function baselineAlternatives(
  view: OperatorView,
  graph: CoordinationGraph,
) {
  const ranked = rankingCandidates(view, graph).sort(
    (a, b) =>
      b.baselineScore - a.baselineScore ||
      candidateKey(a).localeCompare(candidateKey(b)),
  );
  const units = new Set<string>();
  return ranked
    .filter((candidate) => {
      if (units.has(candidate.unitId)) return false;
      units.add(candidate.unitId);
      return true;
    })
    .slice(0, 3);
}

function reviewBasis(
  view: OperatorView,
  candidate: RankingCandidate,
  runId: string,
) {
  return JSON.stringify({
    runId,
    displaySecond: view.displaySecond,
    displayTimestamp: view.displayTimestamp,
    connectivity: view.connectivity,
    vehicleReport: view.lastConfirmedReport,
    units: view.units.map((unit) => [unit.unitId, unit.currentReport]),
    assignments: view.assignedUnitIds,
    objectives: view.objectives,
    unitObjectives: view.unitObjectives,
    traffic: view.trafficSegments.map((segment) => [segment.id, segment.level]),
    candidate,
  });
}

export function createScenarioReview(
  view: OperatorView,
  candidate: RankingCandidate,
  runId: string,
): ScenarioReview {
  return {
    candidate,
    runId,
    displaySecond: view.displaySecond,
    basis: reviewBasis(view, candidate, runId),
  };
}

export function revalidateScenarioReview(
  review: ScenarioReview,
  view: OperatorView,
  graph: CoordinationGraph,
  runId: string,
): {
  status: "current" | "refreshed" | "unavailable";
  review?: ScenarioReview;
} {
  const current = rankingCandidates(view, graph).find(
    (candidate) => candidateKey(candidate) === candidateKey(review.candidate),
  );
  if (!current) return { status: "unavailable" };
  const updated = createScenarioReview(view, current, runId);
  return {
    status: updated.basis === review.basis ? "current" : "refreshed",
    review: updated,
  };
}
