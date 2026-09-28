import type { Coordinates } from "./model";
import mappedFootprints from "./data/sight-line-footprints.v1.json";

export type SightLineFootprint = {
  id: string;
  coordinates: Coordinates[];
  buildingTag: string;
  source: "osm" | "synthetic_fixture";
};
export type SightLineDataset = {
  version: string;
  footprints: SightLineFootprint[];
  observerPoints: Record<string, Coordinates>;
  fixture: "none" | "clear" | "blocked";
};

const osmFootprints: SightLineFootprint[] = mappedFootprints.footprints.map(
  (item) => ({
    ...item,
    coordinates: item.coordinates.map(([longitude, latitude]): Coordinates => [
      longitude,
      latitude,
    ]),
    source: "osm",
  }),
);

// Controlled browser fixture. Its observation point and corner building are
// synthetic, clearly separate from the frozen OSM extract. The building lies
// east of the Fredman Drive approach, not over the simulated road centreline.
const demoSightPoint: Coordinates = [28.05148, -26.103634];
const demoBuilding: SightLineFootprint = {
  id: "synthetic-sight-line-screen",
  buildingTag: "simulated obstruction",
  source: "synthetic_fixture",
  coordinates: [
    [28.05139, -26.10365],
    [28.05145, -26.10365],
    [28.05145, -26.10361],
    [28.05139, -26.10361],
    [28.05139, -26.10365],
  ],
};

export function sightLineDataset(
  fixture: SightLineDataset["fixture"] = "none",
): SightLineDataset {
  return {
    version: mappedFootprints.version,
    footprints:
      fixture === "blocked" ? [...osmFootprints, demoBuilding] : osmFootprints,
    observerPoints: fixture === "none" ? {} : { "junction-7": demoSightPoint },
    fixture,
  };
}

const cross = (a: Coordinates, b: Coordinates, c: Coordinates) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSegment = (a: Coordinates, b: Coordinates, point: Coordinates) =>
  Math.min(a[0], b[0]) <= point[0] &&
  point[0] <= Math.max(a[0], b[0]) &&
  Math.min(a[1], b[1]) <= point[1] &&
  point[1] <= Math.max(a[1], b[1]);
const segmentsIntersect = (
  a: Coordinates,
  b: Coordinates,
  c: Coordinates,
  d: Coordinates,
) => {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  if (abC * abD < 0 && cdA * cdB < 0) return true;
  return (
    (abC === 0 && onSegment(a, b, c)) ||
    (abD === 0 && onSegment(a, b, d)) ||
    (cdA === 0 && onSegment(c, d, a)) ||
    (cdB === 0 && onSegment(c, d, b))
  );
};
const pointInPolygon = (point: Coordinates, ring: Coordinates[]) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j],
      b = ring[i];
    if (cross(a, b, point) === 0 && onSegment(a, b, point)) return true;
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
};

export function sightLineBlocked(
  from: Coordinates,
  to: Coordinates,
  footprints: readonly SightLineFootprint[],
): boolean {
  return footprints.some(({ coordinates: ring }) => {
    if (pointInPolygon(from, ring) || pointInPolygon(to, ring)) return true;
    for (let i = 1; i < ring.length; i++)
      if (segmentsIntersect(from, to, ring[i - 1], ring[i])) return true;
    return false;
  });
}
