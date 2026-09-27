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

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function headingDifference(a, b) {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

async function cameraState() {
  return page.evaluate(() => {
    const viewer = document.querySelector("#globe").__recoveryViewer;
    const { camera, canvas, globe } = viewer.scene;
    const center = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
    const ray = camera.getPickRay(center);
    const focus =
      (ray && globe.pick(ray, viewer.scene)) ||
      camera.pickEllipsoid(center, globe.ellipsoid);
    if (!focus) throw new Error("Map center did not intersect the globe");
    const position = camera.positionWC;
    return {
      focus: { x: focus.x, y: focus.y, z: focus.z },
      range: Math.hypot(
        position.x - focus.x,
        position.y - focus.y,
        position.z - focus.z,
      ),
      heading: camera.heading,
      pitch: camera.pitch,
    };
  });
}

async function markerState(id) {
  return page.evaluate((markerId) => {
    const viewer = document.querySelector("#globe").__recoveryViewer;
    const entity = viewer.entities.getById(markerId);
    const target = entity.position.getValue(viewer.clock.currentTime);
    const point = viewer.scene.cartesianToCanvasCoordinates(target);
    if (!point) throw new Error(`${markerId} is outside the map view`);
    const canvas = viewer.scene.canvas;
    const bounds = canvas.getBoundingClientRect();
    return {
      x: bounds.left + point.x,
      y: bounds.top + point.y,
      picked: viewer.scene.pick(point)?.id?.id ?? null,
      tracked: viewer.trackedEntity?.id ?? null,
      distance: Math.hypot(
        viewer.camera.positionWC.x - target.x,
        viewer.camera.positionWC.y - target.y,
        viewer.camera.positionWC.z - target.z,
      ),
    };
  }, id);
}

async function assertMarkerDoubleClick(id, tilted) {
  await page.getByRole("button", { name: /Fit all/ }).click();
  await page.waitForTimeout(850);
  if (tilted) await page.getByRole("button", { name: "Tilt view" }).click();
  const before = await markerState(id);
  assert.equal(before.picked, id, `${id}: marker was not pickable`);
  await page.mouse.dblclick(before.x, before.y, { delay: 90 });
  await page.waitForTimeout(950);
  const after = await markerState(id);
  assert.equal(after.tracked, null, `${id}: Cesium tracked the marker`);
  assert(
    after.distance < (id === "vehicle" ? 2200 : 1650),
    `${id}: camera did not focus on the marker (${after.distance.toFixed(0)} m)`,
  );
  if (id === "vehicle") {
    assert.equal(
      await page.getByRole("button", { name: "Following vehicle" }).count(),
      1,
    );
  } else {
    assert.equal(await page.locator(".unit-card.selected").count(), 1);
  }
  console.log(`${tilted ? "tilted" : "top-down"} ${id} double click`, {
    distanceMetres: +after.distance.toFixed(0),
    tracked: after.tracked,
  });
}

async function trackFlights() {
  await page.evaluate(() => {
    const camera = document.querySelector("#globe").__recoveryViewer.camera;
    window.__cameraFlights = [];
    let trackingDepth = 0;
    for (const method of ["flyTo", "flyToBoundingSphere"]) {
      const original = camera[method].bind(camera);
      camera[method] = (...args) => {
        if (trackingDepth) return original(...args);
        const position = () => ({ ...camera.positionWC });
        const flight = {
          method,
          duration: args[0].duration ?? args[1]?.duration,
          start: position(),
        };
        window.__cameraFlights.push(flight);
        trackingDepth++;
        let result;
        try {
          result = original(...args);
        } finally {
          trackingDepth--;
        }
        flight.immediate = position();
        setTimeout(() => (flight.middle = position()), 250);
        setTimeout(() => (flight.end = position()), 850);
        return result;
      };
    }
  });
}

async function flightCount() {
  return page.evaluate(() => window.__cameraFlights.length);
}

async function assertFlight(button, method, label, expectMotion = false) {
  const before = await flightCount();
  await button.click();
  const flight = await page.evaluate(() => window.__cameraFlights.at(-1));
  assert.equal(
    await flightCount(),
    before + 1,
    `${label}: expected one flight`,
  );
  assert.equal(flight.method, method, `${label}: wrong camera action`);
  assert(flight.duration >= 0.5, `${label}: flight was immediate`);
  await page.waitForTimeout(950);
  if (expectMotion) {
    const movement = await page.evaluate(() => window.__cameraFlights.at(-1));
    assert(movement.middle && movement.end, `${label}: no camera samples`);
    assert(
      distance(movement.start, movement.immediate) < 1,
      `${label}: camera snapped during the click`,
    );
    assert(
      distance(movement.start, movement.middle) > 10,
      `${label}: camera did not begin moving`,
    );
  }
  console.log(`${label}: ${flight.method} ${flight.duration}s`);
}

async function setNonzeroHeading() {
  await page.evaluate(() => {
    const viewer = document.querySelector("#globe").__recoveryViewer;
    const camera = viewer.camera;
    camera.setView({
      destination: camera.positionWC,
      orientation: { heading: 0.7, pitch: camera.pitch, roll: 0 },
    });
    viewer.scene.requestRender();
  });
}

function assertPreserved(before, after, label) {
  const focusShift = distance(before.focus, after.focus);
  const rangeChange = Math.abs(after.range - before.range) / before.range;
  const headingChange = headingDifference(after.heading, before.heading);
  assert(
    focusShift < 20,
    `${label}: map focus moved ${focusShift.toFixed(1)} m`,
  );
  assert(
    rangeChange < 0.03,
    `${label}: camera range changed ${(rangeChange * 100).toFixed(1)}%`,
  );
  assert(
    headingChange < 0.03,
    `${label}: heading changed ${headingChange.toFixed(3)} rad`,
  );
  console.log(label, {
    focusShiftMetres: +focusShift.toFixed(2),
    rangeChangePercent: +(rangeChange * 100).toFixed(2),
    headingChangeRadians: +headingChange.toFixed(4),
    pitchRadians: +after.pitch.toFixed(3),
  });
}

async function toggleAndCheck(label) {
  const before = await cameraState();
  await page.getByRole("button", { name: "Tilt view" }).click();
  const tilted = await cameraState();
  assertPreserved(before, tilted, `${label}: tilt`);
  assert(Math.abs(tilted.pitch + Math.PI / 3) < 0.04);
  await page.getByRole("button", { name: "Top-down" }).click();
  const topDown = await cameraState();
  assertPreserved(tilted, topDown, `${label}: top-down`);
  assert(Math.abs(topDown.pitch + Math.PI / 2) < 0.04);
}

try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() =>
    Boolean(document.querySelector("#globe")?.__recoveryViewer),
  );
  await page.waitForTimeout(1500);
  await trackFlights();
  for (const tilted of [false, true]) {
    for (const id of ["vehicle", "unit-2"]) {
      await assertMarkerDoubleClick(id, tilted);
    }
  }
  await page.getByRole("button", { name: /Fit all/ }).click();
  await page.waitForTimeout(850);
  const map = page.locator(".map-panel");
  const bounds = await map.boundingBox();
  assert(bounds);
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;

  await assertFlight(
    page.getByRole("button", { name: "Follow vehicle" }),
    "flyToBoundingSphere",
    "vehicle selection",
    true,
  );
  await assertFlight(
    page.getByRole("button", { name: "Following vehicle" }),
    "flyToBoundingSphere",
    "repeat vehicle selection",
  );
  await page.mouse.move(centerX, centerY);
  await page.mouse.wheel(0, -250);
  await page.waitForTimeout(1600);
  assert((await cameraState()).range < 1500);
  await setNonzeroHeading();
  await toggleAndCheck("vehicle after close zoom");
  assert.equal(
    await page.getByRole("button", { name: "Following vehicle" }).count(),
    1,
  );

  await assertFlight(
    page.getByRole("button", { name: "Unit 02", exact: true }),
    "flyToBoundingSphere",
    "unit selection",
    true,
  );
  await assertFlight(
    page.getByRole("button", { name: "Unit 02", exact: true }),
    "flyToBoundingSphere",
    "repeat unit selection",
  );
  await page.mouse.move(centerX, centerY);
  await page.mouse.wheel(0, -250);
  await page.waitForTimeout(1600);
  assert((await cameraState()).range < 1100);
  await setNonzeroHeading();
  await toggleAndCheck("selected unit after close zoom");
  assert.equal(await page.locator(".unit-card.selected").count(), 1);

  await assertFlight(
    page.getByRole("button", { name: /Fit all/ }),
    "flyTo",
    "Fit All",
    true,
  );
  const beforePan = await cameraState();
  await page.mouse.move(centerX + 120, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX - 130, centerY + 60, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(1600);
  const afterPan = await cameraState();
  assert(distance(beforePan.focus, afterPan.focus) > 100);
  await setNonzeroHeading();
  await toggleAndCheck("panned unselected area");
  assert.equal(await page.locator(".unit-card.selected").count(), 0);

  const timeline = page.getByRole("slider", {
    name: "Scenario time in seconds",
  });
  await timeline.fill("59");
  await assertFlight(
    page.getByRole("button", { name: "Follow vehicle" }),
    "flyToBoundingSphere",
    "vehicle before outage",
  );
  const beforeOutage = await cameraState();
  const flightsBeforeReports = await flightCount();
  await timeline.fill("65");
  assert.equal(await page.getByText("10 seconds", { exact: true }).count(), 1);
  await timeline.fill("75");
  assert.equal(await page.getByText("20 seconds", { exact: true }).count(), 1);
  const duringOutage = await cameraState();
  assert(
    distance(beforeOutage.focus, duringOutage.focus) < 2,
    "signal loss moved the followed vehicle camera",
  );
  assert.equal(await flightCount(), flightsBeforeReports);
  await timeline.fill("90");
  const resumed = await cameraState();
  assert(
    distance(duringOutage.focus, resumed.focus) > 10,
    "resumed report did not update following",
  );
  assert.equal(await flightCount(), flightsBeforeReports);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
