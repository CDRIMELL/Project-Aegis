import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RoutePoint } from '../flight/route';
import {
  AIRCRAFT_STATUSES,
  GROUND_SERVICE,
  beginTransfer,
  fuelDiffers,
  fuelDuringTransfer,
  launchReadiness,
  postFlightChecksS,
  refuelRateKgS,
  retargetTransfer,
  serviceCompleteTick,
  serviceProgress,
  transferDurationS,
  type AircraftStatus,
  type GroundService,
  type ReadinessSubject,
} from './service';

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
  targetFuelKg: null,
  transfer: null,
  refuellingSinceTick: null,
  missionId: null,
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
      service: turnaround({ targetFuelKg: 14_000 }),
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
    const wrong = aircraft({ status: 'servicing', service: turnaround({ targetFuelKg: 12_000 }) });
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
      service: turnaround({ targetFuelKg: 14_000 }),
    });
    const complete = 6200 + refuel.connectS + 200;
    expect(serviceCompleteTick(checking, checking.service as GroundService)).toBe(complete);
    expect(serviceProgress(checking, 5600)).toEqual({
      reason: 'turnaround',
      stage: 'checks',
      defuelling: false,
      startedTick: 5000,
      completeTick: complete,
      remainingS: complete - 5600,
      fraction: 600 / (complete - 5000),
      fuelKg: 10_000,
      targetFuelKg: 14_000,
      fuelRemainingKg: 4000,
      connecting: false,
      missionId: null,
    });

    const transfer = beginTransfer(CAPACITY, 6200, 10_000, 14_000);
    const fuelling = aircraft({
      status: 'servicing',
      fuelKg: fuelDuringTransfer(transfer, transfer.flowStartTick + 50),
      service: turnaround({
        stage: 'refuelling',
        targetFuelKg: 14_000,
        transfer,
        refuellingSinceTick: 6200,
        missionId: 'MSN-000004',
      }),
    });
    expect(serviceProgress(fuelling, 6210)).toMatchObject({
      stage: 'refuelling',
      connecting: true,
    });
    expect(serviceProgress(fuelling, transfer.flowStartTick + 50)).toMatchObject({
      stage: 'refuelling',
      connecting: false,
      fuelKg: 11_000,
      fuelRemainingKg: 3000,
      remainingS: 150,
      completeTick: complete,
      missionId: 'MSN-000004',
    });
    // Never outside 0 to 1, whatever tick is asked for.
    expect(serviceProgress(fuelling, 0)?.fraction).toBe(0);
    expect(serviceProgress(fuelling, 1_000_000)).toMatchObject({ fraction: 1, remainingS: 0 });
  });
});
