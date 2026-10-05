import { describe, expect, it } from 'vitest';
import { weatherModel } from '../environment/weather';
import { derivePerformance, type PerformanceModel } from '../flight/performance';
import { evaluatePlan, generatePlan, suggestedFuelKg } from '../flight/plan';
import type { RoutePoint } from '../flight/route';
import { greatCircleDistance } from '../geo';
import { assessRisk } from '../mission/risk';
import { MISSION_TEMPLATES } from '../mission/templates';
import { Rng } from '../rng';
import {
  EVENT_GENERATION,
  EVENT_STATUSES,
  EVENT_TRANSITIONS,
  EVENT_TYPES,
  canEventTransition,
  closureAt,
  disruptionsOnRoute,
  generateEvent,
  hazardsFrom,
  isOpenEvent,
  routePassesWithin,
  type EventDraft,
  type Hazards,
  type WorldEvent,
} from './events';

const aerodrome = (code: string, name: string, lat: number, lon: number): RoutePoint => ({
  kind: 'aerodrome',
  refId: `test:${code}`,
  code,
  name,
  lat,
  lon,
  elevationM: 30,
});
const NEWQUAY = aerodrome('EGHQ', 'Newquay', 50.4406, -4.9954);
const EXETER = aerodrome('EGTE', 'Exeter', 50.7344, -3.4139);
const PRESTWICK = aerodrome('EGPK', 'Glasgow Prestwick', 55.5094, -4.5867);
const INVERNESS = aerodrome('EGPE', 'Inverness', 57.5425, -4.0475);
const PLACES = [NEWQUAY, EXETER, PRESTWICK, INVERNESS];

const TRANSPORT: PerformanceModel = (() => {
  const result = derivePerformance({
    category: 'transport',
    engineType: 'turbofan',
    emptyMassKg: 78600,
    maxTakeoffMassKg: 141000,
    cruiseSpeedKmh: 781,
    maxSpeedKmh: null,
    rangeKm: 3300,
    ferryRangeKm: null,
    serviceCeilingM: 12200,
  });
  if (!result.available) throw new Error('unavailable');
  return result.model;
})();
const WEATHER = weatherModel('event-test', Date.UTC(2026, 9, 4, 12));

const event = (overrides: Partial<WorldEvent>): WorldEvent => ({
  id: 'EVT-000001',
  type: 'aerodrome_closure',
  status: 'active',
  source: 'generated',
  severity: 0.6,
  createdTick: 0,
  startTick: 1000,
  endTick: 5000,
  place: EXETER,
  centre: null,
  radiusM: null,
  aircraftId: null,
  missionId: null,
  title: 'Aerodrome closure: Exeter (EGTE)',
  description: 'Simulated event.',
  ...overrides,
});

describe('event lifecycle', () => {
  it('goes scheduled, active, resolved', () => {
    expect(canEventTransition('scheduled', 'active')).toBe(true);
    expect(canEventTransition('active', 'resolved')).toBe(true);
    expect(canEventTransition('scheduled', 'resolved')).toBe(false);
    expect(canEventTransition('active', 'scheduled')).toBe(false);
  });

  it('can be cancelled only before it starts, and never leaves a finished status', () => {
    expect(EVENT_TRANSITIONS.scheduled).toContain('cancelled');
    expect(EVENT_TRANSITIONS.active).not.toContain('cancelled');
    for (const status of ['resolved', 'cancelled'] as const) {
      expect(EVENT_STATUSES.some((to) => canEventTransition(status, to))).toBe(false);
      expect(isOpenEvent(status)).toBe(false);
    }
    expect(isOpenEvent('scheduled')).toBe(true);
    expect(isOpenEvent('active')).toBe(true);
  });
});

