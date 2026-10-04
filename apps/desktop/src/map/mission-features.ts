import {
  degrees,
  destinationPoint,
  isFinished,
  metres,
  type Mission,
  type NamedPoint,
} from '@aegis/domain';
import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';
import { routeCoordinates } from './flight-features';

/*
 * GeoJSON for missions in the simulation tier: the routes of missions that are planned or under
 * way, the points they must visit, the areas they must remain in, and where open offers ask to
 * go. Pure functions; the map controller only draws what these return.
 */

/** Vertices used to draw an objective area as a ring. */
const RING_VERTICES = 48;

export interface MissionFeatureProperties {
  readonly missionId: string;
  readonly selected: boolean;
  /** True while the mission's flight is airborne. */
  readonly active: boolean;
  readonly label: string;
}

export interface MissionFeatures {
  readonly routes: FeatureCollection<LineString, MissionFeatureProperties>;
  readonly areas: FeatureCollection<Polygon, MissionFeatureProperties>;
  readonly points: FeatureCollection<Point, MissionFeatureProperties & { readonly role: string }>;
}

function ring(centre: NamedPoint, radiusM: number): [number, number][] {
  const out: [number, number][] = [];
  let previousLon = centre.lon;
  for (let i = 0; i <= RING_VERTICES; i++) {
    const at = destinationPoint(
      centre,
      degrees(((i % RING_VERTICES) * 360) / RING_VERTICES),
      metres(radiusM),
    );
    // Keep longitudes continuous so a ring across the antimeridian draws as one ring.
    let lon = at.lon;
    while (lon - previousLon > 180) lon -= 360;
    while (lon - previousLon < -180) lon += 360;
    out.push([lon, at.lat]);
    previousLon = lon;
  }
  return out;
}

/** Missions worth drawing: anything not finished. */
export function drawableMissions(missions: readonly Mission[]): Mission[] {
  return missions.filter((mission) => !isFinished(mission.status));
}

/**
 * A string that changes exactly when the drawn features would: which missions are shown, their
 * state, their route and which is selected. Objective progress changes every step and is not
 * drawn, so it is not part of the key.
 */
export function missionFeaturesKey(
  missions: readonly Mission[],
  selectedId: string | null,
): string {
  return `${selectedId ?? ''}|${drawableMissions(missions)
    .map((mission) => {
      const points = mission.plan?.points ?? [];
      const route = points
        .map((point) => `${point.lat.toFixed(4)},${point.lon.toFixed(4)}`)
        .join(';');
      return `${mission.id}:${mission.status}:${route}`;
    })
    .join('|')}`;
}

export function missionFeatures(
  missions: readonly Mission[],
  selectedId: string | null,
): MissionFeatures {
  const routes: Feature<LineString, MissionFeatureProperties>[] = [];
  const areas: Feature<Polygon, MissionFeatureProperties>[] = [];
  const points: Feature<Point, MissionFeatureProperties & { role: string }>[] = [];

  for (const mission of drawableMissions(missions)) {
    const properties: MissionFeatureProperties = {
      missionId: mission.id,
      selected: mission.id === selectedId,
      active: mission.status === 'active',
      label: mission.id,
    };
    const point = (role: string, label: string, at: { lat: number; lon: number }) =>
      points.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [at.lon, at.lat] },
        properties: { ...properties, role, label },
      });

    if (mission.plan) {
      routes.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: routeCoordinates(mission.plan.points) },
        properties,
      });
      mission.plan.points.forEach((routePoint, index, all) => {
        if (index === 0) point('origin', routePoint.code ?? routePoint.name, routePoint);
        else if (index === all.length - 1) {
          // An out-and-back route ends where it began; one marker is enough.
          if (mission.brief.shape === 'point_to_point') {
            point('destination', routePoint.code ?? routePoint.name, routePoint);
          }
        } else point('waypoint', '', routePoint);
      });
    }

    for (const objective of mission.objectives) {
      const { spec } = objective;
      if (spec.kind === 'visit_point' || spec.kind === 'remain_in_area') {
        const centre = spec.kind === 'visit_point' ? spec.point : spec.centre;
        areas.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [ring(centre, spec.radiusM)] },
          properties,
        });
        point('objective', `${mission.id} ${centre.name}`, centre);
      }
    }

    // An offer or a draft with no route yet still says where it asks to go.
    if (!mission.plan && mission.brief.destination) {
      point(
        'destination',
        `${mission.id} ${mission.brief.destination.code ?? mission.brief.destination.name}`,
        mission.brief.destination,
      );
    }
  }

  return {
    routes: { type: 'FeatureCollection', features: routes },
    areas: { type: 'FeatureCollection', features: areas },
    points: { type: 'FeatureCollection', features: points },
  };
}

/** The box that contains everything a mission draws: west, south, east, north. */
export function missionBounds(mission: Mission): [number, number, number, number] | null {
  const features = missionFeatures(
    [{ ...mission, status: isFinished(mission.status) ? 'planned' : mission.status }],
    null,
  );
  const coordinates: [number, number][] = [
    ...features.routes.features.flatMap(
      (feature) => feature.geometry.coordinates as [number, number][],
    ),
    ...features.areas.features.flatMap(
      (feature) => feature.geometry.coordinates[0] as [number, number][],
    ),
    ...features.points.features.map((feature) => feature.geometry.coordinates as [number, number]),
  ];
  if (coordinates.length === 0) return null;
  const lons = coordinates.map(([lon]) => lon);
  const lats = coordinates.map(([, lat]) => lat);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}
