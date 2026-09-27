import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-webgl"],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  ignoreHTTPSErrors: true,
});
const errors = [];
const streetTiles = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("response", (response) => {
  if (response.url().startsWith("https://tile.openstreetmap.org/"))
    streetTiles.push(response.status());
});
await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".vehicle-card");
await page
  .waitForFunction(
    () =>
      document.querySelector(".map-mode")?.textContent?.trim() === "STREET MAP",
    null,
    { timeout: 35000 },
  )
  .catch(async (error) => {
    console.log("map status", await page.locator(".map-mode").innerText());
    console.log(
      "tile statuses",
      streetTiles.reduce((counts, status) => {
        counts[status] = (counts[status] ?? 0) + 1;
        return counts;
      }, {}),
    );
    await page.screenshot({ path: "/tmp/recovery-replay-load-failure.png" });
    throw error;
  });
assert.match(await page.locator(".map-legend").innerText(), /Inferred path/);
await page.screenshot({
  path: "/tmp/recovery-final-desktop.png",
  fullPage: true,
});
assert.equal(await page.locator("canvas").count(), 1);
assert.equal(await page.locator(".cesium-viewer-bottom").count(), 1);
await page.locator(".speed-control select").selectOption("4");
await page.getByRole("button", { name: "Play scenario" }).click();
const timeline = page.getByRole("slider", { name: "Scenario time in seconds" });
await page
  .waitForFunction(
    () => Number(document.querySelector("input[type=range]")?.value) >= 65,
    null,
    { timeout: 120000 },
  )
  .catch(async (e) => {
    console.log(
      "stalled at",
      await timeline.inputValue(),
      await page.locator(".replay-status").innerText(),
    );
    throw e;
  });
console.log(
  "outage",
  await timeline.inputValue(),
  await page.locator(".signal").innerText(),
  await page.locator(".vehicle-card .detail-row").first().innerText(),
);
assert.equal(
  await page.locator(".signal").innerText(),
  "Last confirmed position",
);
await page.waitForFunction(
  () => Number(document.querySelector("input[type=range]")?.value) >= 95,
  null,
  { timeout: 120000 },
);
console.log(
  "resumed",
  await timeline.inputValue(),
  await page.locator(".signal").innerText(),
);
assert.equal(
  await page.locator(".signal").innerText(),
  "Receiving simulated reports",
);
await page.waitForFunction(
  () => Number(document.querySelector("input[type=range]")?.value) >= 180,
  null,
  { timeout: 120000 },
);
console.log("complete", await page.locator(".replay-status").innerText());
assert.equal(await page.locator(".replay-status").innerText(), "COMPLETE");
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({
  path: "/tmp/recovery-final-mobile.png",
  fullPage: true,
});
const mobileOverflow = await page.evaluate(
  () => document.documentElement.scrollWidth > innerWidth,
);
assert.equal(mobileOverflow, false);
console.log("mobile overflow", mobileOverflow);
console.log("browser errors", errors);
assert.deepEqual(errors, []);
await browser.close();
