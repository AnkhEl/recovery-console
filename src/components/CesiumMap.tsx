import { useEffect, useRef, useState } from "react";
import * as Cesium from "cesium";
import type { Coordinates } from "../model";
import type { CoordinationSnapshot } from "../coordination";
import { elapsed } from "../scenario";
import { validUnitPosition } from "../unitPosition";
import { changeViewAngle, followMovedTarget, pitchForMode } from "./mapCamera";
import { directionArrowImage, screenDirectionRotation } from "./mapDirection";
import { observeUsableImagery } from "./mapImageryReady";

export type CameraRequest =
  | { sequence: number; kind: "vehicle"; coordinates: Coordinates }
  | {
      sequence: number;
      kind: "unit";
      unitId: string;
      coordinates: Coordinates;
    }
  | { sequence: number; kind: "fit"; positions: Coordinates[] };

type Props = {
  snapshot: CoordinationSnapshot;
  selectedUnit: string | null;
  following: boolean;
  fullPageMap: boolean;
  onToggleFullPageMap: () => void;
  cameraRequest: CameraRequest | null;
  onSelectUnit: (id: string) => void;
  onFollow: () => void;
  onFit: () => void;
};
const degreePosition = (p: readonly [number, number], height = 8) =>
  Cesium.Cartesian3.fromDegrees(p[0], p[1], height);
const imageryCredit = (html: string) => new Cesium.Credit(html, true);
const fitDestination = (positions: Coordinates[]) =>
  Cesium.Rectangle.fromDegrees(
    Math.min(...positions.map((point) => point[0])) - 0.006,
    Math.min(...positions.map((point) => point[1])) - 0.005,
    Math.max(...positions.map((point) => point[0])) + 0.006,
    Math.max(...positions.map((point) => point[1])) + 0.005,
  );
