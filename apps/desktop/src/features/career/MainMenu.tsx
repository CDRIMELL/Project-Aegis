import { formatUtc } from '@aegis/domain';
import { Button, Notice } from '@aegis/ui';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { exitApplication, takeCommand } from '../../career/service';
import { useSessionStore, useSettingsStore } from '../../state/session-store';
import { useSimStore } from '../../state/sim-store';
import { FrontFrame, MenuItem } from './parts';

/** What Continue would return to, in a line. */
function useSavedCareer(): { readonly exists: boolean; readonly line: string } {
  const phase = useSimStore((state) => state.phase);
  const view = useSimStore((state) => state.view);
  if (phase === 'starting') return { exists: false, line: 'Looking for a saved career.' };
  if (phase === 'failed') return { exists: false, line: 'The saved world could not be opened.' };
  if (!view) return { exists: false, line: 'No career has been started.' };
  const when = formatUtc(view.clock.simTime).slice(0, 16).replace('T', ' ');
  const fleet = `${view.fleet.aircraft.length} aircraft`;
  if (view.career.day) {
    return { exists: true, line: `Day ${view.career.day.number} · ${when} UTC · ${fleet}` };
  }
  return {
    exists: true,
    line:
      view.career.establishedTick === null
        ? `A world from before careers · ${when} UTC · ${fleet}. Your record begins when you take command.`
        : `Command not yet taken · ${when} UTC · ${fleet}`,
  };
}

/** Where the application opens (ADR 0031). Nothing runs behind it. */
export function MainMenu() {
  const navigate = useNavigate();
  const saved = useSavedCareer();
  const view = useSimStore((state) => state.view);
  const failure = useSimStore((state) => state.failure);
  const error = useSessionStore((state) => state.error);
  const briefOnResume = useSettingsStore((state) => state.briefOnResume);
  const [confirming, setConfirming] = useState(false);

  const resume = () => {
    const day = view?.career.day;
    // A day already under way can be gone straight back to; a day not yet begun is briefed.
    if (day && view.clock.tick > day.startedTick && !briefOnResume) {
      takeCommand();
      void navigate('/operations');
    } else {
      void navigate('/brief');
    }
  };

  return (
    <FrontFrame>
      <div className="flex flex-col gap-8">
        <div>
          <p className="text-2xl leading-tight font-semibold tracking-wordmark text-ink">AEGIS</p>
          <p className="mt-2 text-sm tracking-label text-ink-muted uppercase">
            United Kingdom air operations · Command simulation
          </p>
        </div>

        {failure && (
          <Notice tone="critical" title="The simulation could not start">
            {failure}
          </Notice>
        )}
        {error && (
          <Notice tone="critical" title="That did not work">
            {error}
          </Notice>
        )}

        {confirming ? (
          <div className="flex flex-col gap-3 border-l-2 border-warn bg-surface px-4 py-3">
            <p className="text-lg font-semibold tracking-label text-ink uppercase">
              Start a new career?
            </p>
            <p className="text-sm text-ink-secondary">
              A new career replaces the current one. {saved.line}
            </p>
            <p className="text-sm text-ink-muted">
              The current career is first copied, whole, to the backups folder in the application
              data directory. It is not opened again by AEGIS, but the file is kept.
            </p>
            <div className="flex gap-2">
              <Button
                variant="primary"
                onClick={() => {
                  setConfirming(false);
                  void navigate('/new-career');
                }}
              >
                Replace it and begin
              </Button>
              <Button
                onClick={() => {
                  setConfirming(false);
                }}
              >
                Keep the current career
              </Button>
            </div>
          </div>
        ) : (
          <nav aria-label="Main menu" className="flex flex-col gap-1">
            <MenuItem
              label="Continue"
              detail={saved.line}
              disabled={!saved.exists}
              primary={saved.exists}
              onSelect={resume}
            />
            <MenuItem
              label="New career"
              detail="Assume operational command of United Kingdom military aviation."
              primary={!saved.exists}
              onSelect={() => {
                if (saved.exists) setConfirming(true);
                else void navigate('/new-career');
              }}
            />
            <MenuItem
              label="How to play"
              detail="Your role, the world, decisions and their consequences."
              onSelect={() => {
                void navigate('/how-to-play');
              }}
            />
            <MenuItem
              label="Settings"
              detail="How this installation behaves, and where it keeps its data."
              onSelect={() => {
                void navigate('/settings');
              }}
            />
            <MenuItem
              label="Exit"
              detail="Save and close."
              onSelect={() => {
                void exitApplication();
              }}
            />
          </nav>
        )}
      </div>
    </FrontFrame>
  );
}
