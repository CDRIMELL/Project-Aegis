import { describe, expect, it } from 'vitest';
import { derivePerformance, type PerformanceModel } from '../flight/performance';
import { evaluatePlan, suggestedFuelKg, type FlightLoad, type FlightPlan } from '../flight/plan';
import type { RoutePoint } from '../flight/route';
import { greatCircleDistance } from '../geo';
import { Rng } from '../rng';
import {
  evaluateMission,
  missionAssessment,
  type MaintenancePolicy,
  type MissionAircraft,
} from './evaluate';
import { GENERATION, generateOpportunity, type GenerationAircraft } from './generate';
import {
  forecastObjectives,
  newObjectives,
  objectiveProblem,
  objectivesMet,
  type ObjectiveInput,
} from './objectives';
import { RISK_WEIGHTS, assessRisk } from './risk';
import {
  MISSION_GEOMETRY,
  MISSION_TEMPLATES,
  briefProblem,
  defaultBrief,
  defaultObjectives,
  missionRoute,
} from './templates';
import {
  MISSION_STATUSES,
  MISSION_TRANSITIONS,
  MISSION_TYPES,
  canTransition,
  isFinished,
  type MissionBrief,
  type MissionType,
  type Objective,
} from './types';

// Test inputs in the shape of the reference data. Illustrative, not authoritative.
function model(
  category: string,
  values: [number, number, number, number, number],
): PerformanceModel {
  const [emptyMassKg, maxTakeoffMassKg, cruiseSpeedKmh, rangeKm, serviceCeilingM] = values;
  const result = derivePerformance({
    category,
    engineType: 'turbofan',
    emptyMassKg,
    maxTakeoffMassKg,
    cruiseSpeedKmh,
    maxSpeedKmh: null,
    rangeKm,
    ferryRangeKm: null,
    serviceCeilingM,
  });
  if (!result.available) throw new Error('unavailable');
  return result.model;
}
const TRANSPORT = model('transport', [78600, 141000, 781, 3300, 12200]);
const FAST_JET = model('fast_jet', [11000, 23500, 900, 2900, 16764]);

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
const AREA = { name: 'Area 1', lat: 49.4, lon: -7.2 };

const MAINTENANCE: MaintenancePolicy = {
  dueAfterFlightSeconds: 50 * 3600,
  dueBelowConditionPct: 60,
  expectedWearPct: (durationS) => (0.4 * durationS) / 3600 + 0.5,
};
const aircraft = (overrides: Partial<MissionAircraft> = {}): MissionAircraft => ({
  id: 'AEGIS-TR-001',
  category: 'transport',
  performance: TRANSPORT,
  conditionPct: 100,
  flightSecondsSinceMaintenance: 0,
  ...overrides,
});

function brief(type: MissionType, overrides: Partial<MissionBrief>): MissionBrief {
  return { ...defaultBrief(MISSION_TEMPLATES[type]), ...overrides };
}
function plannedFor(
  type: MissionType,
  missionBrief: MissionBrief,
  performance = TRANSPORT,
  origin = NEWQUAY,
  completeByTick: number | null = null,
) {
  const plan = missionRoute(performance, origin, missionBrief) as FlightPlan;
  const fuelKg = suggestedFuelKg(performance, plan, missionBrief.payloadKg) as number;
  const load: FlightLoad = { fuelKg, payloadKg: missionBrief.payloadKg };
  const objectives = newObjectives(
    defaultObjectives(MISSION_TEMPLATES[type], missionBrief, completeByTick, 60),
  );
  return { plan, load, objectives };
}
function forecast(
  plan: FlightPlan,
  load: FlightLoad,
  inputs: readonly ObjectiveInput[],
  options: { performance?: PerformanceModel; departureTick?: number; conditionPct?: number } = {},
) {
  const result = forecastObjectives({
    model: options.performance ?? TRANSPORT,
    plan,
    load,
    objectives: newObjectives(inputs),
    departureTick: options.departureTick ?? 0,
    conditionPct: options.conditionPct ?? 100,
    expectedWearPct: MAINTENANCE.expectedWearPct,
    stepS: 1,
  });
  if (!result) throw new Error('route invalid');
  return result;
}
const only = (objectives: readonly Objective[]) => objectives[0] as Objective;

