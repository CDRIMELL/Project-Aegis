import {
  aerodromeCapability,
  filterServices,
  type AerodromeActivity,
  type RoutePoint,
  type ServiceRecord,
} from '@aegis/domain';
import {
  DataField,
  DataList,
  DataTable,
  EmptyState,
  Hint,
  Panel,
  SelectField,
  StatTile,
  StatusBadge,
  TextLink,
} from '@aegis/ui';
import { Building2 } from 'lucide-react';
import { useMemo } from 'react';
import { aerodromeView, knownAerodromes } from '../../fleet/ground-logic';
import { formatDuration, formatInteger } from '../../format';
import { formatCoordinates } from '../../map/features';
import { setReportFilter, useReportStore } from '../../state/report-store';
import { useSimStore } from '../../state/sim-store';
import { AircraftLink, MissionLink, TwoLine, when, type SectionProps } from './parts';

/*
 * Aerodromes and the ground services done at them (ADR 0028, ADR 0029). One aerodrome at a time:
 * what it is, what it is assumed to be able to do, what it is doing now, and what was done there
 * in the period. Everything is derived: the capability from the size class, the present from the
 * aircraft's own service records, the past from the log.
 */

const ANY = '__all';
const hours = (seconds: number) => (seconds / 3600).toFixed(1);
const SERVICE_KIND = { turnaround: 'Turnaround', preparation: 'Preparation' } as const;
const NO_ACTIVITY: Omit<AerodromeActivity, 'at'> = {
  services: 0,
  serviceSeconds: 0,
  servicesQueued: 0,
  waitSeconds: 0,
  fuelLoadedKg: 0,
  payloadLoadedKg: 0,
  fuelRemovedKg: 0,
  payloadRemovedKg: 0,
  refuellingSeconds: 0,
  payloadSeconds: 0,
  departures: 0,
  arrivals: 0,
};

function ServicesTable({
  report,
  services,
}: {
  readonly report: SectionProps['report'];
  readonly services: readonly ServiceRecord[];
}) {
  if (services.length === 0) {
    return <Hint>No ground service was completed here in the period.</Hint>;
  }
  return (
    <div className="overflow-x-auto">
      <DataTable<ServiceRecord>
        caption="Ground services completed in the period, in the order they finished"
        rows={services}
        rowKey={(service) => `${service.aircraftId}:${service.completedTick}`}
        columns={[
          {
            header: 'Aircraft',
            cell: (service) => (
              <TwoLine top={<AircraftLink id={service.aircraftId} />} bottom={service.at} />
            ),
          },
          {
            header: 'Service',
            cell: (service) => (
              <TwoLine
                top={SERVICE_KIND[service.reason]}
                bottom={service.missionId ? <MissionLink id={service.missionId} /> : 'no mission'}
              />
            ),
          },
          {
            header: 'Ended',
            numeric: true,
            cell: (service) => (
              <TwoLine
                top={when(report, service.completedTick)}
                bottom={service.stopped ? 'ended short' : 'completed'}
              />
            ),
          },
          {
            header: 'Took',
            numeric: true,
            align: 'right',
            cell: (service) => (
              <TwoLine
                top={formatDuration(service.durationS)}
                bottom={service.waitS > 0 ? `${formatDuration(service.waitS)} waiting` : 'no wait'}
              />
            ),
          },
          {
            header: 'Fuel',
            numeric: true,
            align: 'right',
            cell: (service) => (
              <TwoLine
                top={signed(service.loadedKg)}
                bottom={
                  service.fuelTargetKg === null
                    ? 'none asked for'
                    : `asked ${formatInteger(service.fuelTargetKg)} kg`
                }
              />
            ),
          },
          {
            header: 'Payload',
            numeric: true,
            align: 'right',
            cell: (service) => (
              <TwoLine
                top={signed(service.payloadLoadedKg)}
                bottom={
                  service.payloadTargetKg === null
                    ? 'none asked for'
                    : `asked ${formatInteger(service.payloadTargetKg)} kg`
                }
              />
            ),
          },
        ]}
      />
    </div>
  );
}

/** A quantity moved: loaded is positive, taken off is negative, nothing is a dash. */
function signed(kg: number): string {
  if (Math.round(kg) === 0) return '—';
  return `${kg > 0 ? '+' : '−'}${formatInteger(Math.abs(kg))} kg`;
}

