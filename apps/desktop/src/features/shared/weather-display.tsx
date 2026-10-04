import {
  ENVIRONMENT_EFFECTS,
  EVENT_LABEL,
  severityWord,
  type Conditions,
  type EventStatus,
  type PlanEstimate,
  type WorldEvent,
} from '@aegis/domain';
import { DataField, DataList, Hint, StatusBadge, type StatusTone } from '@aegis/ui';
import { formatDuration, formatInteger, formatKg } from '../../format';

/*
 * How the simulated environment and world events are shown (ADR 0021, ADR 0022). Everything here
 * describes simulated conditions; none of it is real weather.
 */

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** `270° W at 35 km/h`: the direction the wind blows from, and its speed. */
export function formatWind(conditions: Pick<Conditions, 'windFromDeg' | 'windSpeedKmh'>): string {
  if (conditions.windSpeedKmh < 2) return 'Calm';
  const from = Math.round(conditions.windFromDeg) % 360;
  const point = COMPASS[Math.round(from / 45) % 8] as string;
  return `${String(from).padStart(3, '0')}° ${point} at ${formatInteger(conditions.windSpeedKmh)} km/h`;
}

export function formatCloud(conditions: Pick<Conditions, 'cloudCover' | 'ceilingM'>): string {
  const eighths = Math.round(conditions.cloudCover * 8);
  if (eighths === 0) return 'Clear';
  const cover =
    eighths <= 2 ? 'Few' : eighths <= 4 ? 'Scattered' : eighths <= 7 ? 'Broken' : 'Overcast';
  return conditions.ceilingM === null
    ? cover
    : `${cover}, base ${formatInteger(conditions.ceilingM)} m`;
}

export function formatPrecipitation(intensity: number): string {
  if (intensity <= 0) return 'None';
  return intensity < 0.3 ? 'Light' : intensity < 0.65 ? 'Moderate' : 'Heavy';
}

const SEVERITY_TONE: Readonly<Record<ReturnType<typeof severityWord>, StatusTone>> = {
  Benign: 'ok',
  Unsettled: 'neutral',
  Poor: 'warn',
  Severe: 'critical',
};

export function SeverityBadge({ severity }: { readonly severity: number }) {
  const word = severityWord(severity);
  return <StatusBadge tone={SEVERITY_TONE[word]}>{word}</StatusBadge>;
}

/** Surface conditions at one place and time. */
export function ConditionsFields({
  conditions,
  columns = 2,
}: {
  readonly conditions: Conditions;
  readonly columns?: 1 | 2 | 3;
}) {
  return (
    <DataList columns={columns}>
      <DataField label="Wind" value={formatWind(conditions)} />
      <DataField label="Temperature" value={`${conditions.temperatureC.toFixed(0)} °C`} />
      <DataField label="Cloud" value={formatCloud(conditions)} prose />
      <DataField label="Visibility" value={`${conditions.visibilityKm.toFixed(0)} km`} />
      <DataField
        label="Precipitation"
        value={formatPrecipitation(conditions.precipitation)}
        prose
      />
      <DataField label="Pressure" value={`${formatInteger(conditions.pressureHpa)} hPa`} />
    </DataList>
  );
}

const signed = (value: number, digits = 0) =>
  `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(digits)}`;

/**
 * What the weather does to a plan, against the same plan in still air: each line says what
 * changed and by how much, so the estimate is not a mystery.
 */
export function WeatherImpact({ estimate }: { readonly estimate: PlanEstimate }) {
  const weather = estimate.weather;
  if (!weather) return <Hint>Evaluated in still air.</Hint>;
  const extraS = estimate.durationS - weather.stillAirDurationS;
  const extraKg = estimate.fuelUsedKg - weather.stillAirFuelUsedKg;
  const timePct = (extraS / weather.stillAirDurationS) * 100;
  const fuelPct = (extraKg / weather.stillAirFuelUsedKg) * 100;
  const wind = weather.meanTailwindKmh;
  return (
    <div className="flex flex-col gap-2.5">
      <DataList>
        <DataField
          label={wind >= 0 ? 'Mean tailwind' : 'Mean headwind'}
          value={`${formatInteger(Math.abs(wind))} km/h`}
          hint={ENVIRONMENT_EFFECTS.wind.statement}
        />
        <DataField
          label="Flight time against still air"
          value={`${signed(timePct, 1)} %`}
          hint={`${extraS >= 0 ? 'Longer' : 'Shorter'} by ${formatDuration(Math.abs(extraS))}. Still air: ${formatDuration(weather.stillAirDurationS)}.`}
        />
        <DataField
          label="Fuel against still air"
          value={`${signed(fuelPct, 1)} %`}
          hint={`${extraKg >= 0 ? 'More' : 'Less'} by ${formatKg(Math.abs(extraKg))}. ${ENVIRONMENT_EFFECTS.temperature.statement} ${ENVIRONMENT_EFFECTS.precipitation.statement}`}
        />
        <DataField
          label="Worst on route"
          value={severityWord(weather.worstSeverity)}
          hint="The worst of wind, precipitation and visibility met along the route."
          prose
        />
        <DataField
          label="Lowest visibility"
          value={`${weather.lowestVisibilityKm.toFixed(0)} km`}
        />
        <DataField
          label="Heaviest precipitation"
          value={formatPrecipitation(weather.heaviestPrecipitation)}
          prose
        />
      </DataList>
      <DataList columns={1}>
        <DataField
          label="At the origin on departure"
          value={`${formatWind(weather.departure)} · ${formatCloud(weather.departure)} · ${weather.departure.visibilityKm.toFixed(0)} km`}
          prose
        />
        <DataField
          label="At the destination on arrival"
          value={`${formatWind(weather.arrival)} · ${formatCloud(weather.arrival)} · ${weather.arrival.visibilityKm.toFixed(0)} km`}
          prose
        />
      </DataList>
      <Hint>
        Simulated weather, for a departure about now. The simulation flies the plan through the same
        conditions, so this is what will happen if it leaves now; it is recalculated at launch.
      </Hint>
    </div>
  );
}

const EVENT_STATUS: Readonly<Record<EventStatus, { tone: StatusTone; label: string }>> = {
  scheduled: { tone: 'info', label: 'Scheduled' },
  active: { tone: 'warn', label: 'Active' },
  resolved: { tone: 'neutral', label: 'Resolved' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
};

export function EventStatusBadge({ status }: { readonly status: EventStatus }) {
  return <StatusBadge tone={EVENT_STATUS[status].tone}>{EVENT_STATUS[status].label}</StatusBadge>;
}

export function eventTypeLabel(event: WorldEvent): string {
  return EVENT_LABEL[event.type];
}

/** Where an event is, in words. */
export function eventPlace(event: WorldEvent): string | null {
  if (event.place)
    return event.place.code ? `${event.place.name} (${event.place.code})` : event.place.name;
  if (event.centre && event.radiusM !== null) {
    return `${event.centre.name}, within ${formatInteger(event.radiusM / 1000)} km`;
  }
  return event.aircraftId;
}