describe('mission lifecycle', () => {
  it('follows draft, planned, accepted, active, completed', () => {
    const path = ['draft', 'planned', 'accepted', 'active', 'completed'] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i] as never, path[i + 1] as never)).toBe(true);
    }
  });

  it('lets an offer be accepted, rejected or expire, and nothing else', () => {
    expect(MISSION_TRANSITIONS.offered).toEqual(['draft', 'rejected', 'expired']);
  });

  it('allows cancellation only before launch, and failure in flight', () => {
    expect(canTransition('accepted', 'cancelled')).toBe(true);
    expect(canTransition('active', 'cancelled')).toBe(false);
    expect(canTransition('active', 'failed')).toBe(true);
  });

  it('never leaves a finished status', () => {
    const finished = MISSION_STATUSES.filter(isFinished);
    expect(finished).toEqual(['completed', 'failed', 'cancelled', 'rejected', 'expired']);
    for (const status of finished) {
      expect(MISSION_STATUSES.some((to) => canTransition(status, to))).toBe(false);
    }
  });

  it('cannot skip acceptance', () => {
    expect(canTransition('draft', 'active')).toBe(false);
    expect(canTransition('planned', 'active')).toBe(false);
    expect(canTransition('offered', 'accepted')).toBe(false);
  });
});

describe('mission templates', () => {
  it('has one template for every mission type, all on the same framework', () => {
    expect(Object.keys(MISSION_TEMPLATES).sort()).toEqual([...MISSION_TYPES].sort());
    for (const type of MISSION_TYPES) {
      const template = MISSION_TEMPLATES[type];
      expect(template.type).toBe(type);
      expect(template.suitableCategories.length).toBeGreaterThan(0);
      expect(template.shape === 'orbit').toBe(template.holdS > 0);
    }
  });

  it('says what a brief still needs', () => {
    expect(briefProblem(defaultBrief(MISSION_TEMPLATES.logistics))).toMatch(/destination/);
    expect(briefProblem(defaultBrief(MISSION_TEMPLATES.patrol))).toMatch(/where/);
    expect(briefProblem(brief('patrol', { target: AREA, holdS: 0 }))).toMatch(/time in the area/);
    expect(briefProblem(brief('logistics', { destination: EXETER, payloadKg: -1 }))).toMatch(
      /payload/,
    );
    expect(missionRoute(TRANSPORT, NEWQUAY, defaultBrief(MISSION_TEMPLATES.logistics))).toBeNull();
  });

  it('routes a point-to-point mission to its destination', () => {
    const plan = missionRoute(TRANSPORT, NEWQUAY, brief('logistics', { destination: EXETER }));
    expect(plan?.points[0]).toEqual(NEWQUAY);
    expect(plan?.points.at(-1)).toEqual(EXETER);
  });

  it('routes an out-and-back mission to the point and home in one flight', () => {
    const plan = missionRoute(TRANSPORT, NEWQUAY, brief('training', { target: AREA }));
    expect(plan?.points.map((point) => point.kind)).toEqual(['aerodrome', 'waypoint', 'aerodrome']);
    expect(plan?.points.at(-1)).toEqual(NEWQUAY);
    expect(
      evaluatePlan(TRANSPORT, plan as FlightPlan, { fuelKg: 20000, payloadKg: 0 }).flyable,
    ).toBe(true);
  });

  it('routes an orbit as whole laps of the area that take at least the hold time', () => {
    const patrol = brief('patrol', { target: AREA });
    const plan = missionRoute(TRANSPORT, NEWQUAY, patrol) as FlightPlan;
    const orbit = plan.points.slice(1, -1);
    expect((orbit.length - 1) % MISSION_GEOMETRY.orbitPointsPerLap).toBe(0);
    for (const point of orbit) {
      expect(greatCircleDistance(point, AREA)).toBeCloseTo(patrol.orbitRadiusM, -1);
    }
    // The orbit is a closed loop.
    expect(greatCircleDistance(orbit[0] as RoutePoint, orbit.at(-1) as RoutePoint)).toBeLessThan(1);
    const lapM = MISSION_GEOMETRY.orbitPointsPerLap * patrol.orbitRadiusM;
    const laps = (orbit.length - 1) / MISSION_GEOMETRY.orbitPointsPerLap;
    expect(laps * lapM).toBeGreaterThanOrEqual((patrol.holdS * TRANSPORT.cruiseSpeedKmh) / 3.6);
  });

  it('gives a template objectives that fit its shape and brief', () => {
    const kinds = (type: MissionType, b: MissionBrief, by: number | null = null) =>
      defaultObjectives(MISSION_TEMPLATES[type], b, by, 60).map((o) => o.spec.kind);
    expect(
      kinds('logistics', brief('logistics', { destination: EXETER, payloadKg: 5000 })),
    ).toEqual(['complete_flight', 'deliver_payload', 'land_with_reserve']);
    expect(kinds('training', brief('training', { target: AREA }))).toEqual([
      'visit_point',
      'return_to_base',
      'land_with_reserve',
      'maintain_condition',
    ]);
    expect(kinds('patrol', brief('patrol', { target: AREA }))).toEqual([
      'remain_in_area',
      'return_to_base',
      'land_with_reserve',
    ]);
    // A time-critical sortie is judged on reaching the point in time.
    const intercept = defaultObjectives(
      MISSION_TEMPLATES.intercept,
      brief('intercept', { target: AREA }),
      9000,
      60,
    );
    expect(intercept[0]?.spec).toMatchObject({ kind: 'visit_point', byTick: 9000 });
    expect(intercept.some((o) => o.spec.kind === 'arrive_by')).toBe(false);
    expect(
      kinds('emergency_response', brief('emergency_response', { destination: EXETER }), 9000),
    ).toContain('arrive_by');
  });

  it('marks only the mission-defining objectives as required', () => {
    const objectives = defaultObjectives(
      MISSION_TEMPLATES.training,
      brief('training', { target: AREA }),
      null,
      60,
    );
    expect(objectives.filter((o) => o.required).map((o) => o.spec.kind)).toEqual([
      'visit_point',
      'return_to_base',
    ]);
  });
});

