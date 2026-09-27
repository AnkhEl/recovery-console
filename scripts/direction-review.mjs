import assert from "node:assert/strict";
import { chromium } from "playwright";

const target = process.argv[2] || "http://127.0.0.1:5173/";
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

async function arrows() {
  return page.locator("#globe").evaluate((host) => {
    const viewer = host.__recoveryViewer;
    return ["vehicle", "unit-1", "unit-2", "unit-3"].map((id) => {
      const entity = viewer.entities.getById(id);
      return {
        id,
        shown: entity?.show && entity.billboard?.show?.getValue(),
        rotation: entity?.billboard?.rotation?.getValue(
          viewer.clock.currentTime,
        ),
        image: entity?.billboard?.image?.getValue(viewer.clock.currentTime),
      };
    });
  });
}

try {
  await page.goto(target, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      document.querySelector(".map-mode")?.textContent?.trim() === "STREET MAP",
    null,
    { timeout: 35000 },
  );
  assert.match(await page.locator(".map-legend").innerText(), /Heading/);
  let state = await arrows();
  assert(state.every((arrow) => arrow.shown));
  assert(state.every((arrow) => Number.isFinite(arrow.rotation)));
  assert(state.every((arrow) => arrow.image?.startsWith("data:image/svg+xml")));
  await page.locator(".map-panel").screenshot({
    path: "/tmp/recovery-direction-top.png",
  });

  await page.getByRole("button", { name: "Unit 02", exact: true }).click();
  assert.equal(await page.locator(".unit-card.selected").count(), 1);
  await page.getByRole("button", { name: "Tilt view" }).click();
  await page.waitForTimeout(850);
  state = await arrows();
  assert(state.every((arrow) => arrow.shown));
  assert(state.every((arrow) => Number.isFinite(arrow.rotation)));
  await page.locator(".map-panel").screenshot({
    path: "/tmp/recovery-direction-tilted.png",
  });

  const slider = page.getByRole("slider", { name: "Scenario time in seconds" });
  await slider.fill("65");
  state = await arrows();
  assert.equal(state[0].shown, false);
  assert(state.slice(1).every((arrow) => arrow.shown));
  await page.locator(".map-panel").screenshot({
    path: "/tmp/recovery-direction-outage.png",
  });
  await slider.fill("90");
  state = await arrows();
  assert.equal(state[0].shown, true);
  await slider.fill("180");
  state = await arrows();
  assert(state.every((arrow) => arrow.shown));
  await page.getByRole("button", { name: "Top-down" }).click();
  await page.getByRole("button", { name: "Aerial map" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector(".map-mode")?.textContent?.trim() === "AERIAL MAP",
    null,
    { timeout: 35000 },
  );
  assert((await arrows()).every((arrow) => arrow.shown));
  assert.deepEqual(errors, []);
  console.log(
    "Vehicle and unit headings, tilt, outage, replay, and aerial map passed.",
  );
} finally {
  await browser.close();
}
