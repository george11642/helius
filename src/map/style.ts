// MapLibre style JSON builder for Helius's dark "night ops" basemap.
//
// This is a hand-rolled subset of layers, not the @protomaps/basemaps npm
// package (not an installed dependency — checked package.json first). The
// layer/field names below were read directly out of the embedded metadata
// of public/data/packs/<pack>/basemap.pmtiles itself (a Protomaps Basemap
// v4.14.9 / planetiler build: vector_layers = earth, landcover, landuse,
// water, roads, buildings, boundaries, places, pois) and cross-checked
// against the upstream style source (protomaps/basemaps
// styles/src/base_layers.ts) so filters match real data instead of guessed
// field values. landcover is intentionally omitted below: its data only
// exists up to z7, below this app's minimum useful hiking zoom (~11+).
//
// Trail note: there is no separate "path"/"trail" vector layer in this
// schema. Footpaths/trails live in the `roads` source-layer with
// kind='path' (grouped with kind='other', which also holds ferries etc.)
// — PATH_FILTER below is copied from the upstream `roads_other` layer,
// which is exactly how the upstream style itself finds trails.
//
// Terrain: hillshade and contours both come from maplibre-contour's
// DemSource, which the caller (render.ts) constructs and passes in here —
// this module stays a pure style-JSON builder with no side effects of its
// own (protocol registration, fetch patching, etc. all live in render.ts).

import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import type mlcontour from 'maplibre-contour';

type DemSource = InstanceType<typeof mlcontour.DemSource>;

export const PALETTE = {
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
  contourMinor: '#28323f',
  contourMajor: '#3f4d5e',
} as const;

/**
 * Matches the upstream `roads_other` layer's filter exactly (verified
 * against protomaps/basemaps styles/src/base_layers.ts): kind='path' is
 * grouped with kind='other', minus piers (kind_detail='pier', styled
 * separately upstream — irrelevant for a mountain pack, excluded here too
 * so a stray pier tag can't sneak into the trail styling).
 */
const PATH_FILTER = [
  'all',
  ['!has', 'is_tunnel'],
  ['!has', 'is_bridge'],
  ['in', 'kind', 'other', 'path'],
  ['!=', 'kind_detail', 'pier'],
];

const ROAD_FILTER = ['all', ['!has', 'is_tunnel'], ['in', 'kind', 'highway', 'major_road', 'minor_road']];

const LABEL_FONT = ['Noto Sans Regular'];
const LABEL_FONT_EMPHASIS = ['Noto Sans Medium'];

export interface BuildStyleOptions {
  /** Base URL for the region pack's data files. Default `/data/packs/<pack>`. */
  packBaseUrl?: string;
  /** Base URL for shared glyphs/sprites. Default `/vendor`. */
  vendorBaseUrl?: string;
  /**
   * Already-constructed + already `setupMaplibre()`'d DemSource (see
   * render.ts). When omitted, hillshade + contour layers are left out of
   * the style entirely (e.g. before terrain is ready, or if it failed).
   */
  demSource?: DemSource | null;
  /** zoom -> [minorMeters, majorMeters]. Default flat 100m/500m from z8 up. */
  contourThresholds?: Record<number, number | number[]>;
}

