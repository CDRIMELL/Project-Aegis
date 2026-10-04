import { MONO_FONT_FILES, SANS_FONT_FILES, resolveColorTokens, type ColorToken } from '@aegis/ui';
import type { FeatureCollection } from 'geojson';
import {
  Map as MapLibreMap,
  setWorkerUrl,
  type GeoJSONSource,
  type LayerSpecification,
  type MapMouseEvent,
} from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import {
  COUNTRY_HIT_LAYERS,
  DETAIL_ZOOM,
  HIT_LAYERS,
  LAYER_GROUPS,
  TIER_END_SLOT,
  buildMapStyle,
  highDetailBasemap,
  type LayerGroup,
  type MapPalette,
} from './style';

/*
 * The map engine (ADR 0014).
 *
 * This class owns the MapLibre instance and is deliberately not a React component. React decides
 * what the application shows; the controller draws it. Data reaches the map through its methods
 * and goes straight into MapLibre sources, so a change of data never re-renders a component tree.
 * That is what will let the simulation move aircraft many times a second later on.
 */

const BASEMAP_URL = `${window.location.origin}/basemap`;

const PALETTE_TOKENS: Readonly<Record<keyof MapPalette, ColorToken>> = {
  water: '--color-map-water',
  land: '--color-map-land',
  coast: '--color-map-coast',
  border: '--color-map-border',
  graticule: '--color-map-graticule',
  label: '--color-map-label',
  labelHalo: '--color-map-label-halo',
  place: '--color-map-place',
  reference: '--color-map-reference',
  referenceDim: '--color-map-reference-dim',
  simulated: '--color-map-simulated',
  selection: '--color-map-selection',
};

const WORLD_VIEW = { center: [10, 30] as [number, number], zoom: 1.6 };
const MIN_ZOOM = 1;
const MAX_ZOOM = 16;
/** Pixels around the pointer that count as a hit, so small markers are easy to pick. */
const HIT_TOLERANCE_PX = 5;

export type MapPick =
  | { readonly type: 'location'; readonly id: string }
  | { readonly type: 'country'; readonly iso2: string }
  | null;

export type MapSelection =
  | { readonly type: 'location'; readonly id: string; readonly lat: number; readonly lon: number }
  | { readonly type: 'country'; readonly iso2: string }
  | null;

export interface MapViewState {
  readonly zoom: number;
  /** Ground distance covered by one pixel at the centre of the view. */
  readonly metresPerPixel: number;
}

export interface MapPointer {
  readonly lat: number;
  readonly lon: number;
}

/** Handle on one source in the simulation tier. Updating it touches nothing else. */
export interface SimulationSource {
  set(data: FeatureCollection): void;
  remove(): void;
}

type Listener<T> = (value: T) => void;

export class MapController {
  /** The element the map renders into. Hosts attach it to the page; the map survives detaching. */
  readonly element: HTMLDivElement;

  private readonly map: MapLibreMap;
  private readonly palette: MapPalette;
  private readonly ready: Promise<void>;
  private styleReady = false;
  private detailLoaded = false;

  private readonly pickListeners = new Set<Listener<MapPick>>();
  private readonly viewListeners = new Set<Listener<MapViewState>>();
  private readonly pointerListeners = new Set<Listener<MapPointer | null>>();

