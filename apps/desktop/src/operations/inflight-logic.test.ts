import {
  MISSION_TEMPLATES,
  defaultBrief,
  hazardsFrom,
  type RevisionContext,
  type RoutePoint,
  type WorldEvent,
} from '@aegis/domain';
import { SimulationEngine, defaultConfiguration, type FlightView } from '@aegis/sim';
import { FIXTURES, fixtureOrder } from '@aegis/sim/testing';
import { describe, expect, it } from 'vitest';
import { insertWaypoint, moveWaypoint, removeWaypoint } from '../fleet/plan-edit';
import {
  PRESENT_POSITION,
  abortLanding,
  advisoriesFor,
  currentEstimate,
  draftRemainder,
  followAircraft,
  objectivesAffected,
  operationsFor,
  proposalEstimate,
  rankCandidates,
  remainderOf,
  revisionDraft,
} from './inflight-logic';

const { places, models } = FIXTURES;
const TRANSPORT = 'AEGIS-TR-001';
const ROME: RoutePoint = {
  kind: 'aerodrome',
  refId: 'fixture:lirf',
  name: 'Rome',
  code: 'LIRF',
  lat: 41.8003,
  lon: 12.2389,
  elevationM: 5,
};
const MALTA: RoutePoint = {
  ...ROME,
  refId: 'fixture:lmml',
  name: 'Malta',
  code: 'LMML',
  lat: 35.8575,
  lon: 14.4775,
};

function world(): SimulationEngine {
  const engine = SimulationEngine.create({ seed: 'inflight-logic', epoch: FIXTURES.epoch });
  engine.applyCommand({
    type: 'seedStarterFleet',
    aircraft: [
      fixtureOrder('fastJet', places.prestwick),
      fixtureOrder('transport', places.newquay),
    ],
  });
  return engine;
}
const transport = (engine: SimulationEngine) => {
  const found = engine.snapshot().fleet.aircraft.find((each) => each.id === TRANSPORT);
  if (!found) throw new Error('no transport');
  return found;
};
/** A delivery to Akrotiri with fuel to spare, flown for `seconds`. */
function delivering(seconds: number): SimulationEngine {
  const engine = world();
  engine.runSteps(100);
  engine.applyCommand({
    type: 'createMission',
    missionType: 'logistics',
    ...defaultConfiguration(
      'logistics',
      {
        ...defaultBrief(MISSION_TEMPLATES.logistics),
        destination: places.akrotiri,
        payloadKg: 3000,
      },
      transport(engine),
      { context: engine.planContext() },
    ),
    load: { fuelKg: 60_000, payloadKg: 3000 },
  });
  engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
  engine.applyCommand({ type: 'launchMission', missionId: 'MSN-000001' });
  engine.runSteps(seconds);
  return engine;
}
const viewOf = (engine: SimulationEngine): FlightView => {
  const flight = engine.fleetView().activeFlights[0];
  if (!flight) throw new Error('no flight in the air');
  return flight;
};
const contextOf = (engine: SimulationEngine): RevisionContext => {
  const context = engine.planContext();
  return { weather: context.weather, ...(context.hazards && { hazards: context.hazards }) };
};
const missionOf = (engine: SimulationEngine) => {
  const mission = engine.snapshot().missions.missions[0];
  if (!mission) throw new Error('no mission');
  return mission;
};

