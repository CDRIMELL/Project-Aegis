import {
  MISSION_TEMPLATES,
  defaultBrief,
  greatCircleDistance,
  type Mission,
  type MissionBrief,
  type MissionStatus,
  type MissionType,
  type RoutePoint,
} from '@aegis/domain';
import {
  SimulationEngine,
  defaultConfiguration,
  type AircraftState,
  type WorldCommand,
} from '@aegis/sim';
import { FIXTURES, fixtureOrder } from '@aegis/sim/testing';
import { describe, expect, it } from 'vitest';
import type { AerodromeRow } from '../fleet/catalogue';
import { insertWaypoint, removeWaypoint, type PlanDraft } from '../fleet/plan-edit';
import {
  drawableMissions,
  missionBounds,
  missionFeatures,
  missionFeaturesKey,
} from '../map/mission-features';
import {
  blankForm,
  briefFromForm,
  configurationFromForm,
  configurationOf,
  dueTick,
  evaluationOf,
  formFromMission,
  groupOf,
  listMissions,
  missionProgress,
  readiness,
  routeSummary,
  suggestedTarget,
  tickInstant,
} from './mission-logic';
import { chooseOperatingArea } from './operating-area';

const { places } = FIXTURES;
const AREA = { name: 'Area 1', lat: 49.4, lon: -7.2 };
const TRANSPORT = 'AEGIS-TR-001';

function world(): SimulationEngine {
  const engine = SimulationEngine.create({ seed: 'desktop-missions', epoch: FIXTURES.epoch });
  engine.applyCommand({
    type: 'seedStarterFleet',
    aircraft: [
      fixtureOrder('fastJet', places.prestwick),
      fixtureOrder('transport', places.newquay),
    ],
  });
  return engine;
}
const aircraftOf = (engine: SimulationEngine, id = TRANSPORT): AircraftState => {
  const found = engine.snapshot().fleet.aircraft.find((aircraft) => aircraft.id === id);
  if (!found) throw new Error(`no aircraft ${id}`);
  return found;
};
const missionOf = (engine: SimulationEngine, id = 'MSN-000001'): Mission => {
  const found = engine.snapshot().missions.missions.find((mission) => mission.id === id);
  if (!found) throw new Error(`no mission ${id}`);
  return found;
};
const briefFor = (type: MissionType, overrides: Partial<MissionBrief>): MissionBrief => ({
  ...defaultBrief(MISSION_TEMPLATES[type]),
  ...overrides,
});
function create(engine: SimulationEngine, type: MissionType, brief: MissionBrief): Mission {
  const command: WorldCommand = {
    type: 'createMission',
    missionType: type,
    ...defaultConfiguration(type, brief, aircraftOf(engine), { context: engine.planContext() }),
  };
  engine.applyCommand(command);
  return engine.snapshot().missions.missions.at(-1) as Mission;
}
const training = (engine: SimulationEngine) =>
  create(engine, 'training', briefFor('training', { target: AREA }));
/** A mission with only the fields the list logic reads. */
const stub = (id: string, overrides: Partial<Mission>): Mission => ({
  ...training(world()),
  id,
  ...overrides,
});

