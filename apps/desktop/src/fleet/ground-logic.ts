import {
  GROUND_SERVICE,
  fuelDiffers,
  launchReadiness,
  serviceProgress,
  transferDurationS,
  type Readiness,
  type RoutePoint,
  type ServiceProgress,
} from '@aegis/domain';
import type { AircraftState } from '@aegis/sim';
import { formatDuration, formatInteger, formatKg } from '../format';

/*
 * How ground servicing is described and offered (ADR 0027). Pure functions over what the
 * simulation publishes: whether an aircraft can launch is the domain's one rule, and progress is
 * derived from the service record and the tick. Nothing here decides anything.
 */

/** What an aircraft on the ground is doing, in a few words: for badges and list rows. */
export function groundActivity(aircraft: AircraftState): string | null {
  const { service } = aircraft;
  if (!service) return null;
  if (service.stage === 'checks') {
    return service.reason === 'turnaround' ? 'Post-flight checks' : 'Being prepared';
  }
  const transfer = service.transfer;
  return transfer && transfer.toKg < transfer.fromKg ? 'Taking fuel off' : 'Refuelling';
}

export interface GroundServiceView {
  readonly progress: ServiceProgress;
  /** The stage in a few words. */
  readonly activity: string;
  /** One sentence on what is happening and what follows. */
  readonly detail: string;
  /** What the operator can stop, if anything, and what stopping does. */
  readonly stop: { readonly label: string; readonly hint: string } | null;
}

/** An aircraft's ground service as it stands at a tick; `null` when it is not being serviced. */
export function groundServiceView(aircraft: AircraftState, tick: number): GroundServiceView | null {
  const progress = serviceProgress(aircraft, tick);
  const activity = groundActivity(aircraft);
  if (!progress || !activity) return null;
  const target = progress.targetFuelKg;
  /** The fuel still to be reached, when there is some. */
  const wantedKg = target !== null && fuelDiffers(progress.fuelKg, target) ? target : null;

  if (progress.stage === 'checks') {
    return {
      progress,
      activity,
      detail:
        wantedKg !== null
          ? `Checked after its flight, then ${wantedKg < progress.fuelKg ? 'fuel is taken off' : 'fuelled'} to ${formatKg(wantedKg)}. Available in ${formatDuration(progress.remainingS)}.`
          : `Checked after its flight. Available in ${formatDuration(progress.remainingS)}, with the fuel it landed with.`,
      stop:
        wantedKg !== null
          ? {
              label: 'Withdraw the fuel request',
              hint: 'The checks go on; the aircraft is then available with the fuel it has.',
            }
          : null,
    };
  }
  return {
    progress,
    activity,
    detail: progress.connecting
      ? `Connecting. ${formatKg(progress.fuelRemainingKg)} to ${progress.defuelling ? 'take off' : 'load'}; available in ${formatDuration(progress.remainingS)}.`
      : `${formatKg(progress.fuelRemainingKg)} still to ${progress.defuelling ? 'take off' : 'load'}. Available in ${formatDuration(progress.remainingS)}.`,
    stop: {
      label: progress.defuelling ? 'Stop taking fuel off' : 'Stop refuelling',
      hint: 'The aircraft is available at once, with the fuel it then holds.',
    },
  };
}

/** Whether a fuel target can be asked for, and what it would take. */
export interface FuelRequest {
  readonly allowed: boolean;
  /** Why it cannot be asked for, or what asking would do. */
  readonly message: string;
  /** How long the transfer would take from where the fuel will stand; `null` when not allowed. */
  readonly durationS: number | null;
}

/** What asking for `fuelKg` aboard would come to, for the control that asks. */
export function fuelRequest(aircraft: AircraftState, fuelKg: number): FuelRequest {
  const model = aircraft.performance;
  const no = (message: string): FuelRequest => ({ allowed: false, message, durationS: null });
  if (aircraft.location === null) return no('Airborne: it is fuelled on the ground.');
  if (!model) return no('No performance model: it cannot be fuelled.');
  if (aircraft.status === 'maintenance_due' || aircraft.status === 'in_maintenance') {
    return no('Maintenance comes first: it is fuelled for a flight once that is done.');
  }
  if (aircraft.status === 'unserviceable') return no('Unserviceable: it cannot be serviced.');
  if (!Number.isFinite(fuelKg) || fuelKg < 0) return no('Fuel must be zero or more.');
  if (fuelKg > model.fuelCapacityKg + GROUND_SERVICE.fuelToleranceKg) {
    return no(`The tanks hold ${formatKg(model.fuelCapacityKg)}.`);
  }
  const from = aircraft.fuelKg;
  if (!fuelDiffers(from, fuelKg) && aircraft.service?.targetFuelKg !== fuelKg) {
    return no(`It already holds ${formatKg(from)}.`);
  }
  if (aircraft.service?.targetFuelKg === fuelKg) {
    return no(`It is already being brought to ${formatKg(fuelKg)}.`);
  }
  const durationS = transferDurationS(model.fuelCapacityKg, from, fuelKg);
  const difference = fuelKg - from;
  return {
    allowed: true,
    durationS,
    message:
      difference >= 0
        ? `Loads ${formatInteger(difference)} kg in about ${formatDuration(durationS)}.`
        : `Takes ${formatInteger(-difference)} kg off in about ${formatDuration(durationS)}.`,
  };
}

/** What a launch asks of an aircraft: the fuel it departs with and where it starts. */
export interface LaunchNeed {
  readonly fuelKg: number;
  readonly origin: RoutePoint | null;
}

export interface LaunchState {
  readonly readiness: Readiness;
  /** Every reason it cannot launch yet, in words. */
  readonly issues: readonly string[];
  /** When it will be ready with nothing more done, as a tick; `null` if it will not be. */
  readonly readyTick: number | null;
  /**
   * The fuel to ask for so that it becomes ready, when fuel is what is missing and nothing
   * else stands in the way that fuelling cannot wait behind.
   */
  readonly prepareFuelKg: number | null;
  /** How long that preparation would take from when it can begin. */
  readonly prepareS: number | null;
}

/**
 * Whether an aircraft can launch a load now, as the simulation itself will decide it, and what
 * the operator can do about it if not.
 */
export function launchState(
  aircraft: AircraftState | undefined,
  need: LaunchNeed,
  tick: number,
): LaunchState | null {
  if (!aircraft) return null;
  const readiness = launchReadiness(aircraft, need, tick);
  const fuel = readiness.issues.some((issue) => issue.code === 'fuel');
  const fuellable = aircraft.status === 'available' || aircraft.status === 'servicing';
  return {
    readiness,
    issues: readiness.issues.map((issue) => issue.message),
    readyTick: readiness.readyTick,
    prepareFuelKg: fuel && fuellable && aircraft.performance ? need.fuelKg : null,
    prepareS: fuel ? readiness.prepareS : null,
  };
}
