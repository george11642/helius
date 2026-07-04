// Helius Go embedded map — hand-port of the web app's src/map/style.ts +
// src/map/render.ts (fix marker, destination flag, animated route draw),
// minus the DEM/terrain layers (terrain.pmtiles is not bundled in the app).
// All URLs are relative so the page works identically from the custom
// helius:// scheme (device/simulator) and a plain range-capable HTTP server
// (desktop debugging).
'use strict';

// ---------- palette (src/map/style.ts PALETTE) ----------
var PALETTE = {
  background: '#0a0e14',
  earth: '#0d1219',
  landusePark: '#0f1a13',
  landuseUrban: '#12151d',
  landuseNeutral: '#12151b',
  water: '#12304a',
  roads: '#2a3648',
  path: '#ffb454',
  pathCasing: '#050810',
  buildings: '#3a4557',
  label: '#8a919e',
  labelHalo: '#05070bcc',
  trailhead: '#7fd962',
};

var PATH_FILTER = [
  'all',
  ['!has', 'is_tunnel'],
  ['!has', 'is_bridge'],
  ['in', 'kind', 'other', 'path'],
  ['!=', 'kind_detail', 'pier'],
];
var ROAD_FILTER = ['all', ['!has', 'is_tunnel'], ['in', 'kind', 'highway', 'major_road', 'minor_road']];
var LABEL_FONT = ['Noto Sans Regular'];
var LABEL_FONT_EMPHASIS = ['Noto Sans Medium'];

// La Luz upper switchbacks — the canonical demo scene (src/map/render.ts).
var SANDIA_DEMO_CENTER = [-106.4439, 35.1983];

var EMPTY_FC = { type: 'FeatureCollection', features: [] };

