import assert from "node:assert/strict";
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:5173/";
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

async function markerState(id) {
  return page.evaluate((unitId) => {
    const viewer = document.querySelector("#globe").__recoveryViewer;
    const entity = viewer.entities.getById(unitId);
    if (!entity) throw new Error(`${unitId} has no marker`);
    const target = entity.position.getValue(viewer.clock.currentTime);
    const point = viewer.scene.cartesianToCanvasCoordinates(target);
    if (!point) throw new Error(`${unitId} is outside the map view`);
    const bounds = viewer.scene.canvas.getBoundingClientRect();
    return {
      x: bounds.left + point.x,
      y: bounds.top + point.y,
      picked: viewer.scene.pick(point)?.id?.id ?? null,
      size: entity.point.pixelSize.getValue(viewer.clock.currentTime),
      distance: Math.hypot(
        viewer.camera.positionWC.x - target.x,
        viewer.camera.positionWC.y - target.y,
        viewer.camera.positionWC.z - target.z,
      ),
    };
  }, id);
}

async function assertSelected(id) {
  const selected = page.locator(".unit-card.selected .unit-select");
  assert.equal(await selected.count(), 1);
  assert.equal(
    await selected.innerText(),
    `Unit ${id.split("-").at(-1).padStart(2, "0")}`,
  );
  assert.equal(await selected.getAttribute("aria-pressed"), "true");
  const marker = await markerState(id);
  assert.equal(marker.size, 20, `${id}: map marker is not highlighted`);
  assert(marker.distance < 1550, `${id}: camera did not focus on unit`);
  console.log(id, { distanceMetres: +marker.distance.toFixed(0) });
}

async function clickCardBody(index) {
  const bounds = await page
    .locator(".unit-card")
    .nth(index)
    .locator(".unit-coordinates")
    .boundingBox();
  assert(bounds);
  await page.mouse.click(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.waitForTimeout(900);
}

try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() =>
    Boolean(document.querySelector("#globe")?.__recoveryViewer),
  );
  await page.waitForTimeout(1000);

  for (const tilted of [false, true]) {
    await page.getByRole("button", { name: /Fit all/ }).click();
    await page.waitForTimeout(850);
    if (tilted) await page.getByRole("button", { name: "Tilt view" }).click();

    await clickCardBody(0);
    await assertSelected("unit-1");
    await clickCardBody(1);
    await assertSelected("unit-2");

    const marker = await markerState("unit-3");
    assert.equal(marker.picked, "unit-3", "Unit 03 marker is not pickable");
    await page.mouse.click(marker.x, marker.y);
    await page.waitForTimeout(900);
    await assertSelected("unit-3");

    await page
      .getByRole("button", { name: /(?:Release|Assign) Unit 01/ })
      .click();
    await assertSelected("unit-3");
    console.log(tilted ? "tilted view passed" : "top-down view passed");
  }

  const missingReportUrl = new URL(url);
  missingReportUrl.searchParams.set("missingUnit", "unit-2");
  await page.goto(missingReportUrl.href, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() =>
    Boolean(
      document
        .querySelector("#globe")
        ?.__recoveryViewer?.entities.getById("unit-1"),
    ),
  );
  await page.waitForTimeout(900);
  const beforeUnavailableClick = await page.evaluate(() => {
    const viewer = document.querySelector("#globe").__recoveryViewer;
    return { ...viewer.camera.positionWC };
  });
  await clickCardBody(1);
  assert.equal(
    await page.locator(".unit-card.selected .unit-select").innerText(),
    "Unit 02",
  );
  assert.match(
    await page.locator(".unit-card.selected .unit-coordinates").innerText(),
    /Position unavailable/,
  );
  const unavailable = await page.evaluate(() => {
    const viewer = document.querySelector("#globe").__recoveryViewer;
    return {
      markerExists: Boolean(viewer.entities.getById("unit-2")),
      position: { ...viewer.camera.positionWC },
    };
  });
  assert.equal(unavailable.markerExists, false);
  assert(
    Math.hypot(
      unavailable.position.x - beforeUnavailableClick.x,
      unavailable.position.y - beforeUnavailableClick.y,
      unavailable.position.z - beforeUnavailableClick.z,
    ) < 1,
    "unavailable unit moved the camera",
  );
  console.log("missing unit report passed");
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
