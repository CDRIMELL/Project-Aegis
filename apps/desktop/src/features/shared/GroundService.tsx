import { GROUND_SERVICE, addMs, formatUtc } from '@aegis/domain';
import type { AircraftState } from '@aegis/sim';
import { Button, DataField, DataList, Hint, Meter, NumberField, SectionLabel } from '@aegis/ui';
import { Fuel, Square } from 'lucide-react';
import { useState } from 'react';
import { fuelRequest, groundServiceView } from '../../fleet/ground-logic';
import { serviceAircraft, stopServicing } from '../../fleet/service';
import { formatDuration, formatInteger, formatKg } from '../../format';
import { useSimStore } from '../../state/sim-store';

/** A tick as a time of day on the simulation clock. */
function useSimClock(): (tick: number) => string | null {
  const epoch = useSimStore((state) => state.view?.epoch ?? null);
  return (tick) => (epoch === null ? null : formatUtc(addMs(epoch, tick * 1000)).slice(11, 16));
}

export interface GroundServiceProps {
  readonly aircraft: AircraftState;
  /** One column for the side panel; two where there is room. */
  readonly columns?: 1 | 2;
}

/**
 * The ground service under way on an aircraft (ADR 0027): what is being done, how far it has
 * got, and when the aircraft will be available. Everything shown is derived from the service
 * record and the simulation clock. Renders nothing for an aircraft that is not being serviced.
 */
export function GroundServiceProgress({ aircraft, columns = 1 }: GroundServiceProps) {
  const tick = useSimStore((state) => state.view?.clock.tick ?? 0);
  const clock = useSimClock();
  const view = groundServiceView(aircraft, tick);
  if (!view) return null;
  const { progress } = view;
  const target = progress.targetFuelKg;
  return (
    <section className="flex flex-col gap-2.5" aria-label="Ground service">
      <SectionLabel>Ground service</SectionLabel>
      <Meter
        label={view.activity}
        value={progress.fraction}
        reading={`${formatDuration(progress.remainingS)} to go`}
        tone="info"
      />
      <p className="text-sm text-ink-secondary">{view.detail}</p>
      <DataList columns={columns}>
        <DataField
          label="Available at (sim, UTC)"
          value={clock(progress.completeTick)}
          hint="When the servicing under way ends, as things stand."
        />
        <DataField
          label="Began (sim, UTC)"
          value={clock(progress.startedTick)}
          hint={
            progress.reason === 'turnaround'
              ? 'When the aircraft landed.'
              : 'When the preparation was ordered.'
          }
        />
        <DataField label="Fuel aboard" value={formatKg(progress.fuelKg)} />
        <DataField
          label="Fuel to end with"
          value={target === null ? null : formatKg(target)}
          hint="The fuel this servicing brings the aircraft to. None: it keeps what it has."
        />
        {target !== null && (
          <DataField
            label={progress.defuelling ? 'Still to take off' : 'Still to load'}
            value={formatKg(progress.fuelRemainingKg)}
          />
        )}
        {progress.missionId && (
          <DataField
            label="Prepared for"
            value={progress.missionId}
            hint="The mission that asked for this fuel."
          />
        )}
      </DataList>
      {view.stop && (
        <div>
          <Button
            size="sm"
            icon={Square}
            title={view.stop.hint}
            onClick={() => {
              stopServicing(aircraft.id);
            }}
          >
            {view.stop.label}
          </Button>
        </div>
      )}
      <Hint>
        {progress.stage === 'checks'
          ? GROUND_SERVICE.checks.statement
          : GROUND_SERVICE.refuel.statement}
      </Hint>
    </section>
  );
}

/**
 * Asks for an aircraft's fuel to be brought to a quantity. The quantity is the operator's; how
 * long it takes, and whether it can be asked for at all, come from the rules.
 */
export function FuelRequestControl({ aircraft }: { readonly aircraft: AircraftState }) {
  const capacity = aircraft.performance?.fuelCapacityKg ?? 0;
  const [fuelKg, setFuelKg] = useState(() =>
    Math.round(aircraft.service?.targetFuelKg ?? capacity),
  );
  if (aircraft.location === null || !aircraft.performance) return null;
  const request = fuelRequest(aircraft, fuelKg);
  return (
    <div className="flex flex-col gap-2">
      <NumberField
        label="Fuel to bring it to"
        value={fuelKg}
        onChange={setFuelKg}
        unit="kg"
        min={0}
        max={Math.floor(capacity)}
        step={100}
        hint={`Up to ${formatInteger(capacity)} kg. ${request.message}`}
      />
      <div>
        <Button
          size="sm"
          icon={Fuel}
          disabled={!request.allowed}
          title={request.message}
          onClick={() => {
            serviceAircraft(aircraft.id, fuelKg);
          }}
        >
          {fuelKg < aircraft.fuelKg ? 'Take fuel off' : 'Load fuel'}
        </Button>
      </div>
    </div>
  );
}
