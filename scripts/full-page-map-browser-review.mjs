import assert from "node:assert/strict";
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:5174/?scenarioSeed=27";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-webgl"],
});

try {
  for (const viewport of [
    { width: 1600, height: 950 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport, ignoreHTTPSErrors: true });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const map = page.getByRole("region", { name: "Incident map" });
    const units = page.getByRole("region", { name: "Units in view" });
    const slider = page.getByRole("slider", {
      name: "Scenario time in seconds",
    });
    await map.getByRole("button", { name: "Full-page map" }).waitFor();
    await units.getByRole("button", { name: "Unit 03", exact: true }).click();
    await slider.fill("63");
    await page.waitForTimeout(2200);
    const before = await page.evaluate(() => {
      const viewer = document.querySelector("#globe").__recoveryViewer;
      window.__mapReviewViewer = viewer;
      const camera = viewer?.camera;
      const vector = (value) => [value.x, value.y, value.z];
      return camera
        ? {
            camera: [
              ...vector(camera.positionWC),
              ...vector(camera.directionWC),
              ...vector(camera.upWC),
            ],
            canvasHeight: viewer.canvas.height,
          }
        : null;
    });
    assert(before, "Cesium viewer was unavailable");
    await map.getByRole("button", { name: "Full-page map" }).click();
    await page.waitForTimeout(300);
    assert.equal(
      await map.evaluate((element) =>
        element.classList.contains("full-page-map"),
      ),
      true,
    );
    const size = await map.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        top: rect.top,
        left: rect.left,
      };
    });
    assert(Math.abs(size.width - viewport.width) < 1);
    assert(Math.abs(size.height - viewport.height) < 1);
    assert.equal(size.top, 0);
    assert.equal(size.left, 0);
    assert.equal(
      await map.getByRole("button", { name: "Exit full-page map" }).isVisible(),
      true,
    );
    if (viewport.width < 620) {
      const toolbar = await map.locator(".map-toolbar").boundingBox();
      const outage = await map.locator(".signal-overlay").boundingBox();
      const exit = await map
        .getByRole("button", { name: "Exit full-page map" })
        .boundingBox();
      const location = await map.locator(".map-location").boundingBox();
      assert(toolbar && outage);
      assert(exit && location);
      assert(
        outage.y >= toolbar.y + toolbar.height,
        "Signal-loss notice covered the full-page map controls",
      );
      assert(
        exit.x >= location.x + location.width,
        "Exit full-page map covered the incident area label",
      );
    }
    assert.equal(
      await map
        .getByRole("button", { name: "Fit all map markers" })
        .isVisible(),
      true,
    );
    assert.equal(
      await map.getByRole("button", { name: "Tilt map view" }).isVisible(),
      true,
    );
    assert.equal(await slider.inputValue(), "63");
    const during = await page.evaluate(() => {
      const viewer = document.querySelector("#globe").__recoveryViewer;
      const vector = (value) => [value.x, value.y, value.z];
      return {
        sameViewer: viewer === window.__mapReviewViewer,
        camera: [
          ...vector(viewer.camera.positionWC),
          ...vector(viewer.camera.directionWC),
          ...vector(viewer.camera.upWC),
        ],
        canvasHeight: viewer.canvas.height,
      };
    });
    assert.equal(during.sameViewer, true);
    assert(
      during.camera.every(
        (value, index) => Math.abs(value - before.camera[index]) < 1e-7,
      ),
      "Entering full-page view moved the camera",
    );
    assert(
      during.canvasHeight > before.canvasHeight,
      "Cesium canvas did not grow",
    );
    await page.screenshot({
      path: `/tmp/recovery-full-map-${viewport.width}.png`,
    });
    await map.getByRole("button", { name: "Exit full-page map" }).click();
    await page.waitForTimeout(300);
    assert.equal(
      await map.evaluate((element) =>
        element.classList.contains("full-page-map"),
      ),
      false,
    );
    assert.equal(await slider.inputValue(), "63");
    assert.equal(
      await units
        .getByRole("button", { name: "Unit 03", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
    const after = await page.evaluate(() => {
      const viewer = document.querySelector("#globe").__recoveryViewer;
      const vector = (value) => [value.x, value.y, value.z];
      return {
        sameViewer: viewer === window.__mapReviewViewer,
        camera: [
          ...vector(viewer.camera.positionWC),
          ...vector(viewer.camera.directionWC),
          ...vector(viewer.camera.upWC),
        ],
        canvasHeight: viewer.canvas.height,
      };
    });
    assert.equal(after.sameViewer, true);
    assert(
      after.camera.every(
        (value, index) => Math.abs(value - before.camera[index]) < 1e-7,
      ),
      "Exiting full-page view moved the camera",
    );
    assert.equal(after.canvasHeight, before.canvasHeight);

    await map.getByRole("button", { name: "Full-page map" }).click();
    await page.keyboard.press("Escape");
    assert.equal(
      await map.getByRole("button", { name: "Full-page map" }).isVisible(),
      true,
    );

    await slider.fill("20");
    await page.getByRole("button", { name: "Play scenario" }).click();
    await map.getByRole("button", { name: "Full-page map" }).click();
    await page.waitForTimeout(1200);
    assert(Number(await slider.inputValue()) > 20);
    await map.getByRole("button", { name: "Exit full-page map" }).click();
    await page.getByRole("button", { name: "Pause scenario" }).click();

    await slider.fill("0");
    const plan = page.getByRole("region", { name: "Operator plan" });
    await plan.getByRole("button", { name: "Operator plan" }).click();
    await plan.getByRole("button", { name: /Build two-unit plan/ }).click();
    const cancel = plan.getByRole("button", { name: "Cancel plan draft" });
    const review = plan.getByRole("button", { name: "Review combined plan" });
    const cancelBox = await cancel.boundingBox();
    const reviewBox = await review.boundingBox();
    assert(cancelBox && reviewBox);
    assert(Math.abs(cancelBox.x - reviewBox.x) < 1);
    assert(Math.abs(cancelBox.width - reviewBox.width) < 1);
    assert(reviewBox.y >= cancelBox.y + cancelBox.height + 8);
    assert.notEqual(
      await cancel.evaluate(
        (button) => getComputedStyle(button).backgroundColor,
      ),
      await review.evaluate(
        (button) => getComputedStyle(button).backgroundColor,
      ),
    );

    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    "Full-page map and plan button browser review passed at desktop and mobile widths",
  );
} finally {
  await browser.close();
}