const marker = (color: string, label: string) => ({
  billboard: {
    image: directionArrowImage(color),
    width: 40,
    height: 40,
    rotation: 0,
    horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
    verticalOrigin: Cesium.VerticalOrigin.CENTER,
    disableDepthTestDistance: Infinity,
  },
  point: {
    pixelSize: 15,
    color: Cesium.Color.fromCssColorString(color),
    outlineColor: Cesium.Color.fromCssColorString("#0c1421"),
    outlineWidth: 3,
    disableDepthTestDistance: Infinity,
  },
  label: {
    text: label,
    font: "600 14px sans-serif",
    fillColor: Cesium.Color.WHITE,
    showBackground: true,
    backgroundColor: Cesium.Color.fromCssColorString("#102034ee"),
    backgroundPadding: new Cesium.Cartesian2(9, 6),
    pixelOffset: new Cesium.Cartesian2(0, -34),
    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
    disableDepthTestDistance: Infinity,
  },
});
type DebugMapElement = HTMLDivElement & { __recoveryViewer?: Cesium.Viewer };
export function CesiumMap({
  snapshot,
  selectedUnit,
  following,
  fullPageMap,
  onToggleFullPageMap,
  cameraRequest,
  onSelectUnit,
  onFollow,
  onFit,
}: Props) {
  const host = useRef<HTMLDivElement>(null),
    viewerRef = useRef<Cesium.Viewer | null>(null),
    vehicleRef = useRef<Cesium.Entity | null>(null),
    unitRefs = useRef<Map<string, Cesium.Entity>>(new Map()),
    reportRefs = useRef<Cesium.Entity[]>([]),
    inferredPathRefs = useRef<Cesium.Entity[]>([]),
    historyKeyRef = useRef(""),
    plannedRouteRefs = useRef<Cesium.Entity[]>([]),
    plannedKeyRef = useRef(""),
    objectiveRefs = useRef<Cesium.Entity[]>([]),
    observationRefs = useRef<Cesium.Entity[]>([]),
    observationKeyRef = useRef(""),
    mobileObservationRefs = useRef<Cesium.Entity[]>([]),
    mobileObservationKeyRef = useRef(""),
    footprintRefs = useRef<Cesium.Entity[]>([]),
    trafficRefs = useRef<Map<string, { entity: Cesium.Entity; level: 1 | 2 }>>(
      new Map(),
    ),
    trafficKeyRef = useRef(""),
    labelsRef = useRef<Cesium.ImageryLayer | null>(null);
  const [ready, setReady] = useState(false),
    [mapStatus, setMapStatus] = useState<"loading" | "ready" | "failed">(
      "loading",
    ),
    [street, setStreet] = useState(true),
    [tilted, setTilted] = useState(false),
    [labels, setLabels] = useState(true),
    [footprintsVisible, setFootprintsVisible] = useState(
      snapshot.sightLineFixture !== "none",
    ),
    [message, setMessage] = useState("");
  const previousSnapshotRef = useRef(snapshot);
  const latestSnapshotRef = useRef(snapshot);
  const latestSelectionRef = useRef({ selectedUnit, following });
  const activeFlightRef = useRef<CameraRequest | null>(null);
  latestSnapshotRef.current = snapshot;
  latestSelectionRef.current = { selectedUnit, following };
  const clickHandlers = useRef({ onSelectUnit, onFollow });
  clickHandlers.current = { onSelectUnit, onFollow };
  useEffect(() => {
    if (!host.current) return;
    const hostElement = host.current as DebugMapElement;
    let viewer: Cesium.Viewer;
    let removeDirectionListener = () => {};
    try {
      Cesium.Ion.defaultAccessToken = "";
      viewer = new Cesium.Viewer(hostElement, {
        baseLayer: false,
        terrainProvider: new Cesium.EllipsoidTerrainProvider(),
        animation: false,
        timeline: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        infoBox: false,
        selectionIndicator: false,
        skyBox: false,
        skyAtmosphere: false,
        requestRenderMode: true,
        maximumRenderTimeChange: Infinity,
      });
      viewerRef.current = viewer;
      historyKeyRef.current = "";
      plannedKeyRef.current = "";
      observationKeyRef.current = "";
      mobileObservationKeyRef.current = "";
      trafficKeyRef.current = "";
      trafficRefs.current.clear();
      viewer.camera.setView({
        destination: fitDestination([
          snapshot.lastConfirmedReport.coordinates,
          ...snapshot.units.flatMap((unit) => {
            const coordinates = validUnitPosition(unit);
            return coordinates ? [coordinates] : [];
          }),
        ]),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      unitRefs.current.clear();
      viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#162230");
      viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#223247");
      viewer.scene.globe.enableLighting = false;
      viewer.scene.screenSpaceCameraController.minimumZoomDistance = 150;
      viewer.scene.screenSpaceCameraController.maximumZoomDistance = 20000;
      viewer.scene.screenSpaceCameraController.inertiaSpin = 0;
      viewer.scene.screenSpaceCameraController.inertiaTranslate = 0;
      viewer.scene.screenSpaceCameraController.inertiaZoom = 0;
      viewer.creditDisplay.addStaticCredit(
        imageryCredit(
          'Road graph © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> (ODbL) · traffic and movement simulated',
        ),
      );
      viewer.creditDisplay.addStaticCredit(
        imageryCredit(
          'Mapped building footprints © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> (ODbL) · incomplete coverage',
        ),
      );
      vehicleRef.current = viewer.entities.add({
        id: "vehicle",
        ...marker("#ff8982", "DEMO 042 GP"),
      });
      viewer.screenSpaceEventHandler.setInputAction(
        (click: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
          const picked = viewer.scene.pick(click.position);
          const id = (picked?.id as Cesium.Entity | undefined)?.id;
          if (id && unitRefs.current.has(id))
            clickHandlers.current.onSelectUnit(id);
          if (id === "vehicle") clickHandlers.current.onFollow();
        },
        Cesium.ScreenSpaceEventType.LEFT_CLICK,
      );
      // Viewer otherwise tracks or zooms to a picked entity on double click.
      // Marker selection and focus belong to our single-click handler instead.
      viewer.screenSpaceEventHandler.removeInputAction(
        Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
      );
      for (const gesture of [
        Cesium.ScreenSpaceEventType.LEFT_DOWN,
        Cesium.ScreenSpaceEventType.RIGHT_DOWN,
        Cesium.ScreenSpaceEventType.MIDDLE_DOWN,
        Cesium.ScreenSpaceEventType.WHEEL,
        Cesium.ScreenSpaceEventType.PINCH_START,
      ]) {
        viewer.screenSpaceEventHandler.setInputAction(
          () => viewer.camera.cancelFlight(),
          gesture,
        );
      }
      removeDirectionListener = viewer.scene.preRender.addEventListener(() => {
        const current = latestSnapshotRef.current;
        const rotate = (
          entity: Cesium.Entity | null | undefined,
          coordinates: Coordinates,
          headingDegrees: number,
        ) => {
          if (!entity?.show || !entity.billboard?.show?.getValue()) return;
          const angle = screenDirectionRotation(
            viewer,
            coordinates,
            headingDegrees,
          );
          if (angle === null) return;
          const previous = entity.billboard.rotation?.getValue(
            viewer.clock.currentTime,
          );
          if (
            previous === undefined ||
            Math.abs(
              Math.atan2(
                Math.sin(angle - previous),
                Math.cos(angle - previous),
              ),
            ) > 0.01
          ) {
            entity.billboard.rotation = new Cesium.ConstantProperty(angle);
          }
        };
        rotate(
          vehicleRef.current,
          current.lastConfirmedReport.coordinates,
          current.lastConfirmedReport.headingDegrees,
        );
        current.units.forEach((unit) => {
          const coordinates = validUnitPosition(unit);
          if (!coordinates || !unit.currentReport) return;
          rotate(
            unitRefs.current.get(unit.unitId),
            coordinates,
            unit.currentReport.headingDegrees,
          );
        });
      });
      if (import.meta.env.DEV) hostElement.__recoveryViewer = viewer;
      setReady(true);
    } catch (error) {
      console.error("Map unavailable", error);
      setMapStatus("failed");
      setMessage("Map engine unavailable. The diagram is illustrative.");
      return;
    }
    return () => {
      removeDirectionListener();
      delete hostElement.__recoveryViewer;
      viewer.destroy();
      viewerRef.current = null;
      setReady(false);
    };
  }, []);
  useEffect(() => {
    const viewer = viewerRef.current;
    const element = host.current;
    if (!viewer || !element || !ready) return;
    const resize = () => {
      if (viewer.isDestroyed()) return;
      viewer.resize();
      viewer.scene.requestRender();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    return () => observer.disconnect();
  }, [ready]);
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !ready) return;
    viewer.imageryLayers.removeAll();
    viewer.scene.requestRenderMode = false;
    setMapStatus("loading");
    setMessage("");
    const base = new Cesium.UrlTemplateImageryProvider(
      street
        ? {
            url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
            maximumLevel: 19,
            credit: imageryCredit(
              '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> (ODbL)',
            ),
          }
        : {
            url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
            maximumLevel: 19,
            credit: imageryCredit(
              "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community",
            ),
          },
    );
    let active = true;
    let stopObserving = () => {};
    const fail = () => {
      if (!active) return;
      active = false;
      stopObserving();
      viewer.scene.requestRenderMode = true;
      setMapStatus("failed");
      setMessage(
        `${street ? "Street" : "Aerial"} map tiles unavailable. The diagram is illustrative. ${street ? "Choose Aerial map to try satellite imagery." : "Choose Street map to try the street view."}`,
      );
    };
    const succeed = () => {
      if (!active) return;
      active = false;
      stopObserving();
      viewer.scene.requestRenderMode = true;
      setMapStatus("ready");
      setMessage("");
      viewer.scene.requestRender();
    };
    let failures = 0;
    const removeErrorListener = base.errorEvent.addEventListener(() => {
      if (!active) return;
      failures++;
      if (failures >= 3) fail();
    });
    stopObserving = observeUsableImagery(viewer, base, succeed);
    const deadline = setTimeout(fail, 30000);
    viewer.imageryLayers.addImageryProvider(base);
    if (!street) {
      const provider = new Cesium.UrlTemplateImageryProvider({
        url: "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
        maximumLevel: 19,
        credit: imageryCredit("Road labels © Esri"),
      });
      provider.errorEvent.addEventListener(() => {
        if (active && !street)
          setMessage(
            "Road labels unavailable. Street map includes road names.",
          );
      });
      labelsRef.current = viewer.imageryLayers.addImageryProvider(provider);
      labelsRef.current.show = labels;
    } else labelsRef.current = null;
    viewer.scene.requestRender();
    return () => {
      active = false;
      clearTimeout(deadline);
      stopObserving();
      removeErrorListener();
    };
  }, [ready, street]);
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !ready) return;
    footprintRefs.current.forEach((entity) => viewer.entities.remove(entity));
    footprintRefs.current = [];
    if (footprintsVisible) {
      footprintRefs.current = snapshot.sightLineFootprints.map((footprint) =>
        viewer.entities.add({
          id: `mapped-footprint-${footprint.id}`,
          name:
            footprint.source === "synthetic_fixture"
              ? "Synthetic sight-line obstruction fixture"
              : `Mapped OSM building footprint ${footprint.id}; coverage incomplete`,
          ...(footprint.source === "synthetic_fixture"
            ? {
                position: degreePosition([28.05142, -26.10363], 17),
                label: {
                  text: "SYNTHETIC BLOCK",
                  font: "600 11px sans-serif",
                  fillColor: Cesium.Color.WHITE,
                  showBackground: true,
                  backgroundColor: Cesium.Color.fromCssColorString("#70392fee"),
                  pixelOffset: new Cesium.Cartesian2(0, 15),
                  disableDepthTestDistance: Infinity,
                },
              }
            : {}),
          polygon: {
            hierarchy: Cesium.Cartesian3.fromDegreesArray(
              footprint.coordinates.flat(),
            ),
            height: 3,
            material: Cesium.Color.fromCssColorString(
              footprint.source === "synthetic_fixture"
                ? "#f28b7488"
                : "#9c88d455",
            ),
            outline: true,
            outlineColor: Cesium.Color.fromCssColorString(
              footprint.source === "synthetic_fixture" ? "#f28b74" : "#b4a0eb",
            ),
          },
        }),
      );
      for (const [id, point] of Object.entries(
        snapshot.sightLineObserverPoints,
      ))
        footprintRefs.current.push(
          viewer.entities.add({
            id: `sight-point-${id}`,
            name: `Synthetic unit sight point for ${id}`,
            position: degreePosition(point, 13),
            point: {
              pixelSize: 11,
              color: Cesium.Color.fromCssColorString("#f28b74"),
              outlineColor: Cesium.Color.WHITE,
              outlineWidth: 2,
              disableDepthTestDistance: Infinity,
            },
            label: {
              text: "SYNTHETIC SIGHT POINT",
              font: "600 11px sans-serif",
              fillColor: Cesium.Color.WHITE,
              showBackground: true,
              backgroundColor: Cesium.Color.fromCssColorString("#522f30ee"),
              pixelOffset: new Cesium.Cartesian2(0, -22),
            },
          }),
        );
    }
    viewer.scene.requestRender();
  }, [
    ready,
    footprintsVisible,
    snapshot.sightLineFootprints,
    snapshot.sightLineObserverPoints,
  ]);
  useEffect(() => {
    if (labelsRef.current) labelsRef.current.show = labels;
    viewerRef.current?.scene.requestRender();
  }, [labels]);
  useEffect(() => {
    const viewer = viewerRef.current,
      vehicle = vehicleRef.current;
    if (!viewer || !vehicle || !ready) return;
    const report = snapshot.lastConfirmedReport;
    vehicle.position = new Cesium.ConstantPositionProperty(
      degreePosition(report.coordinates),
    );
    vehicle.point!.color = new Cesium.ConstantProperty(
      Cesium.Color.fromCssColorString(
        snapshot.connectivity === "signal_lost" ? "#f5c774" : "#ff8982",
      ),
    );
    vehicle.label!.text = new Cesium.ConstantProperty(
      snapshot.connectivity === "signal_lost"
        ? `LAST CONFIRMED · ${snapshot.reportAgeSeconds}s old`
        : "DEMO 042 GP · CONFIRMED",
    );
    vehicle.billboard!.show = new Cesium.ConstantProperty(
      snapshot.connectivity === "connected" &&
        Number.isFinite(report.headingDegrees) &&
        report.speedKmh > 0,
    );
    const visibleUnitIds = new Set<string>();
    snapshot.units.forEach((u) => {
      const coordinates = validUnitPosition(u);
      if (!coordinates) return;
      visibleUnitIds.add(u.unitId);
      let entity = unitRefs.current.get(u.unitId);
      if (!entity) {
        entity = viewer.entities.add({
          id: u.unitId,
          ...marker("#7bbaff", u.unitName),
        });
        unitRefs.current.set(u.unitId, entity);
      }
      entity.show = true;
      entity.position = new Cesium.ConstantPositionProperty(
        degreePosition(coordinates),
      );
      entity.point!.pixelSize = new Cesium.ConstantProperty(
        selectedUnit === u.unitId ? 20 : 15,
      );
      entity.point!.color = new Cesium.ConstantProperty(
        Cesium.Color.fromCssColorString(
          selectedUnit === u.unitId ? "#c2e3ff" : "#7bbaff",
        ),
      );
      entity.billboard!.show = new Cesium.ConstantProperty(
        Number.isFinite(u.currentReport?.headingDegrees) &&
          (u.currentReport?.speedKmh ?? 0) > 0,
      );
    });
    unitRefs.current.forEach((entity, id) => {
      if (!visibleUnitIds.has(id)) entity.show = false;
    });
    const flight = activeFlightRef.current;
    if (
      flight?.kind === "unit" &&
      !snapshot.units.some(
        (unit) => unit.unitId === flight.unitId && validUnitPosition(unit),
      )
    ) {
      viewer.camera.cancelFlight();
    }
    const historyKey = JSON.stringify([
      snapshot.confirmedReports.map((item) => [item.id, item.coordinates]),
      snapshot.inferredConnections,
    ]);
    const historyChanged = historyKey !== historyKeyRef.current;
    const plannedKey = JSON.stringify(
      snapshot.plannedRoutes.map((route) => [
        route.unitId,
        route.objective.id,
        route.coordinates,
      ]),
    );
    const plansChanged = plannedKey !== plannedKeyRef.current;
    const observationKey = snapshot.observations
      .map((item) => item.id)
      .join(":");
    const observationsChanged = observationKey !== observationKeyRef.current;
    if (historyChanged) {
      reportRefs.current.forEach((entity) => viewer.entities.remove(entity));
      inferredPathRefs.current.forEach((entity) =>
        viewer.entities.remove(entity),
      );
      inferredPathRefs.current = snapshot.inferredConnections.map(
        (connection) =>
          viewer.entities.add({
            id: `inferred-${connection.fromReportId}-${connection.toReportId}`,
            name: "Inferred road path between simulated reports",
            polyline: {
              positions: Cesium.Cartesian3.fromDegreesArrayHeights(
                connection.coordinates.flatMap((point) => [
                  point[0],
                  point[1],
                  6,
                ]),
              ),
              width: 4,
              material: new Cesium.PolylineDashMaterialProperty({
                color: Cesium.Color.fromCssColorString("#ddc1ff"),
                dashLength: 16,
              }),
              arcType: Cesium.ArcType.GEODESIC,
            },
          }),
      );
    }
    if (plansChanged) {
      plannedRouteRefs.current.forEach((entity) =>
        viewer.entities.remove(entity),
      );
      objectiveRefs.current.forEach((entity) => viewer.entities.remove(entity));
      plannedRouteRefs.current = snapshot.plannedRoutes
        .filter((route) => route.coordinates.length >= 2)
        .map((route) =>
          viewer.entities.add({
            id: `unit-plan-${route.unitId}`,
            name: `Simulated planned route for ${route.unitId}`,
            polyline: {
              positions: Cesium.Cartesian3.fromDegreesArrayHeights(
                route.coordinates.flatMap((point) => [point[0], point[1], 7]),
              ),
              width: 3,
              material: new Cesium.PolylineDashMaterialProperty({
                color: Cesium.Color.fromCssColorString("#70d7dc"),
                dashLength: 10,
              }),
              arcType: Cesium.ArcType.GEODESIC,
            },
          }),
        );
      objectiveRefs.current = snapshot.plannedRoutes.map((route) =>
        viewer.entities.add({
          id: `unit-objective-${route.unitId}`,
          name: `Simulated objective for ${route.unitId}: ${route.objective.name}`,
          position: degreePosition(route.objective.coordinates, 11),
          point: {
            pixelSize: 12,
            color: Cesium.Color.fromCssColorString("#0d2632"),
            outlineColor: Cesium.Color.fromCssColorString("#70d7dc"),
            outlineWidth: 3,
            disableDepthTestDistance: Infinity,
          },
          label: {
            text: `OBJECTIVE · ${route.objective.name}`,
            font: "600 12px sans-serif",
            fillColor: Cesium.Color.WHITE,
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString("#123844ee"),
            pixelOffset: new Cesium.Cartesian2(0, -25),
          },
        }),
      );
      plannedKeyRef.current = plannedKey;
    }
    if (observationsChanged) {
      observationRefs.current.forEach((entity) =>
        viewer.entities.remove(entity),
      );
      observationRefs.current = snapshot.observations.map((observation) =>
        viewer.entities.add({
          id: observation.id,
          name: `Simulated unit observation by ${observation.unitName} at ${observation.junction.name}; approximate approach only`,
          position: degreePosition(observation.junction.coordinates, 12),
          ellipse: {
            semiMajorAxis: 35,
            semiMinorAxis: 35,
            material: Cesium.Color.fromCssColorString("#f5c77433"),
            outline: true,
            outlineColor: Cesium.Color.fromCssColorString("#f5c774"),
          },
          label: {
            text: `UNIT OBSERVATION · ${observation.unitName}`,
            font: "600 12px sans-serif",
            fillColor: Cesium.Color.WHITE,
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString("#493c20ee"),
            pixelOffset: new Cesium.Cartesian2(0, -24),
          },
        }),
      );
      observationKeyRef.current = observationKey;
    }
    const mobileKey = JSON.stringify(
      snapshot.mobileObservations.map((observation) => [
        observation.id,
        validUnitPosition(
          snapshot.units.find((unit) => unit.unitId === observation.unitId),
        ),
      ]),
    );
    if (mobileKey !== mobileObservationKeyRef.current) {
      mobileObservationRefs.current.forEach((entity) =>
        viewer.entities.remove(entity),
      );
      mobileObservationRefs.current = snapshot.mobileObservations.flatMap(
        (observation) => {
          const coordinates = validUnitPosition(
            snapshot.units.find((unit) => unit.unitId === observation.unitId),
          );
          return coordinates
            ? [
                viewer.entities.add({
                  id: observation.id,
                  name: `Simulated mobile sighting reported by ${observation.unitName}; approximate ${observation.roadName} corridor, no vehicle position`,
                  position: degreePosition(coordinates, 14),
                  ellipse: {
                    semiMajorAxis: 25,
                    semiMinorAxis: 25,
                    material: Cesium.Color.fromCssColorString("#67e2bd33"),
                    outline: true,
                    outlineColor: Cesium.Color.fromCssColorString("#67e2bd"),
                  },
                  label: {
                    text: `MOBILE SIGHTING · ${observation.unitName}`,
                    font: "600 12px sans-serif",
                    fillColor: Cesium.Color.WHITE,
                    showBackground: true,
                    backgroundColor:
                      Cesium.Color.fromCssColorString("#12483eee"),
                    pixelOffset: new Cesium.Cartesian2(0, -27),
                  },
                }),
              ]
            : [];
        },
      );
      mobileObservationKeyRef.current = mobileKey;
    }
    const trafficKey = snapshot.trafficSegments
      .map((segment) => `${segment.id}:${segment.level}`)
      .join("|");
    if (trafficKey !== trafficKeyRef.current) {
      const visible = new Set<string>();
      for (const segment of snapshot.trafficSegments) {
        if (segment.level === 0) continue;
        visible.add(segment.id);
        const existing = trafficRefs.current.get(segment.id);
        if (existing) {
          if (existing.level !== segment.level) {
            existing.level = segment.level;
            existing.entity.name = `Simulated ${segment.level === 2 ? "slow" : "moderate"} traffic`;
            existing.entity.polyline!.width = new Cesium.ConstantProperty(
              segment.level === 2 ? 5 : 3,
            );
            existing.entity.polyline!.material =
              new Cesium.ColorMaterialProperty(
                Cesium.Color.fromCssColorString(
                  segment.level === 2 ? "#f7b36f99" : "#f5d97888",
                ),
              );
          }
          continue;
        }
        const entity = viewer.entities.add({
          id: `traffic-${segment.id}`,
          name: `Simulated ${segment.level === 2 ? "slow" : "moderate"} traffic`,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArrayHeights([
              segment.from[0],
              segment.from[1],
              4,
              segment.to[0],
              segment.to[1],
              4,
            ]),
            width: segment.level === 2 ? 5 : 3,
            material: Cesium.Color.fromCssColorString(
              segment.level === 2 ? "#f7b36f99" : "#f5d97888",
            ),
          },
        });
        trafficRefs.current.set(segment.id, { entity, level: segment.level });
      }
      for (const [id, existing] of trafficRefs.current) {
        if (visible.has(id)) continue;
        viewer.entities.remove(existing.entity);
        trafficRefs.current.delete(id);
      }
      trafficKeyRef.current = trafficKey;
    }
    if (historyChanged) {
      reportRefs.current = snapshot.confirmedReports
        .filter((confirmed) => confirmed.id !== report.id)
        .map((confirmed) =>
          viewer.entities.add({
            id: `confirmed-${confirmed.id}`,
            name: `Simulated confirmed device report · ${confirmed.deviceTimestamp}`,
            position: degreePosition(confirmed.coordinates, 10),
            point: {
              pixelSize: 7,
              color: Cesium.Color.fromCssColorString("#ff8982"),
              outlineColor: Cesium.Color.fromCssColorString("#37202a"),
              outlineWidth: 2,
              disableDepthTestDistance: Infinity,
            },
          }),
        );
      historyKeyRef.current = historyKey;
    }
    viewer.scene.requestRender();
  }, [snapshot, selectedUnit, ready]);
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !ready) return;
    if (!cameraRequest) {
      viewer.camera.cancelFlight();
      return;
    }
    viewer.camera.cancelFlight();
    activeFlightRef.current = cameraRequest;
    const finish = () => {
      if (activeFlightRef.current !== cameraRequest) return;
      activeFlightRef.current = null;
      if (cameraRequest.kind === "fit") return;
      const latest = latestSnapshotRef.current;
      const selection = latestSelectionRef.current;
      const current =
        cameraRequest.kind === "vehicle"
          ? selection.following
            ? latest.lastConfirmedReport.coordinates
            : null
          : selection.selectedUnit === cameraRequest.unitId
            ? validUnitPosition(
                latest.units.find(
                  (unit) => unit.unitId === cameraRequest.unitId,
                ),
              )
            : null;
      if (current) {
        followMovedTarget(
          viewer,
          degreePosition(cameraRequest.coordinates),
          degreePosition(current),
        );
      }
      viewer.scene.requestRender();
    };
    const cancel = () => {
      if (activeFlightRef.current === cameraRequest)
        activeFlightRef.current = null;
    };
    if (cameraRequest.kind === "fit") {
      setTilted(false);
      viewer.camera.flyTo({
        destination: fitDestination(cameraRequest.positions),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        duration: 0.65,
        complete: finish,
        cancel,
      });
    } else {
      viewer.camera.flyToBoundingSphere(
        new Cesium.BoundingSphere(degreePosition(cameraRequest.coordinates), 0),
        {
          offset: new Cesium.HeadingPitchRange(
            viewer.camera.heading,
            pitchForMode(tilted),
            cameraRequest.kind === "unit" ? 1300 : 1800,
          ),
          duration: 0.65,
          complete: finish,
          cancel,
        },
      );
    }
    viewer.scene.requestRender();
    // The request is a one-shot command. Reports and angle changes must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraRequest, ready]);
  useEffect(() => {
    const viewer = viewerRef.current;
    const previousSnapshot = previousSnapshotRef.current;
    previousSnapshotRef.current = snapshot;
    if (!viewer || !ready || activeFlightRef.current) return;
    if (snapshot !== previousSnapshot) {
      if (selectedUnit) {
        const previous = previousSnapshot.units.find(
          (unit) => unit.unitId === selectedUnit,
        );
        const current = snapshot.units.find(
          (unit) => unit.unitId === selectedUnit,
        );
        const previousPosition = previous && validUnitPosition(previous);
        const currentPosition = current && validUnitPosition(current);
        if (previousPosition && currentPosition) {
          followMovedTarget(
            viewer,
            degreePosition(previousPosition),
            degreePosition(currentPosition),
          );
        }
      } else if (following) {
        followMovedTarget(
          viewer,
          degreePosition(previousSnapshot.lastConfirmedReport.coordinates),
          degreePosition(snapshot.lastConfirmedReport.coordinates),
        );
      }
    }
  }, [snapshot, selectedUnit, following, ready]);
  const project = (p: readonly [number, number]): [number, number] => [
    ((p[0] - 28.043) / 0.018) * 1000,
    ((-26.097 - p[1]) / 0.011) * 800,
  ];
  return (
    <section
      className={`map-panel${fullPageMap ? " full-page-map" : ""}`}
      aria-label="Incident map"
    >
      <div
        ref={host}
        id="globe"
        aria-label={`${street ? "Street" : "Aerial"} map of the simulated incident`}
      />
      {mapStatus !== "ready" && (
        <div className="schematic">
          <svg
            viewBox="0 0 1000 800"
            preserveAspectRatio="xMidYMid slice"
            role="img"
            aria-label="Illustrative incident diagram, not a geographic street map"
          >
            <rect width="1000" height="800" fill="#162230" />
            {footprintsVisible &&
              snapshot.sightLineFootprints.map((footprint) => (
                <polygon
                  key={footprint.id}
                  points={footprint.coordinates
                    .map((point) => project(point).join(","))
                    .join(" ")}
                  fill={
                    footprint.source === "synthetic_fixture"
                      ? "#f28b7488"
                      : "#9c88d455"
                  }
                  stroke={
                    footprint.source === "synthetic_fixture"
                      ? "#f28b74"
                      : "#b4a0eb"
                  }
                  strokeWidth="2"
                />
              ))}
            {snapshot.trafficSegments.map((segment) => (
              <line
                key={segment.id}
                x1={project(segment.from)[0]}
                y1={project(segment.from)[1]}
                x2={project(segment.to)[0]}
                y2={project(segment.to)[1]}
                stroke={
                  segment.level === 2
                    ? "#bd7c47"
                    : segment.level === 1
                      ? "#9c8c58"
                      : "#607084"
                }
                strokeWidth={segment.level === 2 ? "7" : "5"}
              />
            ))}
            {snapshot.inferredConnections.map((connection) => (
              <polyline
                key={`${connection.fromReportId}-${connection.toReportId}`}
                points={connection.coordinates
                  .map((point) => project(point).join(","))
                  .join(" ")}
                fill="none"
                stroke="#ddc1ff"
                strokeWidth="4"
                strokeDasharray="10 8"
              />
            ))}
            {snapshot.plannedRoutes.map((route) => (
              <polyline
                key={route.unitId}
                points={route.coordinates
                  .map((point) => project(point).join(","))
                  .join(" ")}
                fill="none"
                stroke="#70d7dc"
                strokeWidth="3"
                strokeDasharray="7 6"
              />
            ))}
            {snapshot.plannedRoutes.map((route) => {
              const [x, y] = project(route.objective.coordinates);
              return (
                <g key={`objective-${route.unitId}`}>
                  <circle
                    cx={x}
                    cy={y}
                    r="10"
                    fill="#0d2632"
                    stroke="#70d7dc"
                    strokeWidth="3"
                  />
                  <text
                    x={x}
                    y={y - 18}
                    textAnchor="middle"
                    fill="#70d7dc"
                    fontSize="14"
                  >
                    Objective · {route.objective.name}
                  </text>
                </g>
              );
            })}
            {snapshot.observations.map((observation) => {
              const [x, y] = project(observation.junction.coordinates);
              return (
                <g key={observation.id}>
                  <circle
                    cx={x}
                    cy={y}
                    r="28"
                    fill="#f5c77433"
                    stroke="#f5c774"
                    strokeWidth="3"
                  />
                  <text
                    x={x}
                    y={y - 32}
                    textAnchor="middle"
                    fill="#f5c774"
                    fontSize="15"
                  >
                    Unit observation
                  </text>
                </g>
              );
            })}
            {snapshot.mobileObservations.map((observation) => {
              const coordinates = validUnitPosition(
                snapshot.units.find(
                  (unit) => unit.unitId === observation.unitId,
                ),
              );
              if (!coordinates) return null;
              const [x, y] = project(coordinates);
              return (
                <g key={observation.id}>
                  <circle
                    cx={x}
                    cy={y}
                    r="26"
                    fill="#67e2bd33"
                    stroke="#67e2bd"
                    strokeWidth="3"
                  />
                  <text
                    x={x}
                    y={y - 32}
                    textAnchor="middle"
                    fill="#67e2bd"
                    fontSize="14"
                  >
                    Mobile sighting · {observation.unitName}
                  </text>
                </g>
              );
            })}
            {snapshot.confirmedReports
              .filter(
                (confirmed) => confirmed.id !== snapshot.lastConfirmedReport.id,
              )
              .map((confirmed) => {
                const [x, y] = project(confirmed.coordinates);
                return (
                  <circle
                    key={confirmed.id}
                    cx={x}
                    cy={y}
                    r="6"
                    fill="#ff8982"
                    stroke="#37202a"
                    strokeWidth="2"
                  />
                );
              })}
            {snapshot.units.map((u) => {
              const coordinates = validUnitPosition(u);
              if (!coordinates) return null;
              const [x, y] = project(coordinates);
              return (
                <g key={u.unitId} transform={`translate(${x},${y})`}>
                  {u.currentReport &&
                    Number.isFinite(u.currentReport.headingDegrees) &&
                    u.currentReport.speedKmh > 0 && (
                      <path
                        d="M0 -28 7 -16 0 -19 -7 -16Z"
                        transform={`rotate(${u.currentReport.headingDegrees})`}
                        fill="#7bbaff"
                        stroke="#102034"
                        strokeWidth="1.5"
                        strokeLinejoin="round"
                      />
                    )}
                  <circle
                    r="15"
                    fill="#7bbaff"
                    stroke="#10283e"
                    strokeWidth="4"
                  />
                  <text y="-43" textAnchor="middle" fill="white" fontSize="18">
                    {u.unitName}
                  </text>
                </g>
              );
            })}
            {(() => {
              const [x, y] = project(snapshot.lastConfirmedReport.coordinates);
              return (
                <g transform={`translate(${x},${y})`}>
                  {snapshot.connectivity === "connected" &&
                    Number.isFinite(
                      snapshot.lastConfirmedReport.headingDegrees,
                    ) &&
                    snapshot.lastConfirmedReport.speedKmh > 0 && (
                      <path
                        d="M0 -31 8 -19 0 -22 -8 -19Z"
                        transform={`rotate(${snapshot.lastConfirmedReport.headingDegrees})`}
                        fill="#ff8982"
                        stroke="#3b2029"
                        strokeWidth="1.5"
                        strokeLinejoin="round"
                      />
                    )}
                  <circle
                    r="18"
                    fill="#ff8982"
                    stroke="#3b2029"
                    strokeWidth="4"
                  />
                  <text y="-45" textAnchor="middle" fill="white" fontSize="18">
                    Last confirmed
                  </text>
                </g>
              );
            })()}
          </svg>
          <div className="schematic-label" role="status">
            {mapStatus === "loading"
              ? `Loading ${street ? "street" : "aerial"} map · local road graph shown meanwhile`
              : "Local road graph · map imagery unavailable"}
            <span>
              {" "}
              · roads © OpenStreetMap contributors · traffic simulated
            </span>
          </div>
        </div>
      )}
      <div className="map-top">
        <div className="map-location">
          <span className="map-kicker">INCIDENT AREA</span>
          <strong>
            Sandton <span>/ Johannesburg</span>
          </strong>
        </div>
        <span className="map-mode">
          {mapStatus === "ready"
            ? street
              ? "STREET MAP"
              : "AERIAL MAP"
            : mapStatus === "loading"
              ? "LOADING MAP"
              : "ROAD GRAPH VIEW"}
        </span>
      </div>
      <button
        className="map-full-page-button"
        aria-label={fullPageMap ? "Exit full-page map" : "Full-page map"}
        aria-pressed={fullPageMap}
        onClick={onToggleFullPageMap}
      >
        {fullPageMap ? "⤡" : "⤢"}{" "}
        <span className="full-label">
          {fullPageMap ? "Exit full-page map" : "Full-page map"}
        </span>
        <span className="short-label" aria-hidden="true">
          {fullPageMap ? "Exit map" : "Full map"}
        </span>
      </button>
      <div className="map-toolbar" aria-label="Map controls">
        <button
          aria-label="Fit all map markers"
          onClick={onFit}
          disabled={mapStatus !== "ready"}
        >
          ⊞ <span>Fit all</span>
        </button>
        <button
          aria-label={tilted ? "Top-down map view" : "Tilt map view"}
          aria-pressed={tilted}
          disabled={mapStatus !== "ready"}
          onClick={() => {
            const viewer = viewerRef.current;
            if (!viewer) return;

            const unit = snapshot.units.find(
              (candidate) => candidate.unitId === selectedUnit,
            );
            const unitPosition = unit && validUnitPosition(unit);
            const fallback = unitPosition
              ? degreePosition(unitPosition)
              : following
                ? degreePosition(snapshot.lastConfirmedReport.coordinates)
                : undefined;
            const nextTilted = !tilted;
            if (changeViewAngle(viewer, nextTilted, fallback)) {
              setTilted(nextTilted);
            }
          }}
        >
          ◈ <span>{tilted ? "Top-down" : "Tilt view"}</span>
        </button>
        <button
          aria-label={street ? "Aerial map" : "Street map"}
          onClick={() => setStreet((v) => !v)}
        >
          ▧ <span>{street ? "Aerial map" : "Street map"}</span>
        </button>
        <button
          aria-label="Road labels"
          aria-pressed={labels}
          disabled={street}
          onClick={() => setLabels((v) => !v)}
        >
          Aa <span>Road labels</span>
        </button>
        <button
          aria-label="Mapped building footprints"
          aria-pressed={footprintsVisible}
          onClick={() => setFootprintsVisible((visible) => !visible)}
        >
          ▰ <span>Mapped footprints</span>
        </button>
      </div>
      {snapshot.sightLineFixture !== "none" && (
        <div className="sight-line-fixture-label">
          Synthetic sight-line fixture · {snapshot.sightLineFixture} · mapped
          building coverage incomplete
        </div>
      )}
      {snapshot.mobileFixture !== "none" && (
        <div className="mobile-fixture-label">
          Synthetic mobile fixture ·{" "}
          {snapshot.mobileFixture.replaceAll("-", " ")}
        </div>
      )}
      {snapshot.connectivity === "signal_lost" && (
        <div className="signal-overlay">
          <strong>Location updates interrupted</strong>
          <span>
            The vehicle marker remains at its last confirmed device report.
          </span>
        </div>
      )}
      {snapshot.observations.length > 0 && (
        <div className="observation-overlay" role="status">
          <strong>Simulated unit observation</strong>
          <span>
            {snapshot.observations.at(-1)?.unitName} saw an approximate approach
            at {snapshot.observations.at(-1)?.junction.name}. Observed at{" "}
            {elapsed(snapshot.observations.at(-1)!.observedSecond)}; available
            at {elapsed(snapshot.observations.at(-1)!.availableSecond)}.
            {snapshot.connectivity === "signal_lost"
              ? " Vehicle GPS remains at its last confirmed report."
              : ""}{" "}
            No mapped blockage; actual visibility uncertain.
          </span>
        </div>
      )}
      {snapshot.mobileObservations.length > 0 && (
        <div className="mobile-observation-overlay" role="status">
          <strong>Simulated mobile unit sighting</strong>
          <span>
            {snapshot.mobileObservations.at(-1)?.unitName} reported a{" "}
            {snapshot.mobileObservations.at(-1)?.encounterType === "oncoming"
              ? "passing opposite-direction encounter"
              : "following-behind encounter"}{" "}
            on {snapshot.mobileObservations.at(-1)?.roadName}. Observed at{" "}
            {elapsed(snapshot.mobileObservations.at(-1)!.observedSecond)};
            available at{" "}
            {elapsed(snapshot.mobileObservations.at(-1)!.availableSecond)}.
            Approximate corridor only; visibility uncertain. Vehicle GPS stays
            at its last confirmed report during signal loss.
          </span>
        </div>
      )}
      {mapStatus === "ready" && (
        <div className="map-bottom">
          <div className="map-legend">
            <span>
              <i className="legend-target" />
              Confirmed reports
            </span>
            <span>
              <i className="legend-unit" />
              Units
            </span>
            <span>
              <i className="legend-heading" aria-hidden="true">
                <b>▲</b>
                <b>▲</b>
              </i>
              Heading
            </span>
            <span>
              <i className="legend-inferred" />
              Inferred path
            </span>
            <span>
              <i className="legend-plan" /> Simulated unit route
            </span>
            <span>
              <i className="legend-objective" /> Unit objective
            </span>
            <span>
              <i className="legend-traffic" /> Simulated congestion
            </span>
            <span>
              <i className="legend-observation" /> Unit observation
            </span>
            <span>
              <i className="legend-mobile-observation" /> Mobile sighting
            </span>
            {footprintsVisible && (
              <span>
                <i className="legend-footprint" /> Mapped footprints
              </span>
            )}
          </div>
          <button
            className="map-help"
            aria-label="Map and data information"
            onClick={() =>
              setMessage((v) =>
                v
                  ? ""
                  : "Real map imagery and mapped road geometry; all vehicle and unit reports, traffic and movements are simulated. Marker arrows show headings at the latest simulated reports, not predictions. The vehicle arrow is hidden during signal loss. Red points are confirmed simulated device reports. Purple dashed paths are inferred between consecutive reports; no path crosses missing reports. Cyan dashed paths and ETAs are simulated unit plans. Gold rings mark approximate simulated unit observations, including during GPS loss; they never move the last confirmed GPS marker. Mapped building footprints are incomplete; no mapped blockage means uncertain real-world visibility. Synthetic sight-line fixtures are labelled. Road graph and building footprints © OpenStreetMap contributors (ODbL).",
              )
            }
          >
            i
          </button>
        </div>
      )}
      {message && (
        <div
          className="map-message"
          role="status"
          onClick={() => setMessage("")}
        >
          {message}
        </div>
      )}
    </section>
  );
}