describe('objectives', () => {
  const outAndBack = plannedFor('training', brief('training', { target: AREA }));
  const toExeter = plannedFor(
    'logistics',
    brief('logistics', { destination: EXETER, payloadKg: 5000 }),
  );

  it('completes a flight objective on landing, with progress along the way', () => {
    const result = forecast(toExeter.plan, toExeter.load, [
      { label: 'Reach', spec: { kind: 'complete_flight' }, required: true },
    ]);
    expect(only(result.objectives)).toMatchObject({ status: 'complete', progress: 1 });
    expect(result.lands).toBe(true);
  });

  it('fails a flight objective when the fuel runs out first', () => {
    const result = forecast(outAndBack.plan, { fuelKg: 1500, payloadKg: 0 }, [
      { label: 'Reach', spec: { kind: 'complete_flight' }, required: true },
    ]);
    expect(result.lands).toBe(false);
    const objective = only(result.objectives);
    expect(objective.status).toBe('failed');
    expect(objective.progress).toBeGreaterThan(0);
    expect(objective.progress).toBeLessThan(1);
  });

  it('completes a visit when the route passes within the radius, and fails when it does not', () => {
    const visit = (point: { name: string; lat: number; lon: number }) =>
      only(
        forecast(outAndBack.plan, outAndBack.load, [
          {
            label: 'Visit',
            spec: { kind: 'visit_point', point, radiusM: 10_000, byTick: null },
            required: true,
          },
        ]).objectives,
      );
    expect(visit(AREA).status).toBe('complete');
    const missed = visit({ name: 'Elsewhere', lat: 53, lon: 2 });
    expect(missed.status).toBe('failed');
    expect(missed.remark).toMatch(/did not pass within 10 km of Elsewhere/);
  });

  it('fails a timed visit as soon as the time has passed', () => {
    const timed = (byTick: number) =>
      forecast(outAndBack.plan, outAndBack.load, [
        {
          label: 'Reach in time',
          spec: { kind: 'visit_point', point: AREA, radiusM: 10_000, byTick },
          required: true,
        },
      ]);
    const generous = timed(100_000);
    expect(only(generous.objectives).status).toBe('complete');
    const reachedAt = generous.decidedTick.O1 as number;
    expect(only(timed(reachedAt).objectives).status).toBe('complete');
    const late = timed(reachedAt - 1);
    expect(only(late.objectives).status).toBe('failed');
    expect(late.decidedTick.O1).toBe(reachedAt);
  });

  it('accumulates time in an area and completes at the required duration', () => {
    const patrol = plannedFor('patrol', brief('patrol', { target: AREA }));
    const result = forecast(
      patrol.plan,
      patrol.load,
      defaultObjectives(MISSION_TEMPLATES.patrol, brief('patrol', { target: AREA }), null, 60),
    );
    const hold = only(result.objectives);
    expect(hold).toMatchObject({ status: 'complete', accumulatedS: 30 * 60 });
    expect(objectivesMet(result.objectives)).toBe(true);
  });

  it('fails an area objective that a pass-through route cannot satisfy, with the time achieved', () => {
    const result = forecast(outAndBack.plan, outAndBack.load, [
      {
        label: 'Hold',
        spec: { kind: 'remain_in_area', centre: AREA, radiusM: 40_000, durationS: 3600 },
        required: true,
      },
    ]);
    const hold = only(result.objectives);
    expect(hold.status).toBe('failed');
    expect(hold.accumulatedS).toBeGreaterThan(0);
    expect(hold.accumulatedS).toBeLessThan(3600);
    expect(hold.remark).toMatch(/of 60 minutes in the area/);
  });

  it('delivers a payload only if the flight carries it', () => {
    const deliver: ObjectiveInput = {
      label: 'Deliver',
      spec: { kind: 'deliver_payload', massKg: 5000 },
      required: true,
    };
    expect(only(forecast(toExeter.plan, toExeter.load, [deliver]).objectives).status).toBe(
      'complete',
    );
    const short = only(
      forecast(toExeter.plan, { ...toExeter.load, payloadKg: 3000 }, [deliver]).objectives,
    );
    expect(short).toMatchObject({ status: 'failed' });
    expect(short.remark).toMatch(/3,000 kg of the 5,000 kg/);
  });

  it('distinguishes returning to base from landing elsewhere', () => {
    const home: ObjectiveInput = {
      label: 'Return',
      spec: { kind: 'return_to_base' },
      required: true,
    };
    expect(only(forecast(outAndBack.plan, outAndBack.load, [home]).objectives).status).toBe(
      'complete',
    );
    const away = only(forecast(toExeter.plan, toExeter.load, [home]).objectives);
    expect(away.status).toBe('failed');
    expect(away.remark).toBe('Landed at Exeter, not at Newquay.');
  });

  it('judges an arrival deadline to the tick', () => {
    const by = (byTick: number, departureTick = 0) =>
      forecast(
        toExeter.plan,
        toExeter.load,
        [{ label: 'By', spec: { kind: 'arrive_by', byTick }, required: true }],
        { departureTick },
      );
    const duration = by(1_000_000).durationS;
    expect(only(by(duration).objectives).status).toBe('complete');
    expect(only(by(duration - 1).objectives).status).toBe('failed');
    // The same flight departing later is judged against the same absolute deadline.
    expect(only(by(duration + 500, 500).objectives).status).toBe('complete');
    expect(only(by(duration + 499, 500).objectives).status).toBe('failed');
  });

  it('checks reserve fuel on landing', () => {
    const reserve: ObjectiveInput = {
      label: 'Reserve',
      spec: { kind: 'land_with_reserve' },
      required: false,
    };
    expect(only(forecast(toExeter.plan, toExeter.load, [reserve]).objectives).status).toBe(
      'complete',
    );
    const lean = { ...toExeter.load, fuelKg: toExeter.load.fuelKg - TRANSPORT.reserveFuelKg / 2 };
    const result = forecast(toExeter.plan, lean, [reserve]);
    expect(result.lands).toBe(true);
    expect(only(result.objectives).status).toBe('failed');
  });

  it('judges aircraft condition after the wear of the flight', () => {
    const condition = (conditionPct: number) =>
      only(
        forecast(
          toExeter.plan,
          toExeter.load,
          [
            {
              label: 'Condition',
              spec: { kind: 'maintain_condition', minPct: 60 },
              required: false,
            },
          ],
          { conditionPct },
        ).objectives,
      ).status;
    expect(condition(80)).toBe('complete');
    expect(condition(60.2)).toBe('failed');
  });

  it('counts a mission as met when every required objective is complete', () => {
    const [required, optional] = newObjectives([
      { label: 'A', spec: { kind: 'complete_flight' }, required: true },
      { label: 'B', spec: { kind: 'land_with_reserve' }, required: false },
    ]) as [Objective, Objective];
    expect(objectivesMet([required, optional])).toBe(false);
    expect(
      objectivesMet([
        { ...required, status: 'complete' },
        { ...optional, status: 'failed' },
      ]),
    ).toBe(true);
    expect(objectivesMet([{ ...required, status: 'failed' }, optional])).toBe(false);
  });

  it('rejects objective specifications that make no sense', () => {
    expect(objectiveProblem({ kind: 'complete_flight' })).toBeNull();
    expect(
      objectiveProblem({
        kind: 'visit_point',
        point: { ...AREA, lat: 95 },
        radiusM: 1,
        byTick: null,
      }),
    ).toMatch(/valid position/);
    expect(
      objectiveProblem({ kind: 'remain_in_area', centre: AREA, radiusM: 1000, durationS: 0 }),
    ).toMatch(/time in the area/);
    expect(objectiveProblem({ kind: 'deliver_payload', massKg: 0 })).toMatch(/payload/);
    expect(objectiveProblem({ kind: 'maintain_condition', minPct: 140 })).toMatch(
      /between 0 and 100/,
    );
  });

  it('is deterministic', () => {
    const run = () =>
      forecast(
        outAndBack.plan,
        outAndBack.load,
        defaultObjectives(
          MISSION_TEMPLATES.training,
          brief('training', { target: AREA }),
          null,
          60,
        ),
      );
    expect(run()).toEqual(run());
  });
});