describe('event generation', () => {
  const generate = (rng: Rng, overrides: Partial<Parameters<typeof generateEvent>[0]> = {}) =>
    generateEvent({
      rng,
      tick: 7200,
      places: PLACES,
      availableAircraftIds: ['AEGIS-TR-001', 'AEGIS-FT-001'],
      airborneAircraftIds: ['AEGIS-TR-002'],
      openGenerated: [],
      ...overrides,
    });
  function run(seed: string, intervals: number): EventDraft[] {
    const rng = Rng.fromSeed(seed, 'events.generation');
    const out: EventDraft[] = [];
    for (let i = 1; i <= intervals; i++) {
      const draft = generate(rng, { tick: i * EVENT_GENERATION.intervalTicks });
      if (draft) out.push(draft);
    }
    return out;
  }

  it('produces the same events from the same seed', () => {
    expect(run('seed-a', 300)).toEqual(run('seed-a', 300));
    expect(run('seed-a', 300)).not.toEqual(run('seed-b', 300));
  });

  it('is controlled: about one interval in three produces an event', () => {
    const drafts = run('pacing', 2000);
    expect(drafts.length).toBeGreaterThan(500);
    expect(drafts.length).toBeLessThan(EVENT_GENERATION.chancePerInterval * 2000 + 80);
  });

  it('generates nothing, and draws nothing, while enough events are open', () => {
    const rng = Rng.fromSeed('full', 'events.generation');
    const before = rng.state();
    const open = [1, 2, 3].map((n) => event({ id: `EVT-00000${n}` }));
    expect(generate(rng, { openGenerated: open })).toBeNull();
    expect(rng.state()).toEqual(before);
    expect(generate(rng, { places: [] })).toBeNull();
    expect(rng.state()).toEqual(before);
  });

  it('generates every type, each well formed', () => {
    const drafts = run('variety', 3000);
    expect(new Set(drafts.map((draft) => draft.type))).toEqual(
      new Set(EVENT_TYPES.filter((type) => type !== 'severe_weather')),
    );
    for (const draft of drafts) {
      expect(draft.source).toBe('generated');
      expect(draft.severity).toBeGreaterThanOrEqual(0.3);
      expect(draft.severity).toBeLessThanOrEqual(1);
      expect(draft.endTick).toBeGreaterThanOrEqual(draft.startTick);
      expect(draft.description).toMatch(/^Simulated event\./);
      if (draft.type === 'aerodrome_closure' || draft.type === 'logistics_disruption') {
        expect(PLACES).toContainEqual(draft.place);
        expect(draft.centre).toBeNull();
      }
      if (draft.type === 'navigation_disruption') {
        expect(draft.place).toBeNull();
        expect(draft.radiusM).toBeGreaterThanOrEqual(EVENT_GENERATION.areaRadiusM[0]);
        expect(draft.radiusM).toBeLessThanOrEqual(EVENT_GENERATION.areaRadiusM[1]);
        // The area lies near an aerodrome of the operating area.
        const nearest = Math.min(
          ...PLACES.map((place) => greatCircleDistance(place, draft.centre ?? place)),
        );
        expect(nearest).toBeLessThanOrEqual(EVENT_GENERATION.areaOffsetM[1] + 1);
      }
      if (draft.type === 'maintenance_finding') {
        expect(['AEGIS-TR-001', 'AEGIS-FT-001']).toContain(draft.aircraftId);
        expect(draft.endTick).toBe(draft.startTick);
      }
    }
  });

  it('announces an event before it starts and gives it a bounded duration', () => {
    const rng = Rng.fromSeed('timing', 'events.generation');
    let seen = 0;
    for (let i = 1; i <= 600; i++) {
      const tick = i * EVENT_GENERATION.intervalTicks;
      const draft = generate(rng, { tick });
      // A finding and a caution are not announced: they are found, or show themselves, now.
      if (!draft || draft.type === 'maintenance_finding' || draft.type === 'technical_caution') {
        continue;
      }
      seen++;
      expect(draft.startTick - tick).toBeGreaterThanOrEqual(EVENT_GENERATION.leadS[0]);
      expect(draft.startTick - tick).toBeLessThanOrEqual(EVENT_GENERATION.leadS[1]);
      expect(draft.endTick - draft.startTick).toBeGreaterThanOrEqual(EVENT_GENERATION.durationS[0]);
      expect(draft.endTick - draft.startTick).toBeLessThanOrEqual(EVENT_GENERATION.durationS[1]);
    }
    expect(seen).toBeGreaterThan(100);
  });

  it('finds no maintenance fault when no aircraft is available to find one in', () => {
    const drafts: (EventDraft | null)[] = [];
    const rng = Rng.fromSeed('no-aircraft', 'events.generation');
    for (let i = 1; i <= 2000; i++) {
      drafts.push(generate(rng, { tick: i * 7200, availableAircraftIds: [] }));
    }
    expect(drafts.some((draft) => draft?.type === 'maintenance_finding')).toBe(false);
    expect(drafts.some((draft) => draft?.type === 'aerodrome_closure')).toBe(true);
  });

  it('does not close an aerodrome that is already closed', () => {
    const rng = Rng.fromSeed('repeat', 'events.generation');
    const closedEverywhere = PLACES.map((place, index) =>
      event({ id: `EVT-00000${index}`, place, status: 'scheduled' }),
    ).slice(0, 2);
    for (let i = 1; i <= 2000; i++) {
      const draft = generate(rng, { tick: i * 7200, openGenerated: closedEverywhere });
      if (draft?.type === 'aerodrome_closure') {
        expect(closedEverywhere.map((e) => e.place?.refId)).not.toContain(draft.place?.refId);
      }
    }
  });
});

