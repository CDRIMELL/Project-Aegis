import { Button, DataField, DataList, Hint, Panel, SwitchRow } from '@aegis/ui';
import { useNavigate } from 'react-router';
import { fetchAppInfo } from '../../platform/tauri';
import { changeSettings, useSettingsStore } from '../../state/session-store';
import { useAsync } from '../shared/useAsync';
import { FrontFrame, FrontTitle, Kicker } from './parts';

/** The directory a file is in, whichever separator the path uses. */
const directoryOf = (path: string) => path.replace(/[\\/][^\\/]*$/, '');

/**
 * The application's own settings, and where it keeps its data. Only what exists is shown: there
 * is no setting here that does nothing.
 */
export function SettingsFront() {
  const navigate = useNavigate();
  const briefOnResume = useSettingsStore((state) => state.briefOnResume);
  const info = useAsync('app-info', fetchAppInfo);
  const database = info.status === 'ready' ? info.value.databasePath : null;
  const folder = database ? directoryOf(database) : null;

  return (
    <FrontFrame>
      <div className="flex flex-col gap-6">
        <div>
          <Kicker>Application</Kicker>
          <FrontTitle>Settings</FrontTitle>
        </div>

        <Panel title="Briefing">
          <SwitchRow
            label="Show the operational brief when returning to a day already under way"
            checked={briefOnResume}
            onChange={(checked) => {
              changeSettings({ briefOnResume: checked });
            }}
          />
          <Hint>
            The brief at the start of a command day is always shown. With this off, Continue goes
            straight back to a day in progress.
          </Hint>
        </Panel>

        <Panel title="Where your data is kept">
          <DataList columns={1}>
            <DataField label="Career and reference data" value={database} />
            <DataField label="Backups" value={folder ? `${folder}\\backups` : null} />
            <DataField label="Exports" value={folder ? `${folder}\\exports` : null} />
            <DataField label="Build" value={info.status === 'ready' ? info.value.version : null} />
          </DataList>
          {info.status === 'failed' && <Hint>These could not be read: {info.error}</Hint>}
          <Hint>
            Everything is on this computer. AEGIS needs no account and no network. A copy of the
            database is written to Backups before a new career replaces the current one, and before
            a new version changes its structure.
          </Hint>
        </Panel>

        <div>
          <Button
            onClick={() => {
              void navigate('/menu');
            }}
          >
            Back to the menu
          </Button>
        </div>
      </div>
    </FrontFrame>
  );
}
