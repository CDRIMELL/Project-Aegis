# 0008 — Offline public-domain basemap, separate from dynamic layers

- Status: Accepted
- Date: 2026-10-04

## Context

MapLibre needs cartographic data, fonts (glyphs) and sprites. Hosted tile services need a network
connection and usually an API key, both of which the project rules out for core functionality.

## Decision

- The base cartography comes from public-domain data (Natural Earth), bundled with the application
  together with locally served glyphs and sprites. No tile server and no key.
- The basemap is **only** the backdrop. The map is a fully interactive MapLibre surface, built in two
  strictly separate tiers:
  1. **Basemap tier** — land, water, borders, physical labels. Static data, styled from AEGIS tokens.
  2. **AEGIS data tier** — locations, airports and airfields, publicly documented facilities,
     aircraft, mission routes, events, weather and traffic overlays, selection and animation. Each is
     its own source and layer group with defined z-order, zoom ranges and interaction, fed from the
     reference database and the live simulation.
- The data tier never depends on basemap features, so the basemap can be swapped (for example for a
  richer offline vector tileset) without touching simulation layers.

## Consequences

- The map works with no network connection.
- Base detail is limited at city scale. That is acceptable: operational detail is carried by AEGIS
  data layers, and the product is explicitly not a street map.
- Implementation is phase 3. Nothing map-related is built in milestone 1.
