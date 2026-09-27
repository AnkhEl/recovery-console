import * as Cesium from "cesium";

type LoadedTile = { rectangle: Cesium.Rectangle; level: number };

// Cesium's global tile queue also contains terrain and optional label requests.
// Watch successful tiles from this base provider for the current screen instead.
export function observeUsableImagery(
  viewer: Cesium.Viewer,
  provider: Cesium.UrlTemplateImageryProvider,
  onReady: () => void,
): () => void {
  const loadedTiles = new Map<string, LoadedTile>();
  const requestImage = provider.requestImage.bind(provider);
  let active = true;
  let coveredFrames = 0;

  provider.requestImage = (x, y, level, request) => {
    const pending = requestImage(x, y, level, request);
    if (!pending) return undefined;
    return pending.then((image) => {
      if (active) {
        loadedTiles.set(`${level}/${x}/${y}`, {
          rectangle: provider.tilingScheme.tileXYToRectangle(x, y, level),
          level,
        });
        viewer.scene.requestRender();
      }
      return image;
    });
  };

  const removeRenderListener = viewer.scene.postRender.addEventListener(() => {
    if (!active) return;
    if (!currentViewCovered(viewer, [...loadedTiles.values()])) {
      coveredFrames = 0;
      return;
    }
    coveredFrames++;
    if (coveredFrames >= 2) onReady();
    else viewer.scene.requestRender();
  });

  return () => {
    active = false;
    removeRenderListener();
  };
}

function currentViewCovered(
  viewer: Cesium.Viewer,
  tiles: LoadedTile[],
): boolean {
  if (!tiles.length) return false;
  const rectangle = viewer.camera.computeViewRectangle();
  if (!rectangle) return false;
  const viewWidthDegrees = Cesium.Math.toDegrees(rectangle.width);
  if (viewWidthDegrees <= 0) return false;
  const width = viewer.scene.canvas.clientWidth;
  const height = viewer.scene.canvas.clientHeight;
  const targetLevel = Math.max(
    10,
    Math.min(
      16,
      Math.ceil(Math.log2((360 * width) / (256 * 3 * viewWidthDegrees))),
    ),
  );
  const samples: Cesium.Cartographic[] = [];
  for (const y of [0.2, 0.5, 0.8]) {
    for (const x of [0.2, 0.5, 0.8]) {
      const point = viewer.camera.pickEllipsoid(
        new Cesium.Cartesian2(x * width, y * height),
      );
      if (point) samples.push(Cesium.Cartographic.fromCartesian(point));
    }
  }
  if (samples.length < 5) return false;
  const covered = (sample: Cesium.Cartographic) =>
    tiles.some(
      (tile) =>
        tile.level >= targetLevel - 1 &&
        Cesium.Rectangle.contains(tile.rectangle, sample),
    );
  // The centre must have readable street detail. Requiring every edge sample
  // would keep the overlay up when one peripheral tile is slow or unavailable.
  return (
    covered(samples[Math.floor(samples.length / 2)]) &&
    samples.filter(covered).length >= Math.ceil(samples.length / 2)
  );
}
