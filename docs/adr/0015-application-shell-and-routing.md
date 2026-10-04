# 0015 — Application shell and routing

- Status: Accepted
- Date: 2026-10-04

## Context

Milestone 1 had one screen and no router. The product needs a persistent shell with the planned
operational areas, without presenting areas that do not exist as if they did.

## Decision

- **Areas.** Overview, Operations, Fleet, Missions, Reports, Data, System. One list
  (`app/areas.ts`) drives the navigation rail, the top-bar title and the routes.
- **Only built areas have routes.** Operations (the map), Data and System exist. The others appear
  in the rail disabled, each stating the phase that delivers it. There are no placeholder screens.
- **Operations is the home screen.** The application opens on the map.
- **Hash routing** (`react-router`, `createHashRouter`). The application is served from the bundle,
  where nothing rewrites deep paths, and nothing outside the window links into it.
- **The shell persists across routes.** The simulation clock and its controls stay in the top bar
  on every screen, because simulated time is global.
- **Full-surface screens opt in.** An area marked `bleed` fills the content region edge to edge and
  manages its own scrolling (the map). Other areas get the standard padded, scrolling region.
- **Start-up work runs outside the component tree.** The simulation worker and the reference-data
  check are started once in `main.tsx`; screens read their state from stores.

## Consequences

- Adding an area is: build the screen, set its `plannedPhase` to `null`, add its route.
- Earlier names (Command, Locations, Events) are retired. Locations are reached through the map and
  the Data screen; events will surface in Operations and Overview when they exist.
