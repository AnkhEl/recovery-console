import type { Coordinates, ResponseUnitState } from "./model";

export function validUnitPosition(
  unit: ResponseUnitState | null | undefined,
): Coordinates | null {
  const report = unit?.currentReport;
  if (
    !report ||
    report.unitId !== unit?.unitId ||
    report.kind !== "confirmed_device_report" ||
    report.connectivity !== "connected" ||
    !Number.isFinite(Date.parse(report.deviceTimestamp)) ||
    !Number.isFinite(Date.parse(report.serverReceiptTimestamp)) ||
    Date.parse(report.deviceTimestamp) >
      Date.parse(report.serverReceiptTimestamp)
  ) {
    return null;
  }

  const coordinates = report.coordinates;
  if (
    !Array.isArray(coordinates) ||
    coordinates.length !== 2 ||
    !Number.isFinite(coordinates[0]) ||
    !Number.isFinite(coordinates[1]) ||
    Math.abs(coordinates[0]) > 180 ||
    Math.abs(coordinates[1]) > 90
  ) {
    return null;
  }

  return coordinates;
}