describe('what the operator can do with a flight', { timeout: 60_000 }, () => {
  it('offers every action that applies, and aborting only for a mission in flight', () => {
    const engine = delivering(5400);
    const operations = operationsFor(viewOf(engine), transport(engine), missionOf(engine));
    expect(operations.map((each) => [each.operation, each.available])).toEqual([
      ['reroute', true],
      ['divert', true],
      ['return', true],
      ['hold', true],
      ['abort', true],
    ]);
    expect(operations.every((each) => each.reason === null)).toBe(true);
    // A flight on its own, or one whose mission is over, has no mission to abort.
    const without = operationsFor(viewOf(engine), transport(engine), null);
    expect(without.map((each) => each.operation)).toEqual(['reroute', 'divert', 'return', 'hold']);
    const aborted = operationsFor(viewOf(engine), transport(engine), {
      id: 'MSN-000001',
      status: 'aborted',
    });
    expect(aborted.map((each) => each.operation)).not.toContain('abort');
  });

  it('says why an action cannot be taken instead of hiding it', () => {
    const rolling = delivering(3);
    for (const each of operationsFor(viewOf(rolling), transport(rolling), null)) {
      expect(each.available).toBe(false);
      expect(each.reason).toMatch(/still on its take-off roll/);
    }
    const descending = delivering(5400);
    for (let i = 0; i < 2000 && viewOf(descending).phase !== 'descent'; i++)
      descending.runSteps(20);
    const hold = operationsFor(viewOf(descending), transport(descending), null).find(
      (each) => each.operation === 'hold',
    );
    expect(hold).toMatchObject({ available: false });
    expect(hold?.reason).toMatch(/descending to land. Divert it/);
    // Reroute and divert remain: a descent can be abandoned.
    expect(
      operationsFor(viewOf(descending), transport(descending), null)
        .filter((each) => each.available)
        .map((each) => each.operation),
    ).toEqual(['reroute', 'divert', 'return']);
  });

  it('offers resume in place of hold while holding, and not for a hold that is not the operator’s', () => {
    const engine = delivering(5400);
    engine.applyCommand({ type: 'holdFlight', aircraftId: TRANSPORT });
    const holding = operationsFor(viewOf(engine), transport(engine), null);
    expect(holding.map((each) => each.operation)).toEqual([
      'reroute',
      'divert',
      'return',
      'resume',
    ]);
    expect(holding.at(-1)).toMatchObject({ available: true, label: 'Resume' });
    const closed = operationsFor({ ...viewOf(engine), hold: 'closure' }, transport(engine), null);
    expect(closed.at(-1)).toMatchObject({ operation: 'resume', available: false });
    expect(closed.at(-1)?.reason).toMatch(/Akrotiri is closed.*divert to land elsewhere/);
  });

  it('does not offer a return to an aircraft already bound for its origin', () => {
    const engine = delivering(5400);
    engine.applyCommand({
      type: 'reviseFlight',
      aircraftId: TRANSPORT,
      intent: 'return',
      points: [places.newquay],
    });
    const back = operationsFor(viewOf(engine), transport(engine), null).find(
      (each) => each.operation === 'return',
    );
    expect(back).toMatchObject({
      available: false,
      reason: 'The aircraft is already bound for Newquay.',
    });
  });
});

describe('a draft of the rest of a flight', { timeout: 60_000 }, () => {
  const engine = delivering(5400);
  const flight = viewOf(engine);

  it('starts where the aircraft is and is edited with the planner’s own functions', () => {
    const draft = revisionDraft(flight, remainderOf(flight));
    expect(draft.plan.points[0]).toMatchObject({
      kind: 'waypoint',
      name: PRESENT_POSITION,
      lat: flight.lat,
      lon: flight.lon,
    });
    expect(draftRemainder(draft)).toEqual(remainderOf(flight));
    expect(draft.plan.points.at(-1)).toEqual(places.akrotiri);
    expect(draft.load.fuelKg).toBe(flight.fuelKg);

    // Add a waypoint on the first leg and move it north: the planner's editing, unchanged.
    const added = moveWaypoint(insertWaypoint(draft, 0), 1, 48, 10);
    expect(draftRemainder(added)).toHaveLength(remainderOf(flight).length + 1);
    expect(draftRemainder(added)[0]).toMatchObject({ kind: 'waypoint', lat: 48, lon: 10 });
    // The two ends cannot be edited: the present position is where the aircraft is.
    expect(moveWaypoint(added, 0, 0, 0)).toBe(added);
    expect(removeWaypoint(added, 0)).toBe(added);
    expect(removeWaypoint(added, added.plan.points.length - 1)).toBe(added);
    expect(removeWaypoint(added, 1).plan.points).toHaveLength(draft.plan.points.length);
  });

  it('follows the aircraft as it flies on, and leaves any other draft alone', () => {
    const draft = revisionDraft(flight, [ROME]);
    const moved = followAircraft(draft, { lat: flight.lat + 0.5, lon: flight.lon + 1 });
    expect(moved.plan.points[0]).toMatchObject({ lat: flight.lat + 0.5, lon: flight.lon + 1 });
    expect(moved.plan.points.slice(1)).toEqual([ROME]);
    expect(followAircraft(draft, flight)).toBe(draft);
    const ordinary = { ...draft, plan: { ...draft.plan, points: [places.newquay, ROME] } };
    expect(followAircraft(ordinary, { lat: 1, lon: 1 })).toBe(ordinary);
  });
});

