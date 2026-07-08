"use strict";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const numberFormat = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });
const integerFormat = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
const percentFormat = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const ACTIVE_TRAVEL_HOURS_PER_YEAR = 900;
const INTERNAL_STEPS_PER_YEAR = 4;
const MAX_OUTFLOW_FRACTION_PER_INTERNAL_STEP = 0.65;
const MANUAL_COIN_TYPE = "__manual_without_type__";
const MANUAL_COIN_LABEL = "Manuell / ohne Typ";

const state = {
  data: null,
  nodes: new Map(),
  edges: [],
  coinTypes: [],
  coinPeriods: new Map(),
  typeFilter: {
    enabled: false,
    selected: new Set(),
  },
  transportModes: {},
  defaultTransportModes: {},
  settings: {
    startYear: -250,
    durationYears: 200,
    stepYears: 25,
    coinWeight: 0.75,
    distanceScale: 120,
    diffusionRate: 0.04,
    includeUndatedCoins: true,
  },
  simulation: {
    snapshots: [],
    currentStep: 0,
    timer: null,
  },
  selected: null,
  map: null,
  layers: {
    nodes: null,
    edges: null,
    itinere: null,
  },
  markers: new Map(),
  edgeLayers: new Map(),
  modeVisibility: new Map(),
  itinereData: null,
  itinereLoading: null,
  edgeAdd: {
    active: false,
    source: null,
  },
  toastTimer: null,
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function formatYear(year) {
  if (year < 0) return `${integerFormat.format(Math.abs(year))} v. Chr.`;
  if (year > 0) return `${integerFormat.format(year)} n. Chr.`;
  return "Jahr 0 (Modell)";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message, duration = 3200) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("visible"), duration);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function haversineKm(a, b) {
  const radius = 6371.0088;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

function colorMix(start, end, amount) {
  const parse = (hex) => [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
  const left = parse(start);
  const right = parse(end);
  const result = left.map((value, index) =>
    Math.round(value + (right[index] - value) * amount),
  );
  return `#${result.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function coinColor(value, maximum) {
  if (maximum <= 0 || value <= 0) return "#48665a";
  const normalized = Math.log1p(value) / Math.log1p(maximum);
  if (normalized < 0.58) return colorMix("#48665a", "#d2a65a", normalized / 0.58);
  return colorMix("#d2a65a", "#e86652", (normalized - 0.58) / 0.42);
}

function currentYear() {
  return state.settings.startYear + state.simulation.currentStep * state.settings.stepYears;
}

function stepCount() {
  return Math.round(state.settings.durationYears / state.settings.stepYears);
}

function formatPercent(value) {
  return `${percentFormat.format(value * 100)} %`;
}

function coinTypeAllowedByFilter(coinType) {
  if (coinType === MANUAL_COIN_TYPE) return !state.typeFilter.enabled;
  if (!state.typeFilter.enabled) return true;
  return state.typeFilter.selected.has(coinType);
}

function activeCoinType(coinType, year) {
  if (coinType === MANUAL_COIN_TYPE) {
    return !state.typeFilter.enabled && state.settings.includeUndatedCoins;
  }
  if (!coinTypeAllowedByFilter(coinType)) return false;
  const period = state.coinPeriods.get(coinType);
  if (!period || (period.startYear == null && period.endYear == null)) {
    return state.settings.includeUndatedCoins;
  }
  const afterStart = period.startYear == null || year >= period.startYear;
  const beforeEnd = period.endYear == null || year <= period.endYear;
  return afterStart && beforeEnd;
}

function coinTypeLabel(coinType) {
  return coinType === MANUAL_COIN_TYPE ? MANUAL_COIN_LABEL : coinType;
}

function coinTypePeriodLabel(coinType) {
  if (coinType === MANUAL_COIN_TYPE) return "ohne Typdatierung";
  const period = state.coinPeriods.get(coinType);
  if (!period || (period.startYear == null && period.endYear == null)) {
    return "undatiert";
  }
  const start = period.startYear == null ? "offen" : formatYear(period.startYear);
  const end = period.endYear == null ? "offen" : formatYear(period.endYear);
  return `${start} â€“ ${end}`;
}

function cleanTypeCoins(typeCoins = {}) {
  const clean = {};
  for (const [coinType, rawValue] of Object.entries(typeCoins || {})) {
    const value = Math.max(0, Number(rawValue || 0));
    if (Number.isFinite(value) && value > 1e-10) clean[coinType] = value;
  }
  return clean;
}

function sumTypeCoins(typeCoins = {}) {
  return Object.values(typeCoins || {}).reduce(
    (sum, value) => sum + Math.max(0, Number(value || 0)),
    0,
  );
}

function setNodeInitialTypeCoins(node, typeCoins) {
  node.initialTypeCoins = cleanTypeCoins(typeCoins);
  node.initialCoins = sumTypeCoins(node.initialTypeCoins);
}

function visibleInitialCoins(node) {
  ensureNodeTypeState(node);
  return Object.entries(node.initialTypeCoins || {}).reduce((sum, [coinType, value]) => {
    return coinTypeAllowedByFilter(coinType) ? sum + Number(value || 0) : sum;
  }, 0);
}

function seedNodeFromCsvTypes(node) {
  const typeCoins = {};
  for (const [coinType, count] of Object.entries(node.typeCounts || {})) {
    if (!coinTypeAllowedByFilter(coinType)) continue;
    typeCoins[coinType] = Number(count || 0);
  }
  setNodeInitialTypeCoins(node, typeCoins);
}

function manualDistributionCandidates(node) {
  const observedAllowed = Object.keys(node.typeCounts || {}).filter((coinType) =>
    coinTypeAllowedByFilter(coinType),
  );
  if (observedAllowed.length) return observedAllowed;
  const existingAllowed = Object.keys(node.initialTypeCoins || {}).filter((coinType) =>
    coinTypeAllowedByFilter(coinType),
  );
  if (existingAllowed.length) return existingAllowed;
  if (state.typeFilter.enabled && state.typeFilter.selected.size) {
    return [...state.typeFilter.selected];
  }
  const observed = Object.keys(node.typeCounts || {});
  return observed.length ? observed : [MANUAL_COIN_TYPE];
}

function setNodeInitialTotal(node, total) {
  const targetTotal = Math.max(0, Number(total || 0));
  if (targetTotal <= 0) {
    setNodeInitialTypeCoins(node, {});
    return;
  }
  const candidates = manualDistributionCandidates(node);
  const existing = node.initialTypeCoins || {};
  const observed = node.typeCounts || {};
  let weights = candidates.map((coinType) => Math.max(0, Number(existing[coinType] || 0)));
  let weightTotal = weights.reduce((sum, value) => sum + value, 0);
  if (weightTotal <= 0) {
    weights = candidates.map((coinType) => Math.max(0, Number(observed[coinType] || 0)));
    weightTotal = weights.reduce((sum, value) => sum + value, 0);
  }
  if (weightTotal <= 0) {
    weights = candidates.map(() => 1);
    weightTotal = weights.length || 1;
  }
  const typeCoins = {};
  candidates.forEach((coinType, index) => {
    typeCoins[coinType] = targetTotal * (weights[index] / weightTotal);
  });
  setNodeInitialTypeCoins(node, typeCoins);
}

function ensureNodeTypeState(node) {
  if (!node.initialTypeCoins) {
    if (Number(node.initialCoins || 0) > 0) setNodeInitialTotal(node, node.initialCoins);
    else setNodeInitialTypeCoins(node, {});
  } else {
    setNodeInitialTypeCoins(node, node.initialTypeCoins);
  }
}

function nodeCoinCountForFilter(node, year = null) {
  const counts = node?.typeCounts || {};
  return Object.entries(counts).reduce((sum, [coinType, count]) => {
    const included =
      year == null ? coinTypeAllowedByFilter(coinType) : activeCoinType(coinType, year);
    return included ? sum + Number(count || 0) : sum;
  }, 0);
}

function setInitialCoinsFromCurrentTypeFilter() {
  for (const node of state.nodes.values()) {
    seedNodeFromCsvTypes(node);
  }
  state.simulation.currentStep = 0;
  runSimulation();
  if (state.selected?.type === "node") selectNode(state.selected.id);
  showToast(
    state.typeFilter.enabled
      ? "Startmengen aus ausgewählten Typen gesetzt; Datierungen steuern ihre Bewegung."
      : "Startmengen aus allen Typen gesetzt; Datierungen steuern ihre Bewegung.",
  );
}

function simulationSnapshotFromCurrent(current) {
  const byNodeType = current.map((typeCoins) => cleanTypeCoins(typeCoins));
  const totals = byNodeType.map((typeCoins) => sumTypeCoins(typeCoins));
  const typeTotals = {};
  for (const typeCoins of byNodeType) {
    for (const [coinType, value] of Object.entries(typeCoins)) {
      typeTotals[coinType] = (typeTotals[coinType] || 0) + value;
    }
  }
  return { totals, byNodeType, typeTotals };
}

function currentSnapshot() {
  return (
    state.simulation.snapshots[state.simulation.currentStep] || {
      totals: [],
      byNodeType: [],
      typeTotals: {},
    }
  );
}

function nodeTypeSnapshot(nodeId) {
  const nodes = [...state.nodes.values()];
  const index = nodes.findIndex((node) => node.id === nodeId);
  if (index < 0) return {};
  return currentSnapshot().byNodeType[index] || {};
}

function coinMetricsForEdge(edge, year) {
  const source = state.nodes.get(edge.source);
  const target = state.nodes.get(edge.target);
  if (!source || !target) {
    return { sharedTypeCount: 0, sharedCoinMinimum: 0, coinProxy: 0 };
  }
  const sourceCounts = source.typeCounts || {};
  const targetCounts = target.typeCounts || {};
  let sourceTotal = 0;
  let targetTotal = 0;
  let sharedCoinMinimum = 0;
  let sharedTypeCount = 0;

  for (const [coinType, count] of Object.entries(sourceCounts)) {
    if (activeCoinType(coinType, year)) sourceTotal += Number(count);
  }
  for (const [coinType, count] of Object.entries(targetCounts)) {
    if (activeCoinType(coinType, year)) targetTotal += Number(count);
  }
  const smaller =
    Object.keys(sourceCounts).length <= Object.keys(targetCounts).length
      ? sourceCounts
      : targetCounts;
  const other = smaller === sourceCounts ? targetCounts : sourceCounts;
  for (const [coinType, count] of Object.entries(smaller)) {
    if (!other[coinType] || !activeCoinType(coinType, year)) continue;
    sharedTypeCount += 1;
    sharedCoinMinimum += Math.min(Number(count), Number(other[coinType]));
  }
  const denominator = Math.sqrt(sourceTotal * targetTotal);
  return {
    sharedTypeCount,
    sharedCoinMinimum,
    coinProxy: denominator > 0 ? sharedCoinMinimum / denominator : 0,
  };
}

function edgeMetrics(edge, year = currentYear()) {
  const source = state.nodes.get(edge.source);
  const target = state.nodes.get(edge.target);
  const mode = state.transportModes[edge.mode] || state.transportModes.pack_animal;
  const sourceSize = Math.max(0.1, Number(source?.size || 1));
  const targetSize = Math.max(0.1, Number(target?.size || 1));
  const normalizedTrade =
    Math.max(0, Number(edge.strength || 0)) / Math.sqrt(sourceSize * targetSize);
  const terrainPenalty = Math.pow(
    Math.max(1, Number(edge.terrainFactor || 1)),
    Math.max(0, Number(mode.slopePenalty || 0)),
  );
  const travelTime =
    (Number(edge.distanceKm || 0) * terrainPenalty) /
    Math.max(0.1, Number(mode.speedKmh || 1));
  const possibleTripsPerYear =
    ACTIVE_TRAVEL_HOURS_PER_YEAR / Math.max(1, travelTime);
  const travelOpportunity =
    possibleTripsPerYear / (possibleTripsPerYear + 1);
  const distanceFactor =
    Math.max(1, state.settings.distanceScale) /
    (Math.max(1, state.settings.distanceScale) + Math.max(0, Number(edge.distanceKm || 0)));
  const modeFactor =
    (Math.max(0.01, Number(mode.capacity || 1)) /
      (Math.max(0.01, Number(mode.costFactor || 1)) * terrainPenalty));
  const coin = coinMetricsForEdge(edge, year);
  const coinFactor = 1 + state.settings.coinWeight * coin.coinProxy;
  const conductance =
    normalizedTrade * distanceFactor * modeFactor * travelOpportunity * coinFactor;
  return {
    normalizedTrade,
    distanceFactor,
    terrainPenalty,
    travelOpportunity,
    possibleTripsPerYear,
    modeFactor,
    conductance,
    travelTime,
    ...coin,
  };
}

function runSimulation() {
  const nodes = [...state.nodes.values()];
  const nodeIndex = new Map(nodes.map((node, index) => [node.id, index]));
  for (const node of nodes) ensureNodeTypeState(node);
  let current = nodes.map((node) => {
    const typeCoins = {};
    for (const [coinType, value] of Object.entries(node.initialTypeCoins || {})) {
      if (!coinTypeAllowedByFilter(coinType)) continue;
      const amount = Math.max(0, Number(value || 0));
      if (amount > 0) typeCoins[coinType] = amount;
    }
    return typeCoins;
  });
  const initialTypeTotals = {};
  for (const typeCoins of current) {
    for (const [coinType, value] of Object.entries(typeCoins)) {
      initialTypeTotals[coinType] = (initialTypeTotals[coinType] || 0) + value;
    }
  }
  const initialTotal = Object.values(initialTypeTotals).reduce(
    (sum, value) => sum + value,
    0,
  );
  const snapshots = [simulationSnapshotFromCurrent(current)];
  const steps = stepCount();

  for (let step = 0; step < steps; step += 1) {
    const year = state.settings.startYear + step * state.settings.stepYears;
    const adjacency = nodes.map(() => []);
    for (const edge of state.edges) {
      if (!edge.enabled) continue;
      const sourceIndex = nodeIndex.get(edge.source);
      const targetIndex = nodeIndex.get(edge.target);
      if (sourceIndex == null || targetIndex == null) continue;
      const metrics = edgeMetrics(edge, year);
      if (!Number.isFinite(metrics.conductance) || metrics.conductance <= 0) continue;
      adjacency[sourceIndex].push([targetIndex, metrics.conductance]);
      adjacency[targetIndex].push([sourceIndex, metrics.conductance]);
    }

    const internalSteps = Math.max(
      1,
      Math.round(state.settings.stepYears * INTERNAL_STEPS_PER_YEAR),
    );
    const deltaYears = state.settings.stepYears / internalSteps;
    for (let internalStep = 0; internalStep < internalSteps; internalStep += 1) {
      const movementYear = year + internalStep * deltaYears;
      const next = current.map((typeCoins) => ({ ...typeCoins }));
      for (let sourceIndex = 0; sourceIndex < nodes.length; sourceIndex += 1) {
        const neighbors = adjacency[sourceIndex];
        if (!neighbors.length) continue;
        const totalWeight = neighbors.reduce((sum, item) => sum + item[1], 0);
        if (totalWeight <= 0) continue;
        const exchangePressure =
          Math.max(0, Number(state.settings.diffusionRate || 0)) *
          totalWeight *
          deltaYears;
        const outflowFraction = clamp(
          1 - Math.exp(-exchangePressure),
          0,
          MAX_OUTFLOW_FRACTION_PER_INTERNAL_STEP,
        );
        if (outflowFraction <= 0) continue;
        for (const [coinType, sourceAmount] of Object.entries(current[sourceIndex])) {
          const amount = Math.max(0, Number(sourceAmount || 0));
          if (amount <= 0 || !activeCoinType(coinType, movementYear)) continue;
          const budget = amount * outflowFraction;
          next[sourceIndex][coinType] = Math.max(
            0,
            Number(next[sourceIndex][coinType] || 0) - budget,
          );
          for (const [targetIndex, weight] of neighbors) {
            next[targetIndex][coinType] =
              Number(next[targetIndex][coinType] || 0) +
              budget * (weight / totalWeight);
          }
        }
      }
      current = next.map((typeCoins) => cleanTypeCoins(typeCoins));
    }
    if (initialTotal > 0) {
      const currentTypeTotals = {};
      for (const typeCoins of current) {
        for (const [coinType, value] of Object.entries(typeCoins)) {
          currentTypeTotals[coinType] = (currentTypeTotals[coinType] || 0) + value;
        }
      }
      for (const [coinType, initialTypeTotal] of Object.entries(initialTypeTotals)) {
        const currentTypeTotal = currentTypeTotals[coinType] || 0;
        if (currentTypeTotal <= 0 || Math.abs(currentTypeTotal - initialTypeTotal) <= 1e-9) {
          continue;
        }
        const correction = initialTypeTotal / currentTypeTotal;
        current = current.map((typeCoins) => {
          if (!typeCoins[coinType]) return typeCoins;
          return { ...typeCoins, [coinType]: typeCoins[coinType] * correction };
        });
      }
    }
    snapshots.push(simulationSnapshotFromCurrent(current));
  }
  state.simulation.snapshots = snapshots;
  state.simulation.currentStep = clamp(
    state.simulation.currentStep,
    0,
    Math.max(0, snapshots.length - 1),
  );
  updateTimelineUi();
  updateMapStyles();
  updateSummary();
  refreshInspector();
}

function updateTimelineUi() {
  const steps = stepCount();
  const slider = $("#timeline-slider");
  slider.max = String(steps);
  slider.value = String(state.simulation.currentStep);
  $("#year-label").textContent = formatYear(currentYear());
  $("#step-label").textContent = `Schritt ${state.simulation.currentStep} / ${steps}`;
}

function snapshotValue(nodeId) {
  const nodes = [...state.nodes.values()];
  const index = nodes.findIndex((node) => node.id === nodeId);
  if (index < 0) return 0;
  return currentSnapshot().totals[index] || 0;
}

function simulationDiagnostics(threshold = 0.001) {
  const nodes = [...state.nodes.values()];
  const snapshot = currentSnapshot();
  const totals = snapshot.totals || nodes.map(() => 0);
  const values = nodes.map((node, index) => ({
    id: node.id,
    name: node.name,
    value: totals[index] || 0,
    types: snapshot.byNodeType?.[index] || {},
  }));
  const total = values.reduce((sum, item) => sum + item.value, 0);
  const sorted = values
    .slice()
    .sort((left, right) => right.value - left.value);
  return {
    currentStep: state.simulation.currentStep,
    currentYear: currentYear(),
    total,
    nonZeroNodes: values.filter((item) => item.value > threshold).length,
    threshold,
    topNodes: sorted.slice(0, 12),
    topTypes: Object.entries(snapshot.typeTotals || {})
      .map(([type, value]) => ({ type: coinTypeLabel(type), value }))
      .sort((left, right) => right.value - left.value)
      .slice(0, 12),
    settings: deepClone(state.settings),
    typeFilter: {
      enabled: state.typeFilter.enabled,
      selectedCount: state.typeFilter.selected.size,
    },
  };
}

function initMap() {
  state.map = L.map("map", {
    zoomControl: false,
    preferCanvas: true,
    minZoom: 4,
  });
  L.control.zoom({ position: "topright" }).addTo(state.map);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "© OpenStreetMap · GeoNames · Itiner-e",
  }).addTo(state.map);
  state.layers.itinere = L.layerGroup().addTo(state.map);
  state.layers.edges = L.layerGroup().addTo(state.map);
  state.layers.nodes = L.layerGroup().addTo(state.map);
  fitMap();
}

function fitMap() {
  const nodes = [...state.nodes.values()];
  if (!nodes.length || !state.map) return;
  const bounds = L.latLngBounds(nodes.map((node) => [node.lat, node.lon]));
  state.map.fitBounds(bounds.pad(0.05));
}

function renderNodes() {
  state.layers.nodes.clearLayers();
  state.markers.clear();
  const showLabels = $("#show-labels").checked;
  for (const node of state.nodes.values()) {
    const marker = L.circleMarker([node.lat, node.lon], {
      radius: 4 + Math.sqrt(Math.max(0.1, Number(node.size || 1))) * 1.35,
      weight: 1.2,
      color: "#f4e6c6",
      fillColor: "#48665a",
      fillOpacity: 0.88,
      bubblingMouseEvents: false,
    });
    marker.on("click", () => handleNodeClick(node.id));
    if (showLabels) {
      marker.bindTooltip(node.name, {
        permanent: true,
        direction: "top",
        className: "site-label",
        offset: [0, -5],
      });
    } else {
      marker.bindTooltip(
        `<strong>${escapeHtml(node.name)}</strong><br>${integerFormat.format(node.coinFindCount)} Funde`,
        { className: "site-label", direction: "top" },
      );
    }
    marker.addTo(state.layers.nodes);
    state.markers.set(node.id, marker);
  }
  updateMapStyles();
}

function renderEdges() {
  state.layers.edges.clearLayers();
  state.edgeLayers.clear();
  if (!$("#show-edges").checked) return;
  const year = currentYear();
  for (const edge of state.edges) {
    if (!state.modeVisibility.get(edge.mode)) continue;
    const mode = state.transportModes[edge.mode] || state.transportModes.pack_animal;
    const metrics = edgeMetrics(edge, year);
    const route =
      Array.isArray(edge.route) && edge.route.length >= 2
        ? edge.route
        : [
            [state.nodes.get(edge.source).lat, state.nodes.get(edge.source).lon],
            [state.nodes.get(edge.target).lat, state.nodes.get(edge.target).lon],
          ];
    const line = L.polyline(route, {
      color: mode.color || "#d2a65a",
      weight: edge.enabled ? 1.1 + Math.min(5, metrics.conductance * 0.7) : 1,
      opacity: edge.enabled ? 0.58 : 0.18,
      dashArray: mode.lineStyle === "dashed" ? "6 6" : null,
      interactive: true,
      bubblingMouseEvents: false,
    });
    line.on("click", () => selectEdge(edge.id));
    line.addTo(state.layers.edges);
    state.edgeLayers.set(edge.id, line);
  }
}

function updateMapStyles() {
  if (!state.simulation.snapshots.length) return;
  const snapshot = currentSnapshot().totals || [];
  const nodes = [...state.nodes.values()];
  const maximum = Math.max(0, ...snapshot);
  nodes.forEach((node, index) => {
    const marker = state.markers.get(node.id);
    if (!marker) return;
    const selected = state.selected?.type === "node" && state.selected.id === node.id;
    marker.setRadius(4 + Math.sqrt(Math.max(0.1, Number(node.size || 1))) * 1.35);
    marker.setStyle({
      fillColor: coinColor(snapshot[index] || 0, maximum),
      color: selected ? "#ffffff" : "#f4e6c6",
      weight: selected ? 2.6 : 1.2,
      fillOpacity: 0.9,
    });
    if (selected) marker.bringToFront();
  });
  for (const edge of state.edges) {
    const layer = state.edgeLayers.get(edge.id);
    if (!layer) continue;
    const selected = state.selected?.type === "edge" && state.selected.id === edge.id;
    const mode = state.transportModes[edge.mode] || state.transportModes.pack_animal;
    const metrics = edgeMetrics(edge);
    layer.setStyle({
      color: selected ? "#fff0c8" : mode.color || "#d2a65a",
      weight: selected ? 5 : edge.enabled ? 1.1 + Math.min(5, metrics.conductance * 0.7) : 1,
      opacity: selected ? 0.95 : edge.enabled ? 0.58 : 0.18,
      dashArray: mode.lineStyle === "dashed" ? "6 6" : null,
    });
    if (selected) layer.bringToFront();
  }
}

async function ensureItinere() {
  if (state.itinereData) return state.itinereData;
  if (!state.itinereLoading) {
    state.itinereLoading = fetch("/api/itinere")
      .then((response) => {
        if (!response.ok) throw new Error("Itiner-e-Daten konnten nicht geladen werden.");
        return response.json();
      })
      .then((data) => {
        state.itinereData = data;
        return data;
      })
      .finally(() => {
        state.itinereLoading = null;
      });
  }
  return state.itinereLoading;
}

function itinereFeatureVisible(feature, year) {
  const properties = feature.properties || {};
  const routeType = properties.type;
  const typeVisible =
    (routeType === "River" && $("#show-rivers").checked) ||
    ((routeType === "Main Road" || routeType === "Secondary Road") &&
      $("#show-roads").checked) ||
    (routeType === "Sea Lane" && $("#show-sea").checked);
  if (!typeVisible) return false;
  if (routeType === "River" || routeType === "Sea Lane") return true;
  const lower = properties.lowerDate;
  const upper = properties.upperDate;
  if (lower != null && year < Number(lower)) return false;
  if (upper != null && year > Number(upper)) return false;
  return true;
}

async function renderItinere() {
  state.layers.itinere.clearLayers();
  const requested =
    $("#show-rivers").checked || $("#show-roads").checked || $("#show-sea").checked;
  if (!requested) return;
  try {
    const data = await ensureItinere();
    const year = currentYear();
    L.geoJSON(data, {
      filter: (feature) => itinereFeatureVisible(feature, year),
      interactive: false,
      style: (feature) => {
        const properties = feature.properties || {};
        const routeType = properties.type;
        const certainty = properties.segmentCertainty || "";
        const dashArray =
          certainty === "Hypothetical"
            ? "2 8"
            : certainty === "Conjectured"
              ? "7 6"
              : null;
        if (routeType === "River") {
          return { color: "#32a7cd", weight: 2.2, opacity: 0.62 };
        }
        if (routeType === "Sea Lane") {
          return { color: "#55d2de", weight: 1.7, opacity: 0.5, dashArray: "8 7" };
        }
        return {
          color: routeType === "Main Road" ? "#d8b571" : "#a99879",
          weight: routeType === "Main Road" ? 1.8 : 1.1,
          opacity: 0.52,
          dashArray,
        };
      },
    }).addTo(state.layers.itinere);
  } catch (error) {
    showToast(error.message);
  }
}

function renderModeFilters() {
  const container = $("#mode-filters");
  container.innerHTML = "";
  for (const [modeId, mode] of Object.entries(state.transportModes)) {
    if (!state.modeVisibility.has(modeId)) state.modeVisibility.set(modeId, true);
    const label = document.createElement("label");
    label.className = "mode-chip";
    label.innerHTML = `
      <input type="checkbox" data-mode="${escapeHtml(modeId)}" ${state.modeVisibility.get(modeId) ? "checked" : ""}>
      <i class="mode-dot" style="background:${escapeHtml(mode.color)}"></i>
      ${escapeHtml(mode.label)}
    `;
    label.querySelector("input").addEventListener("change", (event) => {
      state.modeVisibility.set(modeId, event.target.checked);
      renderEdges();
      updateMapStyles();
    });
    container.append(label);
  }
}

function updateSummary() {
  const snapshot = currentSnapshot().totals || [];
  const nodes = [...state.nodes.values()];
  const total = snapshot.reduce((sum, value) => sum + value, 0);
  const activeEdges = state.edges.filter((edge) => edge.enabled).length;
  let topIndex = -1;
  let topValue = -Infinity;
  snapshot.forEach((value, index) => {
    if (value > topValue) {
      topValue = value;
      topIndex = index;
    }
  });
  $("#total-coins-current").textContent = numberFormat.format(total);
  $("#active-edge-count").textContent = integerFormat.format(activeEdges);
  $("#top-node-current").textContent =
    topIndex >= 0 && topValue > 0 ? nodes[topIndex].name : "–";
  drawSparkline();
}

function drawSparkline() {
  const svg = $("#distribution-sparkline");
  const concentrations = state.simulation.snapshots.map((snapshot) => {
    const totals = snapshot.totals || [];
    const total = totals.reduce((sum, value) => sum + value, 0);
    if (total <= 0) return 0;
    return Math.max(...totals) / total;
  });
  const maximum = Math.max(0.0001, ...concentrations);
  const width = 240;
  const height = 44;
  const points = concentrations.map((value, index) => {
    const x =
      concentrations.length <= 1 ? 0 : (index / (concentrations.length - 1)) * width;
    const y = height - 4 - (value / maximum) * (height - 10);
    return [x, y];
  });
  const line = points.map((point) => point.join(",")).join(" ");
  const area =
    points.length > 0
      ? `0,${height} ${line} ${width},${height}`
      : `0,${height} ${width},${height}`;
  const cursorX =
    concentrations.length <= 1
      ? 0
      : (state.simulation.currentStep / (concentrations.length - 1)) * width;
  svg.innerHTML = `
    <polygon points="${area}" fill="rgba(210,166,90,0.10)"></polygon>
    <polyline points="${line}" fill="none" stroke="#d2a65a" stroke-width="1.5"></polyline>
    <line x1="${cursorX}" x2="${cursorX}" y1="2" y2="${height}" stroke="#f2ead9" stroke-width="1" opacity="0.55"></line>
  `;
}

function closeInspector() {
  state.selected = null;
  $("#empty-inspector").hidden = false;
  $("#node-inspector").hidden = true;
  $("#edge-inspector").hidden = true;
  updateMapStyles();
}

function handleNodeClick(nodeId) {
  if (state.edgeAdd.active) {
    handleEdgeAddNode(nodeId);
    return;
  }
  selectNode(nodeId);
}

function renderNodeCurrentTypes(node) {
  const currentTypes = Object.entries(nodeTypeSnapshot(node.id))
    .filter(([, value]) => value > 0.001)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8);
  $("#node-current-types").innerHTML = currentTypes.length
    ? currentTypes
        .map(([coinType, value]) => {
          const active = activeCoinType(coinType, currentYear());
          return `
            <div class="rank-item">
              <span title="${escapeHtml(coinTypePeriodLabel(coinType))}">${escapeHtml(coinTypeLabel(coinType))}</span>
              <strong>${numberFormat.format(value)}</strong>
              <em class="type-status ${active ? "active" : "inactive"}">${active ? "beweglich" : "steht"}</em>
            </div>`;
        })
        .join("")
    : '<div class="rank-item"><span>keine simulierten Typmengen</span><strong>–</strong><em class="type-status inactive">leer</em></div>';
}

function nodeTypeDistributionItems(node, search = "") {
  const query = search.trim().toLocaleLowerCase("de");
  const candidates = new Set([
    ...state.coinTypes.map((item) => item.type),
    ...Object.keys(node.initialTypeCoins || {}),
  ]);
  if (Object.keys(node.initialTypeCoins || {}).includes(MANUAL_COIN_TYPE)) {
    candidates.add(MANUAL_COIN_TYPE);
  }
  const currentTypes = nodeTypeSnapshot(node.id);
  return [...candidates]
    .filter((coinType) => coinTypeLabel(coinType).toLocaleLowerCase("de").includes(query))
    .map((coinType) => ({
      type: coinType,
      label: coinTypeLabel(coinType),
      csvCount: Number(node.typeCounts?.[coinType] || 0),
      startValue: Number(node.initialTypeCoins?.[coinType] || 0),
      currentValue: Number(currentTypes?.[coinType] || 0),
      active: activeCoinType(coinType, currentYear()),
    }))
    .sort((left, right) => {
      const rightSignal = right.startValue + right.currentValue + right.csvCount;
      const leftSignal = left.startValue + left.currentValue + left.csvCount;
      if (rightSignal !== leftSignal) return rightSignal - leftSignal;
      return left.label.localeCompare(right.label, "de");
    });
}

function updateNodeTypeDistributionTotal(node) {
  $("#node-type-distribution-total").textContent =
    `${numberFormat.format(node.initialCoins || 0)} Startmünzen`;
}

function renderNodeTypeDistributionDialog(search = "") {
  if (state.selected?.type !== "node") return;
  const node = state.nodes.get(state.selected.id);
  if (!node) return;
  ensureNodeTypeState(node);
  $("#node-type-distribution-title").textContent = `Typmengen: ${node.name}`;
  const items = nodeTypeDistributionItems(node, search);
  $("#node-type-distribution-body").innerHTML = items
    .map(
      (item) => `
        <tr>
          <td title="${escapeHtml(item.type)}">${escapeHtml(item.label)}</td>
          <td>${integerFormat.format(item.csvCount)}</td>
          <td><span class="type-period">${escapeHtml(coinTypePeriodLabel(item.type))}<br>${item.active ? "beweglich im gewählten Jahr" : "steht im gewählten Jahr"}</span></td>
          <td><input type="number" data-type="${escapeHtml(item.type)}" min="0" step="0.1" value="${item.startValue ? Number(item.startValue.toFixed(6)) : ""}"></td>
          <td>${numberFormat.format(item.currentValue)}</td>
        </tr>`,
    )
    .join("");
  $("#node-type-distribution-body").querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", () => {
      const typeCoins = { ...(node.initialTypeCoins || {}) };
      const value = Math.max(0, Number(input.value || 0));
      if (value > 0) typeCoins[input.dataset.type] = value;
      else delete typeCoins[input.dataset.type];
      setNodeInitialTypeCoins(node, typeCoins);
      state.simulation.currentStep = 0;
      runSimulation();
      selectNode(node.id);
      renderNodeTypeDistributionDialog($("#node-type-distribution-search").value);
    });
  });
  updateNodeTypeDistributionTotal(node);
}

function selectNode(nodeId) {
  const node = state.nodes.get(nodeId);
  if (!node) return;
  ensureNodeTypeState(node);
  state.selected = { type: "node", id: nodeId };
  $("#empty-inspector").hidden = true;
  $("#edge-inspector").hidden = true;
  $("#node-inspector").hidden = false;
  $("#node-name").textContent = node.name;
  $("#node-coordinate").textContent = `${Number(node.lat).toFixed(5)}, ${Number(node.lon).toFixed(5)}`;
  $("#node-size-input").value = String(node.size);
  $("#node-coins-input").value = String(visibleInitialCoins(node));
  $("#node-current-coins").textContent = numberFormat.format(snapshotValue(nodeId));
  $("#node-size-basis").textContent = node.sizeBasis || "editierbarer Wert";
  $("#node-find-count").textContent = integerFormat.format(node.coinFindCount || 0);
  $("#node-type-count").textContent = integerFormat.format(node.distinctCoinTypes || 0);
  $("#node-filtered-count").textContent = state.typeFilter.enabled
    ? integerFormat.format(nodeCoinCountForFilter(node))
    : "alle";
  $("#node-coordinate-quality").textContent = node.coordinateQuality || "unbekannt";

  const contexts = Object.entries(node.contexts || {});
  $("#node-contexts").innerHTML = contexts.length
    ? contexts
        .slice(0, 8)
        .map(
          ([context, count]) =>
            `<span class="tag">${escapeHtml(context)} · ${integerFormat.format(count)}</span>`,
        )
        .join("")
    : '<span class="tag">kein Kontextfeld</span>';

  const coinTypes = Object.entries(node.typeCounts || {})
    .filter(([coinType]) => coinTypeAllowedByFilter(coinType))
    .slice(0, 8);
  $("#node-coin-types").innerHTML = coinTypes.length
    ? coinTypes
        .map(
          ([coinType, count]) =>
            `<div class="rank-item"><span title="${escapeHtml(coinType)}">${escapeHtml(coinType)}</span><strong>${integerFormat.format(count)}</strong></div>`,
        )
        .join("")
    : '<div class="rank-item"><span>keine Typcodes</span><strong>–</strong></div>';

  renderNodeCurrentTypes(node);

  const sources = (node.sourceUris || [])
    .flatMap((value) => value.split("|"))
    .map((value) => value.replace(/^,\s*/, "").trim())
    .filter((value) => /^https?:\/\//.test(value));
  const sourceLinks = [
    ...(node.coordinateSource
      ? [{ url: node.coordinateSource, label: "Koordinatenquelle" }]
      : []),
    ...sources.map((url) => ({ url, label: url })),
  ];
  $("#node-sources").innerHTML = sourceLinks.length
    ? sourceLinks
        .map(
          ({ url, label }) =>
            `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`,
        )
        .join("")
    : "<span>Keine URI vorhanden.</span>";
  updateMapStyles();
}

function selectEdge(edgeId) {
  const edge = state.edges.find((item) => item.id === edgeId);
  if (!edge) return;
  const source = state.nodes.get(edge.source);
  const target = state.nodes.get(edge.target);
  state.selected = { type: "edge", id: edgeId };
  $("#empty-inspector").hidden = true;
  $("#node-inspector").hidden = true;
  $("#edge-inspector").hidden = false;
  $("#edge-title").textContent = `${source?.name || "?"} ↔ ${target?.name || "?"}`;
  fillEdgeModeSelect(edge.mode);
  $("#edge-strength-input").value = String(edge.strength);
  $("#edge-strength-output").textContent = numberFormat.format(edge.strength);
  $("#edge-enabled-input").checked = Boolean(edge.enabled);
  $("#edge-route-basis").textContent = edge.waterway
    ? `${edge.routeBasis}: ${edge.waterway}`
    : edge.routeBasis;
  $("#edge-terrain-method").textContent = edge.terrainMethod || "Keine Terrainangabe";
  const link = $("#edge-evidence-link");
  if (edge.evidenceUri) {
    link.href = edge.evidenceUri;
    link.hidden = false;
  } else {
    link.hidden = true;
  }
  refreshEdgeMetrics(edge);
  updateMapStyles();
}

function fillEdgeModeSelect(selectedMode) {
  const select = $("#edge-mode-select");
  select.innerHTML = Object.entries(state.transportModes)
    .map(
      ([modeId, mode]) =>
        `<option value="${escapeHtml(modeId)}" ${modeId === selectedMode ? "selected" : ""}>${escapeHtml(mode.label)}</option>`,
    )
    .join("");
}

function refreshEdgeMetrics(edge) {
  const metrics = edgeMetrics(edge);
  $("#edge-distance").textContent = `${numberFormat.format(edge.distanceKm)} km`;
  $("#edge-travel-time").textContent = `${numberFormat.format(metrics.travelTime)} h`;
  $("#edge-trips-year").textContent =
    `${numberFormat.format(metrics.possibleTripsPerYear)}×`;
  $("#edge-normalized-trade").textContent = numberFormat.format(metrics.normalizedTrade);
  $("#edge-conductance").textContent = numberFormat.format(metrics.conductance);
  $("#edge-coin-proxy").textContent = numberFormat.format(metrics.coinProxy);
  $("#edge-shared-coins").textContent =
    `${integerFormat.format(metrics.sharedTypeCount)} gemeinsame Typcodes · ` +
    `${integerFormat.format(metrics.sharedCoinMinimum)} überlappende Exemplare`;
}

function refreshInspector() {
  if (!state.selected) return;
  if (state.selected.type === "node") {
    const node = state.nodes.get(state.selected.id);
    if (!node) return closeInspector();
    $("#node-current-coins").textContent = numberFormat.format(
      snapshotValue(state.selected.id),
    );
    $("#node-coins-input").value = String(visibleInitialCoins(node));
    renderNodeCurrentTypes(node);
    if ($("#node-type-distribution-dialog")?.open) {
      renderNodeTypeDistributionDialog($("#node-type-distribution-search").value);
    }
  } else {
    const edge = state.edges.find((item) => item.id === state.selected.id);
    if (!edge) return closeInspector();
    refreshEdgeMetrics(edge);
  }
}

function startEdgeAdd(sourceId = null) {
  state.edgeAdd.active = true;
  state.edgeAdd.source = sourceId;
  $("#edge-add-banner").hidden = false;
  $("#add-edge-button").classList.add("active");
  $("#edge-add-instruction").textContent = sourceId
    ? `Zielknoten für ${state.nodes.get(sourceId)?.name || "Quelle"} wählen`
    : "ersten Knoten wählen";
}

function cancelEdgeAdd() {
  state.edgeAdd.active = false;
  state.edgeAdd.source = null;
  $("#edge-add-banner").hidden = true;
  $("#add-edge-button").classList.remove("active");
}

function handleEdgeAddNode(nodeId) {
  if (!state.edgeAdd.source) {
    state.edgeAdd.source = nodeId;
    $("#edge-add-instruction").textContent =
      `Zielknoten für ${state.nodes.get(nodeId)?.name || "Quelle"} wählen`;
    return;
  }
  if (state.edgeAdd.source === nodeId) {
    showToast("Bitte einen anderen Zielknoten wählen.");
    return;
  }
  const duplicate = state.edges.some(
    (edge) =>
      (edge.source === state.edgeAdd.source && edge.target === nodeId) ||
      (edge.source === nodeId && edge.target === state.edgeAdd.source),
  );
  if (duplicate) {
    showToast("Diese Verbindung existiert bereits.");
    return;
  }
  const source = state.nodes.get(state.edgeAdd.source);
  const target = state.nodes.get(nodeId);
  const sourceId = source.id < target.id ? source.id : target.id;
  const targetId = source.id < target.id ? target.id : source.id;
  const distance = haversineKm(source, target);
  const newEdge = {
    id: `e-manual-${Date.now()}`,
    source: sourceId,
    target: targetId,
    enabled: true,
    mode: "pack_animal",
    strength: 5,
    distanceKm: distance,
    directDistanceKm: distance,
    terrainFactor: 1,
    terrainMethod: "Manuell angelegt; kein DEM-LCP",
    route: [
      [state.nodes.get(sourceId).lat, state.nodes.get(sourceId).lon],
      [state.nodes.get(targetId).lat, state.nodes.get(targetId).lon],
    ],
    routeBasis: "Manuelle Verbindungshypothese",
    evidenceUri: null,
    waterway: null,
  };
  state.edges.push(newEdge);
  cancelEdgeAdd();
  renderEdges();
  runSimulation();
  selectEdge(newEdge.id);
  $("#edge-count").textContent = integerFormat.format(state.edges.length);
  showToast("Neue Kante angelegt.");
}

function renderModesTable() {
  const body = $("#modes-table-body");
  body.innerHTML = Object.entries(state.transportModes)
    .map(
      ([modeId, mode]) => `
      <tr>
        <td><span class="mode-dot" style="display:inline-block;background:${escapeHtml(mode.color)}"></span> ${escapeHtml(mode.label)}</td>
        <td><input type="number" data-mode="${escapeHtml(modeId)}" data-field="speedKmh" min="0.1" step="0.1" value="${mode.speedKmh}"></td>
        <td><input type="number" data-mode="${escapeHtml(modeId)}" data-field="costFactor" min="0.01" step="0.05" value="${mode.costFactor}"></td>
        <td><input type="number" data-mode="${escapeHtml(modeId)}" data-field="capacity" min="0.01" step="0.1" value="${mode.capacity}"></td>
        <td><input type="number" data-mode="${escapeHtml(modeId)}" data-field="slopePenalty" min="0" step="0.1" value="${mode.slopePenalty}"></td>
      </tr>`,
    )
    .join("");
  body.querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", () => {
      const value = Number(input.value);
      if (Number.isFinite(value)) {
        state.transportModes[input.dataset.mode][input.dataset.field] = value;
      }
    });
  });
}

function renderCoinPeriodsTable(search = "") {
  const query = search.trim().toLocaleLowerCase("de");
  const body = $("#coin-periods-table-body");
  const filtered = state.coinTypes.filter((item) =>
    item.type.toLocaleLowerCase("de").includes(query),
  );
  body.innerHTML = filtered
    .map((item) => {
      const period = state.coinPeriods.get(item.type) || {
        startYear: null,
        endYear: null,
      };
      return `
        <tr>
          <td title="${escapeHtml(item.type)}">${escapeHtml(item.type)}</td>
          <td>${integerFormat.format(item.coinCount)}</td>
          <td>${integerFormat.format(item.siteCount)}</td>
          <td><input type="number" data-type="${escapeHtml(item.type)}" data-bound="startYear" step="1" placeholder="?" value="${period.startYear ?? ""}"></td>
          <td><input type="number" data-type="${escapeHtml(item.type)}" data-bound="endYear" step="1" placeholder="?" value="${period.endYear ?? ""}"></td>
        </tr>`;
    })
    .join("");
  body.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", () => {
      const period = state.coinPeriods.get(input.dataset.type) || {
        startYear: null,
        endYear: null,
      };
      period[input.dataset.bound] =
        input.value.trim() === "" ? null : Number(input.value);
      state.coinPeriods.set(input.dataset.type, period);
      updateDatedTypeCount();
    });
  });
  updateDatedTypeCount();
}

function updateDatedTypeCount() {
  let dated = 0;
  for (const period of state.coinPeriods.values()) {
    if (period.startYear != null || period.endYear != null) dated += 1;
  }
  $("#dated-type-count").textContent =
    `${integerFormat.format(dated)} / ${integerFormat.format(state.coinTypes.length)} Typen datiert`;
}

function visibleTypeFilterItems(query = "") {
  const normalizedQuery = query.trim().toLocaleLowerCase("de");
  return state.coinTypes.filter((item) =>
    item.type.toLocaleLowerCase("de").includes(normalizedQuery),
  );
}

function updateTypeFilterStatus() {
  const total = state.coinTypes.length;
  const selected = state.typeFilter.selected.size;
  const status = state.typeFilter.enabled
    ? `Typfilter: ${integerFormat.format(selected)} / ${integerFormat.format(total)} Typen aktiv`
    : `Typfilter: alle ${integerFormat.format(total)} Typen`;
  $("#type-filter-status").textContent = status;
  $("#type-filter-count").textContent = state.typeFilter.enabled
    ? `${integerFormat.format(selected)} / ${integerFormat.format(total)} Typen ausgewählt`
    : `Filter aus · ${integerFormat.format(selected)} Typen vorgemerkt`;
}

function renderTypeFilterTable(query = "") {
  const body = $("#type-filter-table-body");
  const items = visibleTypeFilterItems(query);
  body.innerHTML = items
    .map(
      (item) => `
        <tr>
          <td><input type="checkbox" data-type="${escapeHtml(item.type)}" ${state.typeFilter.selected.has(item.type) ? "checked" : ""}></td>
          <td title="${escapeHtml(item.type)}">${escapeHtml(item.type)}</td>
          <td>${integerFormat.format(item.coinCount)}</td>
          <td>${integerFormat.format(item.siteCount)}</td>
        </tr>`,
    )
    .join("");
  body.querySelectorAll("input[type='checkbox']").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) state.typeFilter.selected.add(input.dataset.type);
      else state.typeFilter.selected.delete(input.dataset.type);
      updateTypeFilterStatus();
    });
  });
  updateTypeFilterStatus();
}

function setVisibleTypeFilterSelection(selected) {
  for (const item of visibleTypeFilterItems($("#type-filter-search").value)) {
    if (selected) state.typeFilter.selected.add(item.type);
    else state.typeFilter.selected.delete(item.type);
  }
  renderTypeFilterTable($("#type-filter-search").value);
}

function download(name, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function serializeScenario() {
  return {
    format: "iron-age-network-scenario",
    version: 3,
    exportedAt: new Date().toISOString(),
    settings: deepClone(state.settings),
    typeFilter: {
      enabled: state.typeFilter.enabled,
      selectedTypes: [...state.typeFilter.selected],
    },
    currentStep: state.simulation.currentStep,
    transportModes: deepClone(state.transportModes),
    nodes: [...state.nodes.values()].map((node) => ({
      id: node.id,
      name: node.name,
      size: Number(node.size),
      initialCoins: Number(node.initialCoins),
      initialTypeCoins: cleanTypeCoins(node.initialTypeCoins || {}),
    })),
    edges: deepClone(state.edges),
    coinPeriods: [...state.coinPeriods.entries()].map(([type, period]) => ({
      type,
      startYear: period.startYear,
      endYear: period.endYear,
    })),
  };
}

function applyScenario(scenario) {
  if (!scenario || scenario.format !== "iron-age-network-scenario") {
    throw new Error("Unbekanntes Szenarioformat.");
  }
  if (scenario.settings) Object.assign(state.settings, scenario.settings);
  state.settings.diffusionRate = clamp(
    Number(state.settings.diffusionRate || 0),
    0,
    0.2,
  );
  if (scenario.typeFilter) {
    state.typeFilter.enabled = Boolean(scenario.typeFilter.enabled);
    const knownTypes = new Set(state.coinTypes.map((item) => item.type));
    if (Array.isArray(scenario.typeFilter.selectedTypes)) {
      state.typeFilter.selected = new Set(
        scenario.typeFilter.selectedTypes.filter((type) => knownTypes.has(type)),
      );
    } else {
      state.typeFilter.selected = new Set(state.coinTypes.map((item) => item.type));
    }
  }
  if (scenario.transportModes) state.transportModes = deepClone(scenario.transportModes);
  for (const savedNode of scenario.nodes || []) {
    const node = state.nodes.get(savedNode.id);
    if (!node) continue;
    node.size = Math.max(0.1, Number(savedNode.size || node.size));
    if (savedNode.initialTypeCoins && typeof savedNode.initialTypeCoins === "object") {
      setNodeInitialTypeCoins(node, savedNode.initialTypeCoins);
    } else {
      setNodeInitialTotal(node, Math.max(0, Number(savedNode.initialCoins || 0)));
    }
  }
  if (Array.isArray(scenario.edges)) state.edges = deepClone(scenario.edges);
  for (const item of scenario.coinPeriods || []) {
    if (!state.coinPeriods.has(item.type)) continue;
    state.coinPeriods.set(item.type, {
      startYear: item.startYear == null ? null : Number(item.startYear),
      endYear: item.endYear == null ? null : Number(item.endYear),
    });
  }
  state.simulation.currentStep = Number(scenario.currentStep || 0);
  syncControlsFromState();
  updateTypeFilterStatus();
  renderModeFilters();
  renderNodes();
  renderEdges();
  runSimulation();
  renderItinere();
  $("#edge-count").textContent = integerFormat.format(state.edges.length);
}

function syncControlsFromState() {
  $("#start-year-input").value = String(state.settings.startYear);
  $("#duration-input").value = String(state.settings.durationYears);
  $("#coin-weight").value = String(state.settings.coinWeight);
  $("#distance-scale").value = String(state.settings.distanceScale);
  $("#diffusion-rate").value = String(state.settings.diffusionRate);
  $("#include-undated-coins").checked = state.settings.includeUndatedCoins;
  $("#coin-weight-output").textContent = numberFormat.format(state.settings.coinWeight);
  $("#distance-scale-output").textContent =
    `${integerFormat.format(state.settings.distanceScale)} km`;
  $("#diffusion-output").textContent = formatPercent(state.settings.diffusionRate);
  updateTypeFilterStatus();
}

function parseCsvLine(line) {
  const delimiter = line.includes(";") ? ";" : ",";
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      values.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  values.push(current.trim());
  return values;
}

function importCoinPeriodsCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return;
  const header = parseCsvLine(lines[0]).map((value) => value.toLowerCase());
  const typeIndex = header.findIndex((value) => ["type", "typ", "typecode"].includes(value));
  const startIndex = header.findIndex((value) =>
    ["startyear", "von", "start"].includes(value),
  );
  const endIndex = header.findIndex((value) => ["endyear", "bis", "end"].includes(value));
  if (typeIndex < 0 || startIndex < 0 || endIndex < 0) {
    throw new Error("CSV braucht die Spalten type, startYear und endYear.");
  }
  let imported = 0;
  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line);
    const coinType = values[typeIndex];
    if (!state.coinPeriods.has(coinType)) continue;
    state.coinPeriods.set(coinType, {
      startYear:
        values[startIndex] == null || values[startIndex] === ""
          ? null
          : Number(values[startIndex]),
      endYear:
        values[endIndex] == null || values[endIndex] === ""
          ? null
          : Number(values[endIndex]),
    });
    imported += 1;
  }
  renderCoinPeriodsTable($("#coin-period-search").value);
  showToast(`${integerFormat.format(imported)} Typdatierungen importiert.`);
}

function stopPlayback() {
  clearInterval(state.simulation.timer);
  state.simulation.timer = null;
  $("#play-button").innerHTML = '<span aria-hidden="true">▶</span> Abspielen';
}

function togglePlayback() {
  if (state.simulation.timer) {
    stopPlayback();
    return;
  }
  if (state.simulation.currentStep >= stepCount()) state.simulation.currentStep = 0;
  $("#play-button").innerHTML = '<span aria-hidden="true">❚❚</span> Pause';
  state.simulation.timer = setInterval(() => {
    if (state.simulation.currentStep >= stepCount()) {
      stopPlayback();
      return;
    }
    state.simulation.currentStep += 1;
    updateTimelineUi();
    updateMapStyles();
    updateSummary();
    refreshInspector();
    if ($("#show-roads").checked) renderItinere();
  }, 850);
}

function attachEvents() {
  $$(".dialog-close").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      button.closest("dialog")?.close();
    });
  });
  $$("dialog form").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      form.closest("dialog")?.close();
    });
  });
  $("#apply-modes-button").addEventListener("click", () => $("#modes-dialog").close());
  $("#apply-coin-periods-button").addEventListener("click", () =>
    $("#coin-periods-dialog").close(),
  );
  $("#method-close-button").addEventListener("click", () => $("#method-dialog").close());

  $("#fit-map-button").addEventListener("click", fitMap);
  const selectSearchedNode = (rawQuery, showMissing = true) => {
    const query = rawQuery.trim().toLocaleLowerCase("de");
    if (!query) return;
    const exact = [...state.nodes.values()].find(
      (node) => node.name.toLocaleLowerCase("de") === query,
    );
    const partial = [...state.nodes.values()].find((node) =>
      node.name.toLocaleLowerCase("de").includes(query),
    );
    const node = exact || partial;
    if (!node) {
      if (showMissing) showToast("Kein passender Fundort gefunden.");
      return;
    }
    if (state.edgeAdd.active) {
      handleEdgeAddNode(node.id);
      return;
    }
    state.map.setView([node.lat, node.lon], Math.max(state.map.getZoom(), 8));
    selectNode(node.id);
    state.markers.get(node.id)?.openTooltip();
  };
  $("#node-search").addEventListener("change", (event) => {
    selectSearchedNode(event.target.value);
  });
  $("#node-search").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    selectSearchedNode(event.target.value);
  });
  $("#node-search").addEventListener("input", (event) => {
    const query = event.target.value.trim().toLocaleLowerCase("de");
    const exact = [...state.nodes.values()].some(
      (node) => node.name.toLocaleLowerCase("de") === query,
    );
    if (exact) selectSearchedNode(event.target.value, false);
  });
  $("#play-button").addEventListener("click", togglePlayback);
  $("#reset-simulation-button").addEventListener("click", () => {
    stopPlayback();
    state.simulation.currentStep = 0;
    updateTimelineUi();
    updateMapStyles();
    updateSummary();
    refreshInspector();
  });
  $("#timeline-slider").addEventListener("input", (event) => {
    stopPlayback();
    state.simulation.currentStep = Number(event.target.value);
    updateTimelineUi();
    updateMapStyles();
    updateSummary();
    refreshInspector();
    if ($("#show-roads").checked) renderItinere();
  });
  $("#start-year-input").addEventListener("change", (event) => {
    state.settings.startYear = Number(event.target.value || -250);
    runSimulation();
    renderItinere();
  });
  $("#duration-input").addEventListener("change", (event) => {
    const duration = clamp(Number(event.target.value || 200), 25, 1000);
    state.settings.durationYears =
      Math.round(duration / state.settings.stepYears) * state.settings.stepYears;
    event.target.value = String(state.settings.durationYears);
    runSimulation();
  });
  $("#coin-weight").addEventListener("input", (event) => {
    state.settings.coinWeight = Number(event.target.value);
    $("#coin-weight-output").textContent = numberFormat.format(state.settings.coinWeight);
    runSimulation();
  });
  $("#distance-scale").addEventListener("input", (event) => {
    state.settings.distanceScale = Number(event.target.value);
    $("#distance-scale-output").textContent =
      `${integerFormat.format(state.settings.distanceScale)} km`;
    runSimulation();
  });
  $("#diffusion-rate").addEventListener("input", (event) => {
    state.settings.diffusionRate = Number(event.target.value);
    $("#diffusion-output").textContent = formatPercent(state.settings.diffusionRate);
    runSimulation();
  });
  $("#include-undated-coins").addEventListener("change", (event) => {
    state.settings.includeUndatedCoins = event.target.checked;
    runSimulation();
  });

  $("#seed-finds-button").addEventListener("click", () => {
    for (const node of state.nodes.values()) {
      seedNodeFromCsvTypes(node);
    }
    state.simulation.currentStep = 0;
    runSimulation();
    if (state.selected?.type === "node") selectNode(state.selected.id);
    showToast(
      state.typeFilter.enabled
        ? "Gefilterte Fundmengen wurden typgetrennt als Startverteilung gesetzt."
        : "Die beobachteten Fundmengen wurden typgetrennt als Startverteilung gesetzt.",
    );
  });
  $("#clear-coins-button").addEventListener("click", () => {
    for (const node of state.nodes.values()) setNodeInitialTypeCoins(node, {});
    state.simulation.currentStep = 0;
    runSimulation();
    if (state.selected?.type === "node") selectNode(state.selected.id);
  });

  $("#show-edges").addEventListener("change", () => {
    renderEdges();
    updateMapStyles();
  });
  ["#show-rivers", "#show-roads", "#show-sea"].forEach((selector) => {
    $(selector).addEventListener("change", renderItinere);
  });
  $("#show-labels").addEventListener("change", renderNodes);

  $("#add-edge-button").addEventListener("click", () => {
    if (state.edgeAdd.active) cancelEdgeAdd();
    else startEdgeAdd();
  });
  $("#cancel-edge-add-button").addEventListener("click", cancelEdgeAdd);
  $("#node-edge-source-button").addEventListener("click", () => {
    if (state.selected?.type === "node") startEdgeAdd(state.selected.id);
  });

  $$(".close-inspector").forEach((button) =>
    button.addEventListener("click", closeInspector),
  );
  let nodeEditTimer = null;
  const scheduleNodeRecalculation = (renderGeometry) => {
    clearTimeout(nodeEditTimer);
    nodeEditTimer = setTimeout(() => {
      if (renderGeometry) {
        renderNodes();
        renderEdges();
      }
      runSimulation();
    }, 120);
  };
  $("#node-size-input").addEventListener("input", (event) => {
    if (state.selected?.type !== "node") return;
    const node = state.nodes.get(state.selected.id);
    const value = Number(event.target.value);
    if (!Number.isFinite(value) || value <= 0) return;
    node.size = clamp(value, 0.1, 100);
    scheduleNodeRecalculation(true);
  });
  $("#node-coins-input").addEventListener("input", (event) => {
    if (state.selected?.type !== "node") return;
    const node = state.nodes.get(state.selected.id);
    const value = Number(event.target.value);
    if (!Number.isFinite(value) || value < 0) return;
    setNodeInitialTotal(node, value);
    state.simulation.currentStep = 0;
    scheduleNodeRecalculation(false);
  });
  $("#node-size-input").addEventListener("change", (event) => {
    if (state.selected?.type !== "node") return;
    const node = state.nodes.get(state.selected.id);
    node.size = clamp(Number(event.target.value || 1), 0.1, 100);
    event.target.value = String(node.size);
    renderNodes();
    renderEdges();
    runSimulation();
    selectNode(node.id);
  });
  $("#node-coins-input").addEventListener("change", (event) => {
    if (state.selected?.type !== "node") return;
    const node = state.nodes.get(state.selected.id);
    setNodeInitialTotal(node, Math.max(0, Number(event.target.value || 0)));
    state.simulation.currentStep = 0;
    runSimulation();
    selectNode(node.id);
  });
  $("#node-seed-100-button").addEventListener("click", () => {
    if (state.selected?.type !== "node") return;
    const node = state.nodes.get(state.selected.id);
    setNodeInitialTotal(node, 100);
    state.simulation.currentStep = 0;
    runSimulation();
    selectNode(node.id);
  });
  $("#node-type-distribution-button").addEventListener("click", () => {
    if (state.selected?.type !== "node") return;
    $("#node-type-distribution-search").value = "";
    renderNodeTypeDistributionDialog();
    $("#node-type-distribution-dialog").showModal();
  });
  $("#node-type-distribution-search").addEventListener("input", (event) =>
    renderNodeTypeDistributionDialog(event.target.value),
  );
  $("#node-type-from-csv-button").addEventListener("click", () => {
    if (state.selected?.type !== "node") return;
    const node = state.nodes.get(state.selected.id);
    seedNodeFromCsvTypes(node);
    state.simulation.currentStep = 0;
    runSimulation();
    selectNode(node.id);
    renderNodeTypeDistributionDialog($("#node-type-distribution-search").value);
  });
  $("#node-type-clear-button").addEventListener("click", () => {
    if (state.selected?.type !== "node") return;
    const node = state.nodes.get(state.selected.id);
    setNodeInitialTypeCoins(node, {});
    state.simulation.currentStep = 0;
    runSimulation();
    selectNode(node.id);
    renderNodeTypeDistributionDialog($("#node-type-distribution-search").value);
  });
  $("#apply-node-type-distribution-button").addEventListener("click", () =>
    $("#node-type-distribution-dialog").close(),
  );

  $("#edge-mode-select").addEventListener("change", (event) => {
    if (state.selected?.type !== "edge") return;
    const edge = state.edges.find((item) => item.id === state.selected.id);
    edge.mode = event.target.value;
    renderEdges();
    runSimulation();
    selectEdge(edge.id);
  });
  $("#edge-strength-input").addEventListener("input", (event) => {
    if (state.selected?.type !== "edge") return;
    const edge = state.edges.find((item) => item.id === state.selected.id);
    edge.strength = Number(event.target.value);
    $("#edge-strength-output").textContent = numberFormat.format(edge.strength);
    runSimulation();
  });
  $("#edge-enabled-input").addEventListener("change", (event) => {
    if (state.selected?.type !== "edge") return;
    const edge = state.edges.find((item) => item.id === state.selected.id);
    edge.enabled = event.target.checked;
    renderEdges();
    runSimulation();
    selectEdge(edge.id);
  });
  $("#delete-edge-button").addEventListener("click", () => {
    if (state.selected?.type !== "edge") return;
    state.edges = state.edges.filter((edge) => edge.id !== state.selected.id);
    closeInspector();
    renderEdges();
    runSimulation();
    $("#edge-count").textContent = integerFormat.format(state.edges.length);
    showToast("Kante gelöscht.");
  });

  $("#regenerate-edges-button").addEventListener("click", async () => {
    if (!window.confirm("Bearbeitete und manuelle Kanten werden durch ein neu erzeugtes Netz ersetzt. Fortfahren?")) {
      return;
    }
    const button = $("#regenerate-edges-button");
    button.disabled = true;
    button.textContent = "Erzeuge Kanten …";
    try {
      const k = Number($("#k-neighbors-input").value || 3);
      const maxDistance = Number($("#max-distance-input").value || 180);
      const response = await fetch(
        `/api/edges?k=${encodeURIComponent(k)}&maxDistanceKm=${encodeURIComponent(maxDistance)}`,
      );
      if (!response.ok) throw new Error("Kantengenerierung fehlgeschlagen.");
      const payload = await response.json();
      state.edges = payload.edges;
      closeInspector();
      renderEdges();
      runSimulation();
      $("#edge-count").textContent = integerFormat.format(state.edges.length);
      showToast(`${integerFormat.format(state.edges.length)} Kanten neu erzeugt.`);
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = "Kanten neu erzeugen";
    }
  });

  $("#modes-button").addEventListener("click", () => {
    renderModesTable();
    $("#modes-dialog").showModal();
  });
  $("#modes-dialog").addEventListener("close", () => {
    renderModeFilters();
    renderEdges();
    runSimulation();
  });
  $("#reset-modes-button").addEventListener("click", () => {
    state.transportModes = deepClone(state.defaultTransportModes);
    renderModesTable();
  });

  $("#coin-periods-button").addEventListener("click", () => {
    renderCoinPeriodsTable();
    $("#coin-periods-dialog").showModal();
  });
  $("#coin-periods-dialog").addEventListener("close", runSimulation);
  $("#coin-period-search").addEventListener("input", (event) =>
    renderCoinPeriodsTable(event.target.value),
  );
  $("#coin-period-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      importCoinPeriodsCsv(await file.text());
    } catch (error) {
      showToast(error.message);
    }
    event.target.value = "";
  });
  $("#export-coin-periods-button").addEventListener("click", () => {
    const lines = ["type;startYear;endYear"];
    for (const item of state.coinTypes) {
      const period = state.coinPeriods.get(item.type) || {};
      const safeType = `"${item.type.replaceAll('"', '""')}"`;
      lines.push(`${safeType};${period.startYear ?? ""};${period.endYear ?? ""}`);
    }
    download("muenztopologie_datierung.csv", `${lines.join("\n")}\n`, "text/csv;charset=utf-8");
  });

  $("#type-filter-button").addEventListener("click", () => {
    $("#type-filter-enabled").checked = state.typeFilter.enabled;
    renderTypeFilterTable($("#type-filter-search").value);
    $("#type-filter-dialog").showModal();
  });
  $("#type-filter-enabled").addEventListener("change", (event) => {
    state.typeFilter.enabled = event.target.checked;
    updateTypeFilterStatus();
  });
  $("#type-filter-search").addEventListener("input", (event) =>
    renderTypeFilterTable(event.target.value),
  );
  $("#type-filter-select-visible-button").addEventListener("click", () =>
    setVisibleTypeFilterSelection(true),
  );
  $("#type-filter-clear-visible-button").addEventListener("click", () =>
    setVisibleTypeFilterSelection(false),
  );
  $("#type-filter-apply-start-button").addEventListener("click", () => {
    state.typeFilter.enabled = $("#type-filter-enabled").checked;
    updateTypeFilterStatus();
    setInitialCoinsFromCurrentTypeFilter();
  });
  $("#apply-type-filter-button").addEventListener("click", () =>
    $("#type-filter-dialog").close(),
  );
  $("#type-filter-dialog").addEventListener("close", () => {
    state.typeFilter.enabled = $("#type-filter-enabled").checked;
    updateTypeFilterStatus();
    runSimulation();
    renderEdges();
    if (state.selected?.type === "node") selectNode(state.selected.id);
    if (state.selected?.type === "edge") selectEdge(state.selected.id);
  });

  $("#method-button").addEventListener("click", () => $("#method-dialog").showModal());
  $("#export-button").addEventListener("click", () => {
    download(
      `eisenzeit-netzwerk-${new Date().toISOString().slice(0, 10)}.json`,
      `${JSON.stringify(serializeScenario(), null, 2)}\n`,
      "application/json;charset=utf-8",
    );
  });
  $("#save-button").addEventListener("click", async () => {
    const button = $("#save-button");
    button.disabled = true;
    try {
      const response = await fetch("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(serializeScenario()),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Speichern fehlgeschlagen.");
      showToast("Szenario lokal im Projektordner gespeichert.");
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  });
  $("#import-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      applyScenario(JSON.parse(await file.text()));
      showToast("Szenario importiert.");
    } catch (error) {
      showToast(`Import fehlgeschlagen: ${error.message}`);
    }
    event.target.value = "";
  });
}

