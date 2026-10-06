import type { RoutePoint } from '../flight/route';
import { greatCircleDistance } from '../geo';
import { groupThousands } from '../math';
import {
  aerodromeCapability,
  aerodromeKey,
  resourcePoints,
  type AerodromeCapability,
  type ResourceKind,
} from './aerodrome';

/*
 * Ground servicing (ADR 0027, ADR 0028): what happens to an aircraft between landing and being
 * ready to fly again. Pure rules; the fleet holds the state and steps it.
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
  payload: {
    positionS: 5 * 60,
    statement:
      'Payload handling is assumed to take 5 minutes to position, then to move at the rate of the aerodrome. Payload is taken off at the same rate.',
  },
  /** A quantity aboard within this much of the quantity planned is the quantity planned. */
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

export const SERVICE_STAGES = ['checks', 'preparation'] as const;
/** Post-flight checks, then whatever fuel and payload were asked for. */
export type ServiceStage = (typeof SERVICE_STAGES)[number];

/** A quantity going on to, or coming off, an aircraft: fuel or payload. */
export interface Transfer {
  readonly startTick: number;
  /** When the quantity begins to move: after the time to connect or position. */
  readonly flowStartTick: number;
  readonly fromKg: number;
  readonly toKg: number;
  readonly rateKgS: number;
  readonly completeTick: number;
}
/** Kept for the name it had when only fuel was transferred. */
export type FuelTransfer = Transfer;

/** One thing a service has to do that needs a ground resource: fuel, or payload. */
export interface ServiceTask {
  readonly targetKg: number;
  /** When it began to wait for a point; `null` while it is still behind the checks. */
  readonly queuedTick: number | null;
  /** Its transfer, once it has a point. */
  readonly transfer: Transfer | null;
  /** When it first got a point; `null` before. */
  readonly startedTick: number | null;
  /** When it finished and gave the point up; `null` until then. */
  readonly completedTick: number | null;
}

/** The one record of an aircraft's ground servicing. It exists exactly while it is `servicing`. */
export interface GroundService {
  readonly reason: ServiceReason;
  readonly startedTick: number;
  readonly stage: ServiceStage;
  /** When the post-flight checks end. The tick it started, for a preparation: it has none. */
  readonly checksCompleteTick: number;
  /** What was aboard when the service began, to say afterwards what it moved. */
  readonly fuelAtStartKg: number;
  readonly payloadAtStartKg: number;
  /** The fuel to bring the aircraft to; `null` when it is to be left as it is. */
  readonly fuel: ServiceTask | null;
  readonly payload: ServiceTask | null;
  /** The mission the aircraft is being prepared for, when a mission asked for it. */
  readonly missionId: string | null;
}

/** The task of a service that uses a kind of resource. */
export function taskOf(service: GroundService, kind: ResourceKind): ServiceTask | null {
  return kind === 'fuel' ? service.fuel : service.payload;
}

/** True while a task holds a point: its transfer is running. */
export function holdsPoint(task: ServiceTask | null): boolean {
  return task !== null && task.transfer !== null && task.completedTick === null;
}

/** True while a task waits for a point at an aerodrome. */
export function awaitsPoint(task: ServiceTask | null): boolean {
  return task !== null && task.transfer === null && task.queuedTick !== null;
}

/** How long the checks after a flight of the given length take. */
export function postFlightChecksS(flightS: number): number {
  const { baseS, perFlightHourS, maxS } = GROUND_SERVICE.checks;
  return Math.min(baseS + Math.ceil((perFlightHourS * Math.max(flightS, 0)) / 3600), maxS);
}

/** The rate at which fuel is moved for a type with tanks of the given size. */
export function refuelRateKgS(fuelCapacityKg: number, rateFactor = 1): number {
  const { fullFillS, minRateKgS, maxRateKgS } = GROUND_SERVICE.refuel;
  return Math.min(Math.max(fuelCapacityKg / fullFillS, minRateKgS), maxRateKgS) * rateFactor;
}

/** True when the quantity aboard is not the quantity wanted. */
export function fuelDiffers(aboardKg: number, targetKg: number): boolean {
  return Math.abs(targetKg - aboardKg) > GROUND_SERVICE.fuelToleranceKg;
}

