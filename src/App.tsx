import { useEffect, useMemo, useRef, useState } from "react";
import { CesiumMap, type CameraRequest } from "./components/CesiumMap";
import type { ActivityEvent, Coordinates, Outage } from "./model";
import {
  CoordinatedIncidentSource,
  CoordinationGraph,
  type Order,
  type ScenarioRun,
} from "./coordination";
import { validUnitPosition } from "./unitPosition";
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
  const [selectedUnit, setSelectedUnit] = useState<string | null>(null),
    [following, setFollowing] = useState(false),
    [cameraRequest, setCameraRequest] = useState<CameraRequest | null>(null),
    [roadmap, setRoadmap] = useState(false),
    [toast, setToast] = useState("");
  const cameraSequenceRef = useRef(0);
  const playbackGenerationRef = useRef(0);
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
        setSource(
          new CoordinatedIncidentSource(
            new CoordinationGraph(data),
            unavailableUnitIds,
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
  if (!snapshot || !source)
    return (
      <div className="loading">
        {loadError || "Loading simulated incident…"}
      </div>
    );
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
  const seek = (value: number) => {
    playbackGenerationRef.current++;
    setPlaying(false);
    setTime(Math.max(0, Math.min(DURATION, value)));
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
      text: `${INITIAL_UNITS.find((u) => u.id === a.unitId)?.name} ${a.kind === "release" ? "released" : `${a.kind === "retask" ? "retasked" : "assigned"} to ${a.objectiveId === "last-confirmed" ? "last confirmed vehicle position" : (snapshot.objectives.find((o) => o.id === a.objectiveId)?.name ?? "junction")}`} (simulation only).`,
    })),
  ]
    .filter((e) => e.scenarioSecond <= time)
    .sort((a, b) => b.scenarioSecond - a.scenarioSecond)
    .slice(0, 5);
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
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
          cameraRequest={cameraRequest}
          onSelectUnit={selectUnit}
          onFollow={selectVehicle}
          onFit={fitAll}
        />
        <aside className="units-panel">
          <div className="units-heading">
            <div>
              <div className="section-kicker">RESPONSE TEAM</div>
              <h2>
                Units in view <span>3</span>
              </h2>
            </div>
          </div>
          <p className="muted unit-caption">
            Choose an objective to send a simulated unit from its own position.
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
                    <span className={`unit-tag ${assigned ? "assigned" : ""}`}>
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
                        !(objectiveSelections[u.unitId] ?? activeObjective?.id)
                      }
                    >
                      Retask {u.unitName}
                    </button>
                  )}
                </article>
              );
            })}
          </div>
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
              Seeded simulation · alternative runs remain in this browser
              session
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