describe('grouping and listing missions', () => {
  it('puts every status in exactly one group', () => {
    const groups: Record<MissionStatus, string> = {
      offered: 'offers',
      draft: 'planned',
      planned: 'planned',
      accepted: 'planned',
      active: 'active',
      completed: 'history',
      failed: 'history',
      cancelled: 'history',
      rejected: 'history',
      expired: 'history',
    };
    for (const [status, group] of Object.entries(groups)) {
      expect(groupOf(status as MissionStatus)).toBe(group);
    }
  });

  const missions = [
    stub('MSN-000001', { status: 'completed', type: 'training', priority: 'routine' }),
    stub('MSN-000002', {
      status: 'planned',
      type: 'logistics',
      priority: 'urgent',
      completeByTick: 9000,
    }),
    stub('MSN-000003', {
      status: 'offered',
      type: 'patrol',
      priority: 'priority',
      expiresTick: 4000,
      completeByTick: 50_000,
    }),
    stub('MSN-000004', {
      status: 'active',
      type: 'training',
      priority: 'routine',
      completeByTick: null,
    }),
  ];
  const ids = (list: Mission[]) => list.map((mission) => mission.id.slice(-1));

  it('filters by group and by type', () => {
    const all = { group: 'all', type: 'all', sort: 'newest' } as const;
    expect(ids(listMissions(missions, all))).toEqual(['4', '3', '2', '1']);
    expect(ids(listMissions(missions, { ...all, group: 'planned' }))).toEqual(['2']);
    expect(ids(listMissions(missions, { ...all, group: 'history' }))).toEqual(['1']);
    expect(ids(listMissions(missions, { ...all, type: 'training' }))).toEqual(['4', '1']);
    expect(listMissions(missions, { ...all, group: 'offers', type: 'training' })).toEqual([]);
  });

  it('orders by priority, then newest', () => {
    expect(ids(listMissions(missions, { group: 'all', type: 'all', sort: 'priority' }))).toEqual([
      '2',
      '3',
      '4',
      '1',
    ]);
  });

  it('orders by what is due soonest: an offer by its expiry, a mission by its deadline', () => {
    expect(dueTick(missions[2] as Mission)).toBe(4000);
    expect(dueTick(missions[1] as Mission)).toBe(9000);
    expect(ids(listMissions(missions, { group: 'all', type: 'all', sort: 'deadline' }))).toEqual([
      '3',
      '2',
      '4',
      '1',
    ]);
  });

  it('does not reorder the list it is given', () => {
    const before = ids(missions);
    listMissions(missions, { group: 'all', type: 'all', sort: 'priority' });
    expect(ids(missions)).toEqual(before);
  });
});

describe('describing a mission', () => {
  it('summarises the route by shape', () => {
    const engine = world();
    expect(routeSummary(training(engine))).toBe('EGHQ → Area 1 → EGHQ');
    const logistics = create(
      engine,
      'logistics',
      briefFor('logistics', { destination: places.exeter, payloadKg: 5000 }),
    );
    expect(routeSummary(logistics)).toBe('EGHQ → EGTE');
    expect(routeSummary({ ...logistics, plan: null })).toBe('to EGTE');
    expect(routeSummary({ ...logistics, plan: null, brief: briefFor('logistics', {}) })).toBe(
      'Not yet routed',
    );
  });

  it('measures progress as the mean of the required objectives', () => {
    const mission = training(world());
    expect(missionProgress(mission)).toBe(0);
    const objectives = mission.objectives.map((objective, index) => ({
      ...objective,
      progress: index === 0 ? 1 : index === 1 ? 0.5 : 0.9,
    }));
    // Two of the four objectives are required: 1 and 0.5.
    expect(missionProgress({ ...mission, objectives })).toBeCloseTo(0.75, 6);
  });

  it('converts a tick to simulated time', () => {
    expect(tickInstant(FIXTURES.epoch, 3600)).toBe(FIXTURES.epoch + 3_600_000);
  });
});

describe('readiness', () => {
  it('is derived from the aircraft, and says why a mission is not ready', () => {
    const engine = world();
    training(engine);
    expect(readiness(missionOf(engine), aircraftOf(engine))).toEqual({
      ready: false,
      issues: ['The mission has not been accepted.'],
    });

    engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
    expect(readiness(missionOf(engine), aircraftOf(engine))).toEqual({ ready: true, issues: [] });

    // The aircraft goes into maintenance: the mission is unchanged, but no longer ready.
    engine.applyCommand({ type: 'startMaintenance', aircraftId: TRANSPORT });
    const during = readiness(missionOf(engine), aircraftOf(engine));
    expect(during.ready).toBe(false);
    expect(during.issues).toEqual([`${TRANSPORT} is in maintenance.`]);
    expect(missionOf(engine).status).toBe('accepted');
  });

  it('notices an aircraft that is somewhere else or airborne', () => {
    const engine = world();
    training(engine);
    engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
    const mission = missionOf(engine);
    const elsewhere = { ...aircraftOf(engine), location: places.exeter };
    expect(readiness(mission, elsewhere).issues).toEqual([
      `${TRANSPORT} is at Exeter; the mission starts at Newquay.`,
    ]);
    const airborne = { ...aircraftOf(engine), location: null, status: 'in_flight' as const };
    expect(readiness(mission, airborne).issues).toEqual([`${TRANSPORT} is airborne.`]);
    expect(readiness(mission, undefined).ready).toBe(false);
  });

  it('agrees with the simulation: a ready mission launches', () => {
    const engine = world();
    training(engine);
    engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
    expect(readiness(missionOf(engine), aircraftOf(engine)).ready).toBe(true);
    expect(engine.applyCommand({ type: 'launchMission', missionId: 'MSN-000001' })).toBe(true);
  });
});

