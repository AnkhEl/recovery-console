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

async function cameraState() {
  return page.locator("#globe").evaluate((host) => {
    const viewer = host.__recoveryViewer;
    const { camera, canvas, globe } = viewer.scene;
    const center = {
      x: canvas.clientWidth / 2,
      y: canvas.clientHeight / 2,
    };
    const ray = camera.getPickRay(center);
    const focus =
      (ray && globe.pick(ray, viewer.scene)) ||
      camera.pickEllipsoid(center, globe.ellipsoid);
    const vehicle = viewer.entities
      .getById("vehicle")
      .position.getValue(viewer.clock.currentTime);
    const offset = {
      x: focus.x - vehicle.x,
      y: focus.y - vehicle.y,
      z: focus.z - vehicle.z,
    };
    return {
      focus,
      vehicle,
      offset,
      offsetMetres: Math.hypot(offset.x, offset.y, offset.z),
      range: Math.hypot(
        camera.positionWC.x - focus.x,
        camera.positionWC.y - focus.y,
        camera.positionWC.z - focus.z,
      ),
    };
  });
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function assertPreserved(before, after, label) {
  assert(
    distance(before.offset, after.offset) < 2,
    `${label}: camera shifted relative to the confirmed vehicle position`,
  );
  assert(
    Math.abs(before.range - after.range) < 2,
    `${label}: camera zoom changed on a report update`,
  );
}

try {
  await page.goto(target, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      document.querySelector(".map-mode")?.textContent?.trim() === "STREET MAP",
    null,
    { timeout: 35000 },
  );
  const timeline = page.getByRole("slider", {
    name: "Scenario time in seconds",
  });
  await timeline.fill("10");
  await page.getByRole("button", { name: "Follow vehicle" }).click();
  await page.waitForTimeout(900);
  const map = await page.locator(".map-panel").boundingBox();
  assert(map);
  await page.mouse.move(map.x + map.width * 0.62, map.y + map.height * 0.5);
  await page.mouse.wheel(0, -250);
  await page.waitForTimeout(1700);
  const zoomedIn = await cameraState();
  assert(zoomedIn.range < 1650, "wheel input did not zoom in");
  await timeline.fill("11");
  assertPreserved(
    zoomedIn,
    await cameraState(),
    "unchanged report after zoom in",
  );
  await timeline.fill("15");
  assertPreserved(zoomedIn, await cameraState(), "new report after zoom in");

  await page.mouse.wheel(0, 250);
  await page.waitForTimeout(1700);
  const zoomedOut = await cameraState();
  assert(
    zoomedOut.range > zoomedIn.range + 100,
    "wheel input did not zoom out",
  );
  await timeline.fill("16");
  assertPreserved(
    zoomedOut,
    await cameraState(),
    "unchanged report after zoom out",
  );
  await timeline.fill("20");
  assertPreserved(zoomedOut, await cameraState(), "new report after zoom out");

  await page.getByRole("button", { name: "Play scenario" }).click();
  await page.mouse.wheel(0, -250);
  await page.waitForTimeout(1700);
  const playingZoom = await cameraState();
  await page.waitForFunction(
    () => Number(document.querySelector("input[type=range]")?.value) >= 25,
    null,
    { timeout: 15000 },
  );
  await page.getByRole("button", { name: "Pause scenario" }).click();
  assertPreserved(playingZoom, await cameraState(), "playing after wheel zoom");

  await timeline.fill("59");
  const beforeOutage = await cameraState();
  await timeline.fill("65");
  assertPreserved(beforeOutage, await cameraState(), "signal loss");
  await timeline.fill("75");
  assertPreserved(beforeOutage, await cameraState(), "continued signal loss");
  await timeline.fill("90");
  assertPreserved(beforeOutage, await cameraState(), "first resumed report");
  console.log("Follow zoom, replay, signal loss, and resumed reports passed.");
} finally {
  await browser.close();
}
