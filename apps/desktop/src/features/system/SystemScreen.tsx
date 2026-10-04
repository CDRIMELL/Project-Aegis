import { formatUtc, hex32 } from '@aegis/domain';
import { DataField, DataList, Notice, Panel, StatusBadge } from '@aegis/ui';
import { useEffect, useState } from 'react';
import { formatInteger, formatWallUtc } from '../../format';
import { fetchAppInfo, type AppInfo } from '../../platform/tauri';
import { useSimStore } from '../../state/sim-store';

/** Loads native-core diagnostics once. `error` is set if the core cannot be reached. */
function useAppInfo(): { info: AppInfo | null; error: string | null } {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    fetchAppInfo().then(
      (value) => {
        if (current) setInfo(value);
      },
      (reason: unknown) => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      current = false;
    };
  }, []);

  return { info, error };
}

/** Simulation, persistence and native-core diagnostics. Every value shown is live state. */
export function SystemScreen() {
  const view = useSimStore((state) => state.view);
  const failure = useSimStore((state) => state.failure);
  const rejection = useSimStore((state) => state.rejection);
  const { info, error: infoError } = useAppInfo();

  const clock = view?.clock ?? null;
  const checkpoint = view?.checkpoint ?? null;
  const unsavedSteps =
    clock && checkpoint?.persistedTick != null ? clock.tick - checkpoint.persistedTick : null;

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      {failure && (
        <Notice tone="critical" title="The simulation has stopped">
          {failure} The world on disk is unchanged since the last checkpoint. Restart AEGIS to
          resume from it.
        </Notice>
      )}
      {rejection && (
        <Notice tone="warn" title="The last command was refused">
          {rejection}
        </Notice>
      )}
      {checkpoint?.lastError && (
        <Notice tone="warn" title="The last checkpoint could not be saved">
          {checkpoint.lastError} The simulation is still running and will retry automatically.
        </Notice>
      )}
      {infoError && (
        <Notice tone="critical" title="The native core is not responding">
          {infoError}
        </Notice>
      )}

      <div className="grid grid-cols-2 gap-4">
        <Panel
          title="Simulation clock"
          actions={
            clock &&
            (clock.running ? (
              <StatusBadge tone="ok">Running</StatusBadge>
            ) : (
              <StatusBadge tone="neutral">Paused</StatusBadge>
            ))
          }
        >
          <DataList>
            <DataField
              label="Simulation time (UTC)"
              value={clock && formatUtc(clock.simTime)}
              hint="Simulated time, not the real time. Epoch plus one second per step."
            />
            <DataField
              label="Speed"
              value={clock && `${clock.speed}×`}
              hint="Simulated seconds per real second."
            />
            <DataField
              label="Step"
              value={clock && formatInteger(clock.tick)}
              hint="Fixed one-second simulation steps executed since this world was created."
            />
            <DataField
              label="Integrity digest"
              value={view && hex32(view.integrityDigest)}
              hint="Rolling digest of every step and random draw. Two runs with the same digest at the same step are identical."
            />
          </DataList>
        </Panel>

        <Panel
          title="Persistence"
          actions={
            checkpoint &&
            (checkpoint.lastError ? (
              <StatusBadge tone="warn">Write failed</StatusBadge>
            ) : (
              <StatusBadge tone="ok">Saved</StatusBadge>
            ))
          }
        >
          <DataList>
            <DataField
              label="Last checkpoint"
              value={checkpoint && formatInteger(checkpoint.persistedSeq)}
              hint="Sequence number of the newest checkpoint confirmed on disk."
            />
            <DataField
              label="Saved at (UTC)"
              value={
                checkpoint?.persistedWallMs != null
                  ? formatWallUtc(checkpoint.persistedWallMs)
                  : null
              }
              hint="Real time at which that checkpoint was captured."
            />
            <DataField
              label="Saved step"
              value={
                checkpoint?.persistedTick != null ? formatInteger(checkpoint.persistedTick) : null
              }
            />
            <DataField
              label="Unsaved steps"
              value={unsavedSteps !== null ? formatInteger(unsavedSteps) : null}
              hint="Steps that would be lost if the application stopped right now."
            />
          </DataList>
        </Panel>

        <Panel title="World">
          <DataList>
            <DataField
              label="Seed"
              value={view?.seed ?? null}
              hint="Identifies this world. The same seed and the same commands always produce the same world."
            />
            <DataField
              label="Simulation model"
              value={view && `v${view.modelVersion}`}
              hint="Version of the simulation rules that produced this world."
            />
            <DataField
              label="Epoch (UTC)"
              value={view && formatUtc(view.epoch)}
              hint="Simulation time at step 0."
            />
          </DataList>
        </Panel>

        <Panel title="Native core">
          <DataList>
            <DataField label="Application version" value={info?.version ?? null} />
            <DataField label="SQLite" value={info?.sqliteVersion ?? null} />
            <DataField
              label="Schema migrations"
              value={info && formatInteger(info.schemaMigrations)}
              hint="Migrations applied to this database."
            />
            <DataField
              label="Encryption at rest"
              value={info?.encryption ?? null}
              hint="Database encryption is planned for the security phase."
            />
          </DataList>
          <div className="mt-3">
            <DataList columns={1}>
              <DataField label="Database file" value={info?.databasePath ?? null} />
            </DataList>
          </div>
        </Panel>
      </div>
    </div>
  );
}