describe('mission validation', () => {
  const logistics = brief('logistics', { destination: EXETER, payloadKg: 5000 });
  const planned = plannedFor('logistics', logistics);
  const evaluate = (overrides: Partial<Parameters<typeof evaluateMission>[0]> = {}) =>
    evaluateMission({
      type: 'logistics',
      aircraft: aircraft(),
      plan: planned.plan,
      load: planned.load,
      objectives: planned.objectives,
      departureTick: 0,
      completeByTick: null,
      maintenance: MAINTENANCE,
      stepS: 1,
      ...overrides,
    });
  const codes = (evaluation: ReturnType<typeof evaluate>, severity: string) =>
    evaluation.constraints.filter((c) => c.severity === severity).map((c) => c.code);

  it('accepts a sound mission and forecasts every objective met', () => {
    const evaluation = evaluate();
    expect(evaluation.acceptable).toBe(true);
    expect(codes(evaluation, 'block')).toEqual([]);
    expect(objectivesMet(evaluation.forecast?.objectives ?? [])).toBe(true);
    expect(evaluation.risk).not.toBeNull();
  });

  it('blocks a mission with no aircraft, no route or no objectives', () => {
    expect(codes(evaluate({ aircraft: null }), 'block')).toEqual(['no_aircraft']);
    expect(codes(evaluate({ plan: null }), 'block')).toEqual(['no_route']);
    expect(codes(evaluate({ objectives: [] }), 'block')).toContain('no_objectives');
    expect(codes(evaluate({ aircraft: aircraft({ performance: null }) }), 'block')).toEqual([
      'aircraft_cannot_fly',
    ]);
  });

  it('cannot bypass a flight constraint: the planner’s blocks are the mission’s blocks', () => {
    const overweight = { fuelKg: TRANSPORT.fuelCapacityKg, payloadKg: TRANSPORT.maxPayloadKg };
    const evaluation = evaluate({ load: overweight });
    expect(evaluatePlan(TRANSPORT, planned.plan, overweight).flyable).toBe(false);
    expect(codes(evaluation, 'block')).toContain('over_maximum_mass');
    expect(evaluation.acceptable).toBe(false);
    expect(missionAssessment(evaluation, 0)).toBeNull();

    const dry = evaluate({ load: { fuelKg: 500, payloadKg: 5000 } });
    expect(codes(dry, 'block')).toContain('insufficient_fuel');
  });

  it('blocks a load that does not carry what the mission must deliver', () => {
    const evaluation = evaluate({ load: { ...planned.load, payloadKg: 4000 } });
    expect(codes(evaluation, 'block')).toContain('payload_short');
  });

  it('blocks a mission whose deadline has passed', () => {
    expect(codes(evaluate({ departureTick: 500, completeByTick: 500 }), 'block')).toContain(
      'deadline_passed',
    );
  });

  it('warns, but allows, an aircraft the template is not meant for', () => {
    const evaluation = evaluate({ aircraft: aircraft({ category: 'fast_jet' }) });
    expect(codes(evaluation, 'warning')).toContain('aircraft_unsuitable');
    expect(evaluation.acceptable).toBe(true);
  });

  it('warns when a required objective will not be met as planned, and still allows it', () => {
    const deadline = 60;
    const objectives = newObjectives(
      defaultObjectives(MISSION_TEMPLATES.emergency_response, logistics, deadline, 60),
    );
    const evaluation = evaluate({
      type: 'emergency_response',
      objectives,
      completeByTick: deadline,
    });
    expect(codes(evaluation, 'warning')).toContain('objective_will_fail');
    expect(evaluation.acceptable).toBe(true);
  });

  it('notes an optional objective that will fail and maintenance falling due', () => {
    const lean = { ...planned.load, fuelKg: planned.load.fuelKg - TRANSPORT.reserveFuelKg / 2 };
    expect(codes(evaluate({ load: lean }), 'note')).toContain('optional_objective_will_fail');
    const tired = aircraft({ flightSecondsSinceMaintenance: 50 * 3600 - 60 });
    expect(codes(evaluate({ aircraft: tired }), 'note')).toContain('maintenance_due_after');
  });

  it('records the planner’s figures and the risk when a mission is acceptable', () => {
    const evaluation = evaluate();
    const assessment = missionAssessment(evaluation, 42);
    expect(assessment).toMatchObject({
      assessedTick: 42,
      distanceM: evaluation.plan?.estimate?.distanceM,
      durationS: evaluation.forecast?.durationS,
      risk: evaluation.risk,
    });
  });
});

