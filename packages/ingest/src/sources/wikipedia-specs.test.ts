import { describe, expect, it } from 'vitest';
import { extractAircraftSpecs } from './wikipedia-specs';

const ARTICLE = `
==Design==
Some prose with a {{convert|10|m|ft}} template.

==Specifications (CH-47F)==
[[File:Drawing.svg|right|400px|A caption with | a pipe]]
{{Aircraft specs
|ref=Boeing<ref name=B>{{cite web |url=http://example.org |title=Spec}}</ref>
|prime units?=kts
<!-- General characteristics -->
|crew=3 (pilot, copilot, flight engineer)
|capacity=<br>
** 33–55 troops ''or''
** {{cvt|24000|lb|0}} payload
|length ft=98
|length in=10.7
|length note=<ref name=B/>
|height ft=18
|height in=7.8
|empty weight lb=24,578
|max takeoff weight lb=50000<!-- gross -->
|rot dia ft=60
|max speed kts=170
|cruise speed kts=157<ref name=B/>
|range nmi=400
|ferry range nmi=1,216
|ceiling ft=20000
|armament=* some free text that must never be read
|avionics=more free text
}}

==See also==
`;

describe('extractAircraftSpecs', () => {
  const specs = extractAircraftSpecs(ARTICLE);
  const value = (key: string) => specs?.attributes.find((attribute) => attribute.key === key);

  it('finds the specification block and the variant heading above it', () => {
    expect(specs?.heading).toBe('Specifications (CH-47F)');
  });

  it('converts imperial parameters to the stored units', () => {
    expect(value('length_m')).toEqual({
      key: 'length_m',
      value: 30.14,
      sourceText: 'length ft=98 | length in=10.7',
    });
    expect(value('height_m')?.value).toBe(5.68);
    expect(value('rotor_diameter_m')?.value).toBe(18.29);
    expect(value('empty_mass_kg')?.value).toBe(11148);
    expect(value('max_takeoff_mass_kg')?.value).toBe(22680);
    expect(value('max_speed_kmh')?.value).toBe(315);
    expect(value('cruise_speed_kmh')).toEqual({
      key: 'cruise_speed_kmh',
      value: 291,
      sourceText: 'cruise speed kts=157',
    });
    expect(value('range_km')?.value).toBe(741);
    expect(value('ferry_range_km')?.value).toBe(2252);
    expect(value('service_ceiling_m')?.value).toBe(6096);
  });

  it('reads only the supported numeric parameters', () => {
    expect(specs?.attributes.map((attribute) => attribute.key)).toEqual([
      'length_m',
      'rotor_diameter_m',
      'height_m',
      'empty_mass_kg',
      'max_takeoff_mass_kg',
      'max_speed_kmh',
      'cruise_speed_kmh',
      'range_km',
      'ferry_range_km',
      'service_ceiling_m',
    ]);
    expect(JSON.stringify(specs)).not.toMatch(/armament|avionics|troops|free text/);
  });

  it('prefers metric parameters when both are present', () => {
    const metric = extractAircraftSpecs(
      '{{Aircraft specs\n|length m=15.96\n|length ft=52\n|span m=10.95\n}}',
    );
    expect(metric?.attributes).toEqual([
      { key: 'length_m', value: 15.96, sourceText: 'length m=15.96' },
      { key: 'wingspan_m', value: 10.95, sourceText: 'span m=10.95' },
    ]);
  });

  it('leaves out values that are not plain numbers or are implausible', () => {
    const odd = extractAircraftSpecs(
      '{{Aircraft specs\n|length m=about 15\n|span m={{cvt|10|m}}\n|max speed kmh=\n|ceiling m=99\n|range km=2,900\n}}',
    );
    expect(odd?.attributes).toEqual([
      { key: 'range_km', value: 2900, sourceText: 'range km=2,900' },
    ]);
  });

  it('returns null when the article has no specification template', () => {
    expect(extractAircraftSpecs('==Specifications==\n{| class="wikitable"\n|}')).toBeNull();
    expect(extractAircraftSpecs('{{Aircraft specs\n|length m=10')).toBeNull();
  });
});
