import assert from "node:assert/strict";
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:5173/";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-webgl"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByRole("combobox", { name: "Unit 03 objective" }).waitFor();
  const result = await page.evaluate(async () => {
    const ranking = await import("/src/ranking.ts");
    const simulation = await import("/src/coordination.ts");
    const graphFile = await fetch("/coordination-graph.json").then((response) =>
      response.json(),
    );
    const model = await fetch("/src/generated/ranking-model.v3.json").then(
      (response) => response.json(),
    );
    const graph = new simulation.CoordinationGraph(graphFile);
    const source = new simulation.CoordinatedIncidentSource(graph);
    const view = source.snapshot(65, {
      id: "browser-review",
      name: "Browser review",
      seed: 27,
      actions: [],
      outages: [],
    });
    const candidates = ranking.rankingCandidates(view, graph);
    const probabilities = candidates.map((candidate) =>
      ranking.modelProbability(model, candidate),
    );
    return {
      version: model.version,
      signalLost: view.connectivity === "signal_lost",
      lastConfirmedSecond: Number(
        view.lastConfirmedReport.id.replace("vehicle-", ""),
      ),
      count: candidates.length,
      finiteProbabilities: probabilities.every(
        (probability) =>
          Number.isFinite(probability) && probability >= 0 && probability <= 1,
      ),
    };
  });
  assert.equal(result.version, "observation-ranker-v3");
  assert.equal(result.signalLost, true);
  assert.equal(result.lastConfirmedSecond, 55);
  assert(result.count > 0);
  assert.equal(result.finiteProbabilities, true);
  assert.equal(
    await page.getByText(/AI-generated simulation option/i).count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Browser ranking inference passed; gated advice remains hidden",
    result,
  );
} finally {
  await browser.close();
}