describe('mission risk', () => {
  const logistics = brief('logistics', { destination: INVERNESS, payloadKg: 5000 });
  const planned = plannedFor('logistics', logistics);
  const estimate = (load: FlightLoad) => {
    const evaluation = evaluatePlan(TRANSPORT, planned.plan, load);
    if (!evaluation.estimate) throw new Error('no estimate');
    return evaluation;
  };
  const assess = (overrides: Partial<Parameters<typeof assessRisk>[0]> = {}) => {
    const evaluation = estimate(planned.load);
    return assessRisk({
      template: MISSION_TEMPLATES.logistics,
      model: TRANSPORT,
      aircraftCategory: 'transport',
      conditionPct: 100,
      flightSecondsSinceMaintenance: 0,
      estimate: evaluation.estimate as NonNullable<typeof evaluation.estimate>,
      planConstraints: evaluation.constraints,
      departureTick: 0,
      deadlineTick: null,
      deadlineMetTick: null,
      maintenance: MAINTENANCE,
      ...overrides,
    });
  };
  const value = (risk: ReturnType<typeof assess>, id: string) =>
    risk.contributors.find((contributor) => contributor.id === id)?.value;

  it('is the sum of its contributors, each of which explains itself', () => {
    const risk = assess({ conditionPct: 70, aircraftCategory: 'fast_jet' });
    expect(risk.contributors.map((c) => c.id).sort()).toEqual(Object.keys(RISK_WEIGHTS).sort());
    expect(Math.round(risk.contributors.reduce((sum, c) => sum + c.points, 0))).toBe(risk.index);
    for (const contributor of risk.contributors) {
      expect(contributor.explanation.length).toBeGreaterThan(10);
      expect(contributor.value).toBeGreaterThanOrEqual(0);
      expect(contributor.value).toBeLessThanOrEqual(1);
    }
    // Highest contribution first.
    const points = risk.contributors.map((c) => c.points);
    expect(points).toEqual([...points].sort((a, b) => b - a));
  });

  it('stays within 0 to 100', () => {
    expect(assess().index).toBeGreaterThanOrEqual(0);
    const worst = assess({
      conditionPct: 10,
      flightSecondsSinceMaintenance: 60 * 3600,
      aircraftCategory: 'fast_jet',
      deadlineTick: 10,
      deadlineMetTick: null,
    });
    expect(worst.index).toBeLessThanOrEqual(100);
    expect(worst.index).toBeGreaterThan(assess().index);
  });

  it('rises as the fuel margin shrinks', () => {
    const comfortable = {
      ...planned.load,
      fuelKg: planned.load.fuelKg + TRANSPORT.reserveFuelKg * 1.3,
    };
    const lean = { ...planned.load, fuelKg: planned.load.fuelKg - TRANSPORT.reserveFuelKg * 0.4 };
    const fuel = (load: FlightLoad) => {
      const evaluation = estimate(load);
      return value(
        assess({ estimate: evaluation.estimate as NonNullable<typeof evaluation.estimate> }),
        'fuel_margin',
      ) as number;
    };
    expect(fuel(comfortable)).toBe(0);
    expect(fuel(planned.load)).toBeGreaterThan(fuel(comfortable));
    expect(fuel(lean)).toBeGreaterThan(fuel(planned.load));
  });

  it('rises with a worn aircraft and with little time before maintenance', () => {
    expect(value(assess({ conditionPct: 95 }), 'aircraft_condition')).toBe(0);
    expect(value(assess({ conditionPct: 75 }), 'aircraft_condition')).toBeCloseTo(0.5, 6);
    expect(value(assess({ conditionPct: 55 }), 'aircraft_condition')).toBe(1);
    expect(value(assess(), 'maintenance_margin')).toBe(0);
    expect(
      value(assess({ flightSecondsSinceMaintenance: 50 * 3600 - 600 }), 'maintenance_margin'),
    ).toBe(1);
  });

  it('counts an unsuitable aircraft and explains why', () => {
    const risk = assess({ aircraftCategory: 'fast_jet' });
    expect(value(risk, 'aircraft_suitability')).toBe(1);
    expect(risk.contributors.find((c) => c.id === 'aircraft_suitability')?.explanation).toMatch(
      /not one the logistics template is meant for/,
    );
  });

  it('measures time pressure from the slack against the deadline', () => {
    expect(value(assess(), 'time_pressure')).toBe(0);
    expect(value(assess({ deadlineTick: 9000, deadlineMetTick: 6000 }), 'time_pressure')).toBe(0);
    expect(
      value(assess({ deadlineTick: 7500, deadlineMetTick: 6000 }), 'time_pressure'),
    ).toBeCloseTo(0.5, 6);
    expect(value(assess({ deadlineTick: 6000, deadlineMetTick: 6000 }), 'time_pressure')).toBe(1);
    expect(value(assess({ deadlineTick: 5000, deadlineMetTick: null }), 'time_pressure')).toBe(1);
  });

  it('is deterministic', () => {
    expect(assess({ conditionPct: 71.3 })).toEqual(assess({ conditionPct: 71.3 }));
  });
});

