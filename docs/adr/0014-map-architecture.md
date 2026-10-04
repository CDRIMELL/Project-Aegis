# 0014 — Map architecture: four tiers, driven outside React

- Status: Accepted
- Date: 2026-10-04

## Context

The map is a core product surface. It must show real reference data now and simulated aircraft,
routes, events and weather later, updating many times a second, without being rewritten when the
simulation arrives. ADR 0008 fixed the basemap as offline public-domain data, separate from AEGIS
layers.

## Decision

### Four tiers

Every map layer belongs to exactly one tier, drawn bottom to top:

| Tier        | Content                                                     | Origin         |
| ----------- | ----------------------------------------------------------- | -------------- |
| basemap     | Land, water, lakes, borders, graticule, country names       | Bundled files  |
| reference   | Aerodromes, runways, cities                                 | `ref_*` tables |
| simulation  | Aircraft, headings, trails, routes, events, weather (later) | `sim_*` state  |
| interaction | Hover and selection                                         | UI state       |

The style contains an invisible **slot layer** at the end of each tier. A layer is always inserted
before its tier's slot, so tiers cannot interleave regardless of the order code adds layers in.
The simulation tier exists today as an empty slot and an `addSimulationSource` method.

Colour encodes the same distinction: **teal marks real-world reference data; green is reserved for
simulated AEGIS entities.** The basemap is the quietest thing on screen.

### The map is not a React component

`MapController` owns the MapLibre instance. It is a plain class with methods (`setLocations`,
`setSelection`, `setGroupVisible`, `flyTo`, `addSimulationSource`, ...) and three subscriptions
(`onPick`, `onView`, `onPointer`).

- React mounts the controller's element and renders the panels around it.
- A small binding module pushes application state into the controller and map picks into
  application state.
- Data goes straight into MapLibre sources. Changing data never re-renders a component tree.
- Continuous readouts (pointer position, zoom, scale) are written to the DOM through refs.

This is what will let the simulation update aircraft positions per frame: it will call a source
handle's `set`, and nothing else in the application will notice.

The controller is a singleton that outlives the screen, so leaving and returning to the map does
not reload 55,000 features.

### Offline basemap

- Natural Earth at three levels of detail (1:110m, 1:50m, 1:10m), prepared at release time by
  `npm run data:basemap`: properties reduced to name and ISO code, coordinates rounded to a stated
  precision. Each level is shown over its own zoom range.
- The 1:10m level (about 15 MB) is added the first time the view zooms in far enough to need it.
- Text is rendered by MapLibre from the same bundled IBM Plex font files the interface uses, via
  the style's `font-faces`. There is no glyph server, no sprite sheet and no tile server.
- MapLibre's worker is loaded as a bundled module, so the Content Security Policy stays at
  `worker-src 'self'`.
- The basemap is presentation, not reference data. Nothing from it enters `ref_*`; the only link is
  a country's ISO code, used to look up the reference record when a country is clicked.

### Density

Each location is given the lowest zoom at which its marker and its label appear, from its kind,
population and whether it has scheduled service. Layers filter on those properties, so the world
view shows a few hundred places and the full 55,000 arrive progressively. Runways are drawn from
zoom 9 and only where the source gives both threshold positions. The rules are pure functions with
tests.

### Tokens

MapLibre cannot read CSS variables. The controller resolves map tokens (`--color-map-*`) to
concrete colours at start-up through `resolveColorTokens`, and the style is built from that
palette. A test asserts the style contains no colour that is not in the palette.

## Alternatives considered

- **Vector tiles (PMTiles).** The better format at larger data volumes, but the tooling to build
  them is not available on Windows without extra infrastructure. GeoJSON at three levels of detail
  is sufficient for a 1:10m basemap. The basemap tier can be replaced later without touching the
  others.
- **A React map wrapper with markers as components.** Simple to start with; unusable at this
  feature count and incompatible with per-frame updates.
- **Clustering.** Considered for aerodromes; per-feature zoom thresholds give a more predictable
  and more legible result, and keep every marker a real, selectable place.

## Consequences

- Map behaviour that can be expressed as data (style, tiers, density, features, scale) is unit
  tested. What needs a GPU (rendering, picking) is verified by running the application.
- Adding a simulated layer means one `addSimulationSource` call and feeding it data.
- All reference locations are read into memory once per session (about 55,000 points). If that
  ever becomes too many, the reference tier moves to tiles; the other tiers are unaffected.
