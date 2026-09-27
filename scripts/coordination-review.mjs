import assert from "node:assert/strict";
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:5173/";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-webgl"],
});
const page = await browser.newPage({
  viewport: { width: 1600, height: 950 },
  ignoreHTTPSErrors: true,
});
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.getByRole("combobox", { name: "Unit 03 objective" }).waitFor();
assert.match(
  await page.locator(".unit-card").first().innerText(),
  /Awaiting objective/,
);
await page
  .getByRole("combobox", { name: "Unit 03 objective" })
  .selectOption("junction-3");
await page.getByRole("button", { name: "Assign and move Unit 03" }).click();
assert.match(
  await page.locator(".unit-card").nth(2).innerText(),
  /Objective: 5th Street × Norwich Close/,
);
const initial = await page
  .locator(".unit-card")
  .nth(2)
  .locator(".unit-coordinates")
  .innerText();
const slider = page.getByRole("slider", { name: "Scenario time in seconds" });
await slider.fill("60");
const later = await page
  .locator(".unit-card")
  .nth(2)
  .locator(".unit-coordinates")
  .innerText();
assert.notEqual(later, initial);
assert.match(
  await page.locator(".activity").innerText(),
  /simulated observation/i,
);
await page.screenshot({
  path: "/tmp/recovery-coordination-60.png",
  fullPage: true,
});
await slider.fill("120");
await page
  .getByRole("combobox", { name: "Unit 02 objective" })
  .selectOption("junction-4");
await page.getByRole("button", { name: "Assign and move Unit 02" }).click();
await slider.fill("30");
await page
  .getByRole("combobox", { name: "Unit 03 objective" })
  .selectOption("junction-4");
await page.getByRole("button", { name: "Retask Unit 03" }).click();
assert.equal(
  await page.getByRole("dialog", { name: "Create alternative run" }).count(),
  1,
);
await page.getByRole("button", { name: "Create alternative run" }).click();
assert.equal(
  await page
    .getByRole("combobox", { name: /Scenario run/ })
    .locator("option")
    .count(),
  2,
);
assert.deepEqual(errors, []);
console.log("Phase 1 browser review passed", { initial, later, runCount: 2 });
await browser.close();