/** A transfer at a rate, beginning at `tick` after a lead time. */
export function startTransfer(
  rateKgS: number,
  leadS: number,
  tick: number,
  fromKg: number,
  toKg: number,
): Transfer {
  const flowStartTick = tick + leadS;
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
 * A fuel transfer from one quantity to another, beginning at `tick`. `connect` is false when
 * the aircraft is already connected.
 */
export function beginTransfer(
  fuelCapacityKg: number,
  tick: number,
  fromKg: number,
  toKg: number,
  connect = true,
  rateFactor = 1,
): Transfer {
  return startTransfer(
    refuelRateKgS(fuelCapacityKg, rateFactor),
    connect ? GROUND_SERVICE.refuel.connectS : 0,
    tick,
    fromKg,
    toKg,
  );
}

/**
 * A transfer under way given a new target. The aircraft stays connected, and a connection still
 * being made is not started again.
 */
export function retargetTransfer(
  transfer: Transfer,
  tick: number,
  aboardKg: number,
  toKg: number,
): Transfer {
  const flowStartTick = Math.max(transfer.flowStartTick, tick);
  return {
    startTick: tick,
    flowStartTick,
    fromKg: aboardKg,
    toKg,
    rateKgS: transfer.rateKgS,
    completeTick: flowStartTick + Math.ceil(Math.abs(toKg - aboardKg) / transfer.rateKgS),
  };
}

/** How long a fuel transfer between two quantities takes, connecting included. */
export function transferDurationS(
  fuelCapacityKg: number,
  fromKg: number,
  toKg: number,
  rateFactor = 1,
): number {
  return beginTransfer(fuelCapacityKg, 0, fromKg, toKg, true, rateFactor).completeTick;
}

/** How long handling a payload from one quantity to another takes, positioning included. */
export function payloadDurationS(payloadRateKgS: number, fromKg: number, toKg: number): number {
  return startTransfer(payloadRateKgS, GROUND_SERVICE.payload.positionS, 0, fromKg, toKg)
    .completeTick;
}

/**
 * The quantity aboard at a tick during a transfer. A function of the transfer and the tick alone,
 * so it is the same however the world got there, and it is exactly the target at completion.
 */
export function fuelDuringTransfer(transfer: Transfer, tick: number): number {
  if (tick >= transfer.completeTick) return transfer.toKg;
  const flowedS = Math.max(tick - transfer.flowStartTick, 0);
  const moved = transfer.rateKgS * flowedS;
  return transfer.toKg >= transfer.fromKg
    ? Math.min(transfer.fromKg + moved, transfer.toKg)
    : Math.max(transfer.fromKg - moved, transfer.toKg);
}

/** What an aircraft on the ground is, as far as servicing is concerned. */
export interface ServicedAircraft {
  readonly id: string;
  readonly location: RoutePoint | null;
  readonly fuelKg: number;
  readonly payloadKg: number;
  readonly service: GroundService | null;
  readonly performance: { readonly fuelCapacityKg: number } | null;
}

export const TASK_STATES = ['behind_checks', 'waiting', 'connecting', 'moving', 'done'] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** When one task of a service will get its point and when it will finish, as things stand. */
export interface TaskForecast {
  readonly kind: ResourceKind;
  readonly state: TaskState;
  readonly targetKg: number;
  /** Still to move, either way. */
  readonly remainingKg: number;
  /** True when the quantity is coming off. */
  readonly removing: boolean;
  readonly startTick: number;
  readonly completeTick: number;
  /** Place in the queue for a point, 1 being next; `null` when it is not waiting for one. */
  readonly position: number | null;
  /** The aircraft whose turn at the point comes immediately before; `null` when none does. */
  readonly behind: string | null;
}

/** When a service will be complete, and each of its tasks, as things stand. */
export interface ServiceForecast {
  readonly completeTick: number;
  readonly fuel: TaskForecast | null;
  readonly payload: TaskForecast | null;
}

/** How a kind of resource moves a quantity for an aircraft at an aerodrome. */
export function transferFor(
  kind: ResourceKind,
  capability: AerodromeCapability,
  fuelCapacityKg: number,
  tick: number,
  fromKg: number,
  toKg: number,
): Transfer {
  return kind === 'fuel'
    ? beginTransfer(fuelCapacityKg, tick, fromKg, toKg, true, capability.fuelRateFactor)
    : startTransfer(
        capability.payloadRateKgS,
        GROUND_SERVICE.payload.positionS,
        tick,
        fromKg,
        toKg,
      );
}

const aboard = (aircraft: ServicedAircraft, kind: ResourceKind) =>
  kind === 'fuel' ? aircraft.fuelKg : aircraft.payloadKg;

/**
 * For every aircraft being serviced, when each of its tasks will get a point and finish, and
 * where it stands in the queue (ADR 0028). Each aerodrome's queue is served here in the order the
 * simulation serves it: by when a task began to wait, then by aircraft identifier, each taking
 * the point that is free soonest. So what this says is what happens, unless something further is
 * asked of the aerodrome in the meantime.
 */
export function forecastGroundServices(
  aircraft: readonly ServicedAircraft[],
  tick: number,
): Map<string, ServiceForecast> {
  const tasks = new Map<string, Partial<Record<ResourceKind, TaskForecast>>>();
  const serviced = aircraft.filter((each) => each.service !== null && each.location !== null);
  const byAerodrome = new Map<string, ServicedAircraft[]>();
  for (const each of serviced) {
    const key = aerodromeKey(each.location as RoutePoint);
    byAerodrome.set(key, [...(byAerodrome.get(key) ?? []), each]);
  }

  for (const group of byAerodrome.values()) {
    const capability = aerodromeCapability((group[0] as ServicedAircraft).location);
    for (const kind of ['fuel', 'handling'] as const) {
      // When each point is next free, and whose turn at it ends then.
      const points: { freeTick: number; holder: string | null }[] = [];
      const waiting: { aircraft: ServicedAircraft; task: ServiceTask; eligibleTick: number }[] = [];
      const note = (id: string, forecast: TaskForecast) => {
        tasks.set(id, { ...tasks.get(id), [kind]: forecast });
      };
      for (const each of group) {
        const service = each.service as GroundService;
        const task = taskOf(service, kind);
        if (!task) continue;
        const now = aboard(each, kind);
        const base = {
          kind,
          targetKg: task.targetKg,
          remainingKg: Math.abs(task.targetKg - now),
          removing: task.targetKg < now,
          position: null,
          behind: null,
        };
        if (task.completedTick !== null) {
          note(each.id, {
            ...base,
            state: 'done',
            startTick: task.startedTick ?? task.completedTick,
            completeTick: task.completedTick,
          });
        } else if (task.transfer) {
          points.push({ freeTick: task.transfer.completeTick, holder: each.id });
          note(each.id, {
            ...base,
            state: tick < task.transfer.flowStartTick ? 'connecting' : 'moving',
            startTick: task.startedTick ?? task.transfer.startTick,
            completeTick: task.transfer.completeTick,
          });
        } else {
          waiting.push({
            aircraft: each,
            task,
            eligibleTick: task.queuedTick ?? service.checksCompleteTick,
          });
        }
      }
      while (points.length < resourcePoints(capability, kind)) {
        points.push({ freeTick: tick, holder: null });
      }
      waiting.sort(
        (a, b) =>
          a.eligibleTick - b.eligibleTick ||
          (a.aircraft.id < b.aircraft.id ? -1 : a.aircraft.id > b.aircraft.id ? 1 : 0),
      );
      let position = 0;
      for (const { aircraft: each, task, eligibleTick } of waiting) {
        const point = points.reduce((soonest, candidate) =>
          candidate.freeTick < soonest.freeTick ? candidate : soonest,
        );
        const now = aboard(each, kind);
        const startTick = Math.max(point.freeTick, eligibleTick, tick);
        const transfer = transferFor(
          kind,
          capability,
          each.performance?.fuelCapacityKg ?? 0,
          startTick,
          now,
          task.targetKg,
        );
        // Waiting on a point, as against simply not having got to the end of its checks.
        const held = point.freeTick > Math.max(eligibleTick, tick);
        if (held) position += 1;
        note(each.id, {
          kind,
          targetKg: task.targetKg,
          remainingKg: Math.abs(task.targetKg - now),
          removing: task.targetKg < now,
          state: task.queuedTick === null ? 'behind_checks' : 'waiting',
          startTick,
          completeTick: transfer.completeTick,
          position: held ? position : null,
          behind: held ? point.holder : null,
        });
        point.freeTick = transfer.completeTick;
        point.holder = each.id;
      }
    }
  }

  const forecasts = new Map<string, ServiceForecast>();
  for (const each of serviced) {
    const service = each.service as GroundService;
    const own = tasks.get(each.id) ?? {};
    const fuel = own.fuel ?? null;
    const payload = own.handling ?? null;
    forecasts.set(each.id, {
      completeTick: Math.max(
        service.checksCompleteTick,
        fuel?.completeTick ?? 0,
        payload?.completeTick ?? 0,
      ),
      fuel,
      payload,
    });
  }
  return forecasts;
}

/** The forecast for one aircraft among those at its aerodrome; `null` when it is not serviced. */
export function forecastService(
  aircraft: ServicedAircraft,
  others: readonly ServicedAircraft[],
  tick: number,
): ServiceForecast | null {
  if (!aircraft.service) return null;
  const all = others.some((each) => each.id === aircraft.id) ? others : [...others, aircraft];
  return forecastGroundServices(all, tick).get(aircraft.id) ?? null;
}

/** When a service will be complete, counting only the aircraft itself at its aerodrome. */
export function serviceCompleteTick(aircraft: ServicedAircraft, tick = 0): number {
  return forecastService(aircraft, [], tick)?.completeTick ?? tick;
}

/** A service as it stands at a tick, for display. Derived; never stored. */
export interface ServiceProgress {
  readonly reason: ServiceReason;
  readonly stage: ServiceStage;
  readonly startedTick: number;
  /** When the aircraft will be available, as things stand. */
  readonly completeTick: number;
  readonly remainingS: number;
  /** Share of the whole service done, 0 to 1. */
  readonly fraction: number;
  readonly checksRemainingS: number;
  readonly fuelKg: number;
  readonly payloadKg: number;
  readonly fuel: TaskForecast | null;
  readonly payload: TaskForecast | null;
  readonly missionId: string | null;
}

export function serviceProgress(
  aircraft: ServicedAircraft,
  tick: number,
  forecast: ServiceForecast | null = forecastService(aircraft, [], tick),
): ServiceProgress | null {
  const { service } = aircraft;
  if (!service || !forecast) return null;
  const span = Math.max(forecast.completeTick - service.startedTick, 1);
  return {
    reason: service.reason,
    stage: service.stage,
    startedTick: service.startedTick,
    completeTick: forecast.completeTick,
    remainingS: Math.max(forecast.completeTick - tick, 0),
    fraction: Math.min(Math.max((tick - service.startedTick) / span, 0), 1),
    checksRemainingS: Math.max(service.checksCompleteTick - tick, 0),
    fuelKg: aircraft.fuelKg,
    payloadKg: aircraft.payloadKg,
    fuel: forecast.fuel,
    payload: forecast.payload,
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
  'payload',
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
  /** How long bringing the fuel and payload asked for aboard would take, when that is missing. */
  readonly prepareS: number | null;
}

/** The aircraft as readiness needs to see it. */
export interface ReadinessSubject extends ServicedAircraft {
  readonly status: AircraftStatus;
  readonly performanceMissing: readonly string[];
}

/** What a launch asks of the aircraft. */
export interface LaunchRequirement {
  /** The fuel the plan departs with; `null` to ask only whether the aircraft can launch at all. */
  readonly fuelKg: number | null;
  /** The payload the plan carries; absent or `null` when that is not being asked. */
  readonly payloadKg?: number | null;
  /** Where the flight starts; `null` when that is not being asked. */
  readonly origin: RoutePoint | null;
}

const minutes = (seconds: number) => `${groupThousands(Math.ceil(seconds / 60))} min`;
const kg = (value: number) => `${groupThousands(Math.round(value))} kg`;

/** What an aircraft being serviced is doing, in words that finish "X is ...". */
export function serviceActivity(service: GroundService, forecast: ServiceForecast): string {
  if (service.stage === 'checks') {
    return service.reason === 'turnaround' ? 'in its post-flight checks' : 'being prepared';
  }
  const { fuel, payload } = forecast;
  const moving = (task: TaskForecast | null) =>
    task !== null && (task.state === 'connecting' || task.state === 'moving');
  if (moving(fuel)) return fuel?.removing ? 'having fuel taken off' : 'being refuelled';
  if (moving(payload)) return payload?.removing ? 'having payload taken off' : 'being loaded';
  const waiting = [fuel, payload].find((task) => task?.state === 'waiting');
  if (waiting) {
    const what = waiting.kind === 'fuel' ? 'a fuel point' : 'payload handling';
    return waiting.behind ? `waiting for ${what}, behind ${waiting.behind}` : `waiting for ${what}`;
  }
  return 'being prepared';
}

/**
 * The one rule for whether an aircraft can launch (ADR 0027). The simulation refuses a launch
 * with the first issue; the interface shows them all. `forecast` is the aircraft's place among
 * everything at its aerodrome; without it the aircraft is taken to be alone there.
 */
export function launchReadiness(
  aircraft: ReadinessSubject,
  requirement: LaunchRequirement,
  tick: number,
  forecast: ServiceForecast | null = forecastService(aircraft, [], tick),
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
  const { origin, fuelKg: fuelWanted } = requirement;
  const payloadWanted = requirement.payloadKg ?? null;
  if (origin && greatCircleDistance(aircraft.location, origin) >= 1000) {
    issue('elsewhere', `${id} is at ${aircraft.location.name}; the flight must start there.`);
  }

  // What the aircraft will hold when the servicing under way has finished.
  const fuelThen = service?.fuel?.targetKg ?? aircraft.fuelKg;
  const payloadThen = service?.payload?.targetKg ?? aircraft.payloadKg;
  const fuelWrong = fuelWanted !== null && fuelDiffers(fuelThen, fuelWanted);
  const payloadWrong = payloadWanted !== null && fuelDiffers(payloadThen, payloadWanted);
  const blocked = issues.length > 0;
  const holds = status === 'servicing' ? 'will hold' : 'holds';

  if (status === 'servicing' && service && forecast) {
    issue(
      'servicing',
      `${id} is ${serviceActivity(service, forecast)}. It will be available in ${minutes(Math.max(forecast.completeTick - tick, 0))}.`,
    );
    if (!blocked && !fuelWrong && !payloadWrong) readyTick = forecast.completeTick;
  }
  const capability = aerodromeCapability(aircraft.location);
  if (fuelWanted !== null && fuelWrong) {
    const takes = transferDurationS(
      aircraft.performance?.fuelCapacityKg ?? 0,
      fuelThen,
      fuelWanted,
      capability.fuelRateFactor || 1,
    );
    prepareS = takes;
    const difference = fuelWanted - fuelThen;
    issue(
      'fuel',
      difference > 0
        ? `${id} ${holds} ${kg(fuelThen)}; the flight departs with ${kg(fuelWanted)}. Loading ${kg(difference)} takes ${minutes(takes)}.`
        : `${id} ${holds} ${kg(fuelThen)}; the flight departs with ${kg(fuelWanted)}. Taking ${kg(-difference)} off takes ${minutes(takes)}.`,
    );
  }
  if (payloadWanted !== null && payloadWrong) {
    const takes = capability.servicing
      ? payloadDurationS(capability.payloadRateKgS, payloadThen, payloadWanted)
      : 0;
    // Fuel and payload are handled side by side: the longer of the two is how long it takes.
    prepareS = Math.max(prepareS ?? 0, takes);
    const difference = payloadWanted - payloadThen;
    issue(
      'payload',
      difference > 0
        ? `${id} ${holds} ${kg(payloadThen)} of payload; the flight carries ${kg(payloadWanted)}. Loading ${kg(difference)} takes ${minutes(takes)}.`
        : `${id} ${holds} ${kg(payloadThen)} of payload; the flight carries ${kg(payloadWanted)}. Taking ${kg(-difference)} off takes ${minutes(takes)}.`,
    );
  }
  return { ready: issues.length === 0, issues, readyTick, prepareS };
}
