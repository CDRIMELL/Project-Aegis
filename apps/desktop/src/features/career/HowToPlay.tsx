import { Button } from '@aegis/ui';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { FrontFrame, FrontTitle, Kicker } from './parts';

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 border-l-2 border-line pl-4">
      <h2 className="text-2xs font-semibold tracking-label text-accent uppercase">{title}</h2>
      <div className="flex flex-col gap-1.5 text-base leading-relaxed text-ink-secondary">
        {children}
      </div>
    </section>
  );
}

/** A short guide. It says what the application does now, and nothing it does not yet do. */
export function HowToPlay() {
  const navigate = useNavigate();
  return (
    <FrontFrame>
      <div className="flex flex-col gap-6">
        <div>
          <Kicker>Guide</Kicker>
          <FrontTitle>How to play</FrontTitle>
        </div>

        <Section title="Your role">
          <p>You are responsible for United Kingdom military aviation operations.</p>
          <p>
            Routine activity happens by itself. Your job is to intervene when a decision matters.
          </p>
        </Section>

        <Section title="The world">
          <p>
            Aircraft fly. Missions progress. Weather changes. Aircraft wear, and aerodromes have
            only so many points to fuel and load them at. Problems develop.
          </p>
          <p>
            Time is continuous. Pause it, run it faster, play for twenty minutes or for hours. There
            are no turns.
          </p>
          <p>Not everything requires your attention.</p>
        </Section>

        <Section title="Decisions">
          <p>
            Requirements arrive for you to take up or decline. An aircraft falls due maintenance and
            waits for your order. A destination closes with a flight on its way there.
          </p>
          <p>
            The briefing and the Overview show what is waiting for you. You decide what to do about
            it, and with which aircraft.
          </p>
        </Section>

        <Section title="Consequences">
          <p>
            Decisions change the world. Redirecting an aircraft leaves what it was doing undone.
            Taking an aircraft from the reserve leaves less to answer the next thing with. Putting
            off maintenance keeps an aircraft flying today and takes it from you later.
          </p>
        </Section>

        <Section title="Objective">
          <p>There is no single correct way to operate.</p>
          <p>
            Keep the operation going. Meet the commitments that matter. Look after the aircraft.
            Respond when things go wrong, and live with what follows.
          </p>
        </Section>

        <Section title="Your career">
          <p>
            A command day lasts until you end it. Each one adds to a single record, which is never
            reset. It counts what happened in the simulation, and nothing else.
          </p>
        </Section>

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