function AerodromeDetail({
  code,
  point,
  activity,
  report,
}: {
  readonly code: string;
  readonly point: RoutePoint | null;
  readonly activity: Omit<AerodromeActivity, 'at'>;
  readonly report: SectionProps['report'];
}) {
  const tick = useSimStore((state) => state.view?.clock.tick ?? 0);
  const fleet = useSimStore((state) => state.view?.fleet.aircraft);
  const filter = useReportStore((state) => state.filter);
  const now = point && fleet ? aerodromeView(point, fleet, tick) : null;
  const capability = aerodromeCapability(point);
  const mean = (seconds: number, count: number) =>
    count === 0 ? 'none in the period' : `mean ${formatDuration(seconds / count)}`;
  return (
    <>
      <Panel title={`${point?.name ?? code} · identity`}>
        <DataList columns={4}>
          <DataField label="Code" value={code} />
          <DataField
            label="Position"
            value={point ? formatCoordinates(point.lat, point.lon) : null}
          />
          <DataField
            label="Size class (reference)"
            value={now?.sizeLabel ?? null}
            prose
            hint="The class OurAirports gives the aerodrome, from the packaged reference data. It is the only thing about the aerodrome the simulation uses."
          />
          <DataField
            label="Elevation"
            value={point ? `${formatInteger(point.elevationM)} m` : null}
          />
        </DataList>
      </Panel>

      <Panel
        title="Capability"
        actions={<StatusBadge tone="neutral">Simulation assumption</StatusBadge>}
      >
        <div className="flex flex-col gap-3">
          <DataList columns={4}>
            <StatTile label="Fuel points" value={formatInteger(capability.fuelPoints)} />
            <StatTile
              label="Fuel rate"
              value={capability.fuelRateFactor === 1 ? 'Full' : 'Half'}
              hint="A factor on the rate at which an aircraft takes fuel, which depends on the size of its tanks."
            />
            <StatTile label="Payload handling" value={formatInteger(capability.handlingPoints)} />
            <StatTile
              label="Payload rate"
              value={formatInteger(capability.payloadRateKgS * 60)}
              unit="kg/min"
            />
          </DataList>
          <Hint>
            {now?.statement ?? ''} These figures are AEGIS assumptions about a class of aerodrome.
            They are not specifications of this or any real aerodrome.
          </Hint>
        </div>
      </Panel>

      <Panel title="Now" actions={<StatusBadge tone="ok">Simulated</StatusBadge>}>
        {now ? (
          <DataList columns={2}>
            {now.resources.map((resource) => (
              <DataField
                key={resource.kind}
                label={resource.label}
                prose
                value={
                  resource.inUseBy.length === 0
                    ? `${formatInteger(resource.points)} free of ${formatInteger(resource.points)}`
                    : `${formatInteger(resource.inUseBy.length)} of ${formatInteger(resource.points)} in use: ${resource.inUseBy.join(', ')}`
                }
              />
            ))}
            {now.resources.map((resource) => (
              <DataField
                key={`${resource.kind}-queue`}
                label={`Waiting for ${resource.kind === 'fuel' ? 'a fuel point' : 'payload handling'}`}
                prose
                value={resource.waiting.length === 0 ? 'None' : resource.waiting.join(', then ')}
                hint="In the order they will be served: by when each began to wait."
              />
            ))}
            <DataField
              label="Aircraft on the ground here"
              prose
              value={
                now.aircraft.length === 0
                  ? 'None'
                  : now.aircraft
                      .map((aircraft) => `${aircraft.id} (${aircraft.status.replaceAll('_', ' ')})`)
                      .join(', ')
              }
            />
          </DataList>
        ) : (
          <Hint>
            The world holds no point for this aerodrome any more, so what is there now cannot be
            shown. What was done there in the period is below.
          </Hint>
        )}
      </Panel>

      <Panel title="In the period">
        <div className="flex flex-col gap-3">
          <DataList columns={4}>
            <StatTile
              label="Services completed"
              value={formatInteger(activity.services)}
              detail={mean(activity.serviceSeconds, activity.services)}
            />
            <StatTile
              label="Time servicing"
              value={hours(activity.serviceSeconds)}
              unit="h"
              detail={`${hours(activity.refuellingSeconds)} h on fuel, ${hours(activity.payloadSeconds)} h on payload`}
            />
            <StatTile
              label="Waited for a point"
              value={formatInteger(activity.servicesQueued)}
              detail={mean(activity.waitSeconds, activity.servicesQueued)}
              hint="Services that had to wait for a fuel point or for payload handling here."
            />
            <StatTile
              label="Flights"
              value={`${formatInteger(activity.departures)} out`}
              detail={`${formatInteger(activity.arrivals)} in`}
              hint="Flights finished in the period that left from here, and that landed here."
            />
            <StatTile
              label="Fuel loaded"
              value={formatInteger(activity.fuelLoadedKg)}
              unit="kg"
              detail={`${formatInteger(activity.fuelRemovedKg)} kg taken off`}
            />
            <StatTile
              label="Payload loaded"
              value={formatInteger(activity.payloadLoadedKg)}
              unit="kg"
              detail={`${formatInteger(activity.payloadRemovedKg)} kg taken off`}
              hint="Payload taken off includes deliveries unloaded by the turnaround."
            />
          </DataList>
          <ServicesTable report={report} services={filterServices(report, filter)} />
        </div>
      </Panel>
    </>
  );
}

