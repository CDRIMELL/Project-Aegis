import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RoutePoint } from '../flight/route';
import {
  AIRCRAFT_STATUSES,
  GROUND_SERVICE,
  aerodromeCapability,
  beginTransfer,
  classifiedPoint,
  forecastGroundServices,
  fuelDiffers,
  fuelDuringTransfer,
  launchReadiness,
  postFlightChecksS,
  refuelRateKgS,
  retargetTransfer,
  payloadDurationS,
  serviceCompleteTick,
  serviceProgress,
  transferDurationS,
  type AircraftStatus,
  type GroundService,
  type ReadinessSubject,
  type ServiceTask,
} from './index';

/*
 * Ground servicing rules (ADR 0027): how long things take, where the fuel stands at any tick,
 * and the one rule for whether an aircraft can launch.
 */

const { checks, refuel } = GROUND_SERVICE;
const HOUR = 3600;
/** Tanks of 24,000 kg: 20 kg a second, between the bounds. */
const CAPACITY = 24_000;

describe('how long ground servicing takes', () => {
  it('checks an aircraft for longer after a longer flight, within stated limits', () => {
    expect(postFlightChecksS(0)).toBe(checks.baseS);
    expect(postFlightChecksS(HOUR)).toBe(checks.baseS + checks.perFlightHourS);
    expect(postFlightChecksS(4.5 * HOUR)).toBe(checks.baseS + 4.5 * checks.perFlightHourS);
    expect(postFlightChecksS(100 * HOUR)).toBe(checks.maxS);
    // Whole seconds, so that it is a number of ticks.
    expect(Number.isInteger(postFlightChecksS(1234))).toBe(true);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40 * HOUR }),
        fc.integer({ min: 0, max: HOUR }),
        (s, more) => {
          expect(postFlightChecksS(s + more)).toBeGreaterThanOrEqual(postFlightChecksS(s));
          expect(postFlightChecksS(s)).toBeLessThanOrEqual(checks.maxS);
        },
      ),
    );
  });

  it('moves fuel at a rate set by the size of the tanks, between a floor and a ceiling', () => {
    expect(refuelRateKgS(CAPACITY)).toBe(CAPACITY / refuel.fullFillS);
    expect(refuelRateKgS(4500)).toBe(refuel.minRateKgS);
    expect(refuelRateKgS(120_000)).toBe(refuel.maxRateKgS);
    // The assumptions as stated to the operator are the ones the rules use.
    expect(refuel.statement).toContain('300 kg');
    expect(refuel.statement).toContain('2,400 kg');
    expect(refuel.minRateKgS * 60).toBe(300);
    expect(refuel.maxRateKgS * 60).toBe(2400);
  });

  it('takes longer to load more fuel, and the same to take it off', () => {
    expect(transferDurationS(CAPACITY, 0, 10_000)).toBe(refuel.connectS + 500);
    expect(transferDurationS(CAPACITY, 0, 20_000)).toBe(refuel.connectS + 1000);
    expect(transferDurationS(CAPACITY, 20_000, 0)).toBe(refuel.connectS + 1000);
    // Whole ticks: a part of a second is a second.
    expect(transferDurationS(CAPACITY, 0, 10_001)).toBe(refuel.connectS + 501);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: CAPACITY }),
        fc.integer({ min: 0, max: CAPACITY }),
        fc.integer({ min: 1, max: 2000 }),
        (from, to, more) => {
          const further = to >= from ? to + more : to - more;
          expect(transferDurationS(CAPACITY, from, further)).toBeGreaterThanOrEqual(
            transferDurationS(CAPACITY, from, to),
          );
        },
      ),
    );
  });
});

