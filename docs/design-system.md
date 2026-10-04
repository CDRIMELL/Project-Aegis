# AEGIS design system

The design system is `@aegis/ui`. It is the only place where colour, type, spacing, shape and
motion are decided. This page explains the rules; the tokens themselves are documented in
[`packages/ui/src/styles/aegis.css`](../packages/ui/src/styles/aegis.css).

## Character

Dark, cool, technical and restrained. Most of every screen is graphite. Colour appears only where
it means something. Interest comes from typography, alignment, density and precise state changes,
not from glow, gradients or decoration.

## Rules

1. **Screens compose components.** Feature code under `apps/desktop/src` may use layout utilities
   (flex, grid, gap, width, margin). It may not set colours, fonts, font sizes, borders, radii or
   shadows. If a screen needs a new look, add or extend a component here.
2. **Components use semantic tokens.** `bg-surface`, `text-ink-muted`, `border-line`. Primitive
   ramps (`--aegis-*`) are referenced only inside `aegis.css`.
3. **Tailwind defaults are removed.** `bg-blue-500`, `rounded-2xl` and `shadow-lg` do not exist. A
   class that is not built from an AEGIS token produces no CSS.
4. **Colour is semantic.**

   | Token      | Meaning                                              |
   | ---------- | ---------------------------------------------------- |
   | `accent`   | AEGIS identity: the primary action, the active place |
   | `ok`       | Nominal, operating as intended                       |
   | `info`     | Technical or informational, no judgement             |
   | `warn`     | Needs attention; degraded but working                |
   | `critical` | Failed, unsafe or blocked                            |

   Neutral states (paused, idle, unknown) use neutral tones, not a status colour.

5. **Two typefaces.** IBM Plex Sans for interface text. IBM Plex Mono, with fixed-width digits, for
   telemetry, identifiers and anything that changes while you read it (`telemetry` utility).
6. **Labels are small, uppercase and letter-spaced.** Values are larger and brighter than their
   labels.
7. **Shape is quiet.** Radii of 2 to 4 px, hairline borders, no shadow except on floating layers.
8. **Motion communicates state.** Three durations: fast (90 ms) for feedback, medium (180 ms) for
   panels, slow (320 ms) for map and environment changes. One easing curve. Reduced-motion
   preferences are honoured.
9. **Nothing pretends.** A control either works or is disabled with a stated reason. An unknown
   value shows the standard placeholder, never a made-up number.
10. **Simulated values are labelled as simulated** wherever they could be mistaken for real ones.

## Components (milestone 1)

| Component               | Use                                                       |
| ----------------------- | --------------------------------------------------------- |
| `AppFrame`              | Application shell: rail, top bar, content region          |
| `NavItem`               | Primary navigation entry, with an unavailable state       |
| `Wordmark`              | AEGIS mark and name                                       |
| `Panel`                 | Titled container for related information                  |
| `DataList`, `DataField` | Labelled values with units, hints and a placeholder       |
| `TimeReadout`           | Date and time with stable width                           |
| `StatusBadge`           | Compact semantic state label                              |
| `SegmentedControl`      | Exclusive choice among a few options (Radix toggle group) |
| `Button`                | Primary, secondary and ghost actions                      |
| `Notice`                | Inline information, warning or critical message           |
| `Icon`                  | The one way to render a Lucide icon                       |

## Planned

- Tables (TanStack Table and Virtual), dialogs, drawers, tooltips, selects, tabs, toasts: added as
  the first screen that needs each one is built, wrapping Radix primitives.
- A token export for canvas renderers, so the MapLibre style and the ECharts theme are generated
  from the same values as the CSS.
- A component gallery route in development builds for visual review.
