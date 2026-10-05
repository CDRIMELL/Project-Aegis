import {
  EVENT_LABEL,
  EVENT_TYPES,
  MISSION_TEMPLATES,
  MISSION_TYPES,
  type Report,
  type ReportFilter,
  type ReportTableName,
} from '@aegis/domain';
import { Button, Hint, SelectField, TextLink, type TableSort } from '@aegis/ui';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { STATUS_LABEL } from '../../missions/mission-logic';
import { nextSort, tickTime } from '../../reports/report-logic';
import {
  clearReportFilter,
  setReportFilter,
  setReportSort,
  useReportStore,
} from '../../state/report-store';

/* Pieces the report sections share: links into the rest of the application, filters, sorting. */

export interface SectionProps {
  readonly report: Report;
  /** The period of the same length before; `null` when the world is not that old. */
  readonly previous: Report | null;
}

/** A mission's identifier, opening the mission. */
export function MissionLink({ id }: { readonly id: string | null }) {
  const navigate = useNavigate();
  if (id === null) return <span className="text-ink-disabled">—</span>;
  return (
    <TextLink
      code
      onSelect={() => {
        void navigate(`/missions/${id}`);
      }}
    >
      {id}
    </TextLink>
  );
}

/** An aircraft's identifier, opening the aircraft. */
export function AircraftLink({ id }: { readonly id: string | null }) {
  const navigate = useNavigate();
  if (id === null) return <span className="text-ink-disabled">—</span>;
  return (
    <TextLink
      code
      onSelect={() => {
        void navigate(`/fleet/${id}`);
      }}
    >
      {id}
    </TextLink>
  );
}

/** An event's identifier, opening the event. */
export function EventLink({ id }: { readonly id: string }) {
  const navigate = useNavigate();
  return (
    <TextLink
      code
      onSelect={() => {
        void navigate(`/overview/${id}`);
      }}
    >
      {id}
    </TextLink>
  );
}

/** Two short lines in one table cell: the reading, and what qualifies it. */
export function TwoLine({ top, bottom }: { readonly top: ReactNode; readonly bottom: ReactNode }) {
  return (
    <span className="flex flex-col py-1 leading-tight">
      <span>{top}</span>
      <span className="text-2xs text-ink-muted">{bottom}</span>
    </span>
  );
}

export const when = (report: Report, tick: number | null) =>
  tick === null ? '—' : tickTime(tick, report.epochMs);

/** The order of a section's table, and the handler that changes it. */
export function useSort(section: ReportTableName): {
  sort: TableSort | null;
  onSort: (key: string) => void;
} {
  const sort = useReportStore((state) => state.sort[section] ?? null);
  return {
    sort,
    onSort: (key) => {
      setReportSort(section, nextSort(sort, key));
    },
  };
}

const ANY = '';

type FilterKey = keyof ReportFilter;

/**
 * The filters a section offers. What is chosen narrows the lists on screen and the export alike;
 * totals and charts always describe the whole period, and say so.
 */
export function FilterBar({
  report,
  show,
}: {
  readonly report: Report;
  readonly show: readonly FilterKey[];
}) {
  const filter = useReportStore((state) => state.filter);
  const active = show.some((key) => filter[key] !== null);
  const typesPresent = new Set(report.missions.map((mission) => mission.type));
  const statusesPresent = [...new Set(report.missions.map((mission) => mission.status))].sort();
  const eventTypesPresent = new Set(report.events.map((event) => event.type));

  return (
    <div className="flex flex-wrap items-end gap-3">
      {show.includes('aircraftId') && (
        <div className="w-44">
          <SelectField
            label="Aircraft"
            value={filter.aircraftId ?? ANY}
            options={[
              { value: ANY, label: 'All aircraft' },
              ...report.aircraft.map((row) => ({ value: row.aircraft.id, label: row.aircraft.id })),
            ]}
            onChange={(value) => {
              setReportFilter({ aircraftId: value === ANY ? null : value });
            }}
          />
        </div>
      )}
      {show.includes('missionType') && (
        <div className="w-44">
          <SelectField
            label="Mission type"
            value={filter.missionType ?? ANY}
            options={[
              { value: ANY, label: 'All types' },
              ...MISSION_TYPES.filter(
                (type) => typesPresent.has(type) || type === filter.missionType,
              ).map((type) => ({ value: type, label: MISSION_TEMPLATES[type].label })),
            ]}
            onChange={(value) => {
              setReportFilter({
                missionType: MISSION_TYPES.find((type) => type === value) ?? null,
              });
            }}
          />
        </div>
      )}
      {show.includes('missionStatus') && (
        <div className="w-40">
          <SelectField
            label="Outcome"
            value={filter.missionStatus ?? ANY}
            options={[
              { value: ANY, label: 'All outcomes' },
              ...statusesPresent.map((status) => ({ value: status, label: STATUS_LABEL[status] })),
            ]}
            onChange={(value) => {
              setReportFilter({
                missionStatus: statusesPresent.find((status) => status === value) ?? null,
              });
            }}
          />
        </div>
      )}
      {show.includes('eventType') && (
        <div className="w-48">
          <SelectField
            label="Event type"
            value={filter.eventType ?? ANY}
            options={[
              { value: ANY, label: 'All types' },
              ...EVENT_TYPES.filter(
                (type) => eventTypesPresent.has(type) || type === filter.eventType,
              ).map((type) => ({ value: type, label: EVENT_LABEL[type] })),
            ]}
            onChange={(value) => {
              setReportFilter({ eventType: EVENT_TYPES.find((type) => type === value) ?? null });
            }}
          />
        </div>
      )}
      {active && (
        <Button variant="ghost" size="sm" onClick={clearReportFilter}>
          Clear filters
        </Button>
      )}
    </div>
  );
}

/** Says how many rows a filter leaves, when it leaves fewer than there are. */
export function FilterCount({
  shown,
  of,
  what,
}: {
  readonly shown: number;
  readonly of: number;
  readonly what: string;
}) {
  if (shown === of) return null;
  return (
    <Hint>
      Showing {shown} of {of} {what}. Totals and charts describe the whole period.
    </Hint>
  );
}
