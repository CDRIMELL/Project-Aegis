# 0011 — Fictional operator and fleet over real reference data

- Status: Accepted
- Date: 2026-10-04

## Context

AEGIS anchors its world in real public reference data but must never become, or resemble, a tool for
real-world operational planning.

## Decision

- **Real:** aircraft _types_ and their publicly documented characteristics; countries, cities,
  airports, airfields and appropriate publicly documented facilities. Every such record carries
  provenance.
- **Fictional:** the operator the user plays, every aircraft instance, every tail number and
  callsign, the fleet's size and where it is based, and everything that happens in the simulation.
- AEGIS does not reproduce real current force laydowns, unit dispositions or sensitive operational
  detail, and it does not track real aircraft.
- Aircraft type records hold no weapon, sensor or payload data. Capability is expressed as coarse
  tags. Combat and intercept outcomes are abstract resolutions over simulation factors (readiness,
  distance, fuel, weather, response time, numbers, a simulated threat level).

## Consequences

- Reference tables and simulation tables are separate families in the schema (`ref_*`, `sim_*`), so
  simulated state can never overwrite a sourced record.
- The absence of weapon and sensor fields makes the safety boundary structural, not a matter of
  restraint in later code.
