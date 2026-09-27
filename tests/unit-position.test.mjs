import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: ["src/unitPosition.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { validUnitPosition } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
const currentReport = {
  unitId: "unit-2",
  kind: "confirmed_device_report",
  connectivity: "connected",
  coordinates: [28.05, -26.1],
  deviceTimestamp: "2026-09-26T12:32:00.000Z",
  serverReceiptTimestamp: "2026-09-26T12:32:00.000Z",
};
const unit = { unitId: "unit-2", unitName: "Unit 02", currentReport };

test("unit selection uses only a valid current confirmed report", () => {
  assert.deepEqual(validUnitPosition(unit), [28.05, -26.1]);
  assert.equal(validUnitPosition({ ...unit, currentReport: null }), null);
  assert.equal(
    validUnitPosition({
      ...unit,
      currentReport: { ...currentReport, coordinates: [Infinity, -26.1] },
    }),
    null,
  );
  assert.equal(
    validUnitPosition({
      ...unit,
      currentReport: { ...currentReport, coordinates: [28.05, -126.1] },
    }),
    null,
  );
  assert.equal(
    validUnitPosition({
      ...unit,
      currentReport: { ...currentReport, kind: "estimate" },
    }),
    null,
  );
  assert.equal(
    validUnitPosition({
      ...unit,
      currentReport: { ...currentReport, connectivity: "signal_lost" },
    }),
    null,
  );
  assert.equal(
    validUnitPosition({
      ...unit,
      currentReport: { ...currentReport, deviceTimestamp: "invalid" },
    }),
    null,
  );
});
