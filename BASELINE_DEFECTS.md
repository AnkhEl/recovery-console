# Baseline review, before React migration

- `npm run check` passes when Node child process creation is allowed. The initial sandbox run failed with `spawnSync ... EPERM`, an environment restriction rather than a prototype assertion failure.
- The original `dist/` static server was reviewed in headless Chromium after installing temporary browser dependencies. Cesium created a canvas and credit display without page errors. Its aerial map remained on the illustrative loading diagram during the initial six-second capture; provider tiles loaded slowly in this environment.
- The illustrative fallback diagram puts response units at fixed coordinates while the unit reports move, so the diagram can misrepresent their location.
- Tilt view calls vehicle focus even when a response unit is selected; this discards the selected-unit camera context.
- The scheduled outage ends at 01:30 and the 01:30 report appears immediately. The activity wording should say a new report was received at that point.
- Vehicle speed and heading remain visually headed as current during signal loss, despite belonging to the last confirmed device report. The migrated UI must identify them as last reported values.
- A manual outage begun between report ticks may start before the next scheduled report; the old snapshot logic retains the last report but the rendered age is only labelled as display seconds, with no device or receipt timestamps.