describe('the mission form', () => {
  const engine = world();
  const aircraft = aircraftOf(engine);

  it('starts blank with the template’s defaults', () => {
    expect(blankForm('patrol')).toMatchObject({
      type: 'patrol',
      holdMinutes: 30,
      aircraftId: null,
    });
    expect(blankForm('emergency_response').priority).toBe('urgent');
  });

  it('builds a brief that matches the template’s shape', () => {
    const form = {
      ...blankForm('logistics'),
      destination: places.exeter,
      target: AREA,
      payloadKg: 4000,
    };
    expect(briefFromForm(form)).toMatchObject({
      shape: 'point_to_point',
      destination: places.exeter,
      target: null,
      payloadKg: 4000,
      holdS: 0,
    });
    // A type that carries nothing ignores a payload left over in the form.
    expect(briefFromForm({ ...form, type: 'training' })).toMatchObject({
      shape: 'out_and_back',
      destination: null,
      target: AREA,
      payloadKg: 0,
    });
    expect(briefFromForm({ ...blankForm('patrol'), target: AREA, holdMinutes: 45 }).holdS).toBe(
      2700,
    );
  });

  it('suggests somewhere reachable to fly to', () => {
    const target = suggestedTarget('training', places.newquay, 3000);
    expect(target.name).toBe('Training point');
    expect(greatCircleDistance(places.newquay, target)).toBeCloseTo(150_000, -3);
    expect(target.lon).toBeCloseTo(places.newquay.lon, 1);
    // A short-range aircraft gets a nearer point.
    expect(
      greatCircleDistance(places.newquay, suggestedTarget('patrol', places.newquay, 400)),
    ).toBeCloseTo(60_000, -3);
    expect(suggestedTarget('patrol', places.newquay, 400).name).toBe('Patrol area');
  });

  it('turns a complete form into a planned configuration, with times from now', () => {
    const form = {
      ...blankForm('training'),
      title: '  Evening sortie ',
      aircraftId: TRANSPORT,
      target: AREA,
      startInHours: 2,
      deadlineInHours: 12,
    };
    const configuration = configurationFromForm(form, aircraft, 1000, null);
    expect(configuration).toMatchObject({
      title: 'Evening sortie',
      aircraftId: TRANSPORT,
      plannedStartTick: 1000 + 7200,
      completeByTick: 1000 + 43_200,
    });
    expect(configuration.plan?.points.map((point) => point.name)).toEqual([
      'Newquay',
      'Area 1',
      'Newquay',
    ]);
    expect(configuration.objectives.map((objective) => objective.spec.kind)).toContain('arrive_by');
  });

  it('gives an untitled mission the template’s title, and no route without an aircraft', () => {
    const configuration = configurationFromForm(
      { ...blankForm('training'), target: AREA },
      null,
      0,
      null,
    );
    expect(configuration).toMatchObject({ title: 'Training: Area 1', plan: null, load: null });
  });

  it('keeps a route the player edited when only the details change', () => {
    const scratch = world();
    const mission = training(scratch);
    const edited: Mission = {
      ...mission,
      plan: {
        ...(mission.plan as NonNullable<Mission['plan']>),
        points: [
          places.newquay,
          { kind: 'waypoint', name: 'WP1', lat: 49.9, lon: -6.4, elevationM: 0 },
          ...(mission.plan as NonNullable<Mission['plan']>).points.slice(1),
        ],
      },
    };
    const form = { ...formFromMission(edited), title: 'Renamed', priority: 'urgent' as const };
    const kept = configurationFromForm(form, aircraftOf(scratch), 0, edited);
    expect(kept.plan).toEqual(edited.plan);
    expect(kept).toMatchObject({ title: 'Renamed', priority: 'urgent' });

    // Changing where the mission goes routes it afresh.
    const moved = configurationFromForm(
      { ...form, target: { ...AREA, lat: 49.0 } },
      aircraftOf(scratch),
      0,
      edited,
    );
    expect(moved.plan?.points).toHaveLength(3);
    // So does changing the aircraft.
    const reassigned = configurationFromForm(
      { ...form, aircraftId: 'AEGIS-FT-001' },
      aircraftOf(scratch, 'AEGIS-FT-001'),
      0,
      edited,
    );
    expect(reassigned.plan?.points[0]).toEqual(places.prestwick);
  });

  it('keeps the deadline of an opportunity when the form leaves it alone', () => {
    const offer: Mission = { ...training(world()), source: 'generated', completeByTick: 77_000 };
    const configuration = configurationFromForm(formFromMission(offer), aircraft, 500, offer);
    expect(configuration.completeByTick).toBe(77_000);
    expect(configuration.title).toBe(offer.title);
    expect(configuration.description).toBe(offer.description);
  });

  it('round-trips a mission through its configuration', () => {
    const scratch = world();
    const mission = training(scratch);
    scratch.applyCommand({
      type: 'updateMission',
      missionId: mission.id,
      ...configurationOf(mission),
    });
    expect(missionOf(scratch)).toEqual(mission);
  });

  it('evaluates a mission as the simulation will when it is accepted', () => {
    const scratch = world();
    const mission = training(scratch);
    const evaluation = evaluationOf(mission, aircraftOf(scratch), 0, scratch.planContext());
    scratch.applyCommand({ type: 'acceptMission', missionId: mission.id });
    expect(missionOf(scratch).assessment?.risk).toEqual(evaluation.risk);
    expect(missionOf(scratch).assessment?.durationS).toBe(evaluation.plan?.estimate?.durationS);
  });
});

