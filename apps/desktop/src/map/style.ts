import type { FontFile } from '@aegis/ui';
import type {
  ExpressionSpecification,
  LayerSpecification,
  SourceSpecification,
  StyleSpecification,
} from 'maplibre-gl';
import { RUNWAY_MIN_ZOOM } from './density';
import { graticule } from './features';

/*
 * The map style, built from design tokens (ADR 0014).
 *
 * Layers belong to one of four tiers, drawn bottom to top:
 *
 *   basemap     static offline cartography: land, water, borders, graticule, country names
 *   reference   real-world reference data from `ref_*`: aerodromes, runways, cities
 *   simulation  simulated AEGIS entities from `sim_*`: aircraft, routes, events (later phases)
 *   interaction hover and selection
 *
 * Tiers are separated by invisible slot layers. A layer is always inserted before the slot that
 * ends its tier, so tiers can never interleave whatever order code adds layers in.
 */

export type MapTier = 'basemap' | 'reference' | 'simulation' | 'interaction';

/** The slot that closes each tier. A new layer in a tier goes immediately before its slot. */
export const TIER_END_SLOT: Readonly<Record<MapTier, string>> = {
  basemap: 'slot:end-basemap',
  reference: 'slot:end-reference',
  simulation: 'slot:end-simulation',
  interaction: 'slot:end-interaction',
};

/** Colours the style needs, already resolved from design tokens. */
export interface MapPalette {
  readonly water: string;
  readonly land: string;
  readonly coast: string;
  readonly border: string;
  readonly graticule: string;
  readonly label: string;
  readonly labelHalo: string;
  readonly place: string;
  readonly reference: string;
  readonly referenceDim: string;
  readonly simulated: string;
  readonly selection: string;
  /** World events that affect operations. */
  readonly caution: string;
}

export const FONT_SANS = 'AEGIS Sans';
export const FONT_MONO = 'AEGIS Mono';

export interface MapFonts {
  readonly sans: readonly FontFile[];
  readonly mono: readonly FontFile[];
}

/** Things the user can show or hide, and the layers each controls. */
export const LAYER_GROUPS = {
  aerodromes: ['aerodrome-marker', 'aerodrome-label'],
  runways: ['runway-line', 'runway-label'],
  cities: ['city-marker', 'city-label'],
  countryNames: ['country-label'],
  borders: ['border-50m', 'border-10m'],
  graticule: ['graticule-line'],
} as const satisfies Record<string, readonly string[]>;

export type LayerGroup = keyof typeof LAYER_GROUPS;

/** Zoom at which each level of basemap detail takes over. */
export const DETAIL_ZOOM = { medium: 2.5, high: 5.5 } as const;

/** Layers that respond to a click, most specific first. */
export const HIT_LAYERS = ['aerodrome-marker', 'city-marker', 'runway-line'] as const;
/** Simulated aircraft are picked before anything beneath them. */
export const AIRCRAFT_HIT_LAYER = 'aircraft-marker';
/** Handles of the draft flight plan: waypoints can be dragged, midpoints add a waypoint. */
export const DRAFT_WAYPOINT_LAYER = 'draft-waypoint';
export const DRAFT_MIDPOINT_LAYER = 'draft-midpoint';
/** Name of the image the aircraft layer draws. The controller supplies it. */
export const AIRCRAFT_IMAGE = 'aegis-aircraft';
export const COUNTRY_HIT_LAYERS = ['land-110m', 'land-50m', 'land-10m'] as const;

const EMPTY = { type: 'FeatureCollection', features: [] } as const;

function slot(id: string): LayerSpecification {
  return { id, type: 'background', layout: { visibility: 'none' } };
}

function geojson(data: string | object, extra: object = {}): SourceSpecification {
  return { type: 'geojson', data, ...extra } as SourceSpecification;
}

interface DetailLevel {
  readonly suffix: '110m' | '50m' | '10m';
  readonly minzoom?: number;
  readonly maxzoom?: number;
}

const LOW: DetailLevel = { suffix: '110m', maxzoom: DETAIL_ZOOM.medium };
const MEDIUM: DetailLevel = {
  suffix: '50m',
  minzoom: DETAIL_ZOOM.medium,
  maxzoom: DETAIL_ZOOM.high,
};
const HIGH: DetailLevel = { suffix: '10m', minzoom: DETAIL_ZOOM.high };