export function buildStyle(pack = 'sandia', opts: BuildStyleOptions = {}): StyleSpecification {
  const packBase = opts.packBaseUrl ?? `/data/packs/${pack}`;
  const vendorBase = opts.vendorBaseUrl ?? '/vendor';
  const dem = opts.demSource ?? null;

  const sources: StyleSpecification['sources'] = {
    basemap: {
      type: 'vector',
      url: `pmtiles://${packBase}/basemap.pmtiles`,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
    },
  };

  if (dem) {
    sources['hillshade-dem'] = {
      type: 'raster-dem',
      tiles: [dem.sharedDemProtocolUrl],
      encoding: 'terrarium',
      maxzoom: 12,
      tileSize: 256,
    };
    sources['contours'] = {
      type: 'vector',
      tiles: [
        dem.contourProtocolUrl({
          multiplier: 1, // meters
          thresholds: opts.contourThresholds ?? { 8: [100, 500] },
          contourLayer: 'contours',
          elevationKey: 'ele',
          levelKey: 'level',
        }),
      ],
      maxzoom: 12,
    };
  }

  const layers: LayerSpecification[] = [
    { id: 'background', type: 'background', paint: { 'background-color': PALETTE.background } },

    {
      id: 'earth',
      type: 'fill',
      source: 'basemap',
      'source-layer': 'earth',
      filter: ['==', '$type', 'Polygon'],
      paint: { 'fill-color': PALETTE.earth },
    },

    {
      id: 'landuse',
      type: 'fill',
      source: 'basemap',
      'source-layer': 'landuse',
      paint: {
        'fill-color': [
          'match',
          ['get', 'kind'],
          ['park', 'national_park', 'forest', 'wood', 'nature_reserve', 'protected_area', 'meadow', 'grass'],
          PALETTE.landusePark,
          ['residential', 'urban_area', 'commercial'],
          PALETTE.landuseUrban,
          ['cemetery', 'hospital', 'school', 'industrial', 'military'],
          PALETTE.landuseNeutral,
          PALETTE.earth,
        ],
        'fill-opacity': 0.5,
      },
    },

    {
      id: 'water',
      type: 'fill',
      source: 'basemap',
      'source-layer': 'water',
      filter: ['==', '$type', 'Polygon'],
      paint: { 'fill-color': PALETTE.water },
    },
    {
      id: 'water-river',
      type: 'line',
      source: 'basemap',
      'source-layer': 'water',
      minzoom: 9,
      filter: ['in', 'kind', 'river'],
      paint: {
        'line-color': PALETTE.water,
        'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 9, 0, 9.5, 1, 18, 12],
      },
    },
    {
      id: 'water-stream',
      type: 'line',
      source: 'basemap',
      'source-layer': 'water',
      minzoom: 13,
      filter: ['in', 'kind', 'stream'],
      paint: { 'line-color': PALETTE.water, 'line-width': 0.75 },
    },

    {
      id: 'buildings',
      type: 'fill',
      source: 'basemap',
      'source-layer': 'buildings',
      filter: ['in', 'kind', 'building', 'building_part'],
      paint: { 'fill-color': PALETTE.buildings, 'fill-opacity': 0.35 },
    },

    {
      id: 'roads',
      type: 'line',
      source: 'basemap',
      'source-layer': 'roads',
      filter: ROAD_FILTER,
      paint: {
        'line-color': PALETTE.roads,
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 8, 0.3, 12, 1, 16, 3],
      },
    },

    // Hero layer: trails. Dark casing first so the dashed amber line stays
    // legible over hillshade/contours, then the amber dash on top.
    {
      id: 'paths-casing',
      type: 'line',
      source: 'basemap',
      'source-layer': 'roads',
      filter: PATH_FILTER,
      minzoom: 10,
      layout: { 'line-cap': 'round' },
      paint: {
        'line-color': PALETTE.pathCasing,
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 1, 16, 4.5],
        'line-opacity': 0.85,
      },
    },
    {
      id: 'paths',
      type: 'line',
      source: 'basemap',
      'source-layer': 'roads',
      filter: PATH_FILTER,
      minzoom: 10,
      layout: { 'line-cap': 'round' },
      paint: {
        'line-color': PALETTE.path,
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 0.6, 16, 3],
        'line-dasharray': [2, 1.5],
      },
    },

    ...((dem
      ? [
          {
            id: 'hillshade',
            type: 'hillshade',
            source: 'hillshade-dem',
            paint: {
              'hillshade-exaggeration': 0.35,
              'hillshade-shadow-color': '#000000',
              'hillshade-highlight-color': '#232d3a',
              'hillshade-accent-color': '#0a0e14',
            },
          },
          {
            id: 'contours-minor',
            type: 'line',
            source: 'contours',
            'source-layer': 'contours',
            filter: ['==', ['get', 'level'], 0],
            paint: { 'line-color': PALETTE.contourMinor, 'line-width': 0.6, 'line-opacity': 0.6 },
          },
          {
            id: 'contours-major',
            type: 'line',
            source: 'contours',
            'source-layer': 'contours',
            filter: ['==', ['get', 'level'], 1],
            paint: { 'line-color': PALETTE.contourMajor, 'line-width': 1 },
          },
          {
            id: 'contours-label',
            type: 'symbol',
            source: 'contours',
            'source-layer': 'contours',
            filter: ['==', ['get', 'level'], 1],
            minzoom: 12,
            layout: {
              'symbol-placement': 'line',
              'text-field': ['concat', ['number-format', ['get', 'ele'], {}], 'm'],
              'text-font': LABEL_FONT,
              'text-size': 10,
            },
            paint: { 'text-color': PALETTE.label, 'text-halo-color': PALETTE.labelHalo, 'text-halo-width': 1.2 },
          },
        ]
      : []) as LayerSpecification[]),

    {
      id: 'labels-roads',
      type: 'symbol',
      source: 'basemap',
      'source-layer': 'roads',
      minzoom: 11,
      filter: ['in', 'kind', 'highway', 'major_road', 'minor_road'],
      layout: {
        'symbol-placement': 'line',
        'text-field': ['get', 'name'],
        'text-font': LABEL_FONT,
        'text-size': 11,
      },
      paint: { 'text-color': PALETTE.label, 'text-halo-color': PALETTE.labelHalo, 'text-halo-width': 1.2 },
    },
    {
      id: 'labels-trails',
      type: 'symbol',
      source: 'basemap',
      'source-layer': 'roads',
      minzoom: 12,
      filter: PATH_FILTER,
      layout: {
        'symbol-placement': 'line',
        'symbol-sort-key': ['get', 'min_zoom'],
        'text-field': ['get', 'name'],
        'text-font': LABEL_FONT_EMPHASIS,
        'text-size': 11,
      },
      paint: { 'text-color': PALETTE.label, 'text-halo-color': PALETTE.labelHalo, 'text-halo-width': 1.2 },
    },
    {
      id: 'labels-places',
      type: 'symbol',
      source: 'basemap',
      'source-layer': 'places',
      filter: ['==', 'kind', 'locality'],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': LABEL_FONT_EMPHASIS,
        'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10, 12, 15],
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.05,
      },
      paint: { 'text-color': PALETTE.label, 'text-halo-color': PALETTE.labelHalo, 'text-halo-width': 1.4 },
    },
  ] as LayerSpecification[];

  return {
    version: 8,
    glyphs: `${vendorBase}/fonts/{fontstack}/{range}.pbf`,
    // Unlike glyphs, MapLibre rejects a root-relative sprite URL outright
    // ("must be absolute" — verified live: it threw and silently aborted
    // style load, leaving a blank map with no other symptom). Resolve
    // against the current origin so dev and prod both work unmodified.
    sprite: new URL(`${vendorBase}/sprites/v4/dark`, window.location.href).toString(),
    sources,
    layers,
  };
}

