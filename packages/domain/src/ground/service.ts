import type { RoutePoint } from '../flight/route';
import { greatCircleDistance } from '../geo';
import { groupThousands } from '../math';

/*
 * Ground servicing (ADR 0027): what happens to an aircraft between landing and being ready to
 * fly again. Pure rules; the fleet holds the state and steps it.
 *
 * Time is in simulation seconds, which are engine ticks. Nothing here reads a clock.
 */

/**
 * The simulation's assumptions about ground servicing. They are not reference data and are never
 * presented as such. Each has a plain-language statement for the interface and documentation.
 */
export const GROUND_SERVICE = {
  checks: {
    baseS: 15 * 60,
    perFlightHourS: 2 * 60,
    maxS: 45 * 60,
    statement:
      'Post-flight checks are assumed to take 15 minutes, plus 2 minutes for each hour just flown, and never more than 45 minutes.',
  },
  refuel: {
    connectS: 5 * 60,
    /** The time in which the supply fills a type's tanks from empty, before the bounds below. */
    fullFillS: 20 * 60,
    minRateKgS: 5,
    maxRateKgS: 40,
    statement:
      'Refuelling is assumed to take 5 minutes to connect, then to flow at a rate that would fill the tanks from empty in 20 minutes, no slower than 300 kg and no faster than 2,400 kg a minute. Fuel is taken off at the same rate.',
  },
  /** Fuel aboard within this much of the fuel planned is the fuel planned. */
  fuelToleranceKg: 0.5,
} as const;

/** Every state an aircraft can be in. Exactly one holds at a time. */
export const AIRCRAFT_STATUSES = [
  'available',
  'in_flight',
  'servicing',
  'maintenance_due',
  'in_maintenance',
  'unserviceable',
] as const;
export type AircraftStatus = (typeof AIRCRAFT_STATUSES)[number];

export const SERVICE_REASONS = ['turnaround', 'preparation'] as const;
/** Why an aircraft is being serviced: it has just landed, or it is being made ready to fly. */
export type ServiceReason = (typeof SERVICE_REASONS)[number];

export const SERVICE_STAGES = ['checks', 'refuelling'] as const;
export type ServiceStage = (typeof SERVICE_STAGES)[number];

/** Fuel going on to, or coming off, an aircraft. */
export interface FuelTransfer {
  readonly startTick: number;
  /** When fuel begins to move: after the time to connect. */
  readonly flowStartTick: number;
  readonly fromKg: number;
  readonly toKg: number;
  readonly rateKgS: number;
  readonly completeTick: number;
}

/** The one record of an aircraft's ground servicing. It exists exactly while it is `servicing`. */
export interface GroundService {
  readonly reason: ServiceReason;
  readonly startedTick: number;
  readonly stage: ServiceStage;
  /** When the post-flight checks end. The tick it started, for a preparation: it has none. */
  readonly checksCompleteTick: number;
  /** Fuel aboard when the service began, to say afterwards what it loaded. */
  readonly fuelAtStartKg: number;
  /** The fuel to bring the aircraft to; `null` when it is to be left as it is. */
  readonly targetFuelKg: number | null;
  /** The transfer under way. Present exactly in the `refuelling` stage. */
  readonly transfer: FuelTransfer | null;
  /** When the refuelling stage began; `null` before it has. */
  readonly refuellingSinceTick: number | null;
  /** The mission the aircraft is being prepared for, when a mission asked for it. */
  readonly missionId: string | null;
}

/** How long the checks after a flight of the given length take. */
export function postFlightChecksS(flightS: number): number {
  const { baseS, perFlightHourS, maxS } = GROUND_SERVICE.checks;
  return Math.min(baseS + Math.ceil((perFlightHourS * Math.max(flightS, 0)) / 3600), maxS);
}

/** The rate at which fuel is moved for a type with tanks of the given size. */
export function refuelRateKgS(fuelCapacityKg: number): number {
  const { fullFillS, minRateKgS, maxRateKgS } = GROUND_SERVICE.refuel;
  return Math.min(Math.max(fuelCapacityKg / fullFillS, minRateKgS), maxRateKgS);
}

/** True when the fuel aboard is not the fuel wanted. */
export function fuelDiffers(fuelKg: number, targetKg: number): boolean {
  return Math.abs(targetKg - fuelKg) > GROUND_SERVICE.fuelToleranceKg;
}

/**
 * A transfer from one quantity to another, beginning at `tick`. `connect` is false when the
 * aircraft is already connected, as when a transfer under way is given a new target.
 */
