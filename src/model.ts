export type Coordinates = readonly [longitude: number, latitude: number];
export type ConnectivityState = "connected" | "signal_lost";
export type ReportKind = "confirmed_device_report" | "estimate";
export interface Incident {
  id: string;
  title: string;
  vehicleLabel: string;
  area: string;
  openedAt: string;
  source: "simulator";
}
export interface LocationReport {
  id: string;
  incidentId: string;
  deviceTimestamp: string;
  serverReceiptTimestamp: string;
  coordinates: Coordinates;
  accuracyMetres: number;
  headingDegrees: number;
  speedKmh: number;
  connectivity: ConnectivityState;
  kind: ReportKind;
}
export interface ResponseUnitReport extends LocationReport {
  unitId: string;
  unitName: string;
}
export interface ResponseUnitState {
  unitId: string;
  unitName: string;
  currentReport: ResponseUnitReport | null;
}
export interface Assignment {
  id: string;
  incidentId: string;
  unitId: string;
  assigned: boolean;
  operatorTimestamp: string;
  scenarioSecond: number;
}
export interface ActivityEvent {
  id: string;
  incidentId: string;
  kind:
    | "device_report"
    | "signal_change"
    | "operator_action"
    | "incident"
    | "unit_observation"
    | "mobile_unit_observation"
    | "unit_status";
  displayTimestamp: string;
  deviceTimestamp?: string;
  text: string;
  scenarioSecond: number;
}
export interface Outage {
  start: number;
  end: number;
}
export interface InferredConnection {
  kind: "inferred_route_between_reports";
  fromReportId: string;
  toReportId: string;
  coordinates: Coordinates[];
}
export interface ScenarioSnapshot {
  displaySecond: number;
  displayTimestamp: string;
  reportAgeSeconds: number;
  connectivity: ConnectivityState;
  lastConfirmedReport: LocationReport;
  units: ResponseUnitState[];
  confirmedReports: LocationReport[];
  inferredConnections: InferredConnection[];
}
export interface IncidentDataSource {
  readonly incident: Incident;
  snapshot(second: number, manualOutages?: Outage[]): ScenarioSnapshot;
}
