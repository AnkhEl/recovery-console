import assert from "node:assert/strict";
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:5174/?scenarioSeed=27";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-webgl"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 950 },
    ignoreHTTPSErrors: true,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("combobox", { name: "Unit 02 objective" })
    .selectOption("junction-7");
  await page.getByRole("button", { name: "Assign and move Unit 02" }).click();
  await page
    .getByRole("combobox", { name: "Unit 03 objective" })
    .selectOption("junction-8");
  await page.getByRole("button", { name: "Assign and move Unit 03" }).click();
  const slider = page.getByRole("slider", { name: "Scenario time in seconds" });
  await slider.fill("63");

  const team = page.getByRole("region", { name: "Team coverage" });
  const details = await team.innerText();
  assert.match(details, /No well-supported additional order/);
  assert.match(
    details,
    /GPS is lost; the vehicle's current position and next route are unknown/,
  );
  assert.match(details, /6th Street × Helena Avenue/);
  assert.match(details, /Exploratory coverage alternative/);
  assert.match(
    details,
    /Unit 03 → Fredman Drive × Sandown Valley Crescent adds no configured approach/,
  );
  assert.match(details, /outside the remaining evaluation window/);
  const helena = team.getByRole("button", {
    name: "Review team coverage retask Unit 01 to 6th Street × Helena Avenue",
  });
  await helena.click();
  const review = page.getByRole("dialog", {
    name: "Review scenario analysis option",
  });
  assert.match(await review.innerText(), /TEAM COVERAGE · ORDER REVIEW/);
  assert.match(
    await review.innerText(),
    /Configured approach change: \+3 gained, −0 lost/,
  );
  assert.match(
    await review.innerText(),
    /Exploratory: no recent local approach observation/,
  );
  const before = await page.locator(".activity-operator_action").count();
  await slider.fill("64", { force: true });
  await review.getByRole("button", { name: "Confirm simulated order" }).click();
  assert.match(await review.innerText(), /Replay information changed/);
  assert.equal(await page.locator(".activity-operator_action").count(), before);
  await review.getByRole("button", { name: "Confirm simulated order" }).click();
  assert.equal(await review.count(), 0);
  assert.equal(
    await page.locator(".activity-operator_action").count(),
    before + 1,
  );
  assert.equal(await helena.count(), 0);
  assert.match(await team.innerText(), /TEAM COVERAGE/);

  await page.getByRole("button", { name: "Reset scenario" }).click();
  await slider.fill("86");
  assert.match(
    await team.innerText(),
    /No timely nonduplicate alternative is eligible/,
  );
  assert.deepEqual(errors, []);
  console.log("Team coverage browser review passed");
} finally {
  await browser.close();
}
