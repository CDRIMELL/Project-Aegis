import {
  assessFlightRisk,
  evaluateRevision,
  greatCircleDistance,
  projectFlight,
  remainingPoints,
  type Constraint,
  type FlightProjection,
  type FlightSituation,
  type Mission,
  type Objective,
  type PerformanceModel,
  type RevisionContext,
  type RevisionEvaluation,
  type RevisionIntent,
  type RiskAssessment,
  type RoutePoint,
} from '@aegis/domain';
import type { AbortLanding, AircraftState, FlightView } from '@aegis/sim';
import type { PlanDraft } from '../fleet/plan-edit';
import { formatInteger } from '../format';

/*
 * What the operator can do with a flight in the air, and what each choice would come to
 * (ADR 0026). Pure functions over the published view: the panels show what these return, and the
 * simulation decides for itself, with the same domain functions, when a command arrives.
 */

/** The name of the point a revision draft starts from: where the aircraft is. */
export const PRESENT_POSITION = 'Present position';

/**
 * A flight as the domain's projection and revision functions take it.
 *
 * A hold the operator ordered lasts until the operator ends it, which no projection can know. So
 * for the interface a flight holding by order is projected as if it were resumed now: "what
 * happens if I let it go on". A hold for a closed destination is the world's, and is projected
 * exactly as it will run.
 */
export function situationOf(flight: FlightView): FlightSituation {
  return {
    plan: {
      points: flight.points,
      cruiseAltitudeM: flight.cruiseAltitudeM,
      cruiseSpeedKmh: flight.cruiseSpeedKmh,
    },
    progress: flight.hold === 'operator' ? { ...flight.progress, hold: null } : flight.progress,
    payloadKg: flight.payloadKg,
    departedTick: flight.departedTick,
  };
}

export function presentPoint(flight: Pick<FlightView, 'lat' | 'lon'>): RoutePoint {
  return {
    kind: 'waypoint',
    name: PRESENT_POSITION,
    lat: flight.lat,
    lon: flight.lon,
    elevationM: 0,
  };
}

/** The points still to come on a flight's route, ending with its destination. */
export function remainderOf(flight: FlightView): RoutePoint[] {
  return remainingPoints(situationOf(flight).plan, flight.progress.distanceM);
}

/**
 * A draft of the rest of a flight, in the planner's own form: the present position, where a plan
 * has its origin, then the proposed remainder. The planner's editing functions and the map's
 * handles work on it unchanged, and leave its two ends alone as they do a plan's.
 */
export function revisionDraft(flight: FlightView, remainder: readonly RoutePoint[]): PlanDraft {
  return {
    aircraftId: flight.aircraftId,
    plan: {
      points: [presentPoint(flight), ...remainder],
      cruiseAltitudeM: flight.cruiseAltitudeM,
      cruiseSpeedKmh: flight.cruiseSpeedKmh,
    },
    load: { fuelKg: flight.fuelKg, payloadKg: flight.payloadKg },
  };
}

/** The remainder a draft proposes: everything after the present position. */
export function draftRemainder(draft: PlanDraft): RoutePoint[] {
  return draft.plan.points.slice(1);
}

/** Keeps a revision draft's first point on the aircraft as it flies on. */
export function followAircraft(
  draft: PlanDraft,
  flight: Pick<FlightView, 'lat' | 'lon'>,
): PlanDraft {
  const first = draft.plan.points[0];
  if (first?.name !== PRESENT_POSITION || (first.lat === flight.lat && first.lon === flight.lon)) {
    return draft;
  }
  return {
    ...draft,
    plan: { ...draft.plan, points: [presentPoint(flight), ...draft.plan.points.slice(1)] },
  };
}

export const OPERATIONS = ['reroute', 'divert', 'return', 'hold', 'resume', 'abort'] as const;
export type Operation = (typeof OPERATIONS)[number];