export function beginTransfer(
  fuelCapacityKg: number,
  tick: number,
  fromKg: number,
  toKg: number,
  connect = true,
): FuelTransfer {
  const rateKgS = refuelRateKgS(fuelCapacityKg);
  const flowStartTick = tick + (connect ? GROUND_SERVICE.refuel.connectS : 0);
  return {
    startTick: tick,
    flowStartTick,
    fromKg,
    toKg,
    rateKgS,
    completeTick: flowStartTick + Math.ceil(Math.abs(toKg - fromKg) / rateKgS),
  };
}

/**
 * A transfer under way given a new target. The aircraft stays connected, and a connection still
 * being made is not started again.
 */
export function retargetTransfer(
  transfer: FuelTransfer,
  tick: number,
  fuelNowKg: number,
  toKg: number,
): FuelTransfer {
  const flowStartTick = Math.max(transfer.flowStartTick, tick);
  return {
    startTick: tick,
    flowStartTick,
    fromKg: fuelNowKg,
    toKg,
    rateKgS: transfer.rateKgS,
    completeTick: flowStartTick + Math.ceil(Math.abs(toKg - fuelNowKg) / transfer.rateKgS),
  };
}

/** How long a transfer between two quantities takes, connecting included. */
export function transferDurationS(fuelCapacityKg: number, fromKg: number, toKg: number): number {
  return beginTransfer(fuelCapacityKg, 0, fromKg, toKg).completeTick;
}

/**
 * The fuel aboard at a tick during a transfer. A function of the transfer and the tick alone, so
 * it is the same however the world got there, and it is exactly the target at completion.
 */
export function fuelDuringTransfer(transfer: FuelTransfer, tick: number): number {
  if (tick >= transfer.completeTick) return transfer.toKg;
  const flowedS = Math.max(tick - transfer.flowStartTick, 0);
  const moved = transfer.rateKgS * flowedS;
  return transfer.toKg >= transfer.fromKg
    ? Math.min(transfer.fromKg + moved, transfer.toKg)
    : Math.max(transfer.fromKg - moved, transfer.toKg);
}

/** What an aircraft on the ground is, as far as servicing is concerned. */
export interface ServicedAircraft {
  readonly fuelKg: number;
  readonly service: GroundService | null;
  readonly performance: { readonly fuelCapacityKg: number } | null;
}

/** A service as it stands at a tick, for display. Derived; never stored. */
export interface ServiceProgress {
  readonly reason: ServiceReason;
  readonly stage: ServiceStage;
  /** True when the transfer under way takes fuel off. */
  readonly defuelling: boolean;
  readonly startedTick: number;
  /** When the aircraft will be available, as things stand. */
  readonly completeTick: number;
  readonly remainingS: number;
  /** Share of the whole service done, 0 to 1. */
  readonly fraction: number;
  readonly fuelKg: number;
  readonly targetFuelKg: number | null;
  /** Fuel still to move, either way. */
  readonly fuelRemainingKg: number;
  /** True in the time to connect, before fuel moves. */
  readonly connecting: boolean;
  readonly missionId: string | null;
}

/** When a service will be complete, as it stands. */
export function serviceCompleteTick(aircraft: ServicedAircraft, service: GroundService): number {
  if (service.transfer) return service.transfer.completeTick;
  const { targetFuelKg, checksCompleteTick } = service;
  if (targetFuelKg === null || !fuelDiffers(aircraft.fuelKg, targetFuelKg)) {
    return checksCompleteTick;
  }
  return beginTransfer(
    aircraft.performance?.fuelCapacityKg ?? 0,
    checksCompleteTick,
    aircraft.fuelKg,
    targetFuelKg,
  ).completeTick;
}

export function serviceProgress(aircraft: ServicedAircraft, tick: number): ServiceProgress | null {
  const { service } = aircraft;
  if (!service) return null;
  const completeTick = serviceCompleteTick(aircraft, service);
  const span = Math.max(completeTick - service.startedTick, 1);
  const target = service.targetFuelKg;
  return {
    reason: service.reason,
    stage: service.stage,
    defuelling: target !== null && target < aircraft.fuelKg,
    startedTick: service.startedTick,
    completeTick,
    remainingS: Math.max(completeTick - tick, 0),
    fraction: Math.min(Math.max((tick - service.startedTick) / span, 0), 1),
    fuelKg: aircraft.fuelKg,
    targetFuelKg: target,
    fuelRemainingKg: target === null ? 0 : Math.abs(target - aircraft.fuelKg),
    connecting: service.transfer !== null && tick < service.transfer.flowStartTick,
    missionId: service.missionId,
  };
}

export const READINESS_CODES = [
  'airborne',
  'servicing',
  'maintenance_due',
  'in_maintenance',
  'unserviceable',
  'no_model',
  'elsewhere',
  'fuel',
] as const;
export type ReadinessCode = (typeof READINESS_CODES)[number];

