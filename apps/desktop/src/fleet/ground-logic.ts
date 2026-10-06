import {
  AERODROME_CAPABILITY,
  GROUND_SERVICE,
  aerodromeCapability,
  aerodromeKey,
  awaitsPoint,
  forecastGroundServices,
  fuelDiffers,
  holdsPoint,
  launchReadiness,
  payloadDurationS,
  serviceActivity,
  serviceProgress,
  taskOf,
  transferDurationS,
  type AerodromeCapability,
  type Readiness,
  type ResourceKind,
  type RoutePoint,
  type ServiceForecast,
  type ServiceProgress,
  type TaskForecast,
} from '@aegis/domain';
import type { AircraftState } from '@aegis/sim';
import { formatDuration, formatInteger, formatKg } from '../format';

/*
 * How ground servicing is described and offered (ADR 0027, ADR 0028). Pure functions over what
 * the simulation publishes: whether an aircraft can launch is the domain's one rule, when a task
 * will get its point is the domain's one forecast, and progress is derived from the service
 * record and the tick. Nothing here decides anything.
 */

/** When every service in the fleet will end, and where each stands in its queue. */
export function groundForecasts(
  fleet: readonly AircraftState[],
  tick: number,
): Map<string, ServiceForecast> {
  return forecastGroundServices(fleet, tick);
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** What an aircraft on the ground is doing, in a few words: for badges and list rows. */
export function groundActivity(
  aircraft: AircraftState,
  forecast: ServiceForecast | null,
): string | null {
  const { service } = aircraft;
  if (!service || !forecast) return null;
  if (service.stage === 'checks') {
    return service.reason === 'turnaround' ? 'Post-flight checks' : 'Being prepared';
  }
  // "being refuelled" reads better as a heading as "Refuelling".
  const words = serviceActivity(service, forecast)
    .replace('being refuelled', 'refuelling')
    .replace('being loaded', 'loading payload')
    .replace('having fuel taken off', 'taking fuel off')
    .replace('having payload taken off', 'taking payload off');
  return sentence(words);
}

/** One task of a service, in words. */
export interface TaskLine {
  readonly kind: ResourceKind;
  /** "Fuel" or "Payload". */
  readonly label: string;
  /** The state in a word or two. */
  readonly state: string;
  /** What remains, and when it starts or ends. */
  readonly detail: string;
  /** True once the task needs nothing more. */
  readonly done: boolean;
}

function ordinal(position: number): string {
  if (position === 1) return 'next';
  if (position === 2) return 'second';
  if (position === 3) return 'third';
  return `${position}th`;
}

function taskLine(task: TaskForecast, tick: number): TaskLine {
  const label = task.kind === 'fuel' ? 'Fuel' : 'Payload';
  const point = task.kind === 'fuel' ? 'the fuel point' : 'payload handling';
  const left = `${formatKg(task.remainingKg)} to ${task.removing ? 'take off' : 'load'}`;
  const ends = `done in ${formatDuration(Math.max(task.completeTick - tick, 0))}`;
  const turn = `Its turn comes in ${formatDuration(Math.max(task.startTick - tick, 0))}`;
  const user = task.behind ? ` by ${task.behind}` : '';
  const line = (state: string, detail: string, done = false): TaskLine => ({
    kind: task.kind,
    label,
    state,
    detail,
    done,
  });
  switch (task.state) {
    case 'done':
      return line('Complete', `${formatKg(task.targetKg)} aboard`, true);
    case 'moving':
      return line(task.removing ? 'Coming off' : 'Loading', `${left}; ${ends}`);
    case 'connecting':
      return line(task.kind === 'fuel' ? 'Connecting' : 'Positioning', `${left}; ${ends}`);
    case 'waiting':
      return line(
        task.position === null ? 'Waiting' : `Waiting, ${ordinal(task.position)} in the queue`,
        `${sentence(point)} is in use${user}. ${turn}; ${left}, ${ends}.`,
      );
    case 'behind_checks':
      return line(
        'After the checks',
        task.position === null
          ? `${left}; ${ends}`
          : `${left}. ${sentence(point)} will be in use${user}. ${turn}; ${ends}.`,
      );
  }
}

export interface GroundServiceView {
  readonly progress: ServiceProgress;
  /** What it is doing, in a few words. */
  readonly activity: string;
  /** One sentence on what is happening and what follows. */
  readonly detail: string;
  /** Fuel and payload, where they were asked for. */
  readonly tasks: readonly TaskLine[];
  /** What the operator can stop, if anything, and what stopping does. */
  readonly stop: { readonly label: string; readonly hint: string } | null;
}

/**
 * An aircraft's ground service as it stands at a tick, among the rest of the fleet; `null` when
 * it is not being serviced.
 */
export function groundServiceView(
  aircraft: AircraftState,
  fleet: readonly AircraftState[],
  tick: number,
): GroundServiceView | null {
  const forecast = groundForecasts(fleet, tick).get(aircraft.id) ?? null;
  const progress = serviceProgress(aircraft, tick, forecast);
  const activity = groundActivity(aircraft, forecast);
  if (!progress || !activity) return null;
  const tasks = [progress.fuel, progress.payload]
    .filter((task): task is TaskForecast => task !== null)
    .map((task) => taskLine(task, tick));
  const open = tasks.filter((task) => !task.done);
  const available = `Available in ${formatDuration(progress.remainingS)}`;

  if (progress.stage === 'checks') {
    return {
      progress,
      activity,
      tasks,
      detail:
        open.length > 0
          ? `Checked after its flight, then prepared: ${open.map((task) => task.label.toLowerCase()).join(' and ')}. ${available}.`
          : `Checked after its flight. ${available}, with the fuel it landed with.`,
      stop:
        open.length > 0
          ? {
              label: 'Withdraw the request',
              hint: 'The checks go on; the aircraft is then available as it is.',
            }
          : null,
    };
  }
  const waiting = [progress.fuel, progress.payload].find((task) => task?.state === 'waiting');
  const what = waiting?.kind === 'fuel' ? 'fuel' : 'payload';
  const point = waiting?.kind === 'fuel' ? 'fuel point' : 'payload handling';
  return {
    progress,
    activity,
    tasks,
    detail: waiting
      ? `Nothing is being done about the ${what}: the aerodrome's ${point} is in use${waiting.behind ? ` by ${waiting.behind}` : ''}. ${available}.`
      : `${available}.`,
    stop: {
      label: 'Stop servicing',
      hint: 'Anything being moved stops where it is, anything waiting is given up, and the aircraft is available at once.',
    },
  };
}

/** Whether a target can be asked for, and what it would take. */
export interface ServiceRequest {
  readonly allowed: boolean;
  /** Why it cannot be asked for, or what asking would do. */
  readonly message: string;
  /** How long the work would take once it has its points; `null` when not allowed. */
  readonly durationS: number | null;
}

/** What asking for fuel and payload aboard would come to, for the control that asks. */
export function serviceRequest(
  aircraft: AircraftState,
  fuelKg: number,
  payloadKg: number,
): ServiceRequest {
  const model = aircraft.performance;
  const no = (message: string): ServiceRequest => ({ allowed: false, message, durationS: null });
  if (aircraft.location === null) return no('Airborne: it is serviced on the ground.');
  if (!model) return no('No performance model: it cannot be fuelled.');
  if (aircraft.status === 'maintenance_due' || aircraft.status === 'in_maintenance') {
    return no('Maintenance comes first: it is fuelled for a flight once that is done.');
  }
  if (aircraft.status === 'unserviceable') return no('Unserviceable: it cannot be serviced.');
  const capability = aerodromeCapability(aircraft.location);
  if (!capability.servicing) return no('Not at an aerodrome: nothing can be serviced here.');
  if (!Number.isFinite(fuelKg) || fuelKg < 0) return no('Fuel must be zero or more.');
  if (!Number.isFinite(payloadKg) || payloadKg < 0) return no('Payload must be zero or more.');
  if (fuelKg > model.fuelCapacityKg + GROUND_SERVICE.fuelToleranceKg) {
    return no(`The tanks hold ${formatKg(model.fuelCapacityKg)}.`);
  }
  if (payloadKg > model.maxPayloadKg + GROUND_SERVICE.fuelToleranceKg) {
    return no(`It carries at most ${formatKg(model.maxPayloadKg)}.`);
  }
  const fuelThen = aircraft.service?.fuel?.targetKg ?? aircraft.fuelKg;
  const payloadThen = aircraft.service?.payload?.targetKg ?? aircraft.payloadKg;
  if (!fuelDiffers(fuelThen, fuelKg) && !fuelDiffers(payloadThen, payloadKg)) {
    return no(
      aircraft.service
        ? 'That is what it is already being brought to.'
        : `It already holds ${formatKg(aircraft.fuelKg)} of fuel and ${formatKg(aircraft.payloadKg)} of payload.`,
    );
  }
  const parts: string[] = [];
  let durationS = 0;
  const part = (what: string, aboardKg: number, wantedKg: number, takes: number) => {
    durationS = Math.max(durationS, takes);
    const difference = wantedKg - aboardKg;
    parts.push(
      `${difference > 0 ? 'loads' : 'takes off'} ${formatInteger(Math.abs(difference))} kg of ${what} in about ${formatDuration(takes)}`,
    );
  };
  if (fuelDiffers(aircraft.fuelKg, fuelKg)) {
    part(
      'fuel',
      aircraft.fuelKg,
      fuelKg,
      transferDurationS(model.fuelCapacityKg, aircraft.fuelKg, fuelKg, capability.fuelRateFactor),
    );
  }
  if (fuelDiffers(aircraft.payloadKg, payloadKg)) {
    part(
      'payload',
      aircraft.payloadKg,
      payloadKg,
      payloadDurationS(capability.payloadRateKgS, aircraft.payloadKg, payloadKg),
    );
  }
  return {
    allowed: true,
    durationS,
    message: `${sentence(parts.join(' and '))}, once the aerodrome has a point free.`,
  };
}

/** What a launch asks of an aircraft: what it departs with and where it starts. */
export interface LaunchNeed {
  readonly fuelKg: number;
  readonly payloadKg: number;
  readonly origin: RoutePoint | null;
}

/** One line of what a launch is waiting for. */
export interface ReadinessLine {
  readonly label: string;
  readonly value: string;
  readonly ok: boolean;
}

export interface LaunchState {
  readonly readiness: Readiness;
  /** Every reason it cannot launch yet, in words. */
  readonly issues: readonly string[];
  /** When it will be ready with nothing more done, as a tick; `null` if it will not be. */
  readonly readyTick: number | null;
  /**
   * What to ask for so that it becomes ready, when fuel or payload is what is missing and the
   * aircraft can be serviced.
   */
  readonly prepare: { readonly fuelKg: number; readonly payloadKg: number } | null;
  /** How long that preparation would take once it has its points. */
  readonly prepareS: number | null;
  /** The aircraft, its fuel, its payload and the aerodrome, each in a line. */
  readonly lines: readonly ReadinessLine[];
}

const STANDING = [
  'airborne',
  'maintenance_due',
  'in_maintenance',
  'unserviceable',
  'no_model',
  'elsewhere',
];

/**
 * Whether an aircraft can launch a load now, as the simulation itself will decide it, and what
 * the operator can do about it if not. `fleet` is every aircraft, so that the queue at its
 * aerodrome is counted.
 */
export function launchState(
  aircraft: AircraftState | undefined,
  need: LaunchNeed,
  tick: number,
  fleet: readonly AircraftState[] = aircraft ? [aircraft] : [],
): LaunchState | null {
  if (!aircraft) return null;
  const forecast = groundForecasts(fleet, tick).get(aircraft.id) ?? null;
  const readiness = launchReadiness(aircraft, need, tick, forecast);
  const has = (code: string) => readiness.issues.some((issue) => issue.code === code);
  const serviceable =
    (aircraft.status === 'available' || aircraft.status === 'servicing') &&
    aircraft.performance !== null;

  const quantity = (
    label: string,
    aboardKg: number,
    wantedKg: number,
    task: TaskForecast | null,
  ): ReadinessLine => {
    if (task && task.state !== 'done' && !fuelDiffers(task.targetKg, wantedKg)) {
      const line = taskLine(task, tick);
      return { label, value: `${line.state}: ${line.detail}`, ok: false };
    }
    return fuelDiffers(task?.targetKg ?? aboardKg, wantedKg)
      ? { label, value: `${formatKg(aboardKg)} aboard; ${formatKg(wantedKg)} planned`, ok: false }
      : { label, value: `Complete: ${formatKg(wantedKg)} aboard`, ok: true };
  };
  const waiting = [forecast?.fuel, forecast?.payload].find((task) => task?.state === 'waiting');
  const standing = readiness.issues.find((issue) => STANDING.includes(issue.code));
  const checking = aircraft.service?.stage === 'checks' ? aircraft.service : null;
  const lines: ReadinessLine[] = [
    {
      label: 'Aircraft',
      value:
        standing?.message ??
        (checking
          ? `Post-flight checks: ${formatDuration(Math.max(checking.checksCompleteTick - tick, 0))} remaining`
          : 'Serviceable, and where the flight starts'),
      ok: !standing && !checking,
    },
    quantity('Fuel', aircraft.fuelKg, need.fuelKg, forecast?.fuel ?? null),
    quantity('Payload', aircraft.payloadKg, need.payloadKg, forecast?.payload ?? null),
    {
      label: 'Ground resource',
      value: waiting
        ? `${waiting.kind === 'fuel' ? 'Fuel point' : 'Payload handling'} in use${waiting.behind ? ` by ${waiting.behind}` : ''}`
        : 'Available',
      ok: !waiting,
    },
  ];
  const missing = has('fuel') || has('payload');
  return {
    readiness,
    issues: readiness.issues.map((issue) => issue.message),
    readyTick: readiness.readyTick,
    prepare: missing && serviceable ? { fuelKg: need.fuelKg, payloadKg: need.payloadKg } : null,
    prepareS: missing ? readiness.prepareS : null,
    lines,
  };
}

/** One kind of resource at an aerodrome, as it stands. */
export interface ResourceView {
  readonly kind: ResourceKind;
  readonly label: string;
  readonly points: number;
  /** Aircraft whose transfer is running, by identifier. */
  readonly inUseBy: readonly string[];
  /** Aircraft waiting for a point, in the order they will get one. */
  readonly waiting: readonly string[];
}

/** An aerodrome as a place where aircraft are serviced (ADR 0028). */
export interface AerodromeView {
  readonly capability: AerodromeCapability;
  /** The sourced size class, in words; says so when none is recorded. */
  readonly sizeLabel: string;
  readonly resources: readonly ResourceView[];
  /** Every simulated aircraft on the ground there, by identifier. */
  readonly aircraft: readonly AircraftState[];
  /** The assumption the figures come from, to show beside them. */
  readonly statement: string;
}

const SIZE_LABEL = {
  large: 'Large airport',
  medium: 'Medium airport',
  small: 'Small airport',
} as const;

/** What an aerodrome can do and what it is doing, from the aircraft that are there. */
export function aerodromeView(
  point: RoutePoint,
  fleet: readonly AircraftState[],
  tick: number,
): AerodromeView {
  const capability = aerodromeCapability(point);
  const key = aerodromeKey(point);
  const here = fleet
    .filter((aircraft) => aircraft.location !== null && aerodromeKey(aircraft.location) === key)
    .sort((a, b) => a.id.localeCompare(b.id));
  const forecasts = groundForecasts(fleet, tick);
  const turn = (aircraft: AircraftState, kind: ResourceKind) => {
    const forecast = forecasts.get(aircraft.id);
    return (kind === 'fuel' ? forecast?.fuel : forecast?.payload)?.startTick ?? 0;
  };
  const resource = (kind: ResourceKind, label: string, points: number): ResourceView => ({
    kind,
    label,
    points,
    inUseBy: here
      .filter((aircraft) => aircraft.service && holdsPoint(taskOf(aircraft.service, kind)))
      .map((aircraft) => aircraft.id),
    waiting: here
      .filter((aircraft) => aircraft.service && awaitsPoint(taskOf(aircraft.service, kind)))
      .sort((a, b) => turn(a, kind) - turn(b, kind) || a.id.localeCompare(b.id))
      .map((aircraft) => aircraft.id),
  });
  return {
    capability,
    sizeLabel: capability.size ? SIZE_LABEL[capability.size] : 'Size class not recorded',
    resources: capability.servicing
      ? [
          resource('fuel', 'Fuel points', capability.fuelPoints),
          resource('handling', 'Payload handling', capability.handlingPoints),
        ]
      : [],
    aircraft: here,
    statement: AERODROME_CAPABILITY.statement,
  };
}