describe('comparing a choice with how things stand', { timeout: 60_000 }, () => {
  const engine = delivering(5400);
  const flight = viewOf(engine);
  const model = models.transport;
  const context = contextOf(engine);

  it('estimates the flight as it stands, and a proposal, to what each then does', () => {
    const before = currentEstimate(model, flight, context);
    const proposal = proposalEstimate(model, flight, [ROME], context);
    expect(proposal.blocks).toEqual([]);
    expect(proposal.estimate?.projection.destination).toEqual(ROME);
    expect(proposal.estimate?.projection.arrivalTick).toBeLessThan(before.projection.arrivalTick);
    expect(proposal.estimate?.projection.landingFuelKg).toBeGreaterThan(
      before.projection.landingFuelKg,
    );

    const untouched = delivering(5400);
    for (let i = 0; i < 4000 && untouched.fleetView().activeFlights.length > 0; i++) {
      untouched.runSteps(20);
    }
    const flown = untouched.snapshot().fleet.flights[0];
    expect(flown?.arrivedTick).toBe(before.projection.arrivalTick);
    expect(flown?.progress.fuelKg).toBe(before.projection.landingFuelKg);

    engine.applyCommand({
      type: 'reviseFlight',
      aircraftId: TRANSPORT,
      intent: 'divert',
      points: [ROME],
    });
    for (let i = 0; i < 4000 && engine.fleetView().activeFlights.length > 0; i++)
      engine.runSteps(20);
    const diverted = engine.snapshot().fleet.flights[0];
    expect(diverted?.arrivedTick).toBe(proposal.estimate?.projection.arrivalTick);
    expect(diverted?.progress.fuelKg).toBe(proposal.estimate?.projection.landingFuelKg);
  });

  it('gives each option a risk index from the mission risk model’s own factors', () => {
    const before = currentEstimate(model, flight, context);
    expect(before.risk.index).toBeGreaterThanOrEqual(0);
    expect(before.risk.index).toBeLessThanOrEqual(100);
    expect(before.risk.contributors.map((contributor) => contributor.id).sort()).toEqual([
      'events',
      'fuel_margin',
      'visibility',
      'weather_severity',
    ]);
    const total = before.risk.contributors.reduce(
      (sum, contributor) => sum + contributor.points,
      0,
    );
    expect(Math.round(total)).toBe(before.risk.index);
    // A proposal that would land short of fuel is the worst the fuel factor gets.
    const far: RoutePoint = { ...ROME, refId: 'fixture:far', name: 'Far', lat: 10, lon: 100 };
    const short = proposalEstimate(
      model,
      { ...flight, fuelKg: 8000, progress: { ...flight.progress, fuelKg: 8000 } },
      [far],
      context,
    );
    expect(short.blocks.map((block) => block.code)).toEqual(['insufficient_fuel']);
    expect(short.estimate?.risk.contributors.find((c) => c.id === 'fuel_margin')?.value).toBe(1);
  });

  it('ranks where it could divert to by the fuel it would land with, with the unusable last and explained', () => {
    const here: RoutePoint = {
      ...ROME,
      refId: 'fixture:here',
      name: 'Too near',
      code: 'NEAR',
      lat: flight.lat + 0.2,
      lon: flight.lon,
    };
    const ranked = rankCandidates(
      model,
      flight,
      [MALTA, here, ROME, places.newquay, places.akrotiri],
      context,
    );
    // The present destination is not a diversion.
    expect(ranked.map((candidate) => candidate.place.code)).not.toContain('LCRA');
    const usable = ranked.filter((candidate) => candidate.flyable);
    expect(usable.length).toBeGreaterThanOrEqual(3);
    const fuels = usable.map((candidate) => candidate.estimate?.projection.landingFuelKg ?? 0);
    expect(fuels).toEqual([...fuels].sort((a, b) => b - a));
    const last = ranked.at(-1);
    expect(last).toMatchObject({ flyable: false, estimate: null });
    expect(last?.place.code).toBe('NEAR');
    expect(last?.note).toMatch(/descent from the present altitude needs/);
    // The same inputs give the same list.
    expect(
      rankCandidates(model, flight, [MALTA, here, ROME, places.newquay, places.akrotiri], context),
    ).toEqual(ranked);
    expect(rankCandidates(model, flight, [], context)).toEqual([]);
  });
});

