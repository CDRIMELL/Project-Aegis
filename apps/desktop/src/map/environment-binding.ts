import type { WorldEvent } from '@aegis/domain';
import { useMapStore } from '../state/map-store';
import { useSimStore } from '../state/sim-store';
import { mapController } from './controller';
import {
  eventBounds,
  eventFeatures,
  eventFeaturesKey,
  weatherFeatures,
} from './environment-features';
import { FONT_MONO } from './style';

/*
 * Feeds the simulated weather and world events into the map's simulation tier, outside React
 * (ADR 0014, ADR 0021, ADR 0022).
 *
 * The weather is redrawn when the view moves, when a layer is switched, and every ten simulated
 * minutes: never per frame, and never per simulation update. Events are redrawn only when one is
 * announced, starts or ends. The aircraft path is untouched.
 */

/** The weather layers are recomputed for a new time this often, in ticks. */
const WEATHER_REFRESH_TICKS = 600;
/** After the view stops moving, wait this long before resampling the weather. */
const SETTLE_MS = 150;

let started = false;

export function startEnvironmentBinding(): void {
  if (started) return;
  started = true;
  const controller = mapController();

  void controller.whenReady().then(() => {
    const palette = controller.colors;

    const precipitation = controller.addSimulationSource('weather-precipitation', [
      {
        id: 'fill',
        type: 'fill',
        source: '',
        paint: {
          // Its own colour, not the green of aircraft and routes: weather is background to them.
          'fill-color': palette.weather,
          'fill-opacity': ['interpolate', ['linear'], ['get', 'intensity'], 0, 0.03, 1, 0.22],
        },
      },
    ]);
    const wind = controller.addSimulationSource('weather-wind', [
      {
        id: 'arrow',
        type: 'line',
        source: '',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': palette.label,
          'line-width': 1,
          'line-opacity': ['interpolate', ['linear'], ['get', 'speed'], 15, 0.25, 200, 0.7],
        },
      },
    ]);
    const eventAreas = controller.addSimulationSource('event-areas', [
      {
        id: 'fill',
        type: 'fill',
        source: '',
        paint: { 'fill-color': palette.caution, 'fill-opacity': 0.05 },
      },
      {
        id: 'outline',
        type: 'line',
        source: '',
        paint: {
          'line-color': palette.caution,
          'line-width': 1.25,
          'line-opacity': ['case', ['get', 'active'], 0.85, 0.45],
          'line-dasharray': [4, 3],
        },
      },
    ]);
    const eventPoints = controller.addSimulationSource('event-points', [
      {
        id: 'marker',
        type: 'circle',
        source: '',
        filter: ['==', ['get', 'eventType'], 'aerodrome_closure'],
        paint: {
          'circle-radius': 9,
          'circle-color': palette.water,
          'circle-opacity': 0,
          'circle-stroke-color': palette.caution,
          'circle-stroke-width': 1.75,
          'circle-stroke-opacity': ['case', ['get', 'active'], 0.95, 0.5],
        },
      },
      {
        id: 'label',
        type: 'symbol',
        source: '',
        layout: {
          'text-field': ['get', 'label'],
          'text-font': [FONT_MONO],
          'text-size': 10,
          'text-anchor': 'bottom',
          'text-offset': [0, -1.1],
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': palette.caution,
          'text-halo-color': palette.labelHalo,
          'text-halo-width': 1.25,
          'text-opacity': ['case', ['get', 'active'], 1, 0.7],
        },
      },
    ]);

    let weatherKey = '';
    const drawWeather = (): void => {
      const view = useSimStore.getState().view;
      const { weatherLayers } = useMapStore.getState();
      if (!view) return;
      const tick = view.clock.tick - (view.clock.tick % WEATHER_REFRESH_TICKS);
      const bounds = controller.bounds();
      const zoom = controller.zoom();
      const key = `${tick}|${weatherLayers.wind}|${weatherLayers.precipitation}|${zoom.toFixed(1)}|${bounds.map((value) => value.toFixed(1)).join(',')}`;
      if (key === weatherKey) return;
      weatherKey = key;
      const features = weatherFeatures(view.weather, tick, bounds, zoom, weatherLayers);
      precipitation.set(features.precipitation);
      wind.set(features.wind);
    };

    let eventsKey: string | null = null;
    const drawEvents = (): void => {
      const events = useSimStore.getState().view?.events.events ?? [];
      const key = eventFeaturesKey(events);
      if (key === eventsKey) return;
      eventsKey = key;
      const features = eventFeatures(events);
      eventAreas.set(features.areas);
      eventPoints.set(features.points);
    };

    drawWeather();
    drawEvents();

    let lastBucket = -1;
    useSimStore.subscribe((state) => {
      drawEvents();
      const tick = state.view?.clock.tick ?? 0;
      const bucket = Math.floor(tick / WEATHER_REFRESH_TICKS);
      if (bucket !== lastBucket) {
        lastBucket = bucket;
        drawWeather();
      }
    });
    useMapStore.subscribe((state, previous) => {
      if (state.weatherLayers !== previous.weatherLayers) drawWeather();
    });
    // Resample once the view has settled, not on every frame of a pan or zoom.
    let settle: ReturnType<typeof setTimeout> | null = null;
    controller.onView(() => {
      if (settle !== null) clearTimeout(settle);
      settle = setTimeout(drawWeather, SETTLE_MS);
    });
  });
}

/** Brings an event into view on the map, once the map is on screen. */
export function focusEvent(event: WorldEvent): void {
  const bounds = eventBounds(event);
  if (!bounds) return;
  const controller = mapController();
  let attempts = 0;
  const frame = (): void => {
    if (controller.element.isConnected && controller.element.clientWidth > 0) {
      controller.resize();
      controller.fitBounds(...bounds);
    } else if (attempts++ < 60) {
      requestAnimationFrame(frame);
    }
  };
  frame();
}
