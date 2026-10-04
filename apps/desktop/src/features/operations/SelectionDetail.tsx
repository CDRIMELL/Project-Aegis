import { metres, metresToFeet } from '@aegis/domain';
import {
  Breadcrumb,
  DataField,
  DataList,
  DataTable,
  DetailPanel,
  Hint,
  Notice,
  SectionLabel,
  type BreadcrumbItem,
} from '@aegis/ui';
import { formatInteger } from '../../format';
import { focusContinent, focusCountry } from '../../map/binding';
import { formatCoordinates, runwayName } from '../../map/features';
import { continentName } from '../../map/geography';
import {
  loadCountryDetail,
  loadLocationDetail,
  type CountryDetail,
  type LocationDetail,
  type RunwayRecord,
} from '../../reference/queries';
import { select, type Selection } from '../../state/map-store';
import { ProvenanceSection, ReferenceBadges } from '../shared/ProvenanceSection';
import { useAsync } from '../shared/useAsync';

const KIND_LABEL: Readonly<Record<LocationDetail['location']['kind'], string>> = {
  airport_large: 'Large aerodrome',
  airport_medium: 'Medium aerodrome',
  airport_small: 'Small aerodrome',
  city: 'City',
};

const close = () => {
  select(null);
};

function hierarchy(
  country: { iso2: string; name: string; continent: string } | null,
  region: string | null,
  current: string,
): BreadcrumbItem[] {
  const items: BreadcrumbItem[] = [];
  if (country) {
    items.push({
      label: continentName(country.continent),
      onSelect: () => {
        focusContinent(country.continent);
      },
    });
    items.push({
      label: country.name,
      onSelect: () => {
        focusCountry(country.iso2);
      },
    });
  }
  if (region) items.push({ label: region });
  items.push({ label: current });
  return items;
}

function elevation(valueM: number | null): string | null {
  if (valueM === null) return null;
  return `${formatInteger(valueM)} m / ${formatInteger(metresToFeet(metres(valueM)))} ft`;
}

function Runways({ runways }: { readonly runways: readonly RunwayRecord[] }) {
  if (runways.length === 0) {
    return <Hint>The source lists no runways for this aerodrome.</Hint>;
  }
  return (
    <DataTable
      caption="Runways"
      rows={runways}
      rowKey={(runway) => runway.id}
      columns={[
        {
          header: 'Runway',
          numeric: true,
          cell: (runway) => runwayName(runway.lowEndIdent, runway.highEndIdent) || '—',
        },
        {
          header: 'Length',
          numeric: true,
          align: 'right',
          cell: (runway) => (runway.lengthM === null ? '—' : `${formatInteger(runway.lengthM)} m`),
        },
        { header: 'Surface', numeric: true, cell: (runway) => runway.surface ?? '—' },
        {
          header: 'State',
          cell: (runway) => (runway.closed ? 'Closed' : runway.lighted ? 'Lighted' : 'Unlit'),
        },
      ]}
    />
  );
}

function LocationPanel({ detail }: { readonly detail: LocationDetail }) {
  const { location, country, runways, provenance } = detail;
  const isCity = location.kind === 'city';
  return (
    <DetailPanel
      kicker={KIND_LABEL[location.kind]}
      title={location.name}
      badges={<ReferenceBadges provenance={provenance} />}
      onClose={close}
    >
      <Breadcrumb
        items={hierarchy(country, location.regionCode ?? location.municipality, location.name)}
      />

      <section className="flex flex-col gap-2.5">
        <SectionLabel>{isCity ? 'Place' : 'Aerodrome'}</SectionLabel>
        <DataList>
          {!isCity && <DataField label="ICAO" value={location.icao} />}
          {!isCity && <DataField label="IATA" value={location.iata} />}
          {!isCity && (
            <DataField
              label="Source identifier"
              value={location.ident}
              hint="The source's own identifier; often but not always the ICAO code."
            />
          )}
          {!isCity && (
            <DataField
              label="Scheduled service"
              value={
                location.scheduledService === null ? null : location.scheduledService ? 'Yes' : 'No'
              }
              prose
            />
          )}
          {isCity && (
            <DataField
              label="Population"
              value={location.population === null ? null : formatInteger(location.population)}
              hint="The source's estimate for the urban area."
            />
          )}
          {!isCity && <DataField label="Elevation" value={elevation(location.elevationM)} />}
          {!isCity && <DataField label="Municipality" value={location.municipality} prose />}
        </DataList>
        <DataList columns={1}>
          <DataField label="Position" value={formatCoordinates(location.lat, location.lon)} />
        </DataList>
      </section>

      {!isCity && (
        <section className="flex flex-col gap-2.5">
          <SectionLabel>Runways ({runways.length})</SectionLabel>
          <Runways runways={runways} />
        </section>
      )}

      <ProvenanceSection provenance={provenance} />
    </DetailPanel>
  );
}

function CountryPanel({ detail }: { readonly detail: CountryDetail }) {
  return (
    <DetailPanel
      kicker="Country"
      title={detail.name}
      badges={<ReferenceBadges provenance={detail.provenance} />}
      onClose={close}
    >
      <Breadcrumb
        items={[
          {
            label: continentName(detail.continent),
            onSelect: () => {
              focusContinent(detail.continent);
            },
          },
          { label: detail.name },
        ]}
      />

      <section className="flex flex-col gap-2.5">
        <SectionLabel>Country</SectionLabel>
        <DataList>
          <DataField label="ISO code" value={detail.iso2} />
          <DataField label="Continent" value={continentName(detail.continent)} prose />
        </DataList>
      </section>

      <section className="flex flex-col gap-2.5">
        <SectionLabel>Reference locations held</SectionLabel>
        <DataList>
          <DataField label="Large aerodromes" value={formatInteger(detail.counts.airport_large)} />
          <DataField
            label="Medium aerodromes"
            value={formatInteger(detail.counts.airport_medium)}
          />
          <DataField label="Small aerodromes" value={formatInteger(detail.counts.airport_small)} />
          <DataField label="Cities" value={formatInteger(detail.counts.city)} />
        </DataList>
      </section>

      <ProvenanceSection provenance={detail.provenance} />
    </DetailPanel>
  );
}

function Pending({ title, error }: { readonly title: string; readonly error?: string }) {
  return (
    <DetailPanel kicker="Reference" title={title} onClose={close}>
      {error ? (
        <Notice tone="critical" title="This record could not be read">
          {error}
        </Notice>
      ) : (
        <Hint>Reading the record.</Hint>
      )}
    </DetailPanel>
  );
}

/** Details of whatever is selected on the map. Renders nothing when nothing is selected. */
export function SelectionDetail({
  selection,
}: {
  readonly selection: Exclude<NonNullable<Selection>, { type: 'aircraft' | 'mission' }>;
}) {
  const key =
    selection.type === 'location' ? `location:${selection.id}` : `country:${selection.iso2}`;
  const state = useAsync(key, async () =>
    selection.type === 'location'
      ? { type: 'location' as const, detail: await loadLocationDetail(selection.id) }
      : { type: 'country' as const, detail: await loadCountryDetail(selection.iso2) },
  );

  if (state.status === 'loading') return <Pending title="…" />;
  if (state.status === 'failed') return <Pending title="Unavailable" error={state.error} />;

  const { value } = state;
  const missing = (
    <Pending
      title="Not in reference data"
      error="The map shows this feature, but the reference tables hold no record for it."
    />
  );
  if (value.type === 'location') {
    return value.detail ? <LocationPanel detail={value.detail} /> : missing;
  }
  return value.detail ? <CountryPanel detail={value.detail} /> : missing;
}