export function AerodromesSection({ report }: SectionProps) {
  const view = useSimStore((state) => state.view);
  const filter = useReportStore((state) => state.filter);
  const known = useMemo(
    () => (view ? knownAerodromes(view) : new Map<string, RoutePoint>()),
    [view],
  );
  // Every aerodrome with something to show: activity in the period, or an aircraft there now.
  const codes = useMemo(() => {
    const present = new Set(report.aerodromes.map((each) => each.at));
    for (const aircraft of view?.fleet.aircraft ?? []) {
      const here = aircraft.location;
      if (here?.kind === 'aerodrome') present.add(here.code ?? here.name);
    }
    if (filter.aerodrome !== null) present.add(filter.aerodrome);
    return [...present].sort();
  }, [report.aerodromes, view, filter.aerodrome]);

  if (codes.length === 0) {
    return (
      <Panel title="Aerodromes and services">
        <EmptyState icon={Building2} title="No aerodrome has been used yet" />
      </Panel>
    );
  }
  const selected = filter.aerodrome;
  const activity = report.aerodromes.find((each) => each.at === selected) ?? NO_ACTIVITY;
  return (
    <>
      <Panel title="Aerodrome">
        <div className="flex flex-col gap-3">
          <div className="w-72">
            <SelectField
              label="Aerodrome"
              value={selected ?? ANY}
              options={[
                { value: ANY, label: 'All aerodromes' },
                ...codes.map((code) => ({
                  value: code,
                  label: known.get(code)?.name ? `${code} · ${known.get(code)?.name ?? ''}` : code,
                })),
              ]}
              onChange={(value) => {
                setReportFilter({ aerodrome: value === ANY ? null : value });
              }}
            />
          </div>
          <Hint>
            The export of this section is the list of ground services, one row each, for the
            aerodrome chosen here or for all of them.
          </Hint>
        </div>
      </Panel>

      {selected === null ? (
        <>
          <Panel title="Aerodromes used in the period">
            {report.aerodromes.length === 0 ? (
              <Hint>Nothing was done at any aerodrome in the period.</Hint>
            ) : (
              <div className="overflow-x-auto">
                <DataTable<AerodromeActivity>
                  caption="What was done at each aerodrome in the period"
                  rows={report.aerodromes}
                  rowKey={(row) => row.at}
                  columns={[
                    {
                      header: 'Aerodrome',
                      cell: (row) => (
                        <TwoLine
                          top={
                            <TextLink
                              code
                              onSelect={() => {
                                setReportFilter({ aerodrome: row.at });
                              }}
                            >
                              {row.at}
                            </TextLink>
                          }
                          bottom={known.get(row.at)?.name ?? ''}
                        />
                      ),
                    },
                    {
                      header: 'Services',
                      numeric: true,
                      align: 'right',
                      cell: (row) => (
                        <TwoLine
                          top={formatInteger(row.services)}
                          bottom={`${hours(row.serviceSeconds)} h`}
                        />
                      ),
                    },
                    {
                      header: 'Waited',
                      numeric: true,
                      align: 'right',
                      cell: (row) => (
                        <TwoLine
                          top={formatInteger(row.servicesQueued)}
                          bottom={row.servicesQueued === 0 ? '—' : formatDuration(row.waitSeconds)}
                        />
                      ),
                    },
                    {
                      header: 'Fuel',
                      numeric: true,
                      align: 'right',
                      cell: (row) => (
                        <TwoLine
                          top={`+${formatInteger(row.fuelLoadedKg)} kg`}
                          bottom={`−${formatInteger(row.fuelRemovedKg)} kg`}
                        />
                      ),
                    },
                    {
                      header: 'Payload',
                      numeric: true,
                      align: 'right',
                      cell: (row) => (
                        <TwoLine
                          top={`+${formatInteger(row.payloadLoadedKg)} kg`}
                          bottom={`−${formatInteger(row.payloadRemovedKg)} kg`}
                        />
                      ),
                    },
                    {
                      header: 'Flights',
                      numeric: true,
                      align: 'right',
                      cell: (row) => (
                        <TwoLine
                          top={`${formatInteger(row.departures)} out`}
                          bottom={`${formatInteger(row.arrivals)} in`}
                        />
                      ),
                    },
                  ]}
                />
              </div>
            )}
          </Panel>
          <Panel title="Ground services in the period">
            <ServicesTable report={report} services={filterServices(report, filter)} />
          </Panel>
        </>
      ) : (
        <AerodromeDetail
          code={selected}
          point={known.get(selected) ?? null}
          activity={activity}
          report={report}
        />
      )}
    </>
  );
}