describe('fuel during a transfer', () => {
  const loading = beginTransfer(CAPACITY, 1000, 4000, 14_000);

  it('does not move while connecting, then moves at the rate, and ends exactly on the target', () => {
    expect(loading).toEqual({
      startTick: 1000,
      flowStartTick: 1000 + refuel.connectS,
      fromKg: 4000,
      toKg: 14_000,
      rateKgS: 20,
      completeTick: 1000 + refuel.connectS + 500,
    });
    expect(fuelDuringTransfer(loading, 1000)).toBe(4000);
    expect(fuelDuringTransfer(loading, loading.flowStartTick)).toBe(4000);
    expect(fuelDuringTransfer(loading, loading.flowStartTick + 1)).toBe(4020);
    expect(fuelDuringTransfer(loading, loading.flowStartTick + 250)).toBe(9000);
    expect(fuelDuringTransfer(loading, loading.completeTick - 1)).toBe(13_980);
    expect(fuelDuringTransfer(loading, loading.completeTick)).toBe(14_000);
    expect(fuelDuringTransfer(loading, loading.completeTick + 10_000)).toBe(14_000);
  });

  it('is a function of the transfer and the tick alone, rising every second until it is done', () => {
    // An awkward quantity at an awkward rate: the target is still met exactly.
    const awkward = beginTransfer(31_337, 7, 1234.5, 20_000.25);
    let last = awkward.fromKg;
    for (let tick = awkward.flowStartTick + 1; tick <= awkward.completeTick; tick++) {
      const now = fuelDuringTransfer(awkward, tick);
      expect(now).toBeGreaterThan(last);
      expect(now).toBeLessThanOrEqual(awkward.toKg);
      // Asked again, in any order, it is the same figure.
      expect(fuelDuringTransfer(awkward, tick)).toBe(now);
      last = now;
    }
    expect(last).toBe(20_000.25);
  });

  it('takes fuel off the same way', () => {
    const unloading = beginTransfer(CAPACITY, 0, 14_000, 4000);
    expect(unloading.completeTick).toBe(refuel.connectS + 500);
    expect(fuelDuringTransfer(unloading, refuel.connectS + 100)).toBe(12_000);
    expect(fuelDuringTransfer(unloading, unloading.completeTick)).toBe(4000);
    expect(fuelDuringTransfer(unloading, unloading.completeTick - 1)).toBeGreaterThan(4000);
  });

  it('given a new target, goes on from the fuel it has without connecting again', () => {
    const at = loading.flowStartTick + 100;
    const more = retargetTransfer(loading, at, fuelDuringTransfer(loading, at), 20_000);
    expect(more).toMatchObject({ startTick: at, flowStartTick: at, fromKg: 6000, toKg: 20_000 });
    expect(more.completeTick).toBe(at + 700);
    // Changed while still connecting: the connection is finished, not started again.
    const early = retargetTransfer(loading, 1010, 4000, 6000);
    expect(early.flowStartTick).toBe(loading.flowStartTick);
    expect(early.completeTick).toBe(loading.flowStartTick + 100);
    // Turned round: fuel that was going on comes off.
    const less = retargetTransfer(loading, at, 6000, 5000);
    expect(fuelDuringTransfer(less, at + 25)).toBe(5500);
    expect(less.completeTick).toBe(at + 50);
  });

  it('treats fuel within the tolerance as the fuel asked for', () => {
    expect(fuelDiffers(10_000, 10_000)).toBe(false);
    expect(fuelDiffers(10_000, 10_000.5)).toBe(false);
    expect(fuelDiffers(10_000, 10_001)).toBe(true);
    expect(fuelDiffers(10_001, 10_000)).toBe(true);
  });
});

const NEWQUAY: RoutePoint = {
  kind: 'aerodrome',
  refId: 'fixture:eghq',
  name: 'Newquay',
  code: 'EGHQ',
  lat: 50.4406,
  lon: -4.9954,
  elevationM: 119,
};
const EXETER: RoutePoint = {
  ...NEWQUAY,
  refId: 'fixture:egte',
  name: 'Exeter',
  code: 'EGTE',
  lat: 50.7344,
  lon: -3.4139,
};

const aircraft = (overrides: Partial<ReadinessSubject> = {}): ReadinessSubject => ({
  id: 'AEGIS-TR-001',
  status: 'available',
  location: NEWQUAY,
  fuelKg: 10_000,
  payloadKg: 0,
  service: null,
  performance: { fuelCapacityKg: CAPACITY },
  performanceMissing: [],
  ...overrides,
});
const turnaround = (overrides: Partial<GroundService> = {}): GroundService => ({
  reason: 'turnaround',
  startedTick: 5000,
  stage: 'checks',
  checksCompleteTick: 6200,
  fuelAtStartKg: 10_000,
  payloadAtStartKg: 0,
  fuel: null,
  payload: null,
  missionId: null,
  ...overrides,
});
/** A task that has been asked for and has not yet reached the queue. */
const wanted = (targetKg: number, overrides: Partial<ServiceTask> = {}): ServiceTask => ({
  targetKg,
  queuedTick: null,
  transfer: null,
  startedTick: null,
  completedTick: null,
  ...overrides,
});
const codes = (subject: ReadinessSubject, fuelKg: number | null, tick = 5600, origin = NEWQUAY) =>
  launchReadiness(subject, { fuelKg, origin }, tick).issues.map((issue) => issue.code);