const range = ({ minzoom, maxzoom }: DetailLevel) => ({
  ...(minzoom !== undefined && { minzoom }),
  ...(maxzoom !== undefined && { maxzoom }),
});

function landLayers(palette: MapPalette, level: DetailLevel): LayerSpecification[] {
  const source = `land-${level.suffix}`;
  return [
    {
      id: `land-${level.suffix}`,
      type: 'fill',
      source,
      ...range(level),
      paint: { 'fill-color': palette.land, 'fill-antialias': false },
    },
    {
      id: `coast-${level.suffix}`,
      type: 'line',
      source,
      ...range(level),
      paint: { 'line-color': palette.coast, 'line-width': 0.75 },
    },
  ];
}

function lakeLayer(palette: MapPalette, level: DetailLevel): LayerSpecification {
  return {
    id: `lake-${level.suffix}`,
    type: 'fill',
    source: `lakes-${level.suffix}`,
    ...range(level),
    paint: { 'fill-color': palette.water, 'fill-outline-color': palette.coast },
  };
}

function borderLayer(palette: MapPalette, level: DetailLevel): LayerSpecification {
  return {
    id: `border-${level.suffix}`,
    type: 'line',
    source: `borders-${level.suffix}`,
    ...range(level),
    paint: {
      'line-color': palette.border,
      'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.5, 8, 1.25],
      'line-dasharray': [3, 2],
    },
  };
}

/** Outline of the selected country, one layer per level of detail. */
function countrySelectionLayer(palette: MapPalette, level: DetailLevel): LayerSpecification {
  return {
    id: `selection-country-${level.suffix}`,
    type: 'line',
    source: `land-${level.suffix}`,
    ...range(level),
    filter: ['==', ['get', 'iso2'], ''],
    paint: { 'line-color': palette.selection, 'line-width': 1.5 },
  };
}

const visibleAtZoom = (property: string): ExpressionSpecification => [
  '<=',
  ['get', property],
  ['zoom'],
];

/**
 * High-detail basemap sources and layers. These are large, so the map adds them the first time
 * the user zooms far enough to need them, instead of at start-up.
 */
export function highDetailBasemap(
  palette: MapPalette,
  basemapUrl: string,
): {
  sources: Record<string, SourceSpecification>;
  layers: { layer: LayerSpecification; before: string }[];
} {
  return {
    sources: {
      'land-10m': geojson(`${basemapUrl}/land-10m.json`),
      'lakes-10m': geojson(`${basemapUrl}/lakes-10m.json`),
      'borders-10m': geojson(`${basemapUrl}/borders-10m.json`),
    },
    layers: [
      ...landLayers(palette, HIGH).map((layer) => ({ layer, before: 'slot:after-land' })),
      { layer: lakeLayer(palette, HIGH), before: 'slot:after-lakes' },
      { layer: borderLayer(palette, HIGH), before: 'slot:after-borders' },
      {
        layer: countrySelectionLayer(palette, HIGH),
        before: 'selection-ring',
      },
    ],
  };
}

function fontFaces(fonts: MapFonts): NonNullable<StyleSpecification['font-faces']> {
  const files = (list: readonly FontFile[]) =>
    list.map((file) => ({ url: file.url, 'unicode-range': [...file.unicodeRange] }));
  return { [FONT_SANS]: files(fonts.sans), [FONT_MONO]: files(fonts.mono) };
}

/**
 * The complete start-up style. Reference sources start empty and are filled once reference data
 * has been read; the simulation tier starts with no layers at all.
 */
