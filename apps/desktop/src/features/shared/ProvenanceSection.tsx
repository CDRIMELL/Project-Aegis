import { DataField, DataList, SectionLabel, StatusBadge, type StatusTone } from '@aegis/ui';
import { formatWallUtc } from '../../format';
import type { Provenance } from '../../reference/queries';

const VERIFICATION: Readonly<
  Record<Provenance['verification'], { tone: StatusTone; label: string }>
> = {
  unverified: { tone: 'warn', label: 'Unverified' },
  source_asserted: { tone: 'info', label: 'Source asserted' },
  cross_checked: { tone: 'ok', label: 'Cross-checked' },
};

const CONFIDENCE: Readonly<Record<Provenance['confidence'], { tone: StatusTone; label: string }>> =
  {
    high: { tone: 'neutral', label: 'High confidence' },
    medium: { tone: 'neutral', label: 'Medium confidence' },
    low: { tone: 'warn', label: 'Low confidence' },
  };

/** Badges marking a record as real-world reference data and how far it has been verified. */
export function ReferenceBadges({ provenance }: { readonly provenance: Provenance }) {
  const verification = VERIFICATION[provenance.verification];
  const confidence = CONFIDENCE[provenance.confidence];
  return (
    <>
      <StatusBadge tone="info">Reference</StatusBadge>
      <StatusBadge tone={verification.tone}>{verification.label}</StatusBadge>
      <StatusBadge tone={confidence.tone}>{confidence.label}</StatusBadge>
    </>
  );
}

/** Where a reference record came from, down to the hash of the file it was read from. */
export function ProvenanceSection({ provenance }: { readonly provenance: Provenance }) {
  return (
    <section className="flex flex-col gap-2.5">
      <SectionLabel>Provenance</SectionLabel>
      <DataList columns={1}>
        <DataField label="Source" value={provenance.sourceName} prose />
        <DataField label="Licence" value={provenance.licence} prose />
        <DataField
          label="Source record"
          value={provenance.sourceKey}
          hint="The publisher's own key for this record."
        />
        <DataField
          label="Retrieved (UTC)"
          value={provenance.rawRetrievedAt.slice(0, 19).replace('T', ' ')}
          hint="When the source file this record was read from was obtained."
        />
        <DataField
          label="Source file SHA-256"
          value={provenance.rawSha256}
          hint={`${provenance.rawUrl}\n${provenance.rawSha256}`}
        />
        <DataField
          label="Imported (UTC)"
          value={
            provenance.importedWallMs === null ? null : formatWallUtc(provenance.importedWallMs)
          }
          hint="When the import run that last wrote this record finished."
        />
      </DataList>
    </section>
  );
}