describe('whether an aircraft can launch', () => {
  it('can, when it is available where the flight starts with the fuel planned', () => {
    expect(launchReadiness(aircraft(), { fuelKg: 10_000, origin: NEWQUAY }, 0)).toEqual({
      ready: true,
      issues: [],
      readyTick: null,
      prepareS: null,
    });
    // Asked without a fuel figure: whether it can launch at all.
    expect(launchReadiness(aircraft(), { fuelKg: null, origin: null }, 0).ready).toBe(true);
  });

  it('cannot in any state but available, and says which', () => {
    const blocked: Readonly<Record<Exclude<AircraftStatus, 'available'>, string>> = {
      in_flight: 'airborne',
      servicing: 'servicing',
      maintenance_due: 'maintenance_due',
      in_maintenance: 'in_maintenance',
      unserviceable: 'unserviceable',
    };
    for (const status of AIRCRAFT_STATUSES) {
      const subject = aircraft({
        status,
        location: status === 'in_flight' ? null : NEWQUAY,
        service: status === 'servicing' ? turnaround() : null,
      });
      const readiness = launchReadiness(subject, { fuelKg: 10_000, origin: NEWQUAY }, 5600);
      expect(readiness.ready).toBe(status === 'available');
      // Ready exactly when nothing is in the way.
      expect(readiness.issues.length === 0).toBe(readiness.ready);
      if (status !== 'available') {
        expect(readiness.issues.map((issue) => issue.code)).toEqual([blocked[status]]);
        expect(readiness.issues[0]?.message).toContain('AEGIS-TR-001');
      }
    }
  });

  it('says when a servicing that needs nothing more will leave it ready', () => {
    const checking = aircraft({ status: 'servicing', service: turnaround() });
    const readiness = launchReadiness(checking, { fuelKg: 10_000, origin: NEWQUAY }, 5600);
    expect(readiness.readyTick).toBe(6200);
    expect(readiness.issues[0]?.message).toBe(
      'AEGIS-TR-001 is in its post-flight checks. It will be available in 10 min.',
    );
    // With the fuel to follow the checks, it is ready when that is aboard.
    const fuelling = aircraft({
      status: 'servicing',
      service: turnaround({ fuel: wanted(14_000) }),
    });
    const later = launchReadiness(fuelling, { fuelKg: 14_000, origin: NEWQUAY }, 5600);
    expect(later.readyTick).toBe(6200 + refuel.connectS + 200);
    expect(later.issues.map((issue) => issue.code)).toEqual(['servicing']);
  });

  it('needs the fuel planned aboard, and says what loading it would take', () => {
    const short = launchReadiness(aircraft(), { fuelKg: 14_000, origin: NEWQUAY }, 0);
    expect(short.ready).toBe(false);
    expect(short.readyTick).toBeNull();
    expect(short.prepareS).toBe(refuel.connectS + 200);
    expect(short.issues).toEqual([
      {
        code: 'fuel',
        message:
          'AEGIS-TR-001 holds 10,000 kg; the flight departs with 14,000 kg. Loading 4,000 kg takes 9 min.',
      },
    ]);
    const over = launchReadiness(aircraft(), { fuelKg: 9000, origin: NEWQUAY }, 0);
    expect(over.issues[0]?.message).toBe(
      'AEGIS-TR-001 holds 10,000 kg; the flight departs with 9,000 kg. Taking 1,000 kg off takes 6 min.',
    );
    // Being serviced toward a different quantity: it will not be ready when that is done.
    const wrong = aircraft({ status: 'servicing', service: turnaround({ fuel: wanted(12_000) }) });
    const still = launchReadiness(wrong, { fuelKg: 14_000, origin: NEWQUAY }, 5600);
    expect(still.readyTick).toBeNull();
    expect(still.issues.map((issue) => issue.code)).toEqual(['servicing', 'fuel']);
    expect(still.issues[1]?.message).toContain('will hold 12,000 kg');
  });

  it('must be where the flight starts, and must have a performance model', () => {
    expect(codes(aircraft(), 10_000, 0, EXETER)).toEqual(['elsewhere']);
    expect(
      codes(aircraft({ performance: null, performanceMissing: ['empty mass'] }), null),
    ).toEqual(['no_model']);
    // Everything in the way is reported, most fundamental first.
    expect(codes(aircraft({ status: 'maintenance_due' }), 14_000, 0, EXETER)).toEqual([
      'maintenance_due',
      'elsewhere',
      'fuel',
    ]);
    // Maintenance in the way: time alone will not make it ready.
    expect(
      launchReadiness(aircraft({ status: 'maintenance_due' }), { fuelKg: 10_000, origin: null }, 0)
        .readyTick,
    ).toBeNull();
  });
});

