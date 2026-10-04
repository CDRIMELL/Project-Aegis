import { groupThousands } from '../math';
import type { PerformanceModel } from '../flight/performance';
import type { Constraint, PlanEstimate } from '../flight/plan';
import type { MissionTemplate } from './templates';
import type { RiskAssessment, RiskContributor } from './types';

/*
 * Mission risk (ADR 0017).
 *
 * An index from 0 to 100 built from named contributors, each of which says why it has the value
 * it has. It explains a plan; it never decides an outcome. It is a simulation index and says
 * nothing about real-world operational risk.
 */

/** How much each factor counts. Simulation assumptions, not reference data. */
export const RISK_WEIGHTS = {
  fuel_margin: 3,
  range_use: 2,
  aircraft_condition: 2,
  maintenance_margin: 1,
  time_pressure: 2,
  aircraft_suitability: 2,
  unchecked_limits: 1,
  wind: 2,
  weather_severity: 2,
  visibility: 1,
  precipitation: 1,
  temperature: 1,
  events: 2,
} as const;
export type RiskFactor = keyof typeof RISK_WEIGHTS;

const LABELS: Readonly<Record<RiskFactor, string>> = {
  fuel_margin: 'Fuel margin',
  range_use: 'Distance against range',
  aircraft_condition: 'Aircraft condition',
  maintenance_margin: 'Hours before maintenance',
  time_pressure: 'Time pressure',
  aircraft_suitability: 'Aircraft suitability',
  unchecked_limits: 'Limits that could not be checked',
  wind: 'Wind',
  weather_severity: 'Weather on the route',
  visibility: 'Visibility on arrival',
  precipitation: 'Precipitation',
  temperature: 'Temperature',
  events: 'Events on the route',
};

/** Plan constraints meaning the reference data could not confirm a limit. */
const UNCHECKED_CODES: ReadonlySet<string> = new Set(['ceiling_unknown', 'speed_unchecked']);

export interface RiskInput {
  readonly template: MissionTemplate;
  readonly model: PerformanceModel;
  readonly aircraftCategory: string;
  readonly conditionPct: number;
  readonly flightSecondsSinceMaintenance: number;
  readonly estimate: PlanEstimate;
  readonly planConstraints: readonly Constraint[];
  /** The tick the flight would depart. */
  readonly departureTick: number;
  /** The tick the mission's time-limited objective must be met by; `null` if it has none. */
  readonly deadlineTick: number | null;
  /** The tick at which the forecast meets that objective; `null` if the forecast never does. */
  readonly deadlineMetTick: number | null;
  readonly maintenance: {
    readonly dueAfterFlightSeconds: number;
    readonly dueBelowConditionPct: number;
  };
}

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);
const kg = (value: number) => `${groupThousands(value)} kg`;
const km = (metres: number) => `${groupThousands(metres / 1000)} km`;
const hours = (seconds: number) => `${(seconds / 3600).toFixed(1)} h`;
const minutes = (seconds: number) => `${Math.round(seconds / 60)} min`;