describe('choosing the operating area', () => {
  const row = (id: string, icao: string | null, lat: number, lon: number): AerodromeRow => ({
    id,
    name: `Aerodrome ${id}`,
    lat,
    lon,
    elevationM: 10,
    icao,
    iata: null,
  });
  const homes: RoutePoint[] = [places.prestwick, places.newquay];
  const candidates = [
    row('c', 'EGLL', 51.47, -0.46),
    row('a', 'KJFK', 40.64, -73.78),
    row('b', 'EIDW', 53.42, -6.27),
    row('d', null, 55.5, -4.6),
    row('e', 'EGCC', 53.35, -2.27),
  ];

  it('takes the nearest candidates to any home, nearest first, skipping those without a code', () => {
    const area = chooseOperatingArea(candidates, homes, 3);
    expect(area.map((place) => place.code)).toEqual(['EIDW', 'EGCC', 'EGLL']);
    expect(area.every((place) => place.kind === 'aerodrome')).toBe(true);
    expect(area[0]).toMatchObject({ refId: 'b', name: 'Aerodrome b' });
  });

  it('gives the same area whatever order the rows arrive in', () => {
    const forwards = chooseOperatingArea(candidates, homes);
    const backwards = chooseOperatingArea([...candidates].reverse(), homes);
    expect(backwards).toEqual(forwards);
    expect(forwards).toHaveLength(4);
  });

  it('breaks a tie on distance by reference id', () => {
    const twins = [row('z', 'AAAA', 51, 0), row('y', 'BBBB', 51, 0)];
    expect(chooseOperatingArea(twins, homes).map((place) => place.refId)).toEqual(['y', 'z']);
  });

  it('chooses nothing for a fleet with no homes', () => {
    expect(chooseOperatingArea(candidates, [])).toEqual([]);
  });
});