describe('what a choice does to the mission', { timeout: 60_000 }, () => {
  const engine = delivering(5400);
  const mission = missionOf(engine);

  it('fails the destination objectives of a flight that lands elsewhere', () => {
    const effects = objectivesAffected(mission, ROME, false);
    const delivery = effects.find((each) => each.objective.spec.kind === 'deliver_payload');
    expect(delivery?.effect).toBe('Fails: lands at Rome, not at Akrotiri.');
    expect(effects.every((each) => each.objective.status === 'pending')).toBe(true);
    // Landing where it was planned to decides nothing.
    expect(objectivesAffected(mission, places.akrotiri, false)).toEqual([]);
    expect(objectivesAffected(null, ROME, false)).toEqual([]);
  });

  it('fails everything still pending when the mission is aborted, and nothing already decided', () => {
    const effects = objectivesAffected(mission, places.akrotiri, true);
    expect(effects).toHaveLength(mission.objectives.filter((o) => o.status === 'pending').length);
    expect(effects.every((each) => each.effect === 'Fails: the mission is aborted.')).toBe(true);
    const decided = {
      ...mission,
      objectives: mission.objectives.map((objective, index) =>
        index === 0 ? { ...objective, status: 'complete' as const } : objective,
      ),
    };
    expect(objectivesAffected(decided, ROME, true)).toHaveLength(effects.length - 1);
  });

  it('turns the landing chosen for an abort into the command’s landing', () => {
    expect(abortLanding('continue', [places.akrotiri])).toEqual({ intent: 'continue' });
    expect(abortLanding('return', [places.newquay])).toEqual({
      intent: 'return',
      points: [places.newquay],
    });
    expect(abortLanding('divert', [ROME])).toEqual({ intent: 'divert', points: [ROME] });
  });
});