export const OPERATION_LABEL: Readonly<Record<Operation, string>> = {
  reroute: 'Reroute',
  divert: 'Divert',
  return: 'Return to base',
  hold: 'Hold',
  resume: 'Resume',
  abort: 'Abort mission',
};

export interface OperationState {
  readonly operation: Operation;
  readonly label: string;
  readonly available: boolean;
  /** Why it is not available, in words for the operator. `null` when it is. */
  readonly reason: string | null;
}

/**
 * The actions that mean something for a flight as it is now, each available or with the reason it
 * is not. An action that does not apply at all (resuming a flight that is not holding, aborting a
 * flight that carries no mission) is not offered.
 */
export function operationsFor(
  flight: FlightView,
  aircraft: Pick<AircraftState, 'performance'>,
  mission: Pick<Mission, 'id' | 'status'> | null,
): OperationState[] {
  const state = (operation: Operation, reason: string | null): OperationState => ({
    operation,
    label: OPERATION_LABEL[operation],
    available: reason === null,
    reason,
  });
  const rolling =
    flight.phase === 'takeoff'
      ? 'The aircraft is still on its take-off roll. Available once it is airborne.'
      : null;
  const origin = flight.points[0];
  const destination = flight.points.at(-1);
  const boundHome =
    origin && destination && greatCircleDistance(origin, destination) < 1000
      ? `The aircraft is already bound for ${origin.name}.`
      : null;
  const reserve = aircraft.performance?.reserveFuelKg ?? 0;

  const out: OperationState[] = [
    state('reroute', rolling),
    state('divert', rolling),
    state('return', rolling ?? boundHome),
  ];
  if (flight.hold === null) {
    out.push(
      state(
        'hold',
        rolling ??
          (flight.phase === 'descent'
            ? 'The aircraft is descending to land. Divert it if it must not land there.'
            : flight.fuelKg <= reserve
              ? 'There is no fuel to hold with: it is down to its reserve.'
              : null),
      ),
    );
  } else {
    out.push(
      state(
        'resume',
        flight.hold === 'closure'
          ? `Holding because ${destination?.name ?? 'the destination'} is closed. It goes on when the aerodrome reopens; divert to land elsewhere.`
          : null,
      ),
    );
  }
  if (mission?.status === 'active') out.push(state('abort', null));
  return out;
}

export interface OptionEstimate {
  readonly projection: FlightProjection;
  readonly risk: RiskAssessment;
}

function estimateOf(model: PerformanceModel, projection: FlightProjection): OptionEstimate {
  return {
    projection,
    risk: assessFlightRisk({
      model,
      completes: projection.completes,
      landingFuelKg: projection.landingFuelKg,
      worstSeverity: projection.worstSeverity,
      arrivalVisibilityKm: projection.arrival.visibilityKm,
      disruptions: projection.disruptions,
      holdS: projection.holdS,
      landsDuringClosure: projection.landsDuringClosure,
      destinationName: projection.destination.name,
    }),
  };
}

/** The flight as it stands: what happens if nothing is changed. */
export function currentEstimate(
  model: PerformanceModel,
  flight: FlightView,
  context: RevisionContext,
): OptionEstimate {
  return estimateOf(model, projectFlight(model, situationOf(flight), context));
}

export interface ProposalEstimate {
  readonly evaluation: RevisionEvaluation;
  /** `null` when the proposal cannot be flown at all. */
  readonly estimate: OptionEstimate | null;
  readonly blocks: readonly Constraint[];
}

/** A proposed remainder: whether it can be flown, and what it would come to. */
export function proposalEstimate(
  model: PerformanceModel,
  flight: FlightView,
  remainder: readonly RoutePoint[],
  context: RevisionContext,
): ProposalEstimate {
  const evaluation = evaluateRevision(model, situationOf(flight), remainder, context);
  return {
    evaluation,
    estimate: evaluation.projection ? estimateOf(model, evaluation.projection) : null,
    blocks: evaluation.constraints.filter((constraint) => constraint.severity === 'block'),
  };
}

