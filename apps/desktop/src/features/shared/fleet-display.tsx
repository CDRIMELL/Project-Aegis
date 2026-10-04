import type { RoutePoint } from '@aegis/domain';
import type { AircraftState, AircraftStatus } from '@aegis/sim';
import { Hint, ListRow, ResultList, SearchField, StatusBadge, type StatusTone } from '@aegis/ui';
import { Plane } from 'lucide-react';
import { useState } from 'react';
import { aerodromePoint } from '../../fleet/catalogue';
import { resolveAerodrome } from '../../fleet/service';
import { searchAerodromes } from '../../reference/queries';
import { useAsync } from './useAsync';

const STATUS: Readonly<Record<AircraftStatus, { tone: StatusTone; label: string }>> = {
  available: { tone: 'ok', label: 'Available' },
  in_flight: { tone: 'info', label: 'In flight' },
  maintenance_due: { tone: 'warn', label: 'Maintenance due' },
  in_maintenance: { tone: 'neutral', label: 'In maintenance' },
  unserviceable: { tone: 'critical', label: 'Unserviceable' },
};

export function statusLabel(status: AircraftStatus): string {
  return STATUS[status].label;
}

export function AircraftStatusBadge({ status }: { readonly status: AircraftStatus }) {
  return <StatusBadge tone={STATUS[status].tone}>{STATUS[status].label}</StatusBadge>;
}

/** Marks an entity as fictional AEGIS state, the counterpart of the "Reference" badge. */
export function SimulatedBadge() {
  return <StatusBadge tone="ok">Simulated</StatusBadge>;
}

export function placeName(point: RoutePoint | null): string {
  if (!point) return 'Airborne';
  return point.code ? `${point.name} (${point.code})` : point.name;
}

/** Fuel as a fraction of the aircraft's assumed capacity; 0 when it has no model. */
export function fuelFraction(aircraft: AircraftState): number {
  const capacity = aircraft.performance?.fuelCapacityKg ?? 0;
  return capacity > 0 ? aircraft.fuelKg / capacity : 0;
}

export interface AerodromePickerProps {
  readonly label: string;
  readonly onPick: (aerodrome: RoutePoint) => void;
}

/** Finds a real aerodrome in the reference data and hands back a copy the simulation can use. */
export function AerodromePicker({ label, onPick }: AerodromePickerProps) {
  const [query, setQuery] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const term = query.trim();
  const results = useAsync(`aerodromes:${term}`, () => searchAerodromes(term));

  const pick = (id: string) => {
    resolveAerodrome(id).then(
      (row) => {
        if (row) {
          onPick(aerodromePoint(row));
          setQuery('');
          setProblem(null);
        } else {
          setProblem('That aerodrome is no longer in the reference data.');
        }
      },
      (error: unknown) => {
        setProblem(error instanceof Error ? error.message : String(error));
      },
    );
  };

  return (
    <div className="flex flex-col gap-1">
      <SearchField
        label={label}
        placeholder="Aerodrome name, ICAO or IATA code"
        value={query}
        onChange={setQuery}
      />
      {term.length >= 2 && results.status === 'ready' && (
        <ResultList>
          {results.value.map((row) => (
            <ListRow
              key={row.id}
              icon={Plane}
              primary={row.name}
              secondary={[row.municipality, row.countryIso2].filter(Boolean).join(', ')}
              code={row.code ?? undefined}
              onSelect={() => {
                pick(row.id);
              }}
            />
          ))}
          {results.value.length === 0 && <Hint>No aerodrome matches.</Hint>}
        </ResultList>
      )}
      {results.status === 'failed' && <Hint>Search failed: {results.error}</Hint>}
      {problem && <Hint>{problem}</Hint>}
    </div>
  );
}
