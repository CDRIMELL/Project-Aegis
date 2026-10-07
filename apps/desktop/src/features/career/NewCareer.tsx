import { Button, Notice } from '@aegis/ui';
import { useNavigate } from 'react-router';
import { startNewCareer } from '../../career/service';
import { useSessionStore } from '../../state/session-store';
import { FrontFrame, FrontTitle, Kicker, Prose } from './parts';

/**
 * The introduction to a new career (ADR 0031). Continuing from it makes the world; the briefing
 * follows when the world has run the hours it has behind it.
 */
export function NewCareer() {
  const navigate = useNavigate();
  const creating = useSessionStore((state) => state.creating);
  const error = useSessionStore((state) => state.error);

  const begin = () => {
    void startNewCareer().then((ready) => {
      if (ready) void navigate('/brief', { replace: true });
    });
  };

  return (
    <FrontFrame>
      <div className="flex flex-col gap-6">
        <div>
          <Kicker>New career</Kicker>
          <FrontTitle>Welcome to AEGIS</FrontTitle>
        </div>
        <Prose>You are assuming operational command of United Kingdom military aviation.</Prose>
        <Prose>
          Aircraft are already flying. Missions are already underway. Weather is changing. Resources
          are finite.
        </Prose>
        <Prose>Your responsibility is to keep the operation moving.</Prose>
        <Prose>
          You will decide what matters, what can wait, and how to respond when circumstances change.
        </Prose>
        <p className="text-lg leading-relaxed font-medium text-ink">
          The world does not wait for you.
        </p>

        {error && (
          <Notice tone="critical" title="The career could not be started">
            {error}
          </Notice>
        )}

        {creating ? (
          <div className="flex flex-col gap-2" role="status" aria-live="polite">
            <p className="text-sm text-ink-secondary">{creating.step}…</p>
            <div className="h-1 w-full overflow-hidden rounded-sm bg-surface-hover">
              <div
                className="h-full bg-accent transition-[width]"
                style={{ width: `${Math.round((creating.share ?? 0) * 100)}%` }}
              />
            </div>
            <p className="text-2xs text-ink-muted">
              The world is run from midnight to early morning before you arrive, so that it has a
              past. This takes a few seconds.
            </p>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button variant="primary" onClick={begin}>
              Continue
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                void navigate('/menu');
              }}
            >
              Back
            </Button>
          </div>
        )}
      </div>
    </FrontFrame>
  );
}
