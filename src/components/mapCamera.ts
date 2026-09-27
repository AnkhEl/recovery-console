import * as Cesium from "cesium";

// Exact nadir makes Cesium's heading undefined, so use a visually imperceptible offset.
const TOP_DOWN_PITCH = -Math.PI / 2 + 0.001;
const TILTED_PITCH = -Math.PI / 3;

export function pitchForMode(tilted: boolean): number {
  return tilted ? TILTED_PITCH : TOP_DOWN_PITCH;
}

export function screenCenterFocus(
  viewer: Cesium.Viewer,
): Cesium.Cartesian3 | undefined {
  const { camera, canvas, globe } = viewer.scene;
  const center = new Cesium.Cartesian2(
    canvas.clientWidth / 2,
    canvas.clientHeight / 2,
  );
  const ray = camera.getPickRay(center);

  return (
    (ray && globe.pick(ray, viewer.scene)) ||
    camera.pickEllipsoid(center, globe.ellipsoid)
  );
}

function lookAtKeepingRange(
  viewer: Cesium.Viewer,
  focus: Cesium.Cartesian3,
  pitch: number,
  range: number,
): void {
  const { camera } = viewer;
  const heading = camera.heading;

  camera.cancelFlight();
  camera.lookAt(focus, new Cesium.HeadingPitchRange(heading, pitch, range));
  camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  viewer.scene.requestRender();
}

export function changeViewAngle(
  viewer: Cesium.Viewer,
  tilted: boolean,
  fallbackFocus?: Cesium.Cartesian3,
): boolean {
  const focus = screenCenterFocus(viewer) ?? fallbackFocus;
  if (!focus) return false;

  const range = Cesium.Cartesian3.distance(viewer.camera.positionWC, focus);
  lookAtKeepingRange(viewer, focus, pitchForMode(tilted), range);
  return true;
}

export function followMovedTarget(
  viewer: Cesium.Viewer,
  previous: Cesium.Cartesian3,
  current: Cesium.Cartesian3,
): void {
  const displacement = Cesium.Cartesian3.subtract(
    current,
    previous,
    new Cesium.Cartesian3(),
  );
  // Repeated snapshots without a new report must not interrupt wheel zoom.
  if (Cesium.Cartesian3.magnitude(displacement) < 0.01) return;

  const focus = screenCenterFocus(viewer);
  if (!focus) return;

  const range = Cesium.Cartesian3.distance(viewer.camera.positionWC, previous);
  const distanceFromPrevious = Cesium.Cartesian3.distance(focus, previous);

  // A manual pan away from the selected target takes precedence over tracking.
  if (distanceFromPrevious > Math.max(50, range * 0.15)) return;

  const { camera } = viewer;
  const destination = Cesium.Cartesian3.add(
    camera.positionWC,
    displacement,
    new Cesium.Cartesian3(),
  );
  const direction = Cesium.Cartesian3.clone(camera.directionWC);
  const up = Cesium.Cartesian3.clone(camera.upWC);
  camera.setView({ destination, orientation: { direction, up } });
  viewer.scene.requestRender();
}
