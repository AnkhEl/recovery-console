import assert from "node:assert/strict";
import { chromium } from "playwright";
const target = process.argv[2] || "http://127.0.0.1:5173/";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-webgl"],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  ignoreHTTPSErrors: true,
});
const errors = [];
const tileRequests = [];
page.on("request", (request) => {
  if (
    request.url().includes("arcgisonline") ||
    request.url().includes("openstreetmap")
  )
    tileRequests.push(request.url());
});
page.on("response", (response) => {
  if (
    response.url().includes("arcgisonline") ||
    response.url().includes("openstreetmap")
  ) {
    if (response.status() >= 400)
      errors.push(`${response.status()} ${response.url()}`);
  }
});
page.on("pageerror", (error) => errors.push(String(error)));
page.on("requestfailed", (request) => {
  if (
    request.url().includes("arcgisonline") ||
    request.url().includes("openstreetmap")
  )
    errors.push(`${request.url()} ${request.failure()?.errorText}`);
});
await page.goto(target, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
console.log(
  "URL",
  target,
  "title",
  await page.title(),
  "canvas",
  await page.locator("canvas").count(),
  "credits",
  await page.locator(".cesium-viewer-bottom").count(),
);
console.log("initial", await page.locator(".vehicle-card").innerText());
assert.equal(await page.locator(".map-mode").innerText(), "STREET MAP");
await page.screenshot({
  path: "/tmp/recovery-console-desktop.png",
  fullPage: true,
});
await page.getByRole("button", { name: /Aerial map/ }).click();
assert.equal(await page.locator(".map-mode").innerText(), "AERIAL MAP");
await page.getByRole("button", { name: /Street map/ }).click();
console.log("street", await page.locator(".map-mode").innerText());
await page.getByRole("button", { name: /Aerial map/ }).click();
await page.getByRole("button", { name: /Road labels/ }).click();
await page.getByRole("button", { name: /Tilt view/ }).click();
console.log(
  "tilt",
  await page.getByRole("button", { name: /Top-down/ }).count(),
);
await page.getByRole("button", { name: /Top-down/ }).click();
await page.getByRole("button", { name: "Unit 02", exact: true }).click();
await page.getByRole("button", { name: /Follow vehicle/ }).click();
await page.getByRole("button", { name: /Fit all/ }).click();
const timeline = page.getByRole("slider", { name: "Scenario time in seconds" });
for (const t of [30, 45, 59, 60, 89, 90, 120, 180]) {
  await timeline.fill(String(t));
  console.log(
    "time",
    t,
    "status",
    await page.locator(".signal").innerText(),
    "age",
    await page.locator(".vehicle-card .detail-row").first().innerText(),
    "position",
    await page.locator(".location-box strong").innerText(),
  );
}
await page.getByRole("button", { name: "Reset scenario" }).click();
await timeline.fill("30");
await page.getByRole("button", { name: "Simulate signal loss" }).click();
await timeline.fill("44");
console.log("manual-loss", await page.locator(".signal").innerText());
await page.getByRole("button", { name: "Restore signal" }).click();
await timeline.fill("45");
console.log("manual-restore", await page.locator(".signal").innerText());
await page.getByRole("button", { name: "Assign Unit 02" }).click();
console.log("assignments", await page.locator(".incident-summary").innerText());
await page.getByRole("button", { name: "Reset scenario" }).click();
for (const speed of ["1", "2", "4"]) {
  await page.locator(".speed-control select").selectOption(speed);
  await page.getByRole("button", { name: "Play scenario" }).click();
  await page.waitForTimeout(1200);
  console.log(
    "play",
    speed,
    await page.locator(".timeline-labels").innerText(),
  );
  await page.getByRole("button", { name: "Pause scenario" }).click();
}
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({
  path: "/tmp/recovery-console-mobile.png",
  fullPage: true,
});
console.log(
  "mobile horizontal overflow",
  await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
);
console.log("TILE_REQUESTS", tileRequests.length, tileRequests.slice(0, 3));
console.log("ERRORS", errors);
await browser.close();