describe('hazards for planning', () => {
  const closure = event({});
  const disruption = event({
    id: 'EVT-000002',
    type: 'navigation_disruption',
    place: null,
    centre: { name: 'Area', lat: 50.6, lon: -4.2 },
    radiusM: 60_000,
    severity: 0.8,
  });
  const hazards = hazardsFrom([closure, disruption]);

  it('takes only events that are announced or under way', () => {
    expect(hazards.closures.map((c) => c.eventId)).toEqual(['EVT-000001']);
    expect(hazards.disruptions.map((d) => d.eventId)).toEqual(['EVT-000002']);
    expect(hazardsFrom([{ ...closure, status: 'resolved' }]).closures).toEqual([]);
    expect(hazardsFrom([{ ...closure, status: 'scheduled' }]).closures).toHaveLength(1);
    // A logistics disruption or a maintenance finding is not something a route avoids.
    expect(
      hazardsFrom([
        event({ type: 'logistics_disruption' }),
        event({ type: 'maintenance_finding', place: null, aircraftId: 'AEGIS-TR-001' }),
      ]),
    ).toEqual({ closures: [], disruptions: [] });
  });

  it('finds the closure in force at an aerodrome at a tick', () => {
    expect(closureAt(hazards, EXETER, 999)).toBeUndefined();
    expect(closureAt(hazards, EXETER, 1000)?.eventId).toBe('EVT-000001');
    expect(closureAt(hazards, EXETER, 4999)?.eventId).toBe('EVT-000001');
    expect(closureAt(hazards, EXETER, 5000)).toBeUndefined();
    expect(closureAt(hazards, NEWQUAY, 2000)).toBeUndefined();
    // The same aerodrome from another copy of the reference record still matches.
    expect(closureAt(hazards, { ...EXETER, name: 'Exeter Airport' }, 2000)).toBeDefined();
  });

  it('knows whether a route passes through an area, and when', () => {
    const route = [NEWQUAY, EXETER];
    expect(routePassesWithin(route, { lat: 50.6, lon: -4.2 }, 60_000)).toBe(true);
    expect(routePassesWithin(route, { lat: 53, lon: -4.2 }, 60_000)).toBe(false);
    expect(routePassesWithin([NEWQUAY, INVERNESS], { lat: 54, lon: -4.5 }, 30_000)).toBe(true);

    expect(disruptionsOnRoute(hazards, route, 1500, 3000).map((d) => d.eventId)).toEqual([
      'EVT-000002',
    ]);
    // Flown before the disruption starts, or after it ends, the route does not meet it.
    expect(disruptionsOnRoute(hazards, route, 0, 900)).toEqual([]);
    expect(disruptionsOnRoute(hazards, route, 5000, 7000)).toEqual([]);
    // A route elsewhere does not meet it at any time.
    expect(disruptionsOnRoute(hazards, [PRESTWICK, INVERNESS], 1500, 3000)).toEqual([]);
  });
});

