import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CesiumMap, type CameraRequest } from "./components/CesiumMap";
import type { ActivityEvent, Coordinates, Outage } from "./model";
import {
  COORDINATION_SIMULATOR_VERSION,
  CoordinatedIncidentSource,
  CoordinationGraph,
  type Order,
  type ScenarioRun,
} from "./coordination";
import { validUnitPosition } from "./unitPosition";
import { sightLineDataset } from "./sightLines";
import {
  baselineAlternatives,
  createScenarioReview,
  revalidateScenarioReview,
  type ScenarioReview,
} from "./scenarioAnalysis";
import { teamCoverageView } from "./teamCoverage";
import {
  assessOperatorPlan,
  compareRunBasis,
  comparisonDeadline,
  comparisonObservations,
  linkedPlanOrders,
  planBaseRun,
  plansInRun,
  type PlanDraft,
  type PlanReview,
} from "./operatorPlan";
import {
  clock,
  displayTimestamp,
  DURATION,
  elapsed,
  INCIDENT,
  INITIAL_UNITS,
  PLANNED_OUTAGE,
} from "./scenario";

function formatCoordinates(p: Coordinates) {
  return `${Math.abs(p[1]).toFixed(4)}° S, ${p[0].toFixed(4)}° E`;
}
type PanelSectionId = "scenario" | "team" | "plan" | "units";
function CollapsiblePanel({
  id,
  title,
  count,
  className,
  expanded,
  onToggle,
  children,
}: {
  id: PanelSectionId;
  title: string;
  count?: number;
  className: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className={className} aria-label={title}>
      <h2 className="collapsible-heading">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`${id}-panel-content`}
          onClick={onToggle}
        >
          <span>
            {title}
            {count !== undefined && (
              <span className="section-count">{count}</span>
            )}
          </span>
          <span className="section-chevron" aria-hidden="true">
            {expanded ? "−" : "+"}
          </span>
        </button>
      </h2>
      <div
        id={`${id}-panel-content`}
        className="collapsible-content"
        hidden={!expanded}
      >
        {children}
      </div>
    </section>
  );
}
const scenarioSeed = (() => {
  if (!import.meta.env.DEV) return 42;
  const requested = Number(
    new URLSearchParams(location.search).get("scenarioSeed") ?? 42,
  );
  return Number.isInteger(requested) && requested > 0 && requested <= 10000
    ? requested
    : 42;
})();
export function App() {
  const [source, setSource] = useState<CoordinatedIncidentSource | null>(null),
    [loadError, setLoadError] = useState("");
  const [time, setTime] = useState(0),
    [playing, setPlaying] = useState(false),
    [rate, setRate] = useState(1);
  const [runs, setRuns] = useState<ScenarioRun[]>([
    {
      id: "run-1",
      name: "Original run",
      seed: scenarioSeed,
      actions: [],
      outages: [],
    },
  ]);
  const [activeRunId, setActiveRunId] = useState("run-1");
  const [objectiveSelections, setObjectiveSelections] = useState<
    Record<string, string>
  >({});
  const [pendingOrder, setPendingOrder] = useState<Order | null>(null);
  const [pendingSignal, setPendingSignal] = useState(false);
  const [scenarioReview, setScenarioReview] = useState<ScenarioReview | null>(
    null,
  );
  const [reviewChanged, setReviewChanged] = useState(false);
  const [reviewUnavailable, setReviewUnavailable] = useState(false);
  const [planDraft, setPlanDraft] = useState<PlanDraft | null>(null);
  const [planReview, setPlanReview] = useState<PlanReview | null>(null);
  const [planReviewChanged, setPlanReviewChanged] = useState(false);
  const [comparisonSecond, setComparisonSecond] = useState(0);
  const [comparedThrough, setComparedThrough] = useState<
    Record<string, number>
  >({});
  const [expandedSections, setExpandedSections] = useState<
    Record<PanelSectionId, boolean>
  >({ scenario: false, team: false, plan: false, units: true });
  const toggleSection = (id: PanelSectionId) =>
    setExpandedSections((current) => ({ ...current, [id]: !current[id] }));
  const [selectedUnit, setSelectedUnit] = useState<string | null>(null),
    [following, setFollowing] = useState(false),
    [fullPageMap, setFullPageMap] = useState(false),
    [cameraRequest, setCameraRequest] = useState<CameraRequest | null>(null),
    [roadmap, setRoadmap] = useState(false),
    [toast, setToast] = useState("");
  const cameraSequenceRef = useRef(0);
  const playbackGenerationRef = useRef(0);
  useEffect(() => {
    if (!fullPageMap) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullPageMap(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [fullPageMap]);
  useEffect(() => {
    fetch("/coordination-graph.json")
      .then((r) => {
        if (!r.ok) throw new Error("Scenario road graph unavailable");
        return r.json();
      })
      .then((data) => {
        const unavailableUnitIds = import.meta.env.DEV
          ? new Set(new URLSearchParams(location.search).getAll("missingUnit"))
          : new Set<string>();
        const requestedFixture = import.meta.env.DEV
          ? new URLSearchParams(location.search).get("sightLineFixture")
          : null;
        const sightLineFixture =
          requestedFixture === "clear" || requestedFixture === "blocked"
            ? requestedFixture
            : "none";
        setSource(
          new CoordinatedIncidentSource(
            new CoordinationGraph(data),
            unavailableUnitIds,
            sightLineDataset(sightLineFixture),
          ),
        );
      })
      .catch((error) => setLoadError(String(error)));
  }, []);
  useEffect(() => {
    if (!playing) return;
    const generation = ++playbackGenerationRef.current;
    const startedAt = performance.now();
    const startingTime = time;
    const timer = window.setInterval(() => {
      const now = performance.now();
      const target = Math.min(
        DURATION,
        startingTime + Math.max(0, (now - startedAt) / 1000) * rate,
      );
      setTime((current) =>
        generation === playbackGenerationRef.current
          ? Math.max(current, target)
          : current,
      );
    }, 250);
    return () => {
      window.clearInterval(timer);
      playbackGenerationRef.current++;
    };
  }, [playing, rate]);
  useEffect(() => {
    if (playing && time >= DURATION) setPlaying(false);
  }, [playing, time]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  const displaySecond = Math.floor(time);
  const run = runs.find((candidate) => candidate.id === activeRunId)!;
  const snapshot = useMemo(
    () => source?.snapshot(displaySecond, run),
    [source, displaySecond, run],
  );
  const alternatives = useMemo(
    () =>
      source && snapshot ? baselineAlternatives(snapshot, source.graph) : [],
    [source, snapshot],
  );
  const teamCoverage = useMemo(
    () =>
      source && snapshot ? teamCoverageView(snapshot, source.graph) : null,
    [source, snapshot],
  );
  const currentPlans = useMemo(() => plansInRun(run), [run]);
  const draftBaseRun = useMemo(
    () =>
      planDraft?.runId === run.id
        ? planBaseRun(run, planDraft.second, planDraft.revisionPlanId)
        : null,
    [run, planDraft],
  );
  const draftView = useMemo(
    () =>
      source && draftBaseRun && planDraft
        ? source.snapshot(planDraft.second, draftBaseRun)
        : null,
    [source, draftBaseRun, planDraft],
  );
  const draftAssessment = useMemo(
    () =>
      source && draftBaseRun && draftView && planDraft
        ? assessOperatorPlan(draftView, source.graph, planDraft, draftBaseRun)
        : null,
    [source, draftBaseRun, draftView, planDraft],
  );
  useEffect(() => {
    if (!playing) return;
    setComparedThrough((items) => ({
      ...items,
      [activeRunId]: Math.max(items[activeRunId] ?? 0, displaySecond),
    }));
  }, [playing, activeRunId, displaySecond]);
  if (!snapshot || !source)
    return (
      <div className="loading">
        {loadError || "Loading simulated incident…"}
      </div>
    );
  const comparisonEnd = comparisonDeadline(comparisonSecond);
  const comparisonThrough = Math.min(displaySecond, comparisonEnd);
  const noNewPlanOrderRun = runs.find(
    (item) =>
      !item.actions.some(
        (action) => action.second === comparisonSecond && action.planId,
      ) &&
      compareRunBasis(run, item, comparisonSecond, comparisonEnd).length === 0,
  );
  const controlComplete =
    noNewPlanOrderRun &&
    !playing &&
    displaySecond >= comparisonEnd &&
    (comparedThrough[noNewPlanOrderRun.id] ?? 0) >= comparisonEnd;
  const controlObservations = controlComplete
    ? comparisonObservations(
        source.snapshot(comparisonEnd, noNewPlanOrderRun),
        comparisonSecond,
        comparisonEnd,
      )
    : null;
  const report = snapshot.lastConfirmedReport;
  const selectVehicle = () => {
    setSelectedUnit(null);
    setFollowing(true);
    setCameraRequest({
      sequence: ++cameraSequenceRef.current,
      kind: "vehicle",
      coordinates: report.coordinates,
    });
  };
  const selectUnit = (id: string) => {
    const unit = snapshot.units.find((candidate) => candidate.unitId === id);
    if (!unit) return;
    setSelectedUnit(id);
    setFollowing(false);
    const coordinates = validUnitPosition(unit);
    if (!coordinates) {
      setCameraRequest(null);
      setToast(`${unit.unitName} has no current confirmed position.`);
      return;
    }
    setCameraRequest({
      sequence: ++cameraSequenceRef.current,
      kind: "unit",
      unitId: id,
      coordinates,
    });
  };
  const fitAll = () => {
    setSelectedUnit(null);
    setFollowing(false);
    setCameraRequest({
      sequence: ++cameraSequenceRef.current,
      kind: "fit",
      positions: [
        report.coordinates,
        ...snapshot.units.flatMap((unit) => {
          const coordinates = validUnitPosition(unit);
          return coordinates ? [coordinates] : [];
        }),
      ],
    });
  };
  const assignedAt = (id: string) => snapshot.assignedUnitIds.includes(id);
  const manualActive = run.outages.find(
    (o) => displaySecond >= o.start && displaySecond < o.end,
  );
  const hasFutureActions =
    run.actions.some((action) => action.second > displaySecond) ||
    run.outages.some(
      (outage) =>
        outage.start > displaySecond ||
        (Number.isFinite(outage.end) && outage.end > displaySecond),
    );
  const outagesThrough = (): Outage[] =>
    run.outages
      .filter((outage) => outage.start <= displaySecond)
      .map((outage) => ({
        ...outage,
        end: outage.end > displaySecond ? Infinity : outage.end,
      }));
  const commitSignal = (branch: boolean) => {
    const previous = branch ? outagesThrough() : run.outages;
    const active = previous.find(
      (outage) => displaySecond >= outage.start && displaySecond < outage.end,
    );
    const nextOutages = active
      ? previous.map((outage) =>
          outage === active ? { ...outage, end: displaySecond } : outage,
        )
      : [...previous, { start: displaySecond, end: Infinity }];
    if (branch) {
      const id = `run-${runs.length + 1}`;
      setRuns((items) => [
        ...items,
        {
          id,
          name: `Alternative ${runs.length}`,
          seed: run.seed,
          parentId: run.id,
          branchSecond: displaySecond,
          actions: run.actions.filter(
            (action) => action.second <= displaySecond,
          ),
          outages: nextOutages,
        },
      ]);
      setActiveRunId(id);
    } else {
      setRuns((items) =>
        items.map((item) =>
          item.id === run.id ? { ...item, outages: nextOutages } : item,
        ),
      );
    }
    setPendingSignal(false);
  };
  const toggleSignal = () => {
    if (time >= PLANNED_OUTAGE.start && time < PLANNED_OUTAGE.end) {
      setToast("The scheduled outage ends at 01:30.");
      return;
    }
    if (hasFutureActions) setPendingSignal(true);
    else commitSignal(false);
  };
  const commitOrder = (order: Order, branch: boolean) => {
    if (branch) {
      const id = `run-${runs.length + 1}`;
      const next: ScenarioRun = {
        id,
        name: `Alternative ${runs.length}`,
        seed: run.seed,
        parentId: run.id,
        branchSecond: displaySecond,
        actions: [
          ...run.actions.filter((action) => action.second <= displaySecond),
          order,
        ],
        outages: outagesThrough(),
      };
      setRuns((items) => [...items, next]);
      setActiveRunId(id);
    } else {
      setRuns((items) =>
        items.map((item) =>
          item.id === run.id
            ? { ...item, actions: [...item.actions, order] }
            : item,
        ),
      );
    }
    setPendingOrder(null);
    setToast("Simulation order recorded. No instruction was sent.");
  };
  const orderUnit = (id: string, kind: Order["kind"]) => {
    if (
      run.actions.some(
        (action) =>
          action.second === displaySecond &&
          action.unitId === id &&
          action.planId,
      )
    ) {
      setToast(
        "This unit has a linked plan order now. Revise the plan or choose a later replay time.",
      );
      return;
    }
    const objectiveId =
      objectiveSelections[id] ?? snapshot.unitObjectives[id]?.id;
    if (kind !== "release" && !objectiveId) {
      setToast("Choose an objective before moving this unit.");
      return;
    }
    if (
      kind !== "release" &&
      !validUnitPosition(snapshot.units.find((u) => u.unitId === id))
    ) {
      setToast("A current confirmed unit report is required before an order.");
      return;
    }
    const order: Order = {
      id: `${run.id}-${run.actions.length + 1}-${displaySecond}`,
      second: displaySecond,
      unitId: id,
      kind,
      ...(kind === "release" ? {} : { objectiveId }),
    };
    if (hasFutureActions) setPendingOrder(order);
    else commitOrder(order, false);
  };
  const confirmScenarioOrder = () => {
    if (!scenarioReview) return;
    const currentView = source.snapshot(Math.floor(time), run);
    const checked = revalidateScenarioReview(
      scenarioReview,
      currentView,
      source.graph,
      run.id,
    );
    if (checked.status === "unavailable") {
      setReviewUnavailable(true);
      setReviewChanged(false);
      return;
    }
    if (checked.status === "refreshed") {
      setScenarioReview(checked.review!);
      setReviewChanged(true);
      setReviewUnavailable(false);
      return;
    }
    const candidate = checked.review!.candidate;
    const order: Order = {
      id: `${run.id}-${run.actions.length + 1}-${currentView.displaySecond}`,
      second: currentView.displaySecond,
      unitId: candidate.unitId,
      kind: candidate.action,
      objectiveId: candidate.objectiveId,
    };
    commitOrder(order, hasFutureActions);
    setScenarioReview(null);
    setReviewChanged(false);
    setReviewUnavailable(false);
  };
  const beginOperatorPlan = () => {
    setPlaying(false);
    setPlanDraft({
      runId: run.id,
      second: displaySecond,
      name: `Plan ${runs.length}`,
      choices: [
        { unitId: "", objectiveId: "" },
        { unitId: "", objectiveId: "" },
      ],
      revisionPlanId: null,
    });
    setPlanReview(null);
    setPlanReviewChanged(false);
  };
  const reviseOperatorPlan = (plan: ReturnType<typeof plansInRun>[number]) => {
    setPlaying(false);
    setTime(plan.second);
    setComparisonSecond(plan.second);
    setPlanDraft({
      runId: run.id,
      second: plan.second,
      name: `${plan.name} revision`,
      choices: plan.orders
        .map((order) => ({
          unitId: order.unitId,
          objectiveId: order.objectiveId ?? "",
        }))
        .slice(0, 2) as PlanDraft["choices"],
      revisionPlanId: plan.id,
    });
    setPlanReview(null);
    setPlanReviewChanged(false);
  };
  const reviewOperatorPlan = () => {
    if (
      !planDraft ||
      planDraft.runId !== run.id ||
      time < planDraft.second ||
      displaySecond !== planDraft.second ||
      !draftBaseRun ||
      !draftView
    ) {
      setToast("Return to the plan's selected replay time before review.");
      return;
    }
    setPlaying(false);
    setPlanReview(
      assessOperatorPlan(draftView, source.graph, planDraft, draftBaseRun),
    );
    setPlanReviewChanged(false);
  };
  const confirmOperatorPlan = () => {
    if (
      !planReview ||
      planReview.draft.runId !== run.id ||
      displaySecond !== planReview.draft.second
    ) {
      setPlanReviewChanged(true);
      return;
    }
    const draft = planReview.draft;
    const base = planBaseRun(run, draft.second, draft.revisionPlanId);
    const currentView = source.snapshot(draft.second, base);
    const checked = assessOperatorPlan(currentView, source.graph, draft, base);
    if (checked.issues.length) {
      setPlanReview(checked);
      setPlanReviewChanged(true);
      return;
    }
    if (checked.basis !== planReview.basis) {
      setPlanReview(checked);
      setPlanReviewChanged(true);
      return;
    }
    const id = `run-${runs.length + 1}`;
    const planId = `${id}-plan-${draft.second}`;
    const orders = linkedPlanOrders(
      checked.items,
      draft.second,
      planId,
      draft.name.trim(),
    );
    setRuns((items) => [
      ...items,
      {
        ...base,
        id,
        name: draft.name.trim(),
        parentId: run.id,
        branchSecond: draft.second,
        actions: [...base.actions, ...orders],
      },
    ]);
    setActiveRunId(id);
    setComparisonSecond(draft.second);
    setComparedThrough((items) => ({ ...items, [id]: draft.second }));
    setPlanDraft(null);
    setPlanReview(null);
    setPlanReviewChanged(false);
    setToast(
      "Two simulated orders recorded as one operator plan. No instructions were sent.",
    );
  };
  const saveNoOrderReference = () => {
    const plan = currentPlans.find((item) => item.second === comparisonSecond);
    if (!plan) return;
    const base = planBaseRun(run, comparisonSecond, plan.id);
    const id = `run-${runs.length + 1}`;
    setRuns((items) => [
      ...items,
      {
        ...base,
        id,
        name: `No new orders at ${elapsed(comparisonSecond)}`,
        parentId: run.id,
        branchSecond: comparisonSecond,
      },
    ]);
    setActiveRunId(id);
    setPlaying(false);
    setTime(comparisonSecond);
    setPlanDraft(null);
    setPlanReview(null);
    setComparedThrough((items) => ({ ...items, [id]: comparisonSecond }));
  };
  const seek = (value: number) => {
    playbackGenerationRef.current++;
    setPlaying(false);
    const next = Math.max(0, Math.min(DURATION, value));
    setTime(next);
    setComparedThrough((items) => ({
      ...items,
      [activeRunId]: Math.max(items[activeRunId] ?? 0, Math.floor(next)),
    }));
  };
  const reset = () => {
    playbackGenerationRef.current++;
    setPlaying(false);
    setTime(0);
    setRate(1);
    setRuns([
      {
        id: "run-1",
        name: "Original run",
        seed: scenarioSeed,
        actions: [],
        outages: [],
      },
    ]);
    setActiveRunId("run-1");
    setObjectiveSelections({});
    setPendingOrder(null);
    setPendingSignal(false);
    setScenarioReview(null);
    setReviewChanged(false);
    setReviewUnavailable(false);
    setPlanDraft(null);
    setPlanReview(null);
    setPlanReviewChanged(false);
    setComparisonSecond(0);
    setComparedThrough({});
    setSelectedUnit(null);
    setFollowing(false);
    setCameraRequest(null);
    setToast("Scenario reset. Manual actions cleared.");
  };
  const scheduled: ActivityEvent[] = [
    {
      id: "opened",
      incidentId: INCIDENT.id,
      kind: "incident",
      scenarioSecond: 0,
      displayTimestamp: displayTimestamp(0),
      text: "Incident opened. Initial confirmed device report received.",
    },
    {
      id: "outage",
      incidentId: INCIDENT.id,
      kind: "signal_change",
      scenarioSecond: 60,
      displayTimestamp: displayTimestamp(60),
      text: "Scheduled vehicle signal loss started. Last confirmed report retained.",
    },
    ...(snapshot.confirmedReports.some((report) => report.id === "vehicle-90")
      ? [
          {
            id: "resumed",
            incidentId: INCIDENT.id,
            kind: "device_report" as const,
            scenarioSecond: 90,
            displayTimestamp: displayTimestamp(90),
            deviceTimestamp: displayTimestamp(90),
            text: "New confirmed device report received after outage.",
          },
        ]
      : []),
    {
      id: "complete",
      incidentId: INCIDENT.id,
      kind: "incident",
      scenarioSecond: 180,
      displayTimestamp: displayTimestamp(180),
      text: "Scenario complete. Replay available.",
    },
  ];
  const activity = [
    ...scheduled,
    ...run.outages.flatMap((outage, index): ActivityEvent[] => [
      {
        id: `${run.id}-signal-start-${index}`,
        incidentId: INCIDENT.id,
        kind: "operator_action",
        scenarioSecond: outage.start,
        displayTimestamp: displayTimestamp(outage.start),
        text: "Manual simulated signal loss started.",
      },
      ...(Number.isFinite(outage.end)
        ? [
            {
              id: `${run.id}-signal-end-${index}`,
              incidentId: INCIDENT.id,
              kind: "operator_action" as const,
              scenarioSecond: outage.end,
              displayTimestamp: displayTimestamp(outage.end),
              text: "Manual simulated signal loss ended. Awaiting next device report.",
            },
          ]
        : []),
    ]),
    ...snapshot.coordinationEvents,
    ...run.actions.map((a) => ({
      id: a.id,
      incidentId: INCIDENT.id,
      kind: "operator_action" as const,
      scenarioSecond: a.second,
      displayTimestamp: displayTimestamp(a.second),
      text: `${a.planId ? `${a.planName ?? "Operator plan"} · ` : ""}${INITIAL_UNITS.find((u) => u.id === a.unitId)?.name} ${a.kind === "release" ? "released" : `${a.kind === "retask" ? "retasked" : "assigned"} to ${a.objectiveId === "last-confirmed" ? "last confirmed vehicle position" : (snapshot.objectives.find((o) => o.id === a.objectiveId)?.name ?? "junction")}`} (simulation only).`,
    })),
  ]
    .filter((e) => e.scenarioSecond <= time)
    .sort((a, b) => b.scenarioSecond - a.scenarioSecond)
    .slice(0, 5);
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const approachLabel = (id: string) => {
    const edge = source.graph.edges.find((candidate) => candidate.id === id);
    const objective = snapshot.objectives.find((item) =>
      item.visibleApproachEdgeIds?.includes(id),
    );
    return `${edge?.name ?? "Road approach"} toward ${objective?.name ?? "junction"}`;
  };
  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ⌖
          </span>
          <div>
            RECOVERY <span>CONSOLE</span>
            <small>Incident workspace</small>
          </div>
        </div>
        <div className="header-context">
          <span className="header-divider" />
          <strong>{INCIDENT.id}</strong>
          <span>{INCIDENT.area}</span>
        </div>
        <div className="header-end">
          <span className="demo-label">SIMULATION · SYNTHETIC DATA</span>
          <button className="quiet" onClick={() => setRoadmap(true)}>
            AI roadmap ↗
          </button>
        </div>
      </header>
      <main className="workspace">
        <aside className="incident-panel">
          <div className="section-kicker">
            ACTIVE INCIDENT <span>01</span>
          </div>
          <h1>Vehicle recovery</h1>
          <p className="muted intro">Training scenario · synthetic telemetry</p>
          <section className="vehicle-card">
            <div className="eyebrow">
              <span className="target-dot" /> VEHICLE OF INTEREST
            </div>
            <h2>White SUV</h2>
            <div className="vehicle-id">
              DEMO 042 GP <span>Simulated</span>
            </div>
            <div
              className={`signal ${snapshot.connectivity === "signal_lost" ? "stale" : "good"}`}
            >
              {snapshot.connectivity === "signal_lost"
                ? "Last confirmed position"
                : "Receiving simulated reports"}
            </div>
            <div className="metrics">
              <div>
                <span>Last reported speed</span>
                <strong>
                  {report.speedKmh} <small>km/h</small>
                </strong>
              </div>
              <div>
                <span>Last reported heading</span>
                <strong>
                  {dirs[Math.round(report.headingDegrees / 45) % 8]}{" "}
                  <small>
                    {String(Math.round(report.headingDegrees)).padStart(3, "0")}
                    °
                  </small>
                </strong>
              </div>
            </div>
            <div className="detail-row">
              <span>Report age at display time</span>
              <strong>{snapshot.reportAgeSeconds} seconds</strong>
            </div>
            <div className="detail-row">
              <span>Device report time</span>
              <strong>
                {new Date(report.deviceTimestamp).toLocaleTimeString("en-GB", {
                  timeZone: "Africa/Johannesburg",
                  hour12: false,
                })}{" "}
                SAST
              </strong>
            </div>
            <div className="detail-row">
              <span>Server receipt time</span>
              <strong>
                {new Date(report.serverReceiptTimestamp).toLocaleTimeString(
                  "en-GB",
                  { timeZone: "Africa/Johannesburg", hour12: false },
                )}{" "}
                SAST
              </strong>
            </div>
            <div className="detail-row">
              <span>GPS accuracy</span>
              <strong>
                ± {report.accuracyMetres} m{" "}
                <span className="muted">(demo)</span>
              </strong>
            </div>
            <div className="location-box">
              <span>LAST CONFIRMED DEVICE COORDINATES</span>
              <strong>{formatCoordinates(report.coordinates)}</strong>
              <small>Simulated reports on a real road route near Sandton</small>
            </div>
            <button
              className="primary full"
              aria-pressed={following}
              onClick={selectVehicle}
            >
              {following ? "Following vehicle" : "Follow vehicle"}
            </button>
          </section>
          <section className="incident-summary">
            <div className="section-kicker">INCIDENT SUMMARY</div>
            <div className="detail-row">
              <span>Opened</span>
              <strong>14:32:00 SAST</strong>
            </div>
            <div className="detail-row">
              <span>Units assigned</span>
              <strong>
                {INITIAL_UNITS.filter((u) => assignedAt(u.id)).length} of 3
              </strong>
            </div>
            <div className="detail-row">
              <span>Data source</span>
              <strong>Scenario generator</strong>
            </div>
          </section>
          <div className="scope-note">
            <span className="note-icon">i</span>
            <p>
              Prototype for discussion. All vehicles, assignments and reports
              are simulated.
            </p>
          </div>
        </aside>
        <CesiumMap
          snapshot={snapshot}
          selectedUnit={selectedUnit}
          following={following}
          fullPageMap={fullPageMap}
          onToggleFullPageMap={() => setFullPageMap((current) => !current)}
          cameraRequest={cameraRequest}
          onSelectUnit={selectUnit}
          onFollow={selectVehicle}
          onFit={fitAll}
        />
        <aside className="units-panel">
          <div className="units-heading">
            <div className="section-kicker">RESPONSE TEAM</div>
          </div>
          <CollapsiblePanel
            id="scenario"
            title="Scenario analysis"
            className="scenario-analysis"
            expanded={expandedSections.scenario}
            onToggle={() => toggleSection("scenario")}
          >
            <p>
              Transparent baseline alternatives for this replay moment. Each is
              a separate simulated order, not a multi-unit plan.
            </p>
            {alternatives.length ? (
              <ol>
                {alternatives.map((candidate) => {
                  const unit = snapshot.units.find(
                    (item) => item.unitId === candidate.unitId,
                  );
                  const unitAge = unit?.currentReport
                    ? Math.floor(
                        (Date.parse(snapshot.displayTimestamp) -
                          Date.parse(unit.currentReport.deviceTimestamp)) /
                          1000,
                      )
                    : 0;
                  return (
                    <li key={`${candidate.unitId}:${candidate.objectiveId}`}>
                      <strong>
                        {candidate.unitName} → {candidate.objectiveName}
                      </strong>
                      <span>
                        {candidate.action === "retask" ? "Retask" : "Assign"} ·
                        current-traffic route ETA about{" "}
                        {Math.ceil(candidate.trafficRouteSeconds)}s
                      </span>
                      <small>
                        Vehicle report {snapshot.reportAgeSeconds}s old · unit
                        report {unitAge}s old ·{" "}
                        {Math.round(candidate.features[8] * 3)} configured
                        visible approaches
                      </small>
                      <button
                        className="secondary"
                        onClick={() => {
                          setPlaying(false);
                          setScenarioReview(
                            createScenarioReview(snapshot, candidate, run.id),
                          );
                          setReviewChanged(false);
                          setReviewUnavailable(false);
                        }}
                        aria-label={`Review ${candidate.action} ${candidate.unitName} to ${candidate.objectiveName}`}
                      >
                        Review option
                      </button>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="analysis-unavailable">
                No eligible alternatives at this replay time. Check confirmed
                report ages and unit availability.
              </p>
            )}
            <small>
              Based on confirmed simulated reports, current displayed traffic,
              and mapped directed routes. Future traffic and vehicle movement
              are unknown. No order is placed by this analysis.
            </small>
          </CollapsiblePanel>
          {teamCoverage && (
            <CollapsiblePanel
              id="team"
              title="Team coverage"
              className="team-coverage"
              expanded={expandedSections.team}
              onToggle={() => toggleSection("team")}
            >
              <p>
                Configured approach coverage across current orders. Mapped
                buildings can block a simulated sighting; missing or incomplete
                footprints leave visibility uncertain. These are separate
                possible next orders, not a coordinated dispatch plan.
              </p>
              <p className="team-evidence">
                Last confirmed vehicle GPS report {snapshot.reportAgeSeconds}s
                old.
                {snapshot.observations.length > 0 && (
                  <>
                    {" "}
                    Latest simulated unit observation:{" "}
                    {snapshot.observations.at(-1)?.junction.name}, observed at{" "}
                    {elapsed(snapshot.observations.at(-1)!.observedSecond)} and
                    available at{" "}
                    {elapsed(snapshot.observations.at(-1)!.availableSecond)}.
                  </>
                )}{" "}
                {snapshot.connectivity === "signal_lost"
                  ? "GPS is lost; the vehicle's current position and next route are unknown."
                  : "The next vehicle route is unknown."}
              </p>
              {!teamCoverage.hasWellSupportedOrder && (
                <p className="team-no-order">
                  No well-supported additional order at this replay moment.
                </p>
              )}
              {teamCoverage.alternatives.length ? (
                <ol>
                  {teamCoverage.alternatives.map((option) => (
                    <li
                      key={`${option.candidate.unitId}:${option.candidate.objectiveId}`}
                    >
                      <strong>
                        {option.candidate.unitName} →{" "}
                        {option.candidate.objectiveName}
                      </strong>
                      <span className="team-evidence-label">
                        {option.exploratory
                          ? "Exploratory coverage alternative · no recent local approach observation"
                          : "Recent local approach observed · future route still unknown"}
                      </span>
                      <span>
                        Configured approaches: +
                        {option.gainedApproachIds.length} gained, −
                        {option.lostApproachIds.length} lost
                        {option.uncertainOverlapIds.length > 0 &&
                          ` · ${option.uncertainOverlapIds.length} may replace uncertain coverage`}
                        {option.uncertainLostApproachIds.length > 0 &&
                          ` · ${option.uncertainLostApproachIds.length} uncertain approaches relinquished`}
                        .
                      </span>
                      <span>
                        Route ETA about{" "}
                        {Math.ceil(option.candidate.trafficRouteSeconds)}s ·
                        earliest ready {elapsed(option.earliestReadySecond)} ·
                        earliest possible information{" "}
                        {elapsed(option.earliestPossibleAvailabilitySecond)} if
                        a valid sighting occurs (window ends{" "}
                        {elapsed(option.evaluationEndSecond)}).
                      </span>
                      <button
                        className="secondary"
                        onClick={() => {
                          setPlaying(false);
                          setScenarioReview(
                            createScenarioReview(
                              snapshot,
                              option.candidate,
                              run.id,
                              option,
                            ),
                          );
                          setReviewChanged(false);
                          setReviewUnavailable(false);
                        }}
                        aria-label={`Review team coverage ${option.candidate.action} ${option.candidate.unitName} to ${option.candidate.objectiveName}`}
                      >
                        Inspect alternative
                      </button>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="analysis-unavailable">
                  No timely nonduplicate alternative is eligible with current
                  confirmed reports.
                </p>
              )}
              {teamCoverage.duplicateExample && (
                <p className="team-demoted">
                  Not promoted:{" "}
                  {teamCoverage.duplicateExample.candidate.unitName}
                  {" → "}
                  {teamCoverage.duplicateExample.candidate.objectiveName} adds
                  no configured approach beyond another unit's confirmed post
                  and would lose{" "}
                  {teamCoverage.duplicateExample.lostApproachIds.length} at its
                  current confirmed post.
                  {!teamCoverage.duplicateExample.fitsWindow &&
                    " Its earliest possible information also falls outside the remaining evaluation window."}
                </p>
              )}
              <small>
                Coverage means configured approaches only. A vehicle traversal,
                75 m range, visibility, and the two-second delivery delay are
                still required. No option predicts a sighting or places an
                order.
              </small>
            </CollapsiblePanel>
          )}
          <CollapsiblePanel
            id="plan"
            title="Operator plan"
            className="operator-plan"
            expanded={expandedSections.plan}
            onToggle={() => toggleSection("plan")}
          >
            <p>
              Author two simulated orders for the same replay second. Coverage
              describes configured approaches, not a predicted sighting.
            </p>
            <button className="secondary" onClick={beginOperatorPlan}>
              Build two-unit plan at {elapsed(displaySecond)}
            </button>
            {currentPlans.length > 0 && (
              <div className="saved-plans">
                <strong>Plans in this run</strong>
                {currentPlans.map((plan) => (
                  <div key={plan.id} className="saved-plan-row">
                    <span>
                      {plan.name} · {elapsed(plan.second)}
                    </span>
                    <button
                      className="quiet"
                      onClick={() => reviseOperatorPlan(plan)}
                      aria-label={`Revise ${plan.name}`}
                    >
                      Revise plan
                    </button>
                  </div>
                ))}
              </div>
            )}
            {planDraft?.runId === run.id && (
              <div className="plan-composer">
                <h3>
                  {planDraft.revisionPlanId
                    ? "Revise linked plan"
                    : "New two-unit plan"}
                </h3>
                <p>
                  Decision time {elapsed(planDraft.second)} in {run.name}.
                  {displaySecond !== planDraft.second &&
                    " Return to that replay time to review."}
                </p>
                <label>
                  Plan name
                  <input
                    aria-label="Plan name"
                    value={planDraft.name}
                    onChange={(event) =>
                      setPlanDraft((current) =>
                        current
                          ? { ...current, name: event.target.value }
                          : current,
                      )
                    }
                  />
                </label>
                {planDraft.choices.map((choice, index) => (
                  <div className="plan-choice" key={index}>
                    <strong>Order {index + 1}</strong>
                    <label>
                      Unit
                      <select
                        aria-label={`Plan order ${index + 1} unit`}
                        value={choice.unitId}
                        onChange={(event) =>
                          setPlanDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  choices: current.choices.map((item, at) =>
                                    at === index
                                      ? { ...item, unitId: event.target.value }
                                      : item,
                                  ) as PlanDraft["choices"],
                                }
                              : current,
                          )
                        }
                      >
                        <option value="">Choose unit</option>
                        {draftView?.units.map((unit) => (
                          <option key={unit.unitId} value={unit.unitId}>
                            {unit.unitName}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Named junction
                      <select
                        aria-label={`Plan order ${index + 1} junction`}
                        value={choice.objectiveId}
                        onChange={(event) =>
                          setPlanDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  choices: current.choices.map((item, at) =>
                                    at === index
                                      ? {
                                          ...item,
                                          objectiveId: event.target.value,
                                        }
                                      : item,
                                  ) as PlanDraft["choices"],
                                }
                              : current,
                          )
                        }
                      >
                        <option value="">Choose junction</option>
                        {draftView?.objectives.map((objective) => (
                          <option key={objective.id} value={objective.id}>
                            {objective.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                ))}
                {draftAssessment?.issues.length ? (
                  <p className="plan-issues" role="status">
                    {draftAssessment.issues.join(" ")}
                  </p>
                ) : (
                  <p className="team-evidence">
                    Both orders are eligible for review at this replay time.
                  </p>
                )}
                <p className="muted">
                  {draftBaseRun?.actions.filter(
                    (action) => action.second === planDraft.second,
                  ).length ?? 0}{" "}
                  existing same-second orders stay before this plan.{" "}
                  {
                    run.actions.filter(
                      (action) => action.second > planDraft.second,
                    ).length
                  }{" "}
                  later unit orders stay in the saved run.
                </p>
                <div className="branch-actions">
                  <button
                    className="secondary"
                    onClick={() => setPlanDraft(null)}
                  >
                    Cancel plan draft
                  </button>
                  <button
                    className="primary"
                    disabled={
                      displaySecond !== planDraft.second ||
                      Boolean(draftAssessment?.issues.length)
                    }
                    onClick={reviewOperatorPlan}
                  >
                    Review combined plan
                  </button>
                </div>
              </div>
            )}
          </CollapsiblePanel>
          <CollapsiblePanel
            id="units"
            title="Units in view"
            count={snapshot.units.length}
            className="units-section"
            expanded={expandedSections.units}
            onToggle={() => toggleSection("units")}
          >
            <p className="muted unit-caption">
              Choose an objective to send a simulated unit from its own
              position.
            </p>
            <div id="unitList">
              {snapshot.units.map((u) => {
                const assigned = assignedAt(u.unitId);
                const coordinates = validUnitPosition(u);
                const currentReport = coordinates ? u.currentReport : null;
                const activeObjective = snapshot.unitObjectives[u.unitId];
                const planned = snapshot.plannedRoutes.find(
                  (route) => route.unitId === u.unitId,
                );
                return (
                  <article
                    className={`unit-card ${selectedUnit === u.unitId ? "selected" : ""} ${coordinates ? "" : "unavailable"}`}
                    key={u.unitId}
                  >
                    <div className="unit-top">
                      <button
                        className="unit-select"
                        onClick={() => selectUnit(u.unitId)}
                        aria-pressed={selectedUnit === u.unitId}
                      >
                        <span className="unit-dot" />
                        {u.unitName}
                      </button>
                      <span
                        className={`unit-tag ${assigned ? "assigned" : ""}`}
                      >
                        {snapshot.unitStatuses[u.unitId] === "on_post"
                          ? "On post"
                          : snapshot.unitStatuses[u.unitId] === "en_route"
                            ? "Responding"
                            : assigned
                              ? "Awaiting objective"
                              : "Available"}
                      </span>
                    </div>
                    <div
                      className={`unit-coordinates ${coordinates ? "" : "unavailable"}`}
                    >
                      {coordinates
                        ? formatCoordinates(coordinates)
                        : "Position unavailable · no current confirmed report"}
                    </div>
                    <div className="unit-bottom">
                      <small>
                        {currentReport
                          ? `Reported ${Math.floor(
                              time -
                                (Date.parse(currentReport.deviceTimestamp) -
                                  Date.parse(INCIDENT.openedAt)) /
                                  1000,
                            )}s ago`
                          : "Awaiting a valid unit report"}
                      </small>
                      <button
                        className="assign-button"
                        onClick={() =>
                          orderUnit(u.unitId, assigned ? "release" : "assign")
                        }
                        aria-label={`${assigned ? "Release" : "Assign and move"} ${u.unitName}`}
                        disabled={!assigned && !coordinates}
                      >
                        {assigned ? "Release" : "Assign and move"}
                      </button>
                    </div>
                    <label className="objective-control">
                      Objective
                      <select
                        aria-label={`${u.unitName} objective`}
                        value={
                          objectiveSelections[u.unitId] ??
                          activeObjective?.id ??
                          ""
                        }
                        onChange={(event) =>
                          setObjectiveSelections((items) => ({
                            ...items,
                            [u.unitId]: event.target.value,
                          }))
                        }
                      >
                        <option value="">Choose objective</option>
                        <option value="last-confirmed">
                          Last confirmed vehicle position
                        </option>
                        {snapshot.objectives.map((objective) => (
                          <option key={objective.id} value={objective.id}>
                            {objective.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {activeObjective && (
                      <div className="unit-plan">
                        <strong>Objective: {activeObjective.name}</strong>
                        <span>
                          Simulated route · ETA{" "}
                          {planned?.etaSeconds === null
                            ? "unavailable"
                            : `${planned?.etaSeconds ?? 0}s`}
                        </span>
                      </div>
                    )}
                    {assigned && (
                      <button
                        className="retask-button"
                        onClick={() => orderUnit(u.unitId, "retask")}
                        disabled={
                          !coordinates ||
                          !(
                            objectiveSelections[u.unitId] ?? activeObjective?.id
                          )
                        }
                      >
                        Retask {u.unitName}
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
          </CollapsiblePanel>
          <section className="activity">
            <div className="section-kicker">INCIDENT ACTIVITY</div>
            <ol>
              {activity.map((e) => (
                <li key={e.id} className={`activity-${e.kind}`}>
                  <time>
                    {new Date(e.displayTimestamp).toLocaleTimeString("en-GB", {
                      timeZone: "Africa/Johannesburg",
                      hour12: false,
                    })}
                  </time>
                  {e.text}
                </li>
              ))}
            </ol>
          </section>
        </aside>
        <section className="replay-panel" aria-label="Scenario playback">
          <div className="replay-head">
            <div>
              <span className="section-kicker">SCENARIO REPLAY</span>
              <span className="replay-caption">
                Simulated device reports every 5 seconds
              </span>
            </div>
            <span className="replay-status">
              {playing ? "PLAYING" : time >= DURATION ? "COMPLETE" : "PAUSED"}
            </span>
          </div>
          <div className="run-selection">
            <label>
              Scenario run
              <select
                value={activeRunId}
                onChange={(event) => {
                  setPlaying(false);
                  setActiveRunId(event.target.value);
                  setPlanDraft(null);
                  setPlanReview(null);
                }}
              >
                {runs.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.branchSecond !== undefined
                      ? ` · branched at ${elapsed(item.branchSecond)}`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <span>
              Seeded simulation · {COORDINATION_SIMULATOR_VERSION} · alternative
              runs remain in this browser session
            </span>
          </div>
          <div className="playback-row">
            <button
              className="play-button"
              aria-label={playing ? "Pause scenario" : "Play scenario"}
              onClick={() => {
                if (time >= DURATION) setTime(0);
                setPlaying((v) => !v);
              }}
            >
              {playing ? "Ⅱ" : "▶"}
            </button>
            <button
              className="reset-button"
              aria-label="Reset scenario"
              onClick={reset}
            >
              ↺
            </button>
            <div className="timeline-block">
              <div className="timeline-labels">
                <strong>{clock(time)}</strong>
                <span>{elapsed(time)} / 03:00</span>
              </div>
              <input
                aria-label="Scenario time in seconds"
                type="range"
                min="0"
                max="180"
                value={Math.floor(time)}
                step="1"
                onChange={(e) => seek(Number(e.target.value))}
              />
              <div className="timeline-markers">
                <span>Incident opened</span>
                <span>Signal loss · 01:00–01:30</span>
                <span>End · 03:00</span>
              </div>
            </div>
            <label className="speed-control">
              Speed
              <select
                value={rate}
                onChange={(e) => setRate(Number(e.target.value))}
              >
                <option value="1">1×</option>
                <option value="2">2×</option>
                <option value="4">4×</option>
              </select>
            </label>
            <button
              className="secondary"
              disabled={time >= 60 && time < 90}
              onClick={toggleSignal}
            >
              {manualActive ? "Restore signal" : "Simulate signal loss"}
            </button>
          </div>
          {runs.length > 1 && (
            <section className="run-comparison" aria-label="Compare runs">
              <div className="section-kicker">RUN COMPARISON</div>
              <p>
                Compare confirmed simulation runs from the same pre-decision
                state. Each result appears only after that run is replayed to
                the displayed time or its evaluation deadline.
              </p>
              <label>
                Comparison decision second
                <input
                  type="number"
                  min="0"
                  max="180"
                  step="1"
                  value={comparisonSecond}
                  onChange={(event) =>
                    setComparisonSecond(
                      Math.max(
                        0,
                        Math.min(DURATION, Number(event.target.value) || 0),
                      ),
                    )
                  }
                />
              </label>
              {currentPlans.some(
                (plan) => plan.second === comparisonSecond,
              ) && (
                <button className="secondary" onClick={saveNoOrderReference}>
                  Save no-new-order reference at {elapsed(comparisonSecond)}
                </button>
              )}
              <div className="comparison-grid">
                {runs.map((item) => {
                  const reasons = compareRunBasis(
                    run,
                    item,
                    comparisonSecond,
                    comparisonThrough,
                  );
                  const revealed =
                    (comparedThrough[item.id] ?? 0) >= comparisonThrough;
                  const showOutcome =
                    reasons.length === 0 &&
                    displaySecond > comparisonSecond &&
                    !playing &&
                    revealed;
                  const observations = showOutcome
                    ? comparisonObservations(
                        source.snapshot(comparisonThrough, item),
                        comparisonSecond,
                        comparisonThrough,
                      )
                    : [];
                  const complete = comparisonThrough >= comparisonEnd;
                  const newPlanOrders = item.actions.filter(
                    (action) =>
                      action.second === comparisonSecond && action.planId,
                  ).length;
                  return (
                    <article key={item.id} className="comparison-run">
                      <strong>{item.name}</strong>
                      <small className="comparison-window">
                        Decision {elapsed(comparisonSecond)} ·{" "}
                        {comparisonEnd === comparisonSecond + 90
                          ? "90-second deadline"
                          : "Replay-end deadline"}{" "}
                        {elapsed(comparisonEnd)} · {newPlanOrders} linked plan{" "}
                        {newPlanOrders === 1 ? "order" : "orders"}
                      </small>
                      {reasons.length > 0 ? (
                        <p className="comparison-incompatible">
                          Cannot compare: {reasons.join(" ")}
                        </p>
                      ) : comparisonEnd === comparisonSecond ? (
                        <p>No evaluation time remains at this decision time.</p>
                      ) : displaySecond <= comparisonSecond ? (
                        <p>
                          Advance past {elapsed(comparisonSecond)} to reveal
                          outcomes.
                        </p>
                      ) : playing ? (
                        <p>Pause replay to compare outcomes at this time.</p>
                      ) : !revealed ? (
                        <button
                          className="secondary"
                          onClick={() => {
                            setPlaying(false);
                            setActiveRunId(item.id);
                            setTime(comparisonThrough);
                            setComparedThrough((states) => ({
                              ...states,
                              [item.id]: Math.max(
                                states[item.id] ?? 0,
                                comparisonThrough,
                              ),
                            }));
                          }}
                        >
                          Replay {item.name} to {elapsed(comparisonThrough)}
                        </button>
                      ) : (
                        <div className="comparison-outcome">
                          <span>
                            {complete ? "Completed window" : "Partial replay"} ·
                            available by {elapsed(comparisonThrough)}
                          </span>
                          {observations.length ? (
                            <>
                              <p>
                                {observations.length} valid simulated unit{" "}
                                {observations.length === 1
                                  ? "observation"
                                  : "observations"}
                                {complete ? " by the deadline" : " so far"} ·
                                first available{" "}
                                {elapsed(
                                  Math.min(
                                    ...observations.map(
                                      (observation) =>
                                        observation.availableSecond,
                                    ),
                                  ),
                                )}
                              </p>
                              <ul>
                                {observations.map((observation) => (
                                  <li key={observation.id}>
                                    {observation.unitName} at{" "}
                                    {observation.junction.name} · observed{" "}
                                    {elapsed(observation.observedSecond)} ·
                                    available{" "}
                                    {elapsed(observation.availableSecond)}
                                  </li>
                                ))}
                              </ul>
                            </>
                          ) : (
                            <p>
                              {complete
                                ? `No valid observation available by the ${elapsed(comparisonEnd)} deadline.`
                                : `No valid observation available yet by ${elapsed(comparisonThrough)}; the window remains open until ${elapsed(comparisonEnd)}.`}
                            </p>
                          )}
                          {complete &&
                            controlObservations &&
                            noNewPlanOrderRun && (
                              <p className="comparison-paired">
                                {item.id === noNewPlanOrderRun.id
                                  ? "Compatible no-new-plan-order control."
                                  : `${noNewPlanOrderRun.name}: ${
                                      observations.length &&
                                      controlObservations.length
                                        ? "both runs had an observation"
                                        : observations.length
                                          ? "observation in this run only"
                                          : controlObservations.length
                                            ? "observation in the control only"
                                            : "neither run had an observation"
                                    } by the deadline.`}
                              </p>
                            )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
              {!noNewPlanOrderRun && (
                <p className="comparison-incompatible">
                  No compatible run without new linked plan orders is available
                  for a paired control at this decision time. Open a plan run to
                  save its no-new-order reference.
                </p>
              )}
            </section>
          )}
        </section>
      </main>
      {roadmap && (
        <div className="dialog-backdrop" onClick={() => setRoadmap(false)}>
          <div
            className="roadmap-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="AI roadmap"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="close-dialog"
              aria-label="Close roadmap"
              onClick={() => setRoadmap(false)}
            >
              ×
            </button>
            <div className="section-kicker">PRODUCT ROADMAP</div>
            <h2>
              From shared visibility
              <br />
              to decision support.
            </h2>
            <p>
              An offline synthetic ranking experiment was trained and tested. It
              did not pass its held-out display gate, so this prototype shows no
              AI-generated options.
            </p>
            <ol>
              <li>Authorised incident and telemetry integration</li>
              <li>Shared assignment acknowledgements and audit trail</li>
              <li>
                Evaluate options against recorded or simulated scenarios, state
                uncertainty, and leave decisions with trained operators
              </li>
            </ol>
          </div>
        </div>
      )}
      {planReview && (
        <div className="dialog-backdrop">
          <div
            className="roadmap-dialog operator-plan-review"
            role="dialog"
            aria-modal="true"
            aria-label="Review operator plan"
          >
            <div className="section-kicker">
              OPERATOR PLAN · COMBINED REVIEW
            </div>
            <h2>{planReview.draft.name}</h2>
            {planReviewChanged && (
              <p className="review-changed" role="status">
                Replay information or the selected time changed. Review the
                updated plan at {elapsed(planReview.draft.second)} before
                confirming again.
              </p>
            )}
            <p>
              Two simulated orders at {elapsed(planReview.draft.second)} in{" "}
              {run.name}. Existing unrelated orders at that same second stay
              first. The two plan orders then apply in ascending unit ID order.
              Confirmation saves a separate run.
            </p>
            <ol className="plan-review-orders">
              {[...planReview.items]
                .sort(
                  (a, b) =>
                    a.unitId.localeCompare(b.unitId) ||
                    a.objectiveId.localeCompare(b.objectiveId),
                )
                .map((item) => (
                  <li key={item.unitId}>
                    <strong>
                      {item.kind === "retask" ? "Retask" : "Assign"}{" "}
                      {item.unitName} → {item.objectiveName}
                    </strong>
                    <span>
                      Confirmed unit report{" "}
                      {Math.floor(item.unitReportAgeSeconds)}s old ·
                      current-traffic legal-route ETA about{" "}
                      {Math.ceil(item.routeSeconds)}s
                    </span>
                    <span>
                      Earliest ready {elapsed(item.earliestReadySecond)} ·
                      earliest possible information{" "}
                      {elapsed(item.earliestInformationSecond)}
                    </span>
                  </li>
                ))}
            </ol>
            <p>
              Combined configured approaches: {planReview.coverage.before}{" "}
              before → {planReview.coverage.after} with this plan; +
              {planReview.coverage.gained.length} gained, −
              {planReview.coverage.lostConfirmed.length} lost from fresh
              reported near-post positions, −
              {planReview.coverage.lostUncertain.length} from uncertain posts.
              Target-to-target overlap{" "}
              {planReview.coverage.targetOverlap.length}; overlap with retained
              posts {planReview.coverage.incumbentOverlap.length}.
            </p>
            <details>
              <summary>Inspect approach changes</summary>
              <p>
                Gained:{" "}
                {planReview.coverage.gained.map(approachLabel).join("; ") ||
                  "none"}
              </p>
              <p>
                Lost from fresh reported near-post positions:{" "}
                {planReview.coverage.lostConfirmed
                  .map(approachLabel)
                  .join("; ") || "none"}
              </p>
              <p>
                Lost from uncertain posts:{" "}
                {planReview.coverage.lostUncertain
                  .map(approachLabel)
                  .join("; ") || "none"}
              </p>
              <p>
                Overlapping targets:{" "}
                {planReview.coverage.targetOverlap
                  .map(approachLabel)
                  .join("; ") || "none"}
              </p>
            </details>
            <p>
              Last confirmed simulated vehicle GPS report{" "}
              {planReview.vehicleReportAgeSeconds}s old.{" "}
              {planReview.signalLost
                ? "GPS is lost; the current vehicle position and next route are unknown."
                : "The next vehicle route is unknown."}{" "}
              Current simulated traffic may change. The window ends{" "}
              {elapsed(planReview.evaluationEndSecond)}.
            </p>
            <p>
              Readiness and coverage are possibilities only. A visible vehicle
              approach, 75 m range, dwell and availability rules must still be
              met. This review does not reveal a future observation.
            </p>
            {run.actions.some(
              (action) => action.second > planReview.draft.second,
            ) && (
              <p>
                Later unit orders remain in the saved run and are excluded from
                this new alternative.
              </p>
            )}
            {planReview.issues.length > 0 && (
              <p className="plan-issues" role="status">
                Cannot confirm either order: {planReview.issues.join(" ")}
              </p>
            )}
            <div className="branch-actions">
              <button className="secondary" onClick={() => setPlanReview(null)}>
                Close plan review
              </button>
              <button
                className="primary"
                disabled={planReview.issues.length > 0}
                onClick={confirmOperatorPlan}
              >
                Confirm simulated plan
              </button>
            </div>
          </div>
        </div>
      )}
      {scenarioReview && (
        <div className="dialog-backdrop">
          <div
            className="roadmap-dialog scenario-review"
            role="dialog"
            aria-modal="true"
            aria-label="Review scenario analysis option"
          >
            <div className="section-kicker">
              {scenarioReview.team
                ? "TEAM COVERAGE · ORDER REVIEW"
                : "SCENARIO ANALYSIS · ORDER REVIEW"}
            </div>
            <h2>
              {scenarioReview.candidate.action === "retask"
                ? "Retask"
                : "Assign"}{" "}
              {scenarioReview.candidate.unitName}
            </h2>
            {reviewUnavailable ? (
              <p role="status">
                This option is no longer eligible in the current replay view.
                Close this review and choose a current alternative.
              </p>
            ) : (
              <>
                {reviewChanged && (
                  <p role="status" className="review-changed">
                    Replay information changed. Review these updated details,
                    then confirm again if you still want this order.
                  </p>
                )}
                <p>
                  Objective: {scenarioReview.candidate.objectiveName}. Order at{" "}
                  {elapsed(scenarioReview.displaySecond)} in{" "}
                  {runs.find((item) => item.id === scenarioReview.runId)
                    ?.name ?? "this run"}
                  .
                </p>
                <p>
                  Estimated legal-route travel time with currently displayed
                  traffic: about{" "}
                  {Math.ceil(scenarioReview.candidate.trafficRouteSeconds)}s.
                  This is not an observation prediction. The vehicle may take
                  another approach, traffic may change, or visibility may block
                  a sighting.
                </p>
                {scenarioReview.team && (
                  <p>
                    Configured approach change: +
                    {scenarioReview.team.gainedApproachIds.length} gained, −
                    {scenarioReview.team.lostApproachIds.length} lost. Earliest
                    possible information{" "}
                    {elapsed(
                      scenarioReview.team.earliestPossibleAvailabilitySecond,
                    )}{" "}
                    if a valid sighting occurs; evaluation window ends{" "}
                    {elapsed(scenarioReview.team.evaluationEndSecond)}.{" "}
                    {scenarioReview.team.exploratory
                      ? "Exploratory: no recent local approach observation supports this destination."
                      : "A recent local approach was observed; the future route remains unknown."}
                  </p>
                )}
                {hasFutureActions && (
                  <p>
                    Confirming creates an alternative run at this replay time;
                    later actions remain in the saved run.
                  </p>
                )}
              </>
            )}
            <div className="branch-actions">
              <button
                className="secondary"
                onClick={() => setScenarioReview(null)}
              >
                Close review
              </button>
              {!reviewUnavailable && (
                <button className="primary" onClick={confirmScenarioOrder}>
                  Confirm simulated order
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {(pendingOrder || pendingSignal) && (
        <div className="dialog-backdrop">
          <div
            className="roadmap-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Create alternative run"
          >
            <div className="section-kicker">REPLAY BRANCH</div>
            <h2>Create an alternative run?</h2>
            <p>
              New {pendingSignal ? "signal action" : "unit order"} at{" "}
              {elapsed(displaySecond)}. Later actions from {run.name} stay in
              that saved run. The new run replays from this branch point.
            </p>
            <div className="branch-actions">
              <button
                className="secondary"
                onClick={() => {
                  setPendingOrder(null);
                  setPendingSignal(false);
                }}
              >
                Cancel
              </button>
              <button
                className="primary"
                onClick={() =>
                  pendingOrder
                    ? commitOrder(pendingOrder, true)
                    : commitSignal(true)
                }
              >
                Create alternative run
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}
