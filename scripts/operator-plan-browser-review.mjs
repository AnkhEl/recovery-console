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
  const composer = page.getByRole("region", { name: "Operator plan" });
  await composer.getByRole("button", { name: /Build two-unit plan/ }).waitFor();
  const slider = page.getByRole("slider", { name: "Scenario time in seconds" });
  const runs = page.getByRole("combobox", { name: "Scenario run" });
  const comparison = page.getByRole("region", { name: "Compare runs" });

  async function createPlan(name, first, second) {
    await composer.getByRole("button", { name: /Build two-unit plan/ }).click();
    await composer.getByRole("textbox", { name: "Plan name" }).fill(name);
    await composer
      .getByRole("combobox", { name: "Plan order 1 unit" })
      .selectOption(first[0]);
    await composer
      .getByRole("combobox", { name: "Plan order 1 junction" })
      .selectOption(first[1]);
    await composer
      .getByRole("combobox", { name: "Plan order 2 unit" })
      .selectOption(second[0]);
    await composer
      .getByRole("combobox", { name: "Plan order 2 junction" })
      .selectOption(second[1]);
    await composer
      .getByRole("button", { name: "Review combined plan" })
      .click();
    const review = page.getByRole("dialog", { name: "Review operator plan" });
    await review.waitFor();
    return review;
  }

  let review = await createPlan(
    "Plan A",
    ["unit-3", "junction-3"],
    ["unit-2", "junction-7"],
  );
  let details = await review.innerText();
  assert.match(details, /Unit 02 → Fredman Drive × Sandown Valley Crescent/);
  assert.match(details, /Unit 03 → 5th Street × Norwich Close/);
  assert.match(details, /Combined configured approaches: 0 before → 6/);
  assert.match(details, /earliest possible information 00:05/);
  assert.match(details, /earliest possible information 00:46/);
  assert.doesNotMatch(details, /observed 01:01|available 01:03/i);
  assert.equal(await page.locator(".activity-operator_action").count(), 0);
  await review.getByRole("button", { name: "Confirm simulated plan" }).click();
  assert.equal(await runs.locator("option").count(), 2);
  assert.match(await runs.locator("option:checked").innerText(), /Plan A/);
  assert.equal(await page.locator(".activity-operator_action").count(), 2);
  assert.match(
    await comparison.innerText(),
    /Advance past 00:00 to reveal outcomes/,
  );

  await slider.fill("55");
  const confirmedAt55 = await page.locator(".location-box strong").innerText();
  await slider.fill("63");
  assert.equal(
    await page.locator(".location-box strong").innerText(),
    confirmedAt55,
  );
  assert.match(
    await page.locator(".vehicle-card").innerText(),
    /14:32:55 SAST/,
  );
  assert.match(
    await page.locator(".observation-overlay").innerText(),
    /Observed at 01:01; available at 01:03/,
  );
  assert.match(await comparison.innerText(), /Plan A[\s\S]*observed 01:01/);
  await comparison
    .getByRole("button", { name: "Replay Original run to 01:03" })
    .click();
  assert.match(
    await comparison.innerText(),
    /Original run[\s\S]*No valid observation/,
  );

  await slider.fill("0");
  review = await createPlan(
    "Plan B",
    ["unit-2", "junction-1"],
    ["unit-3", "junction-3"],
  );
  details = await review.innerText();
  assert.match(details, /earliest possible information 01:22/);
  assert.match(details, /Combined configured approaches: 0 before → 6/);
  await review.getByRole("button", { name: "Confirm simulated plan" }).click();
  assert.equal(await runs.locator("option").count(), 3);
  await slider.fill("90");
  assert.match(
    await comparison.innerText(),
    /Plan B[\s\S]*No valid observation/,
  );
  await comparison
    .getByRole("button", { name: "Replay Plan A to 01:30" })
    .click();
  assert.match(await comparison.innerText(), /Plan A[\s\S]*observed 01:01/);
  await comparison
    .getByRole("button", { name: "Replay Original run to 01:30" })
    .click();
  assert.match(
    await comparison.innerText(),
    /Original run[\s\S]*No valid observation/,
  );

  await runs.selectOption("run-2");
  await composer.getByRole("button", { name: "Revise Plan A" }).click();
  assert.equal(await slider.inputValue(), "0");
  await composer
    .getByRole("combobox", { name: "Plan order 1 junction" })
    .selectOption("junction-1");
  await composer.getByRole("button", { name: "Review combined plan" }).click();
  review = page.getByRole("dialog", { name: "Review operator plan" });
  assert.match(await review.innerText(), /Plan A revision/);
  await slider.fill("1", { force: true });
  await review.getByRole("button", { name: "Confirm simulated plan" }).click();
  assert.match(
    await review.innerText(),
    /Replay information or the selected time changed/,
  );
  assert.equal(await runs.locator("option").count(), 3);
  await slider.fill("0", { force: true });
  await review.getByRole("button", { name: "Close plan review" }).click();
  await composer.getByRole("button", { name: "Review combined plan" }).click();
  review = page.getByRole("dialog", { name: "Review operator plan" });
  await review.getByRole("button", { name: "Confirm simulated plan" }).click();
  assert.equal(await runs.locator("option").count(), 4);
  assert.match(
    await runs.locator("option:checked").innerText(),
    /Plan A revision/,
  );
  const activity = await page.locator(".activity").innerText();
  assert.match(
    activity,
    /Plan A revision · Unit 02 assigned to 5th Street × Park Lane/,
  );
  assert.doesNotMatch(
    activity,
    /Plan A · Unit 02 assigned to Fredman Drive × Sandown Valley Crescent/,
  );
  await slider.fill("90");
  assert.match(
    await comparison.innerText(),
    /Plan A revision[\s\S]*No valid observation/,
  );
  await comparison
    .getByRole("spinbutton", { name: "Comparison decision second" })
    .fill("35");
  assert.match(
    await comparison.innerText(),
    /Cannot compare: Prior unit orders differ/,
  );

  await page.getByRole("button", { name: "Reset scenario" }).click();
  assert.equal(await runs.locator("option").count(), 1);
  assert.equal(await comparison.count(), 0);
  await page
    .getByRole("combobox", { name: "Unit 03 objective" })
    .selectOption("junction-3");
  await page.getByRole("button", { name: "Assign and move Unit 03" }).click();
  assert.match(
    await page.locator(".activity").innerText(),
    /Unit 03 assigned to 5th Street × Norwich Close/,
  );
  await page.getByRole("button", { name: "Reset scenario" }).click();
  assert.equal(await page.locator(".activity-operator_action").count(), 0);
  assert.deepEqual(errors, []);
  console.log("Operator plan browser review passed");
} finally {
  await browser.close();
}
