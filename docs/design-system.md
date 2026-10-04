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
11. **Reference and simulated are different colours.** On the map and in badges, teal means
    real-world reference data and green means a simulated AEGIS entity. A record's detail panel
    carries a "Reference" badge with its verification level and confidence.
12. **Canvas renderers use the same tokens.** The map (and later charts) cannot read CSS variables.
    They ask `resolveColorTokens` for the resolved values, so no colour is ever written outside
    `aegis.css`. A test asserts the map style contains no colour that is not in its palette.

## Map tokens

`--color-map-*` tokens define the map: `water`, `land`, `coast`, `border`, `graticule`, `label`,
`label-halo`, `place` (cities), `reference`, `reference-dim`, `simulated`, `selection`. Geography
uses the darkest neutrals so data stands out from it. Map text uses the bundled IBM Plex files
through `SANS_FONT_FILES` and `MONO_FONT_FILES`: labels in the sans face, codes in the mono face.

## Components

| Component                                  | Use                                                       |
| ------------------------------------------ | --------------------------------------------------------- |
| `AppFrame`                                 | Application shell: rail, top bar, content region          |
| `NavItem`                                  | Primary navigation entry, with an unavailable state       |
| `Wordmark`                                 | AEGIS mark and name                                       |
| `Panel`                                    | Titled container for related information                  |
| `DataList`, `DataField`                    | Labelled values with units, hints and a placeholder       |
| `TimeReadout`                              | Date and time with stable width                           |
| `StatusBadge`                              | Compact semantic state label                              |
| `SegmentedControl`                         | Exclusive choice among a few options (Radix toggle group) |
| `Button`                                   | Primary, secondary and ghost actions                      |
| `Notice`                                   | Inline information, warning or critical message           |
| `Icon`                                     | The one way to render a Lucide icon                       |
| `IconButton`                               | Icon-only action with a required accessible name          |
| `SwitchRow`                                | Labelled on/off setting on one line                       |
| `SearchField`                              | Text search input with a clear action                     |
| `ProgressBar`                              | Determinate progress                                      |
| `FloatingPanel`                            | Surface floating above another, such as map tools         |
| `DetailPanel`                              | Side panel describing the selected entity                 |
| `Breadcrumb`                               | Path through a hierarchy, with navigable levels           |
| `SectionLabel`, `Hint`                     | Group heading and secondary explanatory text              |
| `ListRow`, `ResultList`                    | Selectable lines in a result list                         |
| `DataTable`                                | Compact read-only table for short lists                   |
| `ReadoutStrip`, `ReadoutItem`, `ScaleRule` | Line of small technical readouts, written by ref          |
| `EmptyState`                               | Nothing to show, and what to do next                      |

`AppFrame` takes `bleed` for full-surface screens such as the map.

## Planned

- A virtualised table (TanStack Table and Virtual) for long lists; dialogs, tooltips, selects, tabs
  and toasts, wrapping Radix primitives. Each is added by the first screen that needs it.
- An ECharts theme generated from tokens through the same resolver the map uses.
- A component gallery route in development builds for visual review.
