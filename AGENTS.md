# Recovery Console guidance

Goal: a simulated incident workspace for authorised vehicle recovery operators, intended as an independent concept for a possible Cartrack pitch.

Commands: `npm ci`, `npm run dev`, `npm run check`, `npm test`, `npm run build`, `npm run preview`. The original static prototype was removed after migration; the active production output is `build/`.

Use React function components, TypeScript strict mode, and a dedicated Cesium viewer component. Format authored code with Prettier (`npm run format`) and keep `npm run format:check` passing. Keep scenario calculations pure. Keep all incident and replay state outside the Cesium component. Use semantic controls and accessible names. Do not add backend calls, dispatch messaging, or Cartrack integration.

All telemetry, incidents, units and assignments are synthetic. Label the simulation in the UI. A geographic map or real road geometry does not make simulated reports real. Distinguish confirmed device reports from estimates and operator actions visually and in types. Do not display an estimated position as a GPS report.

Device timestamp means the time the device produced a report; server receipt timestamp means when the server received it; display time means the operator's current replay view. Never substitute one for another. During signal loss retain the last confirmed position and age it against display time. Never interpolate the observed marker through missing reports. Never join observed trail segments across missing reports. New segments begin only with resumed confirmed reports. Preserve source attribution, map-provider credits, and Cesium notices.

- N.B Try to reference Gods Eye View to see if the functionalty that we trying to build is not already built there whenever possibe https://github.com/bilawalsidhu/gods-eye-view

- After making code changes, ask me if you should commit them or not, I have initialized git on our project 
