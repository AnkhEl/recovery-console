import assert from "node:assert/strict";
import { chromium } from "playwright";

const target = process.argv[2] || "http://127.0.0.1:5173/";
const onlySecond = process.argv[3] ? Number(process.argv[3]) : null;
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
const slider = page.getByRole("slider", { name: "Scenario time in seconds" });

async function mapEntities() {
  return page.locator("#globe").evaluate((host) => {
    const entities = host.__recoveryViewer.entities.values;
    return {
      reports: entities.filter((entity) =>
        entity.id.startsWith("confirmed-vehicle-"),
      ).length,
      connections: entities.filter((entity) =>
        entity.id.startsWith("inferred-vehicle-"),
      ).length,
      outageBridge: entities.some(
        (entity) => entity.id === "inferred-vehicle-55-vehicle-90",
      ),
      firstTurnVertices: entities
        .find((entity) => entity.id === "inferred-vehicle-0-vehicle-5")
        ?.polyline.positions.getValue().length,
    };
  });
}

async function focusVehicle() {
  await page.getByRole("button", { name: /Follow(?:ing)? vehicle/ }).click();
  await page.waitForTimeout(850);
}

async function screenshot(name) {
  await page.waitForTimeout(1300);
  await page
    .locator(".map-panel")
    .screenshot({ path: `/tmp/recovery-trail-${name}.png` });
}

async function assertVehicleInView() {
  const visible = await page.locator("#globe").evaluate((host) => {
    const viewer = host.__recoveryViewer;
    const vehicle = viewer.entities.getById("vehicle");
    const position = vehicle.position.getValue(viewer.clock.currentTime);
    const point = viewer.scene.cartesianToCanvasCoordinates(position);
    const { clientWidth, clientHeight } = viewer.scene.canvas;
    return (
      point &&
      point.x >= 0 &&
      point.y >= 0 &&
      point.x <= clientWidth &&
      point.y <= clientHeight
    );
  });
  assert(visible, "Vehicle must remain visible in the close turn review");
}

try {
  await page.goto(target, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      document.querySelector(".map-mode")?.textContent?.trim() === "STREET MAP",
    null,
    { timeout: 35000 },
  );
  assert.match(await page.locator(".map-legend").innerText(), /Inferred path/);
  await page.locator(".speed-control select").selectOption("4");
  await page.getByRole("button", { name: "Play scenario" }).click();
  await page.waitForFunction(
    () => Number(document.querySelector("input[type=range]")?.value) >= 5,
  );
  await page.getByRole("button", { name: "Pause scenario" }).click();
  await slider.fill("5");
  assert.deepEqual(await mapEntities(), {
    reports: 1,
    connections: 1,
    outageBridge: false,
    firstTurnVertices: 4,
  });

  for (const [second, name, expectedConnections] of [
    [5, "park-lane", 1],
    [25, "grayston", 5],
    [180, "daisy", 29],
  ].filter(([second]) => onlySecond === null || second === onlySecond)) {
    await slider.fill(String(second));
    assert.equal((await mapEntities()).connections, expectedConnections);
    await page.getByRole("button", { name: /Fit all/ }).click();
    await page.waitForTimeout(850);
    await focusVehicle();
    await screenshot(`${name}-normal-top`);
    await page.getByRole("button", { name: "Tilt view" }).click();
    await screenshot(`${name}-normal-tilted`);
    await page.getByRole("button", { name: "Top-down" }).click();
    await page.locator("#globe").evaluate((host) => {
      const viewer = host.__recoveryViewer;
      viewer.camera.zoomIn(1000);
      viewer.scene.requestRender();
    });
    await assertVehicleInView();
    await screenshot(`${name}-close-top`);
    await page.getByRole("button", { name: "Tilt view" }).click();
    await assertVehicleInView();
    await screenshot(`${name}-close-tilted`);
    await page.getByRole("button", { name: "Top-down" }).click();
  }

  await slider.fill("75");
  assert.equal((await mapEntities()).outageBridge, false);
  await slider.fill("95");
  assert.equal((await mapEntities()).outageBridge, false);
  await slider.fill("5");
  assert.equal((await mapEntities()).connections, 1);
  assert.deepEqual(errors, []);
  console.log(
    "Replay, scrub, outage gap, and three turns in both angles passed.",
  );
} finally {
  await browser.close();
}
