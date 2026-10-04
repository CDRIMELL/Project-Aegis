# 0023 — Range conditions and flight model 3

- Status: Accepted
- Date: 2026-10-04
- Amends: ADR 0019 (calibration)

## Context

The flight model is calibrated to one published range per type. A range means little without its
loading: the same aircraft flies far further empty than full, and further still with fuel carried
outside its own tanks. Until now the reference data held the figure and nothing about the
conditions it was published for, so the model had to assume them, by aircraft category.

## Decision

### Reference data

Every range and ferry-range record now carries what its source states about the figure:

- `variant`: the variant the source's figures are for, where it names one.
- `conditions`: payload, fuel state, speed and altitude, and whether fuel was carried externally,
  each in the source's own terms, with the source's wording and a link.

Conditions are curated in `data/curated/aircraft-range-conditions.json`, transcribed from the same
pinned article revisions as the figures.

- **What a source does not state is `unknown`.** Nothing is inferred. A range with no curated
  entry has every condition `unknown`, and is stored as such.
- **A loading AEGIS does not hold is `not_recorded`.** Where a source gives a figure for a
  particular equipment or weapon fit, that fit is not transcribed (ADR 0011); the record says only
  that a loading was stated.
- No published value was changed. The figures are as they were; they now have context.

### Flight model 3

The conditions select the calibration point, in this order:

1. **A ferry range on internal fuel** (full fuel, no payload), when the fuel capacity is sourced.
   Never used when the source says the figure includes external fuel. Where the source says
   nothing, it is taken as internal for transport-class types only, as in model 2, and that is
   listed as an assumption.
2. **A range at the payload the source states.**
3. **A range, assumed flown from maximum take-off mass.** Listed as an assumption.
4. **A ferry range, assumed on internal fuel**, when it is the only figure and the source does not
   say otherwise. Listed as an assumption.

A type whose only published range was flown with external fuel has **no model**: the figure says
nothing about the aircraft on its own tanks, and the model does not carry external fuel.

Each model records which rule calibrated it (`calibration`), the payload it assumed aboard, and
the source's wording of the conditions. The interface shows all three, and labels a loading as
"sourced" or "assumed".

### Existing aircraft

As in ADR 0019: an aircraft keeps the model it has. Grounded aircraft are migrated to model 3 by
the logged `updatePerformance` command; an airborne aircraft finishes its flight first. An
aircraft of a type that no longer has a model keeps its old one.

## Consequences

- 22 of the 40 types can fly, three fewer than under model 2: the F-16, Rafale and Black Hawk
  have only a ferry range published, and their sources say it was flown with external tanks.
  They fly again when a range on internal fuel is sourced.
- The C-130J is calibrated at its stated payload. The Typhoon's ferry range is now excluded
  because its source says so, not because of its category.
- For most types the source states no conditions, and the model says it is assuming them.