describe('opportunity generation', () => {
  const fleet: GenerationAircraft[] = [
    { category: 'transport', performance: TRANSPORT, location: NEWQUAY },
    { category: 'fast_jet', performance: FAST_JET, location: PRESTWICK },
  ];
  const generate = (rng: Rng, overrides: Partial<Parameters<typeof generateOpportunity>[0]> = {}) =>
    generateOpportunity({
      rng,
      tick: 3600,
      places: PLACES,
      aircraft: fleet,
      openOffers: 0,
      ordinal: 1,
      ...overrides,
    });
  /** Every opportunity a seed produces over a number of considered hours. */
  function run(seed: string, hours: number) {
    const rng = Rng.fromSeed(seed, 'missions.generation');
    const offers = [];
    for (let hour = 1; hour <= hours; hour++) {
      const offer = generate(rng, { tick: hour * 3600, ordinal: offers.length + 1 });
      if (offer) offers.push(offer);
    }
    return offers;
  }

  it('produces the same opportunities from the same seed', () => {
    expect(run('seed-a', 200)).toEqual(run('seed-a', 200));
    expect(run('seed-a', 200)).not.toEqual(run('seed-b', 200));
  });

  it('is controlled: well under one opportunity per considered hour', () => {
    const offers = run('pacing', 1000);
    expect(offers.length).toBeGreaterThan(250);
    expect(offers.length).toBeLessThan(GENERATION.chancePerInterval * 1000 + 60);
  });

  it('generates nothing, and draws nothing, while enough offers are waiting', () => {
    const rng = Rng.fromSeed('full', 'missions.generation');
    const before = rng.state();
    expect(generate(rng, { openOffers: GENERATION.maxOpenOffers })).toBeNull();
    expect(rng.state()).toEqual(before);
  });

  it('generates nothing without an operating area or an aircraft that can fly', () => {
    for (let i = 0; i < 50; i++) {
      const rng = Rng.fromSeed(`none-${i}`, 'missions.generation');
      expect(generate(rng, { places: [] })).toBeNull();
      expect(generate(rng, { aircraft: [] })).toBeNull();
      expect(
        generate(rng, { aircraft: [{ category: 'tanker', performance: null, location: NEWQUAY }] }),
      ).toBeNull();
      expect(
        generate(rng, { aircraft: [{ ...(fleet[0] as GenerationAircraft), location: null }] }),
      ).toBeNull();
    }
  });

  it('offers only what an aircraft in the fleet can fly from where it is', () => {
    const offers = run('feasible', 150);
    expect(new Set(run('feasible', 600).map((offer) => offer.type)).size).toBeGreaterThan(5);
    for (const offer of offers) {
      const template = MISSION_TEMPLATES[offer.type];
      expect(briefProblem(offer.brief)).toBeNull();
      const flyable = fleet.some((candidate) => {
        if (!template.suitableCategories.includes(candidate.category)) return false;
        const performance = candidate.performance as PerformanceModel;
        const plan = missionRoute(performance, candidate.location as RoutePoint, offer.brief);
        if (!plan) return false;
        const fuelKg = suggestedFuelKg(performance, plan, offer.brief.payloadKg);
        return (
          fuelKg !== null &&
          evaluatePlan(performance, plan, { fuelKg, payloadKg: offer.brief.payloadKg }).flyable
        );
      });
      expect(flyable, offer.title).toBe(true);
    }
  });

  it('uses only places from the operating area as destinations', () => {
    for (const offer of run('places', 600)) {
      if (offer.brief.destination) expect(PLACES).toContainEqual(offer.brief.destination);
      else expect(offer.brief.target?.name).toMatch(/^Area \d+$/);
    }
  });

  it('gives every opportunity an answer window and a later deadline, and says it is simulated', () => {
    const rng = Rng.fromSeed('timing', 'missions.generation');
    let seen = 0;
    for (let hour = 1; hour <= 300; hour++) {
      const tick = hour * 3600;
      const offer = generate(rng, { tick, ordinal: seen + 1 });
      if (!offer) continue;
      seen += 1;
      const [shortest, longest] = GENERATION.answerWindowS;
      expect(offer.expiresTick - tick).toBeGreaterThanOrEqual(shortest);
      expect(offer.expiresTick - tick).toBeLessThanOrEqual(longest);
      expect(offer.completeByTick).toBeGreaterThan(offer.expiresTick);
      expect(offer.description).toMatch(/^Simulated requirement./);
      if (offer.brief.payloadKg > 0) {
        expect(MISSION_TEMPLATES[offer.type].carriesPayload).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(50);
  });

  it('gives an urgent mission a deadline that an immediate launch can meet', () => {
    const urgent = run('urgent', 700).filter((offer) => MISSION_TEMPLATES[offer.type].timeCritical);
    expect(urgent.length).toBeGreaterThan(10);
    for (const offer of urgent) {
      const template = MISSION_TEMPLATES[offer.type];
      const candidate = fleet.find((a) => template.suitableCategories.includes(a.category));
      if (!candidate?.performance || !candidate.location) throw new Error('no candidate');
      const plan = missionRoute(
        candidate.performance,
        candidate.location,
        offer.brief,
      ) as FlightPlan;
      const fuelKg = suggestedFuelKg(candidate.performance, plan, offer.brief.payloadKg) as number;
      const objectives = newObjectives(
        defaultObjectives(template, offer.brief, offer.completeByTick, 60),
      );
      const result = forecastObjectives({
        model: candidate.performance,
        plan,
        load: { fuelKg, payloadKg: offer.brief.payloadKg },
        objectives,
        // Launched the moment the offer appears.
        departureTick: offer.expiresTick - 6 * 3600,
        conditionPct: 100,
        expectedWearPct: MAINTENANCE.expectedWearPct,
        stepS: 1,
      });
      expect(objectivesMet(result?.objectives ?? []), offer.title).toBe(true);
    }
  });
});