function buildStyle() {
  var base = new URL('.', window.location.href).toString().replace(/\/$/, '');
  return {
    version: 8,
    glyphs: base + '/vendor/fonts/{fontstack}/{range}.pbf',
    sprite: base + '/vendor/sprites/v4/dark',
    sources: {
      basemap: {
        type: 'vector',
        url: 'pmtiles://' + base + '/pack/basemap.pmtiles',
        attribution: '&copy; OpenStreetMap',
      },
      // Declared empty in the style (not added on 'load') so setData works the
      // instant the Map exists — same load-stall lesson as the web renderer.
      route: { type: 'geojson', data: EMPTY_FC },
      accuracy: { type: 'geojson', data: EMPTY_FC },
      pois: { type: 'geojson', data: EMPTY_FC },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': PALETTE.background } },
      { id: 'earth', type: 'fill', source: 'basemap', 'source-layer': 'earth',
        filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': PALETTE.earth } },
      { id: 'landuse', type: 'fill', source: 'basemap', 'source-layer': 'landuse',
        paint: {
          'fill-color': ['match', ['get', 'kind'],
            ['park', 'national_park', 'forest', 'wood', 'nature_reserve', 'protected_area', 'meadow', 'grass'], PALETTE.landusePark,
            ['residential', 'urban_area', 'commercial'], PALETTE.landuseUrban,
            ['cemetery', 'hospital', 'school', 'industrial', 'military'], PALETTE.landuseNeutral,
            PALETTE.earth],
          'fill-opacity': 0.5,
        } },
      { id: 'water', type: 'fill', source: 'basemap', 'source-layer': 'water',
        filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': PALETTE.water } },
      { id: 'water-river', type: 'line', source: 'basemap', 'source-layer': 'water', minzoom: 9,
        filter: ['in', 'kind', 'river'],
        paint: { 'line-color': PALETTE.water,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 9, 0, 9.5, 1, 18, 12] } },
      { id: 'water-stream', type: 'line', source: 'basemap', 'source-layer': 'water', minzoom: 13,
        filter: ['in', 'kind', 'stream'], paint: { 'line-color': PALETTE.water, 'line-width': 0.75 } },
      { id: 'buildings', type: 'fill', source: 'basemap', 'source-layer': 'buildings',
        filter: ['in', 'kind', 'building', 'building_part'],
        paint: { 'fill-color': PALETTE.buildings, 'fill-opacity': 0.35 } },
      { id: 'roads', type: 'line', source: 'basemap', 'source-layer': 'roads', filter: ROAD_FILTER,
        paint: { 'line-color': PALETTE.roads,
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 8, 0.3, 12, 1, 16, 3] } },
      // Hero layer: trails — dark casing, then dashed amber.
      { id: 'paths-casing', type: 'line', source: 'basemap', 'source-layer': 'roads',
        filter: PATH_FILTER, minzoom: 10, layout: { 'line-cap': 'round' },
        paint: { 'line-color': PALETTE.pathCasing,
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 1, 16, 4.5],
          'line-opacity': 0.85 } },
      { id: 'paths', type: 'line', source: 'basemap', 'source-layer': 'roads',
        filter: PATH_FILTER, minzoom: 10, layout: { 'line-cap': 'round' },
        paint: { 'line-color': PALETTE.path,
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 0.6, 16, 3],
          'line-dasharray': [2, 1.5] } },
      { id: 'labels-roads', type: 'symbol', source: 'basemap', 'source-layer': 'roads', minzoom: 11,
        filter: ['in', 'kind', 'highway', 'major_road', 'minor_road'],
        layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': LABEL_FONT, 'text-size': 11 },
        paint: { 'text-color': PALETTE.label, 'text-halo-color': PALETTE.labelHalo, 'text-halo-width': 1.2 } },
      { id: 'labels-trails', type: 'symbol', source: 'basemap', 'source-layer': 'roads', minzoom: 12,
        filter: PATH_FILTER,
        layout: { 'symbol-placement': 'line', 'symbol-sort-key': ['get', 'min_zoom'],
          'text-field': ['get', 'name'], 'text-font': LABEL_FONT_EMPHASIS, 'text-size': 11 },
        paint: { 'text-color': PALETTE.label, 'text-halo-color': PALETTE.labelHalo, 'text-halo-width': 1.2 } },
      { id: 'labels-places', type: 'symbol', source: 'basemap', 'source-layer': 'places',
        filter: ['==', 'kind', 'locality'],
        layout: { 'text-field': ['get', 'name'], 'text-font': LABEL_FONT_EMPHASIS,
          'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10, 12, 15],
          'text-transform': 'uppercase', 'text-letter-spacing': 0.05 },
        paint: { 'text-color': PALETTE.label, 'text-halo-color': PALETTE.labelHalo, 'text-halo-width': 1.4 } },
      // POIs (trailheads + peaks) — src/map/style.ts poiLayers()
      { id: 'poi-trailhead-halo', type: 'circle', source: 'pois', filter: ['==', 'kind', 'trailhead'],
        paint: { 'circle-radius': 8, 'circle-color': PALETTE.trailhead, 'circle-opacity': 0.22 } },
      { id: 'poi-trailhead', type: 'circle', source: 'pois', filter: ['==', 'kind', 'trailhead'],
        paint: { 'circle-radius': 4, 'circle-color': PALETTE.trailhead,
          'circle-stroke-color': PALETTE.background, 'circle-stroke-width': 1.5 } },
      { id: 'poi-peak', type: 'circle', source: 'pois', filter: ['==', 'kind', 'peak'],
        paint: { 'circle-radius': 3, 'circle-color': PALETTE.label,
          'circle-stroke-color': PALETTE.background, 'circle-stroke-width': 1 } },
      { id: 'poi-labels', type: 'symbol', source: 'pois', minzoom: 11,
        layout: { 'text-field': ['get', 'name'], 'text-font': LABEL_FONT_EMPHASIS, 'text-size': 11,
          'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
        paint: { 'text-color': PALETTE.label, 'text-halo-color': PALETTE.labelHalo, 'text-halo-width': 1.2 } },
      // Runtime layers, topmost.
      { id: 'route-casing', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': PALETTE.pathCasing, 'line-width': 7, 'line-opacity': 0.9 } },
      { id: 'route-line', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': PALETTE.path, 'line-width': 4 } },
      { id: 'accuracy-fill', type: 'fill', source: 'accuracy',
        paint: { 'fill-color': PALETTE.path, 'fill-opacity': 0.12 } },
      { id: 'accuracy-outline', type: 'line', source: 'accuracy',
        paint: { 'line-color': PALETTE.path, 'line-width': 1, 'line-opacity': 0.4 } },
    ],
  };
}

// ---------- geometry helpers (ports of render.ts internals) ----------

function haversineM(lat1, lon1, lat2, lon2) {
  var R = 6371000;
  var p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180;
  var dPhi = ((lat2 - lat1) * Math.PI) / 180, dLam = ((lon2 - lon1) * Math.PI) / 180;
  var s1 = Math.sin(dPhi / 2), s2 = Math.sin(dLam / 2);
  return 2 * R * Math.asin(Math.sqrt(s1 * s1 + Math.cos(p1) * Math.cos(p2) * s2 * s2));
}

function accuracyCirclePolygon(lat, lon, radiusM) {
  var pts = [];
  var latR = radiusM / 111320;
  var lonR = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  for (var i = 0; i <= 48; i++) {
    var a = (i / 48) * 2 * Math.PI;
    pts.push([lon + lonR * Math.cos(a), lat + latR * Math.sin(a)]);
  }
  return { type: 'Polygon', coordinates: [pts] };
}

function cumulativeDistances(coords) {
  var out = [0];
  for (var i = 1; i < coords.length; i++) {
    out.push(out[i - 1] + haversineM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
  }
  return out;
}

// Slice the route at fractional progress t (0..1 of total length),
// interpolating the final point — same visual as the web's animated draw.
function sliceRouteAtProgress(coords, cumulative, total, t) {
  var target = total * t;
  if (target <= 0) return [coords[0], coords[0]];
  var i = 1;
  while (i < cumulative.length && cumulative[i] < target) i++;
  if (i >= coords.length) return coords;
  var seg = cumulative[i] - cumulative[i - 1];
  var f = seg > 0 ? (target - cumulative[i - 1]) / seg : 0;
  var a = coords[i - 1], b = coords[i];
  var partial = coords.slice(0, i);
  partial.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  return partial;
}

function boundsOf(coords) {
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (var i = 0; i < coords.length; i++) {
    var c = coords[i];
    if (c[0] < minX) minX = c[0];
    if (c[0] > maxX) maxX = c[0];
    if (c[1] < minY) minY = c[1];
    if (c[1] > maxY) maxY = c[1];
  }
  return [[minX, minY], [maxX, maxY]];
}

function buildFixMarkerElement() {
  var el = document.createElement('div');
  el.className = 'helius-fix-marker';
  el.innerHTML = '<div class="ring"></div><div class="dot"></div>';
  return el;
}

function buildDestinationFlagElement() {
  var el = document.createElement('div');
  el.innerHTML =
    '<svg class="helius-dest-flag" width="18" height="24" viewBox="0 0 18 24" xmlns="http://www.w3.org/2000/svg">' +
    '<line x1="2" y1="2" x2="2" y2="22" stroke="' + PALETTE.path + '" stroke-width="2" stroke-linecap="round"/>' +
    '<path d="M2 3 L16 7 L2 12 Z" fill="' + PALETTE.path + '"/></svg>';
  return el;
}

function notifySwift(msg) {
  try {
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.helius) {
      window.webkit.messageHandlers.helius.postMessage(msg);
    }
  } catch (e) { /* desktop debugging: no bridge */ }
}

// ---------- map bootstrap ----------

var protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

var map = new maplibregl.Map({
  container: 'map',
  style: buildStyle(),
  center: SANDIA_DEMO_CENTER,
  zoom: 12.5,
  attributionControl: { compact: true },
});

map.on('error', function (e) {
  var msg = e && e.error ? String(e.error.message || e.error) : 'unknown map error';
  console.error('[heliusMap]', msg);
  notifySwift({ type: 'error', message: msg });
});

// POIs: fetched by the page itself (bundled next to the basemap) — no bridge needed.
fetch('./pack/pois.json')
  .then(function (r) { return r.json(); })
  .then(function (pois) {
    var features = [];
    (pois.trailheads || []).forEach(function (t) {
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
        properties: { kind: 'trailhead', name: t.name } });
    });
    (pois.peaks || []).forEach(function (p) {
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { kind: 'peak', name: p.name } });
    });
    var src = map.getSource('pois');
    if (src) src.setData({ type: 'FeatureCollection', features: features });
  })
  .catch(function (e) { console.warn('[heliusMap] pois load failed', e); });