export function buildMapStyle(
  palette: MapPalette,
  fonts: MapFonts,
  basemapUrl: string,
): StyleSpecification {
  const label = {
    'text-color': palette.label,
    'text-halo-color': palette.labelHalo,
    'text-halo-width': 1.25,
  };

  const basemap: LayerSpecification[] = [
    { id: 'water', type: 'background', paint: { 'background-color': palette.water } },
    ...landLayers(palette, LOW),
    ...landLayers(palette, MEDIUM),
    slot('slot:after-land'),
    lakeLayer(palette, MEDIUM),
    slot('slot:after-lakes'),
    {
      id: 'graticule-line',
      type: 'line',
      source: 'graticule',
      paint: { 'line-color': palette.graticule, 'line-width': 0.5 },
    },
    borderLayer(palette, MEDIUM),
    slot('slot:after-borders'),
    {
      id: 'country-label',
      type: 'symbol',
      source: 'country-labels',
      minzoom: 1.5,
      maxzoom: 8,
      // Natural Earth's rank: prominent countries from the world view, the rest as zoom allows.
      filter: ['<=', ['get', 'labelRank'], ['+', ['zoom'], 1.5]],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': [FONT_SANS],
        'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 6, 13],
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.12,
        'text-max-width': 8,
        'symbol-sort-key': ['get', 'labelRank'],
      },
      paint: label,
    },
  ];

  const reference: LayerSpecification[] = [
    {
      id: 'runway-line',
      type: 'line',
      source: 'runways',
      minzoom: RUNWAY_MIN_ZOOM,
      layout: { 'line-cap': 'butt' },
      paint: {
        'line-color': ['case', ['get', 'closed'], palette.referenceDim, palette.reference],
        'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 9, 1, 13, 5, 16, 22],
      },
    },
    {
      id: 'city-marker',
      type: 'circle',
      source: 'locations',
      filter: ['all', ['==', ['get', 'group'], 'city'], visibleAtZoom('minZoom')],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 1.5, 8, 3],
        'circle-color': palette.water,
        'circle-stroke-color': palette.place,
        'circle-stroke-width': 1,
      },
    },
    {
      id: 'aerodrome-marker',
      type: 'circle',
      source: 'locations',
      filter: ['all', ['==', ['get', 'group'], 'aerodrome'], visibleAtZoom('minZoom')],
      paint: {
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          2,
          ['match', ['get', 'kind'], 'airport_large', 2, 1.5],
          10,
          ['match', ['get', 'kind'], 'airport_large', 5.5, 'airport_medium', 4.5, 3.5],
        ],
        'circle-color': [
          'match',
          ['get', 'kind'],
          'airport_small',
          palette.referenceDim,
          palette.reference,
        ],
        'circle-stroke-color': palette.water,
        'circle-stroke-width': 1,
        // Once runways are drawn the marker becomes a faint anchor, not the main symbol.
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 11, 1, 13, 0.35],
      },
    },
    {
      id: 'city-label',
      type: 'symbol',
      source: 'locations',
      filter: ['all', ['==', ['get', 'group'], 'city'], visibleAtZoom('labelMinZoom')],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': [FONT_SANS],
        'text-size': 11,
        'text-anchor': 'left',
        'text-offset': [0.6, 0],
        'text-max-width': 9,
        'symbol-sort-key': ['get', 'priority'],
      },
      paint: { ...label, 'text-color': palette.place },
    },
    {
      id: 'aerodrome-label',
      type: 'symbol',
      source: 'locations',
      filter: [
        'all',
        ['==', ['get', 'group'], 'aerodrome'],
        ['!=', ['get', 'code'], ''],
        visibleAtZoom('labelMinZoom'),
      ],
      layout: {
        'text-field': ['get', 'code'],
        'text-font': [FONT_MONO],
        'text-size': 10.5,
        'text-anchor': 'top',
        'text-offset': [0, 0.7],
        'symbol-sort-key': ['get', 'priority'],
      },
      paint: { ...label, 'text-color': palette.reference },
    },
    {
      id: 'runway-label',
      type: 'symbol',
      source: 'runways',
      minzoom: 12,
      layout: {
        'symbol-placement': 'line-center',
        'text-field': ['get', 'name'],
        'text-font': [FONT_MONO],
        'text-size': 10,
        'text-offset': [0, 1.1],
      },
      paint: { ...label, 'text-color': palette.reference },
    },
  ];

  // Simulated AEGIS entities: fictional state from `sim_*`, drawn in the simulated colour.
  const simulation: LayerSpecification[] = [
    {
      id: 'flight-route',
      type: 'line',
      source: 'sim-routes',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': palette.simulated,
        'line-width': ['case', ['get', 'selected'], 2, 1.25],
        'line-opacity': ['case', ['get', 'selected'], 0.9, 0.45],
      },
    },
    {
      id: 'aircraft-marker',
      type: 'symbol',
      source: 'sim-aircraft',
      layout: {
        'icon-image': AIRCRAFT_IMAGE,
        'icon-rotate': ['get', 'heading'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 2, 0.6, 8, 1],
        'text-field': ['get', 'id'],
        'text-font': [FONT_MONO],
        'text-size': 10.5,
        'text-anchor': 'top',
        'text-offset': [0, 1.2],
        'text-optional': true,
      },
      paint: { ...label, 'text-color': palette.simulated },
    },
  ];

  const interaction: LayerSpecification[] = [
    countrySelectionLayer(palette, LOW),
    countrySelectionLayer(palette, MEDIUM),
    {
      id: 'aircraft-selected',
      type: 'circle',
      source: 'sim-aircraft',
      filter: ['==', ['get', 'selected'], true],
      paint: {
        'circle-radius': 15,
        'circle-color': 'transparent',
        'circle-stroke-color': palette.selection,
        'circle-stroke-width': 1.5,
      },
    },
    // The flight plan being drafted. It is not simulation state until it is launched.
    {
      id: 'draft-route-line',
      type: 'line',
      source: 'draft-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': palette.selection, 'line-width': 1.75, 'line-dasharray': [2, 2] },
    },
    {
      id: 'draft-midpoint',
      type: 'circle',
      source: 'draft-handles',
      filter: ['==', ['get', 'role'], 'midpoint'],
      paint: {
        'circle-radius': 4,
        'circle-color': palette.water,
        'circle-stroke-color': palette.selection,
        'circle-stroke-width': 1,
      },
    },
    {
      id: 'draft-endpoint',
      type: 'circle',
      source: 'draft-handles',
      filter: ['in', ['get', 'role'], ['literal', ['origin', 'destination']]],
      paint: {
        'circle-radius': 6,
        'circle-color': palette.simulated,
        'circle-stroke-color': palette.water,
        'circle-stroke-width': 1.5,
      },
    },
    {
      id: 'draft-waypoint',
      type: 'circle',
      source: 'draft-handles',
      filter: ['==', ['get', 'role'], 'waypoint'],
      paint: {
        'circle-radius': 6,
        'circle-color': palette.selection,
        'circle-stroke-color': palette.water,
        'circle-stroke-width': 1.5,
      },
    },
    {
      id: 'draft-label',
      type: 'symbol',
      source: 'draft-handles',
      filter: ['!=', ['get', 'role'], 'midpoint'],
      layout: {
        'text-field': ['get', 'label'],
        'text-font': [FONT_MONO],
        'text-size': 10.5,
        'text-anchor': 'bottom',
        'text-offset': [0, -0.9],
        'text-allow-overlap': true,
      },
      paint: { ...label, 'text-color': palette.selection },
    },
    {
      id: 'selection-ring',
      type: 'circle',
      source: 'selection',
      paint: {
        'circle-radius': 10,
        'circle-color': 'transparent',
        'circle-stroke-color': palette.selection,
        'circle-stroke-width': 1.5,
      },
    },
  ];

  return {
    version: 8,
    name: 'AEGIS',
    'font-faces': fontFaces(fonts),
    sources: {
      'land-110m': geojson(`${basemapUrl}/land-110m.json`),
      'land-50m': geojson(`${basemapUrl}/land-50m.json`),
      'lakes-50m': geojson(`${basemapUrl}/lakes-50m.json`),
      'borders-50m': geojson(`${basemapUrl}/borders-50m.json`),
      'country-labels': geojson(`${basemapUrl}/country-labels.json`),
      graticule: geojson(graticule(10)),
      locations: geojson(EMPTY),
      runways: geojson(EMPTY),
      selection: geojson(EMPTY),
      'sim-routes': geojson(EMPTY),
      'sim-aircraft': geojson(EMPTY),
      'draft-route': geojson(EMPTY),
      'draft-handles': geojson(EMPTY),
    },
    layers: [
      ...basemap,
      slot(TIER_END_SLOT.basemap),
      ...reference,
      slot(TIER_END_SLOT.reference),
      ...simulation,
      slot(TIER_END_SLOT.simulation),
      ...interaction,
      slot(TIER_END_SLOT.interaction),
    ],
  };
}

/** Which tier a layer of the start-up style belongs to, by its position among the slots. */
export function tierOfLayer(style: StyleSpecification, layerId: string): MapTier | null {
  const tiers: MapTier[] = ['basemap', 'reference', 'simulation', 'interaction'];
  let tier = 0;
  for (const layer of style.layers) {
    if (layer.id === layerId) return tiers[tier] ?? null;
    if (layer.id === TIER_END_SLOT[tiers[tier] ?? 'interaction']) tier++;
  }
  return null;
}
