# 0019 — Sourced fuel capacity and flight model 2

- Status: Accepted
- Date: 2026-10-04
- Amends: ADR 0016 (fuel capacity, range condition, model version)

## Context

Flight model 1 assumed every type's fuel capacity to be half of its useful load. That is
transparent but far from published figures for some types. Published fuel capacities exist for
several types and can be held as reference data like any other characteristic.

Using a real capacity exposes a second assumption. Model 1 calibrated fuel burn to the published
range as if it were flown with full fuel. For a transport the published range is at a heavy
payload, where full fuel cannot be carried, so a real capacity with the old calibration would make
the aircraft burn far too much.

## Decision

### Reference data

Two new characteristic keys, held with provenance like the others:

- `fuel_capacity_kg`: capacity published as a mass.
- `fuel_capacity_l`: capacity published as a volume, stored as published. It is never converted in
  the reference data.

Where no source could be retrieved the value is recorded as not established, with the reason.

### Flight model 2

1. **Capacity.** A sourced mass is used as published. A sourced volume is converted with one named
   assumption, 0.80 kg per litre. Only when neither exists is the capacity assumed, as before.
   Every model records which (`fuelCapacityBasis`), and the interface labels it.
2. **Calibration.** A transport-class type with a sourced capacity and a published ferry range is
   calibrated to the ferry range: full fuel and no payload is a loading the model can reproduce.
   Fast jets, trainers, rotorcraft and uncrewed types are not, because their published ferry ranges
   usually include external or auxiliary fuel that the model does not carry. They, and any type
   without a ferry range, are calibrated to the published range as in model 1.
3. **Consistency.** If a published capacity does not fit between the published empty and maximum
   masses, no model is produced. The model does not guess which figure is wrong.

The step function (`advanceFlight`) is unchanged. Only the derivation of the numbers differs.

### Existing aircraft

An aircraft stores the model it was given, so a saved world behaves exactly as before.

- A new command, `updatePerformance`, replaces the model of one aircraft. It is issued by the
  application (actor `system`) and logged.
- **It is refused for an airborne aircraft.** A flight finishes under the model it departed with.
  The application migrates the aircraft after it lands.
- Fuel on board is kept, reduced only if the new model cannot hold it.
- The application migrates an aircraft whose model is from an older version, or which had no model
  and can now have one.

## Consequences

- 25 of the 40 reference types can fly; five use a sourced fuel capacity. The other 20 flyable
  types still assume one and say so.
- The same route costs different fuel before and after migration. That is the intended effect.
- Ranges remain approximate: a calibration point is one published figure whose conditions are only
  partly known.
- Merlin has no fuel capacity in any source retrieved; it keeps the assumption.