describe('events and the flight planner', () => {
  const plan = generatePlan(TRANSPORT, NEWQUAY, EXETER);
  const evaluate = (departureTick: number, hazards: Hazards) => {
    const world = { weather: WEATHER, departureTick, hazards };
    const fuelKg = suggestedFuelKg(TRANSPORT, plan, 0, world) as number;
    return evaluatePlan(TRANSPORT, plan, { fuelKg, payloadKg: 0 }, world);
  };
  const codes = (evaluation: ReturnType<typeof evaluate>, severity: string) =>
    evaluation.constraints.filter((c) => c.severity === severity).map((c) => c.code);

  it('blocks a departure from a closed aerodrome, and says when it can leave', () => {
    const closedOrigin = hazardsFrom([event({ place: NEWQUAY, startTick: 0, endTick: 9000 })]);
    const blocked = evaluate(100, closedOrigin);
    expect(blocked.flyable).toBe(false);
    expect(codes(blocked, 'block')).toEqual(['origin_closed']);
    expect(blocked.constraints[0]?.message).toMatch(
      /Newquay is closed to departures \(EVT-000001\)/,
    );
    // Once it has reopened the same plan flies.
    expect(evaluate(9000, closedOrigin).flyable).toBe(true);
  });

  it('blocks a plan that would arrive during a known closure, but not one that arrives before', () => {
    const duration = evaluate(0, { closures: [], disruptions: [] }).estimate?.durationS ?? 0;
    const closedOnArrival = hazardsFrom([
      event({ place: EXETER, startTick: duration - 60, endTick: duration + 3600 }),
    ]);
    const blocked = evaluate(0, closedOnArrival);
    expect(codes(blocked, 'block')).toEqual(['destination_closed_on_arrival']);
    expect(
      blocked.constraints.find((c) => c.code === 'destination_closed_on_arrival')?.message,
    ).toMatch(/Exeter will be closed when the flight arrives/);

    const closesAfter = hazardsFrom([
      event({ place: EXETER, startTick: duration + 60, endTick: duration + 3600 }),
    ]);
    expect(evaluate(0, closesAfter).flyable).toBe(true);
  });

  it('warns about a disrupted area on the route, and still allows the flight', () => {
    const disrupted = hazardsFrom([
      event({
        type: 'navigation_disruption',
        place: null,
        centre: { name: 'Area', lat: 50.6, lon: -4.2 },
        radiusM: 60_000,
        startTick: 0,
        endTick: 20_000,
        severity: 0.8,
      }),
    ]);
    const evaluation = evaluate(100, disrupted);
    expect(evaluation.flyable).toBe(true);
    expect(codes(evaluation, 'warning')).toContain('navigation_disruption');
    expect(evaluation.estimate?.disruptions.map((d) => d.eventId)).toEqual(['EVT-000001']);
  });

  it('ignores events entirely when a plan is evaluated outside any world', () => {
    const still = evaluatePlan(TRANSPORT, plan, { fuelKg: 8000, payloadKg: 0 });
    expect(still.flyable).toBe(true);
    expect(still.estimate?.disruptions).toEqual([]);
    expect(still.estimate?.weather).toBeNull();
  });
});