describe('a service as it stands', () => {
  it('is nothing for an aircraft that is not being serviced', () => {
    expect(serviceProgress(aircraft(), 100)).toBeNull();
  });

  it('reports the stage, what remains and when it ends, from the record and the tick', () => {
    const checking = aircraft({
      status: 'servicing',
      service: turnaround({ fuel: wanted(14_000) }),
    });
    const complete = 6200 + refuel.connectS + 200;
    expect(serviceCompleteTick(checking, 5600)).toBe(complete);
    expect(serviceProgress(checking, 5600)).toMatchObject({
      reason: 'turnaround',
      stage: 'checks',
      startedTick: 5000,
      completeTick: complete,
      remainingS: complete - 5600,
      fraction: 600 / (complete - 5000),
      checksRemainingS: 600,
      fuelKg: 10_000,
      fuel: {
        kind: 'fuel',
        state: 'behind_checks',
        targetKg: 14_000,
        remainingKg: 4000,
        removing: false,
        startTick: 6200,
        completeTick: complete,
        position: null,
        behind: null,
      },
      payload: null,
      missionId: null,
    });

    const transfer = beginTransfer(CAPACITY, 6200, 10_000, 14_000);
    const fuelling = aircraft({
      status: 'servicing',
      fuelKg: fuelDuringTransfer(transfer, transfer.flowStartTick + 50),
      service: turnaround({
        stage: 'preparation',
        fuel: wanted(14_000, { queuedTick: 6200, startedTick: 6200, transfer }),
        missionId: 'MSN-000004',
      }),
    });
    expect(serviceProgress(fuelling, 6210)?.fuel?.state).toBe('connecting');
    expect(serviceProgress(fuelling, transfer.flowStartTick + 50)).toMatchObject({
      stage: 'preparation',
      fuelKg: 11_000,
      fuel: { state: 'moving', remainingKg: 3000, completeTick: complete },
      remainingS: 150,
      completeTick: complete,
      missionId: 'MSN-000004',
    });
    // Never outside 0 to 1, whatever tick is asked for.
    expect(serviceProgress(fuelling, 0)?.fraction).toBe(0);
    expect(serviceProgress(fuelling, 1_000_000)).toMatchObject({ fraction: 1, remainingS: 0 });
  });
});

describe('what an aerodrome can do', () => {
  it('is assumed from its size class, and nothing where there is no aerodrome', () => {
    expect(aerodromeCapability({ ...NEWQUAY, size: 'large' })).toMatchObject({
      servicing: true,
      size: 'large',
      fuelPoints: 2,
      handlingPoints: 2,
    });
    expect(aerodromeCapability({ ...NEWQUAY, size: 'small' })).toMatchObject({
      fuelPoints: 1,
      fuelRateFactor: 0.5,
    });
    // No class recorded: the assumptions of a medium aerodrome, and it says the class is unknown.
    expect(aerodromeCapability(NEWQUAY)).toEqual({
      ...aerodromeCapability({ ...NEWQUAY, size: 'medium' }),
      size: null,
    });
    expect(aerodromeCapability({ ...NEWQUAY, kind: 'waypoint' }).servicing).toBe(false);
    expect(aerodromeCapability(null)).toMatchObject({ servicing: false, fuelPoints: 0 });
    // A smaller aerodrome takes longer over the same fuel and the same payload.
    expect(transferDurationS(CAPACITY, 0, 12_000, 0.5)).toBe(refuel.connectS + 1200);
    expect(transferDurationS(CAPACITY, 0, 12_000, 1)).toBe(refuel.connectS + 600);
    expect(payloadDurationS(30, 0, 9000)).toBe(GROUND_SERVICE.payload.positionS + 300);
    expect(payloadDurationS(15, 9000, 0)).toBe(GROUND_SERVICE.payload.positionS + 600);
  });
});