export interface ReadinessIssue {
  readonly code: ReadinessCode;
  readonly message: string;
}

/** Whether an aircraft can launch now, and if not, why. */
export interface Readiness {
  readonly ready: boolean;
  /** Everything in the way, most fundamental first. Empty exactly when `ready`. */
  readonly issues: readonly ReadinessIssue[];
  /**
   * When the servicing under way ends and leaves the aircraft ready for this launch; `null` when
   * it is ready already, or when something stands in the way that time alone will not remove.
   */
  readonly readyTick: number | null;
  /** How long loading the fuel asked for would take from now, when that is what is missing. */
  readonly prepareS: number | null;
}

/** The aircraft as readiness needs to see it. */
export interface ReadinessSubject extends ServicedAircraft {
  readonly id: string;
  readonly status: AircraftStatus;
  readonly location: RoutePoint | null;
  readonly performanceMissing: readonly string[];
}

/** What a launch asks of the aircraft. */
export interface LaunchRequirement {
  /** The fuel the plan departs with; `null` to ask only whether the aircraft can launch at all. */
  readonly fuelKg: number | null;
  /** Where the flight starts; `null` when that is not being asked. */
  readonly origin: RoutePoint | null;
}

const minutes = (seconds: number) => `${groupThousands(Math.ceil(seconds / 60))} min`;
const kg = (value: number) => `${groupThousands(Math.round(value))} kg`;

/**
 * The one rule for whether an aircraft can launch (ADR 0027). The simulation refuses a launch
 * with the first issue; the interface shows them all.
 */
export function launchReadiness(
  aircraft: ReadinessSubject,
  requirement: LaunchRequirement,
  tick: number,
): Readiness {
  const issues: ReadinessIssue[] = [];
  const issue = (code: ReadinessCode, message: string) => issues.push({ code, message });
  let readyTick: number | null = null;
  let prepareS: number | null = null;
  const { id, status, service } = aircraft;

  if (status === 'in_flight' || aircraft.location === null) {
    issue('airborne', `${id} is airborne; it cannot launch until it has landed.`);
    return { ready: false, issues, readyTick, prepareS };
  }
  if (!aircraft.performance) {
    issue(
      'no_model',
      `${id} cannot fly: the reference data lacks ${aircraft.performanceMissing.join(', ')}.`,
    );
  }
  if (status === 'maintenance_due') {
    issue('maintenance_due', `${id} is due maintenance and cannot launch until it is done.`);
  } else if (status === 'in_maintenance') {
    issue('in_maintenance', `${id} is in maintenance.`);
  } else if (status === 'unserviceable') {
    issue('unserviceable', `${id} is unserviceable and must be recovered by maintenance.`);
  }
  const { origin, fuelKg: required } = requirement;
  if (origin && greatCircleDistance(aircraft.location, origin) >= 1000) {
    issue('elsewhere', `${id} is at ${aircraft.location.name}; the flight must start there.`);
  }

  // What the aircraft will hold when the servicing under way has finished.
  const fuelWhenServiced =
    service?.targetFuelKg !== null && service?.targetFuelKg !== undefined
      ? service.targetFuelKg
      : aircraft.fuelKg;
  const fuelWillDiffer = required !== null && fuelDiffers(fuelWhenServiced, required);
  const blocked = issues.length > 0;

  if (status === 'servicing' && service) {
    const completeTick = serviceCompleteTick(aircraft, service);
    const what =
      service.stage === 'refuelling'
        ? service.transfer && service.transfer.toKg < service.transfer.fromKg
          ? 'having fuel taken off'
          : 'being refuelled'
        : service.reason === 'turnaround'
          ? 'in its post-flight checks'
          : 'being prepared';
    issue(
      'servicing',
      `${id} is ${what}. It will be available in ${minutes(Math.max(completeTick - tick, 0))}.`,
    );
    if (!blocked && !fuelWillDiffer) readyTick = completeTick;
  }
  if (required !== null && fuelWillDiffer) {
    const capacity = aircraft.performance?.fuelCapacityKg ?? 0;
    prepareS = transferDurationS(capacity, fuelWhenServiced, required);
    const difference = required - fuelWhenServiced;
    issue(
      'fuel',
      difference > 0
        ? `${id} ${status === 'servicing' ? 'will hold' : 'holds'} ${kg(fuelWhenServiced)}; the flight departs with ${kg(required)}. Loading ${kg(difference)} takes ${minutes(prepareS)}.`
        : `${id} ${status === 'servicing' ? 'will hold' : 'holds'} ${kg(fuelWhenServiced)}; the flight departs with ${kg(required)}. Taking ${kg(-difference)} off takes ${minutes(prepareS)}.`,
    );
  }
  return { ready: issues.length === 0, issues, readyTick, prepareS };
}
