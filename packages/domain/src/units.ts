/*
 * Units of measure as branded number types.
 *
 * A value's unit is part of its type, so passing feet where metres are expected fails to compile.
 * Storage and calculation use SI-derived units (metres, kilograms, kilometres per hour); aviation
 * units (nautical miles, knots, feet) are for display and for reading sources.
 */

declare const unit: unique symbol;
type Quantity<U extends string> = number & { readonly [unit]: U };

export type Metres = Quantity<'m'>;
export type Feet = Quantity<'ft'>;
export type Kilometres = Quantity<'km'>;
export type NauticalMiles = Quantity<'nmi'>;
export type Kilograms = Quantity<'kg'>;
export type Pounds = Quantity<'lb'>;
export type KilometresPerHour = Quantity<'km/h'>;
export type Knots = Quantity<'kn'>;
export type Degrees = Quantity<'deg'>;

// Exact by international definition.
export const METRES_PER_FOOT = 0.3048;
export const METRES_PER_NAUTICAL_MILE = 1852;
export const METRES_PER_STATUTE_MILE = 1609.344;
export const KILOGRAMS_PER_POUND = 0.45359237;

function quantity<U extends string>(value: number, name: string): Quantity<U> {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite number, got ${value}`);
  }
  return value as Quantity<U>;
}

export const metres = (value: number): Metres => quantity(value, 'Metres');
export const feet = (value: number): Feet => quantity(value, 'Feet');
export const kilometres = (value: number): Kilometres => quantity(value, 'Kilometres');
export const nauticalMiles = (value: number): NauticalMiles => quantity(value, 'Nautical miles');
export const kilograms = (value: number): Kilograms => quantity(value, 'Kilograms');
export const pounds = (value: number): Pounds => quantity(value, 'Pounds');
export const kilometresPerHour = (value: number): KilometresPerHour =>
  quantity(value, 'Kilometres per hour');
export const knots = (value: number): Knots => quantity(value, 'Knots');
export const degrees = (value: number): Degrees => quantity(value, 'Degrees');

export const feetToMetres = (value: Feet): Metres => metres(value * METRES_PER_FOOT);
export const metresToFeet = (value: Metres): Feet => feet(value / METRES_PER_FOOT);
export const metresToKilometres = (value: Metres): Kilometres => kilometres(value / 1000);
export const kilometresToMetres = (value: Kilometres): Metres => metres(value * 1000);
export const nauticalMilesToMetres = (value: NauticalMiles): Metres =>
  metres(value * METRES_PER_NAUTICAL_MILE);
export const metresToNauticalMiles = (value: Metres): NauticalMiles =>
  nauticalMiles(value / METRES_PER_NAUTICAL_MILE);
export const poundsToKilograms = (value: Pounds): Kilograms =>
  kilograms(value * KILOGRAMS_PER_POUND);
export const kilogramsToPounds = (value: Kilograms): Pounds => pounds(value / KILOGRAMS_PER_POUND);
/** One knot is one nautical mile per hour. */
export const knotsToKilometresPerHour = (value: Knots): KilometresPerHour =>
  kilometresPerHour((value * METRES_PER_NAUTICAL_MILE) / 1000);
export const kilometresPerHourToKnots = (value: KilometresPerHour): Knots =>
  knots((value * 1000) / METRES_PER_NAUTICAL_MILE);