export function assessRisk(input: RiskInput): RiskAssessment {
  const { model, estimate, maintenance } = input;
  const factors: { id: RiskFactor; value: number; explanation: string }[] = [];
  const add = (id: RiskFactor, value: number, explanation: string) =>
    factors.push({ id, value: clamp01(value), explanation });

  // Fuel margin: none when landing with the reserve or more, full when landing empty.
  if (!estimate.completes) {
    add('fuel_margin', 1, 'The fuel on board runs out before the destination.');
  } else {
    const ratio = model.reserveFuelKg > 0 ? estimate.fuelAtDestinationKg / model.reserveFuelKg : 1;
    add(
      'fuel_margin',
      1 - ratio,
      `Lands with ${kg(estimate.fuelAtDestinationKg)} against a reserve of ${kg(model.reserveFuelKg)}.`,
    );
  }

  // Range use: none up to half the type's published range, full at all of it.
  const rangeM = model.referenceRangeKm * 1000;
  add(
    'range_use',
    (estimate.distanceM / rangeM - 0.5) / 0.5,
    `The route is ${km(estimate.distanceM)}, ${Math.round((estimate.distanceM / rangeM) * 100)} % of the type's published ${model.referenceRangeKind === 'range' ? 'range' : 'ferry range'}.`,
  );

  // Condition: none at 90 % or better, full at the maintenance threshold.
  add(
    'aircraft_condition',
    (90 - input.conditionPct) / (90 - maintenance.dueBelowConditionPct),
    `Aircraft condition is ${input.conditionPct.toFixed(1)} %; maintenance falls due below ${maintenance.dueBelowConditionPct} %.`,
  );

  // Maintenance margin: none while the flight uses under half the hours left, full when it uses them all.
  const leftS = Math.max(
    maintenance.dueAfterFlightSeconds - input.flightSecondsSinceMaintenance,
    0,
  );
  add(
    'maintenance_margin',
    leftS === 0 ? 1 : (estimate.durationS / leftS - 0.5) / 0.5,
    `The flight takes ${hours(estimate.durationS)}; ${hours(leftS)} of flying remain before maintenance is due.`,
  );

  // Time pressure: none with slack of half the time needed, full with no slack.
  if (input.deadlineTick === null) {
    add('time_pressure', 0, 'The mission has no deadline.');
  } else if (input.deadlineMetTick === null) {
    add('time_pressure', 1, 'The planned flight does not meet the deadline.');
  } else {
    const neededS = Math.max(input.deadlineMetTick - input.departureTick, 1);
    const slackS = input.deadlineTick - input.deadlineMetTick;
    add(
      'time_pressure',
      1 - slackS / (neededS * 0.5),
      `Launching now meets the deadline with ${minutes(Math.max(slackS, 0))} to spare, after ${minutes(neededS)} of flying.`,
    );
  }

  const suitable = input.template.suitableCategories.includes(input.aircraftCategory);
  add(
    'aircraft_suitability',
    suitable ? 0 : 1,
    suitable
      ? `This aircraft category suits a ${input.template.label.toLowerCase()} mission.`
      : `This aircraft category is not one the ${input.template.label.toLowerCase()} template is meant for.`,
  );

  const unchecked = input.planConstraints.filter((c) => UNCHECKED_CODES.has(c.code)).length;
  add(
    'unchecked_limits',
    unchecked / 2,
    unchecked === 0
      ? 'Every limit the plan depends on is in the reference data.'
      : `${unchecked} limit${unchecked === 1 ? '' : 's'} could not be checked because the reference data does not give ${unchecked === 1 ? 'it' : 'them'}.`,
  );

  // The environment. In still air, with no events, these all contribute nothing.
  const weather = estimate.weather;
  if (!weather) {
    add('wind', 0, 'Evaluated in still air.');
    add('weather_severity', 0, 'Evaluated without weather.');
    add('visibility', 0, 'Evaluated without weather.');
    add('precipitation', 0, 'Evaluated without weather.');
    add('temperature', 0, 'Evaluated in a standard atmosphere.');
  } else {
    // Wind: none with a tailwind, full when the mean headwind is a quarter of cruise speed.
    const headwindKmh = -weather.meanTailwindKmh;
    const extraS = estimate.durationS - weather.stillAirDurationS;
    add(
      'wind',
      headwindKmh / (model.cruiseSpeedKmh * 0.25),
      headwindKmh > 0.5
        ? `A mean headwind of ${Math.round(headwindKmh)} km/h adds ${minutes(Math.max(extraS, 0))} to the flight.`
        : `A mean tailwind of ${Math.round(-headwindKmh)} km/h; the flight is ${minutes(Math.max(-extraS, 0))} shorter than in still air.`,
    );
    add(
      'weather_severity',
      (weather.worstSeverity - 0.2) / 0.6,
      `The worst conditions on the route have a severity of ${Math.round(weather.worstSeverity * 100)} out of 100.`,
    );
    // Visibility: none at 10 km or better, full at 1 km.
    add(
      'visibility',
      (10 - weather.arrival.visibilityKm) / 9,
      `Visibility at the destination on arrival is forecast to be ${weather.arrival.visibilityKm.toFixed(0)} km.`,
    );
    add(
      'precipitation',
      weather.heaviestPrecipitation,
      weather.heaviestPrecipitation > 0
        ? `The heaviest precipitation on the route has an intensity of ${Math.round(weather.heaviestPrecipitation * 100)} out of 100.`
        : 'No precipitation is forecast on the route.',
    );
    // Temperature: none within 10 °C of standard, full at 30 °C from it.
    const deviation = weather.departure.temperatureDeviationC;
    add(
      'temperature',
      (Math.abs(deviation) - 10) / 20,
      `The surface temperature at departure is ${Math.abs(deviation).toFixed(0)} °C ${deviation >= 0 ? 'above' : 'below'} standard.`,
    );
  }
  const worstEvent = estimate.disruptions.reduce((worst, d) => Math.max(worst, d.severity), 0);
  add(
    'events',
    worstEvent,
    estimate.disruptions.length === 0
      ? 'No announced event lies on the route.'
      : `The route passes through ${estimate.disruptions.length} affected area${estimate.disruptions.length === 1 ? '' : 's'}: ${estimate.disruptions.map((d) => d.eventId).join(', ')}.`,
  );

  const totalWeight = Object.values(RISK_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
  const contributors: RiskContributor[] = factors.map((factor) => ({
    id: factor.id,
    label: LABELS[factor.id],
    value: factor.value,
    weight: RISK_WEIGHTS[factor.id],
    points: (100 * RISK_WEIGHTS[factor.id] * factor.value) / totalWeight,
    explanation: factor.explanation,
  }));
  const index = Math.round(contributors.reduce((sum, c) => sum + c.points, 0));
  return {
    index,
    // Highest contribution first; ties keep the fixed factor order, so the result is stable.
    contributors: contributors
      .map((contributor, order) => ({ contributor, order }))
      .sort((a, b) => b.contributor.points - a.contributor.points || a.order - b.order)
      .map(({ contributor }) => contributor),
  };
}
