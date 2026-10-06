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
  AIRCRAFT_HIT_LAYER,
  AIRCRAFT_IMAGE,
  COUNTRY_HIT_LAYERS,
  DRAFT_MIDPOINT_LAYER,
  DRAFT_WAYPOINT_LAYER,
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
  caution: '--color-map-caution',
  weather: '--color-map-weather',
};

const WORLD_VIEW = { center: [10, 30] as [number, number], zoom: 1.6 };
const MIN_ZOOM = 1;
const MAX_ZOOM = 16;
/** Pixels around the pointer that count as a hit, so small markers are easy to pick. */
const HIT_TOLERANCE_PX = 5;

/** An edit to the draft flight plan made on the map. Indices refer to the plan's points. */
export type DraftEdit =
  | { readonly type: 'move'; readonly index: number; readonly lat: number; readonly lon: number }
  | {
      readonly type: 'insert';
      readonly afterIndex: number;
      readonly lat: number;
      readonly lon: number;
    }
  | { readonly type: 'remove'; readonly index: number };

export type MapPick =
  | { readonly type: 'aircraft'; readonly id: string }
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
  private readonly draftListeners = new Set<Listener<DraftEdit>>();
  /** Index of the waypoint being dragged, while a drag is in progress. */
  private dragging: number | null = null;
  /** Set when a press acted on a draft handle, so the click that follows is not also a pick. */
  private suppressPick = false;

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
    this.map.on('styleimagemissing', (event) => {
      if (event.id === AIRCRAFT_IMAGE && !this.map.hasImage(AIRCRAFT_IMAGE)) {
        this.map.addImage(
          AIRCRAFT_IMAGE,
          aircraftImage(this.palette.simulated, this.palette.water),
          {
            pixelRatio: 2,
          },
        );
      }
    });
    this.bindDraftEditing();
    this.map.on('click', (event) => {
      if (this.suppressPick) {
        this.suppressPick = false;
        return;
      }
      const pick = this.pickAt(event);
      for (const listener of this.pickListeners) listener(pick);
    });
    this.map.on('mousemove', (event) => {
      const { lat, lng } = event.lngLat.wrap();
      for (const listener of this.pointerListeners) listener({ lat, lon: lng });
      if (this.dragging !== null) return;
      this.map.getCanvas().style.cursor =
        this.draftHandleAt(event) || this.pickAt(event, false) ? 'pointer' : '';
    });
    this.map.on('mouseout', () => {
      for (const listener of this.pointerListeners) listener(null);
    });
  }

  /** Resolves once the start-up style is loaded and sources can be filled. */
  /** The colours the map draws in, resolved from the design tokens. */
  get colors(): MapPalette {
    return this.palette;
  }

  /** The visible area: west, south, east, north. Longitudes run past ±180 when the view wraps. */
  bounds(): [number, number, number, number] {
    const visible = this.map.getBounds();
    return [visible.getWest(), visible.getSouth(), visible.getEast(), visible.getNorth()];
  }

  zoom(): number {
    return this.map.getZoom();
  }

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

  // --- Simulated entities --------------------------------------------------------------------

  /** Aircraft positions. Called every animation frame while anything is flying. */
  setAircraft(data: FeatureCollection): void {
    void this.source('sim-aircraft').setData(data);
  }

  /** Routes of the flights in progress. Called when the set of flights or the selection changes. */
  setFlightRoutes(data: FeatureCollection): void {
    void this.source('sim-routes').setData(data);
  }

  // --- Draft flight plan ---------------------------------------------------------------------

  setDraft(route: FeatureCollection, handles: FeatureCollection): void {
    void this.source('draft-route').setData(route);
    void this.source('draft-handles').setData(handles);
  }

  /** Edits made to the draft on the map: dragging a waypoint, adding one, removing one. */
  onDraftEdit(listener: Listener<DraftEdit>): () => void {
    return subscribe(this.draftListeners, listener);
  }

  private emitDraft(edit: DraftEdit): void {
    for (const listener of this.draftListeners) listener(edit);
  }

  private draftHandleAt(event: MapMouseEvent): { role: string; index: number } | null {
    const { x, y } = event.point;
    const [feature] = this.map.queryRenderedFeatures(
      [
        [x - HIT_TOLERANCE_PX, y - HIT_TOLERANCE_PX],
        [x + HIT_TOLERANCE_PX, y + HIT_TOLERANCE_PX],
      ],
      { layers: [DRAFT_WAYPOINT_LAYER, DRAFT_MIDPOINT_LAYER] },
    );
    const properties = feature?.properties as { role?: unknown; index?: unknown } | undefined;
    return typeof properties?.role === 'string' && typeof properties.index === 'number'
      ? { role: properties.role, index: properties.index }
      : null;
  }

  /**
   * Drag a waypoint to move it, press a leg's midpoint handle to add a waypoint there (and keep
   * dragging it), right-click a waypoint to remove it.
   */
  private bindDraftEditing(): void {
    this.map.on('mousedown', (event) => {
      const handle = this.draftHandleAt(event);
      if (!handle || event.originalEvent.button !== 0) return;
      // Stops the map from panning while a handle is held.
      event.preventDefault();
      this.suppressPick = true;
      const { lat, lng } = event.lngLat.wrap();
      if (handle.role === 'midpoint') {
        this.emitDraft({ type: 'insert', afterIndex: handle.index, lat, lon: lng });
        this.dragging = handle.index + 1;
      } else {
        this.dragging = handle.index;
      }
      this.map.getCanvas().style.cursor = 'grabbing';
    });
    this.map.on('mousemove', (event) => {
      if (this.dragging === null) return;
      const { lat, lng } = event.lngLat.wrap();
      this.emitDraft({ type: 'move', index: this.dragging, lat, lon: lng });
    });
    const endDrag = () => {
      if (this.dragging === null) return;
      this.dragging = null;
      this.map.getCanvas().style.cursor = '';
    };
    this.map.on('mouseup', endDrag);
    this.map.on('mouseout', endDrag);
    this.map.on('contextmenu', (event) => {
      const handle = this.draftHandleAt(event);
      if (handle?.role !== 'waypoint') return;
      event.preventDefault();
      this.emitDraft({ type: 'remove', index: handle.index });
    });
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

    const [aircraft] = this.map.queryRenderedFeatures(box, {
      layers: present([AIRCRAFT_HIT_LAYER]),
    });
    const aircraftId = (aircraft?.properties as { id?: unknown } | undefined)?.id;
    if (typeof aircraftId === 'string') return { type: 'aircraft', id: aircraftId };

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

/** The aircraft marker: a plain arrowhead pointing north, rotated by heading when drawn. */
function aircraftImage(fill: string, outline: string): ImageData {
  const size = 40;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable; the aircraft marker cannot be drawn');
  ctx.beginPath();
  ctx.moveTo(20, 4);
  ctx.lineTo(33, 35);
  ctx.lineTo(20, 28);
  ctx.lineTo(7, 35);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = outline;
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
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