describe('giving a point its size class', () => {
  const sizes = { 'fixture:eghq': 'large', 'fixture:other': 'small' } as const;

  it('fills in the class the reference data holds, for an aerodrome that lacks one', () => {
    expect(classifiedPoint(NEWQUAY, sizes)).toEqual({ ...NEWQUAY, size: 'large' });
    expect(aerodromeCapability(classifiedPoint(NEWQUAY, sizes)).fuelPoints).toBe(2);
  });

  it('leaves an aerodrome the reference data does not know as it is: the medium fallback', () => {
    expect(classifiedPoint(EXETER, sizes)).toBe(EXETER);
    expect(aerodromeCapability(classifiedPoint(EXETER, sizes))).toMatchObject({
      size: null,
      fuelPoints: 1,
      fuelRateFactor: 1,
    });
    // No reference id to look it up by: nothing is guessed from its name or position.
    const anonymous = Object.fromEntries(
      Object.entries(NEWQUAY).filter(([key]) => key !== 'refId'),
    ) as RoutePoint;
    expect(classifiedPoint(anonymous, sizes)).toBe(anonymous);
  });

  it('never replaces a class, and never classes what is not an aerodrome', () => {
    const small = { ...NEWQUAY, size: 'small' as const };
    expect(classifiedPoint(small, sizes)).toBe(small);
    const waypoint = { ...NEWQUAY, kind: 'waypoint' as const };
    expect(classifiedPoint(waypoint, sizes)).toBe(waypoint);
    // Applying it again changes nothing.
    const once = classifiedPoint(NEWQUAY, sizes);
    expect(classifiedPoint(once, sizes)).toBe(once);
  });
});