// ---------- Swift-facing API ----------

var fixMarker = null;
var destinationMarker = null;
var routeAnimationHandle = null;
var routeFullCoords = null;

window.heliusMap = {
  setFix: function (lat, lon, accuracyM) {
    if (!fixMarker) {
      fixMarker = new maplibregl.Marker({ element: buildFixMarkerElement(), anchor: 'center' })
        .setLngLat([lon, lat]).addTo(map);
    } else {
      fixMarker.setLngLat([lon, lat]);
    }
    map.getSource('accuracy').setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: accuracyCirclePolygon(lat, lon, accuracyM), properties: {} }],
    });
    if (!routeFullCoords) map.easeTo({ center: [lon, lat] });
  },

  // coords: [[lon,lat],...] start -> destination. Animated draw + camera fit,
  // matching the web renderer's route beat.
  drawRoute: function (coords, animateMs) {
    if (routeAnimationHandle !== null) {
      cancelAnimationFrame(routeAnimationHandle);
      routeAnimationHandle = null;
    }
    var src = map.getSource('route');
    routeFullCoords = coords && coords.length ? coords : null;
    if (!routeFullCoords) {
      src.setData(EMPTY_FC);
      return;
    }

    var dest = coords[coords.length - 1];
    if (!destinationMarker) {
      destinationMarker = new maplibregl.Marker({ element: buildDestinationFlagElement(), anchor: 'bottom' })
        .setLngLat(dest).addTo(map);
    } else {
      destinationMarker.setLngLat(dest);
    }

    var b = boundsOf(coords);
    map.fitBounds(b, { padding: 40, duration: 800 });

    if (coords.length < 2) {
      src.setData({ type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }] });
      return;
    }

    var cumulative = cumulativeDistances(coords);
    var total = cumulative[cumulative.length - 1];
    var durationMs = animateMs || 1500;
    var start = performance.now();
    var step = function (now) {
      var t = Math.min(1, (now - start) / durationMs);
      var partial = total > 0 ? sliceRouteAtProgress(coords, cumulative, total, t) : coords;
      src.setData({ type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: partial }, properties: {} }] });
      if (t < 1) routeAnimationHandle = requestAnimationFrame(step);
      else routeAnimationHandle = null;
    };
    // Delay the draw until the camera fit has mostly landed, like the web demo beat.
    setTimeout(function () { routeAnimationHandle = requestAnimationFrame(step); }, 500);
  },

  clearRoute: function () {
    if (routeAnimationHandle !== null) {
      cancelAnimationFrame(routeAnimationHandle);
      routeAnimationHandle = null;
    }
    routeFullCoords = null;
    map.getSource('route').setData(EMPTY_FC);
    if (destinationMarker) { destinationMarker.remove(); destinationMarker = null; }
  },
};

map.on('load', function () { notifySwift({ type: 'ready' }); });
