import assert from "node:assert/strict";
import { chromium } from "playwright";

const target = process.argv[2] ?? "http://127.0.0.1:5173/";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-webgl"],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  ignoreHTTPSErrors: true,
});
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));

async function inspect(name, selectedId) {
  const layout = await page.locator("#globe").evaluate((host, id) => {
    const viewer = host.__recoveryViewer;
    const entity = viewer.entities.getById(id);
    const position = entity.position.getValue(viewer.clock.currentTime);
    const point = viewer.scene.cartesianToCanvasCoordinates(position);
    const canvas = viewer.scene.canvas.getBoundingClientRect();
    const legend = document
      .querySelector(".map-legend")
      .getBoundingClientRect();
    const marker = { x: canvas.left + point.x, y: canvas.top + point.y };
    return {
      marker,
      legend: { left: legend.left, right: legend.right, top: legend.top },
      mapWidth: canvas.width,
      visible:
        point.x >= 0 &&
        point.x <= canvas.width &&
        point.y >= 0 &&
        point.y <= canvas.height,
    };
  }, selectedId);
  assert(layout.visible, `${name}: selected marker is outside the map`);
  assert(layout.legend.right - layout.legend.left < layout.mapWidth * 0.55);
  assert(
    layout.marker.x < layout.legend.left - 24 ||
      layout.marker.x > layout.legend.right + 24 ||
      layout.marker.y < layout.legend.top - 24,
    `${name}: legend obscures the selected marker`,
  );
  await page.locator(".map-panel").screenshot({
    path: `/tmp/recovery-direction-${name}.png`,
  });
  console.log(name, layout);
}

try {
  await page.goto(target, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      document.querySelector(".map-mode")?.textContent?.trim() === "STREET MAP",
    null,
    { timeout: 35000 },
  );

  for (const imagery of ["street", "aerial"]) {
    if (imagery === "aerial") {
      await page.getByRole("button", { name: "Aerial map" }).click();
      await page.waitForFunction(
        () =>
          document.querySelector(".map-mode")?.textContent?.trim() ===
          "AERIAL MAP",
        null,
        { timeout: 35000 },
      );
    }
    for (const [id, button] of [
      ["vehicle", /Follow(?:ing)? vehicle/],
      ["unit-2", "Unit 02"],
    ]) {
      for (const zoom of ["normal", "close"]) {
        await page.getByRole("button", { name: button, exact: true }).click();
        await page.waitForTimeout(1000);
        if (zoom === "close") {
          await page.locator("#globe").evaluate((host, markerId) => {
            const viewer = host.__recoveryViewer;
            viewer.camera.zoomIn(markerId === "vehicle" ? 1250 : 850);
            viewer.scene.requestRender();
          }, id);
          await page.waitForTimeout(250);
        }
        await inspect(`${imagery}-${id}-${zoom}-top`, id);
        await page.getByRole("button", { name: "Tilt view" }).click();
        await page.waitForTimeout(250);
        await inspect(`${imagery}-${id}-${zoom}-tilted`, id);
        await page.getByRole("button", { name: "Top-down" }).click();
        await page.waitForTimeout(250);
      }
    }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
