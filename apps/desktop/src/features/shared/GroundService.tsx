import { GROUND_SERVICE, addMs, formatUtc, type RoutePoint } from '@aegis/domain';
import type { AircraftState } from '@aegis/sim';
import {
  Button,
  DataField,
  DataList,
  Hint,
  Meter,
  NumberField,
  SectionLabel,
  StatusBadge,
} from '@aegis/ui';
import { Fuel, Square } from 'lucide-react';
import { useState } from 'react';
import { aerodromeView, groundServiceView, serviceRequest } from '../../fleet/ground-logic';
import { serviceAircraft, stopServicing } from '../../fleet/service';
import { formatDuration, formatInteger, formatKg } from '../../format';
import { useSimStore } from '../../state/sim-store';

const NO_AIRCRAFT: readonly AircraftState[] = [];

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
 * The ground service under way on an aircraft (ADR 0027, ADR 0028): what is being done, what it
 * is waiting for and behind whom, and when the aircraft will be available. Everything shown is
 * derived from the service records and the simulation clock. Renders nothing for an aircraft
 * that is not being serviced.
 */
export function GroundServiceProgress({ aircraft, columns = 1 }: GroundServiceProps) {
  const tick = useSimStore((state) => state.view?.clock.tick ?? 0);
  const fleet = useSimStore((state) => state.view?.fleet.aircraft ?? NO_AIRCRAFT);
  const clock = useSimClock();
  const view = groundServiceView(aircraft, fleet, tick);
  if (!view) return null;
  const { progress } = view;
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
      {view.tasks.length > 0 && (
        <dl className="flex flex-col gap-2">
          {view.tasks.map((task) => (
            <div key={task.kind} className="flex flex-col gap-0.5">
              <dt className="text-2xs tracking-label text-ink-muted uppercase">
                {task.label} · {task.state}
              </dt>
              <dd className="cursor-text text-sm text-ink-secondary select-text">{task.detail}</dd>
            </div>
          ))}
        </dl>
      )}
      <DataList columns={columns}>
        <DataField
          label="Available at (sim, UTC)"
          value={clock(progress.completeTick)}
          hint="When the servicing under way ends, as things stand at this aerodrome."
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
        <DataField label="Payload aboard" value={formatKg(progress.payloadKg)} />
        {progress.missionId && (
          <DataField
            label="Prepared for"
            value={progress.missionId}
            hint="The mission that asked for this."
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
          : `${GROUND_SERVICE.refuel.statement} ${GROUND_SERVICE.payload.statement}`}
      </Hint>
    </section>
  );
}

/**
 * Asks for an aircraft's fuel and payload to be brought to quantities. The quantities are the
 * operator's; how long it takes, and whether it can be asked for at all, come from the rules.
 */
export function ServiceRequestControl({ aircraft }: { readonly aircraft: AircraftState }) {
  const model = aircraft.performance;
  const [fuelKg, setFuelKg] = useState(() =>
    Math.round(aircraft.service?.fuel?.targetKg ?? model?.fuelCapacityKg ?? 0),
  );
  const [payloadKg, setPayloadKg] = useState(() =>
    Math.round(aircraft.service?.payload?.targetKg ?? aircraft.payloadKg),
  );
  if (aircraft.location === null || !model) return null;
  const request = serviceRequest(aircraft, fuelKg, payloadKg);
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label="Fuel to bring it to"
          value={fuelKg}
          onChange={setFuelKg}
          unit="kg"
          min={0}
          max={Math.floor(model.fuelCapacityKg)}
          step={100}
          hint={`Up to ${formatInteger(model.fuelCapacityKg)} kg.`}
        />
        <NumberField
          label="Payload to bring it to"
          value={payloadKg}
          onChange={setPayloadKg}
          unit="kg"
          min={0}
          max={Math.floor(model.maxPayloadKg)}
          step={500}
          hint={`Up to ${formatInteger(model.maxPayloadKg)} kg. No particular cargo is modelled.`}
        />
      </div>
      <p className="text-sm text-ink-secondary">{request.message}</p>
      <div>
        <Button
          size="sm"
          icon={Fuel}
          disabled={!request.allowed}
          title={request.message}
          onClick={() => {
            serviceAircraft(aircraft.id, fuelKg, payloadKg);
          }}
        >
          Prepare the aircraft
        </Button>
      </div>
    </div>
  );
}

/**
 * An aerodrome as a place where simulated aircraft are serviced (ADR 0028): what it is assumed
 * to be able to do, which of its points are in use and by whom, and who is waiting. The size
 * class is reference data; everything derived from it is a simulation assumption, and says so.
 */
export function AerodromeGroundOperations({ point }: { readonly point: RoutePoint }) {
  const tick = useSimStore((state) => state.view?.clock.tick ?? 0);
  const fleet = useSimStore((state) => state.view?.fleet.aircraft ?? NO_AIRCRAFT);
  const view = aerodromeView(point, fleet, tick);
  if (!view.capability.servicing) return null;
  return (
    <section className="flex flex-col gap-2.5" aria-label="Ground operations">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>Ground operations</SectionLabel>
        <StatusBadge tone="ok">Simulated</StatusBadge>
      </div>
      <DataList columns={1}>
        <DataField
          label="Size class (reference)"
          value={view.sizeLabel}
          prose
          hint="From the reference data. It is the only thing about this aerodrome the simulation uses."
        />
        {view.resources.map((resource) => (
          <DataField
            key={resource.kind}
            label={`${resource.label} (assumed)`}
            value={
              resource.inUseBy.length === 0
                ? `${formatInteger(resource.points)} free of ${formatInteger(resource.points)}`
                : `${formatInteger(resource.inUseBy.length)} of ${formatInteger(resource.points)} in use: ${resource.inUseBy.join(', ')}`
            }
            prose
            hint={view.statement}
          />
        ))}
        {view.resources
          .filter((resource) => resource.waiting.length > 0)
          .map((resource) => (
            <DataField
              key={`${resource.kind}-queue`}
              label={`Waiting for ${resource.kind === 'fuel' ? 'a fuel point' : 'payload handling'}`}
              value={resource.waiting.join(', then ')}
              prose
              hint="In the order they will be served: by when each began to wait."
            />
          ))}
        <DataField
          label="Simulated aircraft here"
          value={
            view.aircraft.length === 0
              ? null
              : view.aircraft.map((aircraft) => aircraft.id).join(', ')
          }
          prose
        />
      </DataList>
      <Hint>{view.statement}</Hint>
    </section>
  );
}

/**
 * What a launch is waiting for, a line for each thing: the aircraft, its fuel, its payload and
 * the aerodrome's resources. The lines come from the readiness rule; this only sets them out.
 */
export function ReadinessChecklist({
  lines,
  earliest,
}: {
  readonly lines: readonly { label: string; value: string; ok: boolean }[];
  /** When it can launch at the earliest, in words; `null` when that cannot be said. */
  readonly earliest: string | null;
}) {
  return (
    <dl className="flex flex-col gap-1.5">
      {[
        ...lines,
        ...(earliest ? [{ label: 'Earliest launch', value: earliest, ok: true }] : []),
      ].map((line) => (
        <div key={line.label} className="grid grid-cols-[9rem_1fr] gap-x-3 text-sm">
          <dt className="text-2xs tracking-label text-ink-muted uppercase">{line.label}</dt>
          <dd className={line.ok ? 'text-ink-secondary' : 'text-ink'}>{line.value}</dd>
        </div>
      ))}
    </dl>
  );
}
