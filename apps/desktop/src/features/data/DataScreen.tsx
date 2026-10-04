import { DataField, DataList, DataTable, EmptyState, Notice, Panel, StatusBadge } from '@aegis/ui';
import { Database } from 'lucide-react';
import { formatInteger, formatWallUtc } from '../../format';
import {
  loadIssueSummary,
  loadReferenceSummary,
  type DatasetSummary,
  type IssueSummary,
} from '../../reference/queries';
import { useReferenceStore } from '../../state/reference-store';
import { useAsync } from '../shared/useAsync';

const shortHash = (hash: string) => `${hash.slice(0, 12)}…`;

/**
 * Read-only view of the reference data held by this installation: which pack is installed, what
 * each dataset contains and where it came from, and what the import flagged. Import controls and
 * corrections belong to a later phase.
 */
export function DataScreen() {
  const phase = useReferenceStore((state) => state.phase);
  const state = useAsync(`reference-summary:${phase}`, async () => ({
    summary: await loadReferenceSummary(),
    issues: await loadIssueSummary(),
  }));

  if (state.status === 'failed') {
    return (
      <Notice tone="critical" title="Reference data could not be read">
        {state.error}
      </Notice>
    );
  }
  if (state.status === 'loading') {
    return <Panel title="Reference data">Reading.</Panel>;
  }

  const { summary, issues } = state.value;
  if (summary.datasets.length === 0) {
    return (
      <EmptyState icon={Database} title="No reference data is installed">
        The reference data shipped with AEGIS is installed automatically on first launch. If this
        message stays, see the System screen for errors.
      </EmptyState>
    );
  }

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <Panel
        title="Installed reference data pack"
        actions={
          summary.pack ? (
            <StatusBadge tone="ok">Installed</StatusBadge>
          ) : (
            <StatusBadge tone="warn">Not recorded</StatusBadge>
          )
        }
      >
        <DataList columns={3}>
          <DataField
            label="Pack identity"
            value={summary.pack ? shortHash(summary.pack.manifestSha256) : null}
            hint={
              summary.pack
                ? `SHA-256 of the pack manifest:\n${summary.pack.manifestSha256}`
                : 'No pack has been installed; the data was imported directly.'
            }
          />
          <DataField
            label="Installed (UTC)"
            value={summary.pack ? formatWallUtc(summary.pack.installedWallMs) : null}
          />
          <DataField
            label="Records"
            value={summary.pack ? formatInteger(summary.pack.rowCount) : null}
          />
          <DataField
            label="Pack format"
            value={summary.pack ? `v${summary.pack.formatVersion}` : null}
          />
          <DataField
            label="Pipeline"
            value={summary.pack ? `v${summary.pack.pipelineVersion}` : null}
            hint="Version of the normalisation rules that produced the pack."
          />
          <DataField label="Datasets" value={formatInteger(summary.datasets.length)} />
        </DataList>
      </Panel>

      <Panel title="Datasets">
        <DataTable<DatasetSummary>
          caption="Reference datasets and their sources"
          rows={summary.datasets}
          rowKey={(row) => row.dataset}
          columns={[
            { header: 'Dataset', numeric: true, cell: (row) => row.dataset },
            { header: 'Source', cell: (row) => row.sourceName },
            { header: 'Licence', cell: (row) => row.licence },
            {
              header: 'Records',
              numeric: true,
              align: 'right',
              cell: (row) => formatInteger(row.rows),
            },
            {
              header: 'Issues',
              numeric: true,
              align: 'right',
              cell: (row) => formatInteger(row.issues),
            },
            {
              header: 'Source retrieved',
              numeric: true,
              cell: (row) => row.rawRetrievedAt.slice(0, 10),
            },
            { header: 'Source SHA-256', numeric: true, cell: (row) => shortHash(row.rawSha256) },
          ]}
        />
      </Panel>

      <Panel title="Import issues">
        <DataTable<IssueSummary>
          caption="Issues recorded by the most recent import of each dataset"
          rows={issues}
          rowKey={(row) => `${row.dataset}:${row.severity}:${row.code}`}
          columns={[
            { header: 'Dataset', numeric: true, cell: (row) => row.dataset },
            {
              header: 'Severity',
              cell: (row) =>
                row.severity === 'error' ? (
                  <StatusBadge tone="critical">Rejected</StatusBadge>
                ) : (
                  <StatusBadge tone="warn">Caveat</StatusBadge>
                ),
            },
            { header: 'Reason', numeric: true, cell: (row) => row.code },
            {
              header: 'Records',
              numeric: true,
              align: 'right',
              cell: (row) => formatInteger(row.count),
            },
          ]}
        />
      </Panel>
    </div>
  );
}
