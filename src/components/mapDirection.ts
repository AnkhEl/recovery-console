import * as Cesium from "cesium";
import type { Coordinates } from "../model";

export const directionArrowImage = (color: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><path d="M20 1 27 13 20 10 13 13Z" fill="${color}" stroke="#102034" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  )}`;

// Project a local heading into the current camera view. This keeps the arrow
// aligned with the reported bearing through camera rotation and tilt.
export function screenDirectionRotation(
  viewer: Cesium.Viewer,
  coordinates: Coordinates,
  headingDegrees: number,
): number | null {
  if (!Number.isFinite(headingDegrees)) return null;
  const origin = Cesium.Cartesian3.fromDegrees(...coordinates, 8);
  const transform = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  const radians = Cesium.Math.toRadians(headingDegrees);
  const forward = Cesium.Matrix4.multiplyByPoint(
    transform,
    new Cesium.Cartesian3(100 * Math.sin(radians), 100 * Math.cos(radians), 0),
    new Cesium.Cartesian3(),
  );
  const from = viewer.scene.cartesianToCanvasCoordinates(origin);
  const to = viewer.scene.cartesianToCanvasCoordinates(forward);
  if (!from || !to) return null;
  const east = to.x - from.x;
  const north = from.y - to.y;
  if (Math.hypot(east, north) < 1) return null;
  return -Math.atan2(east, north);
}