async function initialize() {
  try {
    if (!window.L) throw new Error("Leaflet konnte nicht geladen werden.");
    const response = await fetch("/api/bootstrap");
    if (!response.ok) throw new Error("Projektdaten konnten nicht geladen werden.");
    const data = await response.json();
    state.data = data;
    state.nodes = new Map(data.nodes.map((node) => [node.id, node]));
    for (const node of state.nodes.values()) ensureNodeTypeState(node);
    state.edges = data.edges;
    state.coinTypes = data.coinTypes;
    state.coinPeriods = new Map(
      data.coinTypes.map((item) => [
        item.type,
        { startYear: item.startYear, endYear: item.endYear },
      ]),
    );
    state.typeFilter.selected = new Set(data.coinTypes.map((item) => item.type));
    state.transportModes = deepClone(data.transportModes);
    state.defaultTransportModes = deepClone(data.transportModes);
    state.settings.startYear = data.metadata.defaultStartYear;
    state.settings.durationYears = data.metadata.durationYears;
    state.settings.stepYears = data.metadata.stepYears;

    $("#site-count").textContent = integerFormat.format(data.metadata.siteCount);
    $("#edge-count").textContent = integerFormat.format(data.metadata.edgeCount);
    $("#coin-count").textContent = integerFormat.format(data.metadata.coinRowCount);
    $("#type-count").textContent = integerFormat.format(data.metadata.coinTypeCount);
    $("#k-neighbors-input").value = String(data.metadata.kNeighbors);
    $("#max-distance-input").value = String(data.metadata.maxDistanceKm);
    $("#node-options").innerHTML = data.nodes
      .map((node) => `<option value="${escapeHtml(node.name)}"></option>`)
      .join("");

    syncControlsFromState();
    renderModeFilters();
    initMap();
    renderEdges();
    renderNodes();
    attachEvents();
    runSimulation();
    $("#loading-screen").classList.add("hidden");
  } catch (error) {
    const loading = $("#loading-screen");
    loading.innerHTML = `
      <div class="loading-mark">!</div>
      <div><strong>App konnte nicht starten</strong><span>${escapeHtml(error.message)}</span></div>
    `;
    console.error(error);
  }
}

window.__ironAgeLab = {
  diagnostics: simulationDiagnostics,
};

initialize();
