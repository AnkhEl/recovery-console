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
    await page
      .locator(".units-panel")
      .screenshot({ path: `/tmp/recovery-panel-${viewport.width}.png` });
    const region = (name) => page.getByRole("region", { name });
    const toggle = (name) => region(name).getByRole("button", { name });
    const slider = page.getByRole("slider", {
      name: "Scenario time in seconds",
    });
    const units = region("Units in view");
    const plan = region("Operator plan");

    for (const name of [
      "Scenario analysis",
      "Team coverage",
      "Operator plan",
    ]) {
      assert.equal(await toggle(name).getAttribute("aria-expanded"), "false");
      assert.equal(await toggle(name).isVisible(), true);
      const target = await toggle(name).getAttribute("aria-controls");
      assert.equal(await page.locator(`#${target}`).getAttribute("hidden"), "");
    }
    assert.equal(
      await toggle("Units in view").getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(
      await units
        .getByRole("button", { name: "Assign and move Unit 03" })
        .isVisible(),
      true,
    );

    await toggle("Scenario analysis").focus();
    await page.keyboard.press("Enter");
    assert.equal(
      await toggle("Scenario analysis").getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(
      await toggle("Team coverage").getAttribute("aria-expanded"),
      "false",
    );
    await page.keyboard.press("Enter");
    assert.equal(
      await toggle("Scenario analysis").getAttribute("aria-expanded"),
      "false",
    );

    await units
      .getByRole("combobox", { name: "Unit 03 objective" })
      .selectOption("junction-3");
    await units.getByRole("button", { name: "Unit 03", exact: true }).click();
    await slider.fill("17");
    await page.waitForTimeout(2000);
    const cameraBefore = await page.evaluate(() => {
      const camera = document.querySelector("#globe").__recoveryViewer?.camera;
      return camera
        ? [camera.positionWC, camera.directionWC, camera.upWC].flatMap(
            (vector) => [vector.x, vector.y, vector.z],
          )
        : null;
    });
    assert(cameraBefore, "Cesium camera was not available for the review");
    await toggle("Units in view").click();
    assert.equal(
      await toggle("Units in view").getAttribute("aria-expanded"),
      "false",
    );
    assert.equal(await slider.inputValue(), "17");
    await toggle("Units in view").click();
    assert.equal(
      await units
        .getByRole("combobox", { name: "Unit 03 objective" })
        .inputValue(),
      "junction-3",
    );
    assert.equal(
      await units
        .getByRole("button", { name: "Unit 03", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
    const cameraAfter = await page.evaluate(() => {
      const camera = document.querySelector("#globe").__recoveryViewer?.camera;
      return camera
        ? [camera.positionWC, camera.directionWC, camera.upWC].flatMap(
            (vector) => [vector.x, vector.y, vector.z],
          )
        : null;
    });
    assert(
      cameraAfter.every(
        (value, index) => Math.abs(value - cameraBefore[index]) < 1e-8,
      ),
      "Collapsing the panel moved the map camera",
    );

    await slider.fill("0");
    await toggle("Operator plan").click();
    await plan.getByRole("button", { name: /Build two-unit plan/ }).click();
    await plan.getByRole("textbox", { name: "Plan name" }).fill("Panel draft");
    await plan
      .getByRole("combobox", { name: "Plan order 1 unit" })
      .selectOption("unit-2");
    await plan
      .getByRole("combobox", { name: "Plan order 1 junction" })
      .selectOption("junction-7");
    await plan
      .getByRole("combobox", { name: "Plan order 2 unit" })
      .selectOption("unit-3");
    await plan
      .getByRole("combobox", { name: "Plan order 2 junction" })
      .selectOption("junction-3");
    await toggle("Operator plan").click();
    await toggle("Operator plan").click();
    assert.equal(
      await plan.getByRole("textbox", { name: "Plan name" }).inputValue(),
      "Panel draft",
    );
    assert.equal(
      await plan
        .getByRole("combobox", { name: "Plan order 2 junction" })
        .inputValue(),
      "junction-3",
    );

    await plan.getByRole("button", { name: "Review combined plan" }).click();
    const review = page.getByRole("dialog", { name: "Review operator plan" });
    await review.waitFor();
    const actionsBefore = await page
      .locator(".activity-operator_action")
      .count();
    await toggle("Operator plan").evaluate((button) => button.click());
    assert.equal(await review.count(), 1);
    assert.equal(
      await page.locator(".activity-operator_action").count(),
      actionsBefore,
    );
    await review
      .getByRole("button", { name: "Confirm simulated plan" })
      .click();
    assert.equal(await review.count(), 0);
    assert.equal(
      await page.getByRole("combobox", { name: "Scenario run" }).inputValue(),
      "run-2",
    );
    assert.equal(
      await page.locator(".activity-operator_action").count(),
      actionsBefore + 2,
    );
    await toggle("Operator plan").click();
    assert.match(await plan.innerText(), /Panel draft/);

    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
      `Horizontal page overflow at ${viewport.width}px`,
    );
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    "Panel collapse browser review passed at desktop and mobile widths",
  );
} finally {
  await browser.close();
}