describe('advisories', { timeout: 60_000 }, () => {
  const model = models.transport;
  const closure = (engine: SimulationEngine, hours: number): WorldEvent => ({
    id: 'EVT-000001',
    type: 'aerodrome_closure',
    status: 'active',
    source: 'generated',
    severity: 0.6,
    createdTick: engine.clock.tick,
    startTick: engine.clock.tick,
    endTick: engine.clock.tick + hours * 3600,
    place: places.akrotiri,
    centre: null,
    radiusM: null,
    aircraftId: null,
    missionId: null,
    title: 'Aerodrome closure: Akrotiri',
    description: 'Simulated event.',
  });

  it('says nothing when there is nothing to say', () => {
    const engine = delivering(5400);
    const flight = viewOf(engine);
    const { projection } = currentEstimate(model, flight, contextOf(engine));
    expect(advisoriesFor(flight, model, projection)).toEqual([]);
  });

  it('warns that the destination will be closed on arrival, and what would then happen', () => {
    const engine = delivering(5400);
    const flight = viewOf(engine);
    const hazards = hazardsFrom([closure(engine, 4)]);
    const { projection } = currentEstimate(model, flight, {
      weather: engine.planContext().weather,
      hazards,
    });
    expect(projection.holdS).toBeGreaterThan(0);
    const [advisory] = advisoriesFor(flight, model, projection);
    expect(advisory).toMatchObject({ tone: 'warn', title: 'Akrotiri will be closed on arrival' });
    expect(advisory?.detail).toMatch(
      /hold short of it for \d+ min until it reopens.*or be diverted/,
    );

    // Closed for longer than the fuel lasts: it says the aircraft would land regardless.
    const long = currentEstimate(model, flight, {
      weather: engine.planContext().weather,
      hazards: hazardsFrom([closure(engine, 60)]),
    }).projection;
    expect(long.landsDuringClosure).toBe(true);
    expect(advisoriesFor(flight, model, long)[0]?.detail).toMatch(
      /land during the closure with its fuel at reserve/,
    );
  });

  it('describes a hold for a closure, a hold by order, a caution and short fuel, each in its own words', () => {
    const engine = delivering(5400);
    const flight = viewOf(engine);
    const { projection } = currentEstimate(model, flight, contextOf(engine));
    const titles = (overrides: Partial<FlightView>, changed = projection) =>
      advisoriesFor({ ...flight, ...overrides }, model, changed).map((advisory) => advisory.title);

    expect(titles({ hold: 'closure' }, { ...projection, holdS: 1200 })).toEqual([
      'Holding: Akrotiri is closed',
    ]);
    expect(titles({ hold: 'operator', heldS: 300 })).toEqual(['Holding on your order']);
    // A hold by order is projected as if resumed now. It is not mistaken for a closure, and the
    // fuel the hold would burn if it went on for ever is not reported as a shortage.
    const holding = delivering(5400);
    holding.applyCommand({ type: 'holdFlight', aircraftId: TRANSPORT });
    holding.runSteps(120);
    const held = viewOf(holding);
    const resumedNow = currentEstimate(model, held, contextOf(holding)).projection;
    expect(resumedNow.holdS).toBe(0);
    expect(resumedNow.landingFuelKg).toBeGreaterThan(model.reserveFuelKg);
    expect(advisoriesFor(held, model, resumedNow).map((advisory) => advisory.title)).toEqual([
      'Holding on your order',
    ]);
    expect(advisoriesFor(held, model, resumedNow)[0]?.detail).toMatch(
      /Held for 2 min so far. Resumed now, the aircraft would land with [\d,]+ kg/,
    );
    // And that is what happens when it is resumed now.
    holding.applyCommand({ type: 'resumeFlight', aircraftId: TRANSPORT });
    for (let i = 0; i < 4000 && holding.fleetView().activeFlights.length > 0; i++) {
      holding.runSteps(20);
    }
    expect(holding.snapshot().fleet.flights[0]?.progress.fuelKg).toBe(resumedNow.landingFuelKg);
    expect(titles({ caution: { eventId: 'EVT-000007', sinceTick: 1 } })).toEqual([
      'Technical caution',
    ]);
    expect(titles({ closureLanding: true })).toEqual(['Landing at Akrotiri during its closure']);
    expect(titles({}, { ...projection, landingFuelKg: model.reserveFuelKg - 500 })).toEqual([
      'Landing below reserve fuel',
    ]);
    expect(titles({}, { ...projection, completes: false, shortM: 250_000 })).toEqual([
      'Fuel will not reach the destination',
    ]);
    const disrupted = {
      ...projection,
      disruptions: [
        {
          eventId: 'EVT-000003',
          type: 'navigation_disruption' as const,
          centre: { name: 'Area', lat: 40, lon: 20 },
          radiusM: 100_000,
          severity: 0.7,
          startTick: 0,
          endTick: 1_000_000,
        },
      ],
    };
    expect(titles({}, disrupted)).toEqual(['Disrupted area on the route ahead']);
    // None of them tells the operator what to do.
    for (const advisory of advisoriesFor({ ...flight, hold: 'closure' }, model, {
      ...projection,
      holdS: 1200,
    })) {
      expect(advisory.detail).not.toMatch(/you should|you must|recommend/i);
    }
  });
});
