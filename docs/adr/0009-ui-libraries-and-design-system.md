# 0009 — Token-driven design system; UI library set

- Status: Accepted
- Date: 2026-10-04

## Context

Visual consistency is a non-negotiable project requirement. Utility CSS makes one-off styling easy,
which is exactly the failure to prevent.

## Decision

- `@aegis/ui` is the only place colours, type, spacing, radii, borders and motion are defined.
- Tokens have two tiers. **Primitive** tokens are raw ramps. **Semantic** tokens (surface, border,
  text, accent, status) reference primitives. Components and screens use semantic tokens only.
- Tailwind CSS 4 is configured from those tokens, and Tailwind's default palette, font and radius
  scales are removed. A colour that is not an AEGIS token does not exist as a class.
- Feature code composes `@aegis/ui` components. A new visual need extends the design system; it is
  not solved locally.
- Fonts are bundled with the application (IBM Plex Sans for UI, IBM Plex Mono for telemetry; SIL Open
  Font License). No font CDN.
- Libraries:
  - Radix primitives for behaviour-heavy accessible controls, unstyled, wrapped by `@aegis/ui`.
  - TanStack Table and Virtual for data tables, when the first table screen is built.
  - Zod for validation at trust boundaries.
  - Lucide for icons, ECharts for charts, Zustand for UI-side state.
  - Framer Motion is **not** used in V1. Motion is CSS transitions driven by motion tokens.

## Consequences

- Chart and map themes will be generated from the same tokens (phases 3 and 8) so canvas-rendered
  surfaces match the DOM.
- The token foundation and first components ship in milestone 1, before any feature screen exists.