export interface DiversionCandidate {
  readonly place: RoutePoint;
  readonly distanceM: number;
  readonly flyable: boolean;
  /** `null` when the place cannot be reached or descended to. */
  readonly estimate: OptionEstimate | null;
  /** The first thing to know about it: why it cannot be used, or what to expect. */
  readonly note: string | null;
}

/**
 * Aerodromes a flight could divert to, most useful first: those that can be reached, by the fuel
 * they would be landed at; then those that cannot, nearest first, each with the reason.
 */
export function rankCandidates(
  model: PerformanceModel,
  flight: FlightView,
  places: readonly RoutePoint[],
  context: RevisionContext,
  limit = 8,
): DiversionCandidate[] {
  const here = { lat: flight.lat, lon: flight.lon };
  const destination = flight.points.at(-1);
  const candidates = places
    .filter((place) => !destination || greatCircleDistance(place, destination) >= 1000)
    .map((place) => ({ place, distanceM: greatCircleDistance(here, place) }))
    // Nearest first, and a stable order where distances tie.
    .sort((a, b) => a.distanceM - b.distanceM || (a.place.name < b.place.name ? -1 : 1))
    .slice(0, limit * 3)
    .map(({ place, distanceM }): DiversionCandidate => {
      const { evaluation, estimate, blocks } = proposalEstimate(model, flight, [place], context);
      const warning = evaluation.constraints.find(
        (constraint) => constraint.severity === 'warning',
      );
      return {
        place,
        distanceM,
        flyable: evaluation.flyable,
        estimate: evaluation.flyable ? estimate : null,
        note: blocks[0]?.message ?? warning?.message ?? null,
      };
    });
  const usable = candidates
    .filter((candidate) => candidate.flyable)
    .sort(
      (a, b) =>
        (b.estimate?.projection.landingFuelKg ?? 0) - (a.estimate?.projection.landingFuelKg ?? 0) ||
        a.distanceM - b.distanceM,
    );
  const unusable = candidates.filter((candidate) => !candidate.flyable);
  return [...usable, ...unusable].slice(0, limit);
}

export interface ObjectiveEffect {
  readonly objective: Objective;
  /** What the choice does to it, in words. */
  readonly effect: string;
}

const DESTINATION_KINDS: ReadonlySet<string> = new Set([
  'complete_flight',
  'deliver_payload',
  'arrive_by',
]);

/**
 * The objectives of a flight's mission that a choice would decide. An objective already complete
 * or failed is not listed: nothing changes it.
 */
export function objectivesAffected(
  mission: Pick<Mission, 'objectives' | 'plan'> | null,
  landing: RoutePoint | null,
  aborting: boolean,
): ObjectiveEffect[] {
  if (!mission?.plan) return [];
  const pending = mission.objectives.filter((objective) => objective.status === 'pending');
  if (aborting) {
    return pending.map((objective) => ({ objective, effect: 'Fails: the mission is aborted.' }));
  }
  if (!landing) return [];
  const planned = mission.plan.points.at(-1);
  const origin = mission.plan.points[0];
  const elsewhere = planned !== undefined && greatCircleDistance(landing, planned) >= 1000;
  const effects: ObjectiveEffect[] = [];
  for (const objective of pending) {
    const { kind } = objective.spec;
    if (DESTINATION_KINDS.has(kind) && elsewhere) {
      effects.push({
        objective,
        effect: `Fails: lands at ${landing.name}, not at ${planned.name}.`,
      });
    } else if (
      kind === 'return_to_base' &&
      origin &&
      greatCircleDistance(landing, origin) >= 1000
    ) {
      effects.push({
        objective,
        effect: `Fails: lands at ${landing.name}, not at ${origin.name}.`,
      });
    } else if (kind === 'visit_point' || kind === 'remain_in_area') {
      effects.push({
        objective,
        effect:
          'Met only if the new route still passes it. It fails otherwise when the flight lands.',
      });
    }
  }
  return effects;
}