/**
 * Trailhead/peak layers for the runtime GeoJSON `pois` source that
 * render.ts adds once pois.json has loaded (see HeliusMap.init). Kept here
 * so palette/styling stays centralized in this file even though the
 * source itself is populated at runtime, not part of the static style.
 */
export function poiLayers(sourceId: string): LayerSpecification[] {
  return [
    {
      id: 'poi-trailhead-halo',
      type: 'circle',
      source: sourceId,
      filter: ['==', 'kind', 'trailhead'],
      paint: { 'circle-radius': 8, 'circle-color': PALETTE.trailhead, 'circle-opacity': 0.22 },
    },
    {
      id: 'poi-trailhead',
      type: 'circle',
      source: sourceId,
      filter: ['==', 'kind', 'trailhead'],
      paint: {
        'circle-radius': 4,
        'circle-color': PALETTE.trailhead,
        'circle-stroke-color': PALETTE.background,
        'circle-stroke-width': 1.5,
      },
    },
    {
      id: 'poi-peak',
      type: 'circle',
      source: sourceId,
      filter: ['==', 'kind', 'peak'],
      paint: {
        'circle-radius': 3,
        'circle-color': PALETTE.label,
        'circle-stroke-color': PALETTE.background,
        'circle-stroke-width': 1,
      },
    },
    {
      id: 'poi-labels',
      type: 'symbol',
      source: sourceId,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': LABEL_FONT_EMPHASIS,
        'text-size': 11,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: { 'text-color': PALETTE.label, 'text-halo-color': PALETTE.labelHalo, 'text-halo-width': 1.2 },
    },
  ] as LayerSpecification[];
}
