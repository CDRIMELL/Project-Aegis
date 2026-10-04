import { groupThousands } from '../math';
import type { PerformanceModel } from '../flight/performance';
import {
  evaluatePlan,
  type Constraint,
  type FlightLoad,
  type FlightPlan,
  type PlanEvaluation,
} from '../flight/plan';
import { forecastObjectives, type ObjectiveForecast } from './objectives';
import { assessRisk } from './risk';
import { MISSION_TEMPLATES } from './templates';
import type { MissionAssessment, MissionType, Objective, RiskAssessment } from './types';

/*
 * Mission validation (ADR 0017).
 *
 * A mission is checked by the flight planner first: its constraints are the plan's constraints,
 * plus the ones that only a mission has. Nothing a mission says can relax a flight constraint.
 */

/** Simulation rules the mission layer needs from the fleet. Supplied by the simulation. */
export interface MaintenancePolicy {
  readonly dueAfterFlightSeconds: number;
  readonly dueBelowConditionPct: number;
  /** Expected wear of a flight of the given length, in percentage points of condition. */
  readonly expectedWearPct: (durationS: number) => number;
}

/** What the mission layer needs to know about the aircraft assigned to a mission. */
export interface MissionAircraft {
  readonly id: string;
  readonly category: string;
  readonly performance: PerformanceModel | null;
  readonly conditionPct: number;
  readonly flightSecondsSinceMaintenance: number;
}

export interface MissionEvaluationInput {
  readonly type: MissionType;
  readonly aircraft: MissionAircraft | null;
  readonly plan: FlightPlan | null;
  readonly load: FlightLoad | null;
  readonly objectives: readonly Objective[];
  /** The tick the flight would depart: now, for a mission not yet launched. */
  readonly departureTick: number;
  readonly completeByTick: number | null;
  readonly maintenance: MaintenancePolicy;
  readonly stepS: number;
}

export interface MissionEvaluation {
  /** The flight planner's evaluation; `null` until there is an aircraft with a model and a plan. */
  readonly plan: PlanEvaluation | null;
  /** What the objectives will do if the plan is flown as it stands. */
  readonly forecast: ObjectiveForecast | null;
  /** Plan constraints first, then mission constraints. */
  readonly constraints: readonly Constraint[];
  readonly risk: RiskAssessment | null;
  /** True when nothing blocks the mission from being accepted and flown. */
  readonly acceptable: boolean;
}

export function evaluateMission(input: MissionEvaluationInput): MissionEvaluation {
  const template = MISSION_TEMPLATES[input.type];
  const mission: Constraint[] = [];
  const block = (code: string, message: string) =>
    mission.push({ severity: 'block', code, message });
  const warn = (code: string, message: string) =>
    mission.push({ severity: 'warning', code, message });
  const note = (code: string, message: string) => mission.push({ severity: 'note', code, message });

  const { aircraft, plan, load } = input;
  if (!aircraft) block('no_aircraft', 'No aircraft is assigned to the mission.');
  else if (!aircraft.performance) {
    block(
      'aircraft_cannot_fly',
      `${aircraft.id} has no performance model, so it cannot fly a mission.`,
    );
  }
  if (!plan || !load) block('no_route', 'The mission has no route yet.');
  if (input.objectives.length === 0) block('no_objectives', 'The mission has no objectives.');
  if (input.completeByTick !== null && input.completeByTick <= input.departureTick) {
    block('deadline_passed', "The mission's deadline has already passed.");
  }

  const model = aircraft?.performance ?? null;
  if (!aircraft || !model || !plan || !load) {
    return { plan: null, forecast: null, constraints: mission, risk: null, acceptable: false };
  }

  const planEvaluation = evaluatePlan(model, plan, load);

  for (const objective of input.objectives) {
    if (
      objective.spec.kind === 'deliver_payload' &&
      objective.required &&
      load.payloadKg + 0.5 < objective.spec.massKg
    ) {
      block(
        'payload_short',
        `The mission must deliver ${groupThousands(objective.spec.massKg)} kg; the load carries ${groupThousands(load.payloadKg)} kg.`,
      );
    }
  }

  if (!template.suitableCategories.includes(aircraft.category)) {
    warn(
      'aircraft_unsuitable',
      `This aircraft category is not one the ${template.label.toLowerCase()} template is meant for. It may fly the mission, at higher risk.`,
    );
  }

  const forecast = planEvaluation.estimate?.completes
    ? forecastObjectives({
        model,
        plan,
        load,
        objectives: input.objectives,
        departureTick: input.departureTick,
        conditionPct: aircraft.conditionPct,
        expectedWearPct: input.maintenance.expectedWearPct,
        stepS: input.stepS,
      })
    : null;

  if (forecast) {
    for (const objective of forecast.objectives) {
      if (objective.status !== 'failed') continue;
      const message =
        `As planned, "${objective.label}" will not be met. ${objective.remark ?? ''}`.trim();
      if (objective.required) warn('objective_will_fail', message);
      else note('optional_objective_will_fail', message);
    }
    const wear = input.maintenance.expectedWearPct(forecast.durationS);
    if (
      aircraft.flightSecondsSinceMaintenance + forecast.durationS >=
        input.maintenance.dueAfterFlightSeconds ||
      aircraft.conditionPct - wear < input.maintenance.dueBelowConditionPct
    ) {
      note('maintenance_due_after', 'The aircraft will be due maintenance after this flight.');
    }
  }

  let risk: RiskAssessment | null = null;
  if (planEvaluation.estimate) {
    // The time-limited objective, if the mission has one, and when the forecast meets it.
    const timed = input.objectives.find(
      (objective) =>
        objective.spec.kind === 'arrive_by' ||
        (objective.spec.kind === 'visit_point' && objective.spec.byTick !== null),
    );
    const deadlineTick =
      timed?.spec.kind === 'arrive_by' || timed?.spec.kind === 'visit_point'
        ? timed.spec.byTick
        : null;
    const met = timed && forecast?.objectives.find((objective) => objective.id === timed.id);
    risk = assessRisk({
      template,
      model,
      aircraftCategory: aircraft.category,
      conditionPct: aircraft.conditionPct,
      flightSecondsSinceMaintenance: aircraft.flightSecondsSinceMaintenance,
      estimate: planEvaluation.estimate,
      planConstraints: planEvaluation.constraints,
      departureTick: input.departureTick,
      deadlineTick,
      deadlineMetTick: met?.status === 'complete' ? (forecast?.decidedTick[met.id] ?? null) : null,
      maintenance: input.maintenance,
    });
  }

  const constraints = [...planEvaluation.constraints, ...mission];
  return {
    plan: planEvaluation,
    forecast,
    constraints,
    risk,
    acceptable: !constraints.some((constraint) => constraint.severity === 'block'),
  };
}

/** The figures recorded on a mission when it is accepted. `null` if it cannot be accepted. */
export function missionAssessment(
  evaluation: MissionEvaluation,
  tick: number,
): MissionAssessment | null {
  const estimate = evaluation.plan?.estimate;
  if (!evaluation.acceptable || !estimate || !evaluation.risk) return null;
  return {
    assessedTick: tick,
    distanceM: estimate.distanceM,
    durationS: estimate.durationS,
    fuelUsedKg: estimate.fuelUsedKg,
    fuelAtDestinationKg: estimate.fuelAtDestinationKg,
    risk: evaluation.risk,
  };
}