describe('weather and events in the risk index', () => {
  const plan = generatePlan(TRANSPORT, NEWQUAY, INVERNESS);
  const assess = (hazards: Hazards, departureTick = 0) => {
    const world = { weather: WEATHER, departureTick, hazards };
    const fuelKg = suggestedFuelKg(TRANSPORT, plan, 0, world) as number;
    const evaluation = evaluatePlan(TRANSPORT, plan, { fuelKg, payloadKg: 0 }, world);
    if (!evaluation.estimate) throw new Error('no estimate');
    return {
      estimate: evaluation.estimate,
      risk: assessRisk({
        template: MISSION_TEMPLATES.transport,
        model: TRANSPORT,
        aircraftCategory: 'transport',
        conditionPct: 100,
        flightSecondsSinceMaintenance: 0,
        estimate: evaluation.estimate,
        planConstraints: evaluation.constraints,
        departureTick,
        deadlineTick: null,
        deadlineMetTick: null,
        maintenance: { dueAfterFlightSeconds: 180_000, dueBelowConditionPct: 60 },
      }),
    };
  };
  const contributor = (risk: ReturnType<typeof assess>['risk'], id: string) =>
    risk.contributors.find((c) => c.id === id);

  it('adds a contributor for each part of the environment, each with its reason', () => {
    const { risk } = assess({ closures: [], disruptions: [] });
    for (const id of [
      'wind',
      'weather_severity',
      'visibility',
      'precipitation',
      'temperature',
      'events',
    ]) {
      const found = contributor(risk, id);
      expect(found, id).toBeDefined();
      expect(found?.explanation.length).toBeGreaterThan(10);
      expect(found?.value).toBeGreaterThanOrEqual(0);
      expect(found?.value).toBeLessThanOrEqual(1);
    }
    expect(Math.round(risk.contributors.reduce((sum, c) => sum + c.points, 0))).toBe(risk.index);
  });

  it('explains wind from what it does to the flight', () => {
    // Over many departures, a headwind raises the contribution and a tailwind does not.
    let headwinds = 0;
    let tailwinds = 0;
    for (let hour = 0; hour < 600 && (headwinds < 3 || tailwinds < 3); hour += 7) {
      const { estimate, risk } = assess({ closures: [], disruptions: [] }, hour * 3600);
      const mean = estimate.weather?.meanTailwindKmh ?? 0;
      const wind = contributor(risk, 'wind');
      if (mean < -20) {
        headwinds++;
        expect(wind?.value).toBeGreaterThan(0);
        expect(wind?.explanation).toMatch(/headwind of \d+ km\/h adds \d+ min/);
      } else if (mean > 20) {
        tailwinds++;
        expect(wind?.value).toBe(0);
        expect(wind?.explanation).toMatch(/tailwind/);
      }
    }
    expect(headwinds).toBeGreaterThanOrEqual(1);
    expect(tailwinds).toBeGreaterThanOrEqual(1);
  });

  it('counts an event on the route by its severity, and names it', () => {
    expect(contributor(assess({ closures: [], disruptions: [] }).risk, 'events')?.value).toBe(0);
    const hazards = hazardsFrom([
      event({
        id: 'EVT-000007',
        type: 'navigation_disruption',
        place: null,
        centre: { name: 'Area', lat: 54, lon: -4.5 },
        radiusM: 100_000,
        startTick: 0,
        endTick: 50_000,
        severity: 0.8,
      }),
    ]);
    const events = contributor(assess(hazards).risk, 'events');
    expect(events?.value).toBe(0.8);
    expect(events?.explanation).toMatch(/1 affected area: EVT-000007/);
    expect(assess(hazards).risk.index).toBeGreaterThan(
      assess({ closures: [], disruptions: [] }).risk.index,
    );
  });

  it('contributes nothing in still air with no events', () => {
    const evaluation = evaluatePlan(TRANSPORT, plan, { fuelKg: 12_000, payloadKg: 0 });
    if (!evaluation.estimate) throw new Error('no estimate');
    const risk = assessRisk({
      template: MISSION_TEMPLATES.transport,
      model: TRANSPORT,
      aircraftCategory: 'transport',
      conditionPct: 100,
      flightSecondsSinceMaintenance: 0,
      estimate: evaluation.estimate,
      planConstraints: evaluation.constraints,
      departureTick: 0,
      deadlineTick: null,
      deadlineMetTick: null,
      maintenance: { dueAfterFlightSeconds: 180_000, dueBelowConditionPct: 60 },
    });
    for (const id of [
      'wind',
      'weather_severity',
      'visibility',
      'precipitation',
      'temperature',
      'events',
    ]) {
      expect(contributor(risk, id)?.value, id).toBe(0);
    }
  });
});