describe('missions on the map', () => {
  it('draws the route, its waypoints and its objective areas for a planned mission', () => {
    const mission = training(world());
    const features = missionFeatures([mission], null);
    expect(features.routes.features).toHaveLength(1);
    expect(features.routes.features[0]?.properties).toEqual({
      missionId: 'MSN-000001',
      selected: false,
      active: false,
      label: 'MSN-000001',
    });
    expect(features.points.features.map((feature) => feature.properties.role)).toEqual([
      'origin',
      'waypoint',
      'objective',
    ]);
    // The visit objective is drawn as a ring of its radius around the point.
    const ring = features.areas.features[0]?.geometry.coordinates[0] ?? [];
    expect(ring).toHaveLength(49);
    for (const [lon, lat] of ring as [number, number][]) {
      expect(greatCircleDistance({ lat, lon }, AREA)).toBeCloseTo(10_000, -1);
    }
    expect(ring[0]).toEqual(ring.at(-1));
  });

  it('marks the origin and destination of a point-to-point mission', () => {
    const mission = create(
      world(),
      'logistics',
      briefFor('logistics', { destination: places.exeter, payloadKg: 5000 }),
    );
    const features = missionFeatures([mission], mission.id);
    expect(features.points.features.map((f) => [f.properties.role, f.properties.label])).toEqual([
      ['origin', 'EGHQ'],
      ['destination', 'EGTE'],
    ]);
    expect(features.routes.features[0]?.properties.selected).toBe(true);
    expect(features.areas.features).toEqual([]);
  });

  it('shows where an offer asks to go before it has a route', () => {
    const offer: Mission = {
      ...training(world()),
      status: 'offered',
      source: 'generated',
      plan: null,
      load: null,
      aircraftId: null,
    };
    const features = missionFeatures([offer], null);
    expect(features.routes.features).toEqual([]);
    expect(features.areas.features).toHaveLength(1);
    expect(features.points.features.map((f) => f.properties.label)).toEqual(['MSN-000001 Area 1']);
  });

  it('draws nothing for a finished mission', () => {
    const mission = training(world());
    for (const status of ['completed', 'failed', 'cancelled', 'rejected', 'expired'] as const) {
      expect(drawableMissions([{ ...mission, status }])).toEqual([]);
    }
    expect(missionFeatures([{ ...mission, status: 'completed' }], null).routes.features).toEqual(
      [],
    );
  });

  it('flags an active mission so its dashed route gives way to the flight’s solid one', () => {
    const mission = training(world());
    const features = missionFeatures(
      [{ ...mission, status: 'active', flightId: 'FLT-000001' }],
      null,
    );
    expect(features.routes.features[0]?.properties.active).toBe(true);
  });

  it('redraws when a mission, its route or the selection changes, and not for objective progress', () => {
    const mission = training(world());
    const key = missionFeaturesKey([mission], null);
    const progressed: Mission = {
      ...mission,
      objectives: mission.objectives.map((objective) => ({ ...objective, progress: 0.4 })),
    };
    expect(missionFeaturesKey([progressed], null)).toBe(key);

    expect(missionFeaturesKey([mission], mission.id)).not.toBe(key);
    expect(missionFeaturesKey([{ ...mission, status: 'accepted' }], null)).not.toBe(key);
    const plan = mission.plan as NonNullable<Mission['plan']>;
    const moved: Mission = {
      ...mission,
      plan: {
        ...plan,
        points: plan.points.map((point, index) =>
          index === 1 ? { ...point, lat: point.lat + 0.5 } : point,
        ),
      },
    };
    expect(missionFeaturesKey([moved], null)).not.toBe(key);
    expect(missionFeaturesKey([], null)).not.toBe(key);
  });

  it('bounds everything a mission draws, even after it has finished', () => {
    const mission = training(world());
    const [west, south, east, north] = missionBounds({ ...mission, status: 'completed' }) ?? [];
    expect(west).toBeLessThan(AREA.lon);
    expect(east).toBeGreaterThanOrEqual(places.newquay.lon);
    expect(south).toBeLessThan(AREA.lat);
    expect(north).toBeGreaterThanOrEqual(places.newquay.lat);
    expect(
      missionBounds({ ...mission, plan: null, objectives: [], brief: briefFor('training', {}) }),
    ).toBeNull();
  });
});

describe('editing a mission route with the flight planner', () => {
  it('numbers the planner’s own waypoints and leaves the mission’s named points alone', () => {
    const mission = training(world());
    const draft: PlanDraft = {
      aircraftId: TRANSPORT,
      plan: mission.plan as NonNullable<Mission['plan']>,
      load: mission.load as NonNullable<Mission['load']>,
    };
    const names = (edited: PlanDraft) => edited.plan.points.map((point) => point.name);
    const one = insertWaypoint(draft, 0);
    expect(names(one)).toEqual(['Newquay', 'WP1', 'Area 1', 'Newquay']);
    const two = insertWaypoint(one, 2);
    expect(names(two)).toEqual(['Newquay', 'WP1', 'Area 1', 'WP2', 'Newquay']);
    // Removing the first leaves the second numbered from one again, and the named point as it was.
    expect(names(removeWaypoint(two, 1))).toEqual(['Newquay', 'Area 1', 'WP1', 'Newquay']);
  });
});