  constructor() {
    setWorkerUrl(workerUrl);
    this.palette = resolveColorTokens(PALETTE_TOKENS);

    this.element = document.createElement('div');
    this.element.className = 'size-full';

    this.map = new MapLibreMap({
      container: this.element,
      style: buildMapStyle(
        this.palette,
        { sans: SANS_FONT_FILES, mono: MONO_FONT_FILES },
        BASEMAP_URL,
      ),
      ...WORLD_VIEW,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      // Attribution is shown by the application's own interface, in its own style.
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      fadeDuration: 120,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.keyboard.disableRotation();

    this.ready = new Promise((resolve) => {
      void this.map.once('load', () => {
        this.styleReady = true;
        this.ensureDetail();
        resolve();
      });
    });

    this.map.on('zoom', () => {
      this.ensureDetail();
    });
    this.map.on('move', () => {
      this.emitView();
    });
    this.map.on('click', (event) => {
      const pick = this.pickAt(event);
      for (const listener of this.pickListeners) listener(pick);
    });
    this.map.on('mousemove', (event) => {
      const { lat, lng } = event.lngLat.wrap();
      for (const listener of this.pointerListeners) listener({ lat, lon: lng });
      this.map.getCanvas().style.cursor = this.pickAt(event, false) ? 'pointer' : '';
    });
    this.map.on('mouseout', () => {
      for (const listener of this.pointerListeners) listener(null);
    });
  }

  /** Resolves once the start-up style is loaded and sources can be filled. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /** Call after the element has been attached to the page or its size has changed. */
  resize(): void {
    this.map.resize();
  }

  // --- Reference tier ----------------------------------------------------------------------

  setLocations(data: FeatureCollection): void {
    void this.source('locations').setData(data);
  }

  setRunways(data: FeatureCollection): void {
    void this.source('runways').setData(data);
  }

  // --- Simulation tier ---------------------------------------------------------------------

  /**
   * Adds a source and its layers to the simulation tier and returns a handle for updating it.
   * Layers are placed above all reference data and below selection, whatever the call order.
   * Nothing uses this until simulated entities exist; it is the contract they will draw through.
   */
  addSimulationSource(id: string, layers: readonly LayerSpecification[]): SimulationSource {
    const sourceId = `sim:${id}`;
    this.map.addSource(sourceId, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    const layerIds: string[] = [];
    for (const layer of layers) {
      const layerId = `sim:${id}:${layer.id}`;
      this.map.addLayer(
        { ...layer, id: layerId, source: sourceId } as LayerSpecification,
        TIER_END_SLOT.simulation,
      );
      layerIds.push(layerId);
    }
    return {
      set: (data) => {
        void this.source(sourceId).setData(data);
      },
      remove: () => {
        for (const layerId of layerIds) this.map.removeLayer(layerId);
        this.map.removeSource(sourceId);
      },
    };
  }

  // --- Interaction ---------------------------------------------------------------------------

  setSelection(selection: MapSelection): void {
    void this.source('selection').setData({
      type: 'FeatureCollection',
      features:
        selection?.type === 'location'
          ? [
              {
                type: 'Feature',
                properties: {},
                geometry: { type: 'Point', coordinates: [selection.lon, selection.lat] },
              },
            ]
          : [],
    });
    const iso2 = selection?.type === 'country' ? selection.iso2 : '';
    for (const suffix of ['110m', '50m', '10m']) {
      const layer = `selection-country-${suffix}`;
      if (this.map.getLayer(layer)) {
        this.map.setFilter(layer, ['==', ['get', 'iso2'], iso2]);
      }
    }
    this.selectedCountry = iso2;
  }

  private selectedCountry = '';

  setGroupVisible(group: LayerGroup, visible: boolean): void {
    this.hiddenGroups[visible ? 'delete' : 'add'](group);
    for (const layer of LAYER_GROUPS[group]) {
      if (this.map.getLayer(layer)) {
        this.map.setLayoutProperty(layer, 'visibility', visible ? 'visible' : 'none');
      }
    }
  }

  private readonly hiddenGroups = new Set<LayerGroup>();

  // --- Camera -------------------------------------------------------------------------------

  flyTo(lat: number, lon: number, zoom: number): void {
    this.map.flyTo({ center: [lon, lat], zoom: Math.max(zoom, this.map.getZoom()), speed: 1.4 });
  }

  /** Frames a bounding box given as west, south, east, north. */
  fitBounds(west: number, south: number, east: number, north: number): void {
    this.map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: 64, maxZoom: 9, speed: 1.4 },
    );
  }

  zoomBy(delta: number): void {
    this.map.easeTo({ zoom: this.map.getZoom() + delta, duration: 180 });
  }

  resetView(): void {
    this.map.flyTo({ ...WORLD_VIEW, speed: 1.4 });
  }

  // --- Events -------------------------------------------------------------------------------

  onPick(listener: Listener<MapPick>): () => void {
    return subscribe(this.pickListeners, listener);
  }

  /** Fires continuously while the view changes. Write the result to the DOM, not to React state. */
  onView(listener: Listener<MapViewState>): () => void {
    listener(this.viewState());
    return subscribe(this.viewListeners, listener);
  }

  /** Fires on every pointer move over the map. Write the result to the DOM, not to React state. */
  onPointer(listener: Listener<MapPointer | null>): () => void {
    return subscribe(this.pointerListeners, listener);
  }

  // --- Internals ----------------------------------------------------------------------------

  private source(id: string): GeoJSONSource {
    const source = this.map.getSource<GeoJSONSource>(id);
    if (!source) {
      throw new Error(`Map source "${id}" does not exist`);
    }
    return source;
  }

  private viewState(): MapViewState {
    const zoom = this.map.getZoom();
    const latitude = this.map.getCenter().lat;
    // Web Mercator ground resolution at 512-pixel tiles.
    const metresPerPixel =
      (40_075_016.686 * Math.cos((latitude * Math.PI) / 180)) / (512 * 2 ** zoom);
    return { zoom, metresPerPixel };
  }

  private emitView(): void {
    const state = this.viewState();
    for (const listener of this.viewListeners) listener(state);
  }

  /** Adds the large high-detail basemap the first time the view gets close enough to need it. */
  private ensureDetail(): void {
    if (!this.styleReady || this.detailLoaded || this.map.getZoom() < DETAIL_ZOOM.high - 1) return;
    this.detailLoaded = true;
    const detail = highDetailBasemap(this.palette, BASEMAP_URL);
    for (const [id, source] of Object.entries(detail.sources)) {
      this.map.addSource(id, source);
    }
    for (const { layer, before } of detail.layers) {
      this.map.addLayer(layer, before);
    }
    // Late layers must honour choices made before they existed.
    for (const group of this.hiddenGroups) this.setGroupVisible(group, false);
    this.map.setFilter('selection-country-10m', ['==', ['get', 'iso2'], this.selectedCountry]);
  }

  /** What is under the pointer: a reference location if any, otherwise the country. */
  private pickAt(event: MapMouseEvent, includeCountries = true): MapPick {
    const { x, y } = event.point;
    const box: [[number, number], [number, number]] = [
      [x - HIT_TOLERANCE_PX, y - HIT_TOLERANCE_PX],
      [x + HIT_TOLERANCE_PX, y + HIT_TOLERANCE_PX],
    ];
    const present = (layers: readonly string[]) => layers.filter((id) => this.map.getLayer(id));

    for (const layer of present(HIT_LAYERS)) {
      const [feature] = this.map.queryRenderedFeatures(box, { layers: [layer] });
      const properties = feature?.properties as { id?: unknown; locationId?: unknown } | undefined;
      const id = properties?.locationId ?? properties?.id;
      if (typeof id === 'string') return { type: 'location', id };
    }
    if (!includeCountries) return null;

    const [country] = this.map.queryRenderedFeatures(event.point, {
      layers: present(COUNTRY_HIT_LAYERS),
    });
    const iso2 = (country?.properties as { iso2?: unknown } | undefined)?.iso2;
    return typeof iso2 === 'string' && iso2.length === 2 ? { type: 'country', iso2 } : null;
  }
}

function subscribe<T>(listeners: Set<Listener<T>>, listener: Listener<T>): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let instance: MapController | null = null;

/**
 * The application's single map. Created on first use and kept for the life of the window, so
 * leaving and returning to the map screen does not reload its data.
 */
export function mapController(): MapController {
  instance ??= new MapController();
  return instance;
}