export interface Advisory {
  readonly tone: 'info' | 'warn' | 'critical';
  readonly title: string;
  readonly detail: string;
}

/**
 * What the operator should know about a flight as it stands. Each is read from the flight's own
 * state and its projection; none is a recommendation.
 */
export function advisoriesFor(
  flight: FlightView,
  model: PerformanceModel,
  projection: FlightProjection,
): Advisory[] {
  const destination = projection.destination.name;
  const minutes = (seconds: number) => `${Math.max(1, Math.round(seconds / 60))} min`;
  const out: Advisory[] = [];
  if (!projection.completes) {
    out.push({
      tone: 'critical',
      title: 'Fuel will not reach the destination',
      detail: `As it stands the fuel on board runs out ${Math.round(projection.shortM / 1000)} km short of ${destination}. Divert somewhere nearer.`,
    });
  }
  if (flight.hold === 'closure') {
    out.push({
      tone: 'warn',
      title: `Holding: ${destination} is closed`,
      detail: projection.landsDuringClosure
        ? `It will still be closed when fuel is down to reserve, in about ${minutes(projection.holdS)}. The aircraft will then land regardless, and be inspected before it flies again. It can be diverted now.`
        : `It reopens in about ${minutes(projection.holdS)}, and the aircraft will then land with ${formatInteger(projection.landingFuelKg)} kg. It can wait, or be diverted.`,
    });
  } else if (flight.closureLanding) {
    out.push({
      tone: 'warn',
      title: `Landing at ${destination} during its closure`,
      detail: 'Fuel is down to reserve. The aircraft will be inspected before it flies again.',
    });
  } else if (projection.landsDuringClosure || projection.holdS > 0) {
    out.push({
      tone: 'warn',
      title: `${destination} will be closed on arrival`,
      detail: projection.landsDuringClosure
        ? `The aircraft would hold short of it for ${minutes(projection.holdS)} and then land during the closure with its fuel at reserve. It can be diverted.`
        : `The aircraft would hold short of it for ${minutes(projection.holdS)} until it reopens. It can go on, or be diverted.`,
    });
  }
  if (flight.hold === 'operator') {
    out.push({
      tone: 'info',
      title: 'Holding on your order',
      detail: projection.completes
        ? `Held for ${minutes(flight.heldS)} so far. Resumed now, the aircraft would land with ${formatInteger(projection.landingFuelKg)} kg. The hold ends when you resume, change the route, or fuel is down to reserve.`
        : `Held for ${minutes(flight.heldS)} so far. The hold ends when you resume, change the route, or fuel is down to reserve.`,
    });
  }
  if (
    projection.completes &&
    !projection.landsDuringClosure &&
    projection.landingFuelKg < model.reserveFuelKg
  ) {
    out.push({
      tone: 'warn',
      title: 'Landing below reserve fuel',
      detail: `As it stands the aircraft lands with ${formatInteger(projection.landingFuelKg)} kg against a reserve of ${formatInteger(model.reserveFuelKg)} kg.`,
    });
  }
  if (projection.disruptions.length > 0) {
    out.push({
      tone: 'info',
      title: 'Disrupted area on the route ahead',
      detail: `${projection.disruptions.map((disruption) => disruption.eventId).join(', ')}. The route can be changed to avoid it.`,
    });
  }
  if (flight.caution) {
    out.push({
      tone: 'warn',
      title: 'Technical caution',
      detail: `${flight.caution.eventId}. The aircraft can go on; it wears faster for as long as it flies, and is due maintenance when it lands. Landing sooner costs less condition.`,
    });
  }
  return out;
}

/** The landing part of an abort command for a chosen remainder; `null` remainder means go on. */
export function abortLanding(
  intent: RevisionIntent | 'continue',
  remainder: readonly RoutePoint[],
): AbortLanding {
  return intent === 'continue' || intent === 'reroute'
    ? { intent: 'continue' }
    : { intent, points: remainder };
}