describe('the queue for a point', () => {
  const waiting = (id: string, queuedTick: number, toKg: number, fuelKg = 10_000) =>
    aircraft({
      id,
      status: 'servicing',
      fuelKg,
      service: turnaround({
        reason: 'preparation',
        stage: 'preparation',
        startedTick: queuedTick,
        checksCompleteTick: queuedTick,
        fuel: wanted(toKg, { queuedTick }),
      }),
    });
  const transfer = beginTransfer(CAPACITY, 1000, 10_000, 20_000);
  const fuelling = (id: string) =>
    aircraft({
      id,
      status: 'servicing',
      service: turnaround({
        reason: 'preparation',
        stage: 'preparation',
        startedTick: 1000,
        checksCompleteTick: 1000,
        fuel: wanted(20_000, { queuedTick: 1000, startedTick: 1000, transfer }),
      }),
    });

  it('serves one aircraft at a time where there is one point, in the order they began to wait', () => {
    const forecasts = forecastGroundServices(
      [fuelling('A'), waiting('C', 1200, 12_000), waiting('B', 1100, 14_000)],
      1300,
    );
    expect(forecasts.get('A')?.fuel).toMatchObject({ state: 'moving', position: null });
    // B began to wait first: it takes the point when A gives it up, and C follows B.
    const b = forecasts.get('B')?.fuel;
    expect(b).toMatchObject({
      state: 'waiting',
      position: 1,
      behind: 'A',
      startTick: transfer.completeTick,
      completeTick: transfer.completeTick + refuel.connectS + 200,
    });
    expect(forecasts.get('C')?.fuel).toMatchObject({
      state: 'waiting',
      position: 2,
      behind: 'B',
      startTick: b?.completeTick,
      completeTick: (b?.completeTick ?? 0) + refuel.connectS + 100,
    });
    expect(forecasts.get('C')?.completeTick).toBe(forecasts.get('C')?.fuel?.completeTick);
  });

  it('serves two at once where there are two points, and breaks a tie by identifier', () => {
    const large = (subject: ReadinessSubject): ReadinessSubject => ({
      ...subject,
      location: { ...NEWQUAY, size: 'large' },
    });
    const forecasts = forecastGroundServices(
      [large(fuelling('A')), large(waiting('C', 1100, 12_000)), large(waiting('B', 1100, 14_000))],
      1100,
    );
    // The second point is free: B, first by identifier, starts now. C waits for whichever
    // point is free soonest, which is B's.
    expect(forecasts.get('B')?.fuel).toMatchObject({
      startTick: 1100,
      position: null,
      behind: null,
    });
    const bDone = 1100 + refuel.connectS + 200;
    expect(forecasts.get('C')?.fuel).toMatchObject({
      state: 'waiting',
      position: 1,
      behind: 'B',
      startTick: bDone,
    });
    expect(bDone).toBeLessThan(transfer.completeTick);
  });

  it('keeps aerodromes, and the two kinds of resource, apart', () => {
    const elsewhere = { ...waiting('B', 1100, 14_000), location: EXETER };
    const loading = aircraft({
      id: 'D',
      status: 'servicing',
      service: turnaround({
        reason: 'preparation',
        stage: 'preparation',
        startedTick: 1100,
        checksCompleteTick: 1100,
        payload: wanted(9000, { queuedTick: 1100 }),
      }),
    });
    const forecasts = forecastGroundServices([fuelling('A'), elsewhere, loading], 1100);
    // Another aerodrome's point, and the handling point here: neither waits for A's fuel.
    expect(forecasts.get('B')?.fuel).toMatchObject({ startTick: 1100, position: null });
    expect(forecasts.get('D')).toMatchObject({
      fuel: null,
      payload: { kind: 'handling', startTick: 1100, position: null },
      completeTick: 1100 + payloadDurationS(30, 0, 9000),
    });
  });

  it('tells a waiting aircraft whom it is behind, in the readiness rule', () => {
    const b = waiting('B', 1100, 14_000);
    const forecast = forecastGroundServices([fuelling('A'), b], 1300).get('B') ?? null;
    const readiness = launchReadiness(b, { fuelKg: 14_000, origin: NEWQUAY }, 1300, forecast);
    expect(readiness.issues).toHaveLength(1);
    expect(readiness.issues[0]?.message).toMatch(
      /^B is waiting for a fuel point, behind A\. It will be available in \d+ min\.$/,
    );
    expect(readiness.readyTick).toBe(forecast?.completeTick);
    // Alone at its aerodrome it would not have had to wait.
    expect(launchReadiness(b, { fuelKg: 14_000, origin: NEWQUAY }, 1300).readyTick).toBeLessThan(
      forecast?.completeTick ?? 0,
    );
  });
});

describe('payload and readiness', () => {
  it('needs the planned payload aboard, as it needs the planned fuel', () => {
    const ready = launchReadiness(aircraft(), { fuelKg: 10_000, payloadKg: 0, origin: NEWQUAY }, 0);
    expect(ready.ready).toBe(true);
    const short = launchReadiness(
      aircraft(),
      { fuelKg: 10_000, payloadKg: 9000, origin: NEWQUAY },
      0,
    );
    expect(short.issues).toEqual([
      {
        code: 'payload',
        message:
          'AEGIS-TR-001 holds 0 kg of payload; the flight carries 9,000 kg. Loading 9,000 kg takes 10 min.',
      },
    ]);
    expect(short.prepareS).toBe(payloadDurationS(30, 0, 9000));
    // Fuel and payload are handled side by side: the longer of the two is how long it takes.
    const both = launchReadiness(
      aircraft(),
      { fuelKg: 22_000, payloadKg: 9000, origin: NEWQUAY },
      0,
    );
    expect(both.issues.map((issue) => issue.code)).toEqual(['fuel', 'payload']);
    expect(both.prepareS).toBe(
      Math.max(transferDurationS(CAPACITY, 10_000, 22_000), payloadDurationS(30, 0, 9000)),
    );
    const over = launchReadiness(
      aircraft({ payloadKg: 4000 }),
      { fuelKg: 10_000, payloadKg: 0, origin: NEWQUAY },
      0,
    );
    expect(over.issues[0]?.message).toMatch(/Taking 4,000 kg off takes \d+ min\./);
  });
});
