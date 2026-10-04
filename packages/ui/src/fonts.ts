import monoLatinExt from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-ext-500-normal.woff2?url';
import monoLatin from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2?url';
import sansLatinExt from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-ext-500-normal.woff2?url';
import sansLatin from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2?url';

/*
 * The bundled font files, for renderers that draw text themselves instead of through CSS (the
 * map). Same files the stylesheet uses, so canvas text matches interface text. Nothing is fetched
 * from a network.
 */

export interface FontFile {
  readonly url: string;
  /** Code points this file covers, in CSS `unicode-range` notation. */
  readonly unicodeRange: readonly string[];
}

const LATIN = ['U+0000-00FF', 'U+2000-206F'];
const LATIN_EXTENDED = ['U+0100-02FF', 'U+1E00-1EFF'];

/** IBM Plex Sans Medium: interface and label text. */
export const SANS_FONT_FILES: readonly FontFile[] = [
  { url: sansLatin, unicodeRange: LATIN },
  { url: sansLatinExt, unicodeRange: LATIN_EXTENDED },
];

/** IBM Plex Mono Medium: identifiers and telemetry. */
export const MONO_FONT_FILES: readonly FontFile[] = [
  { url: monoLatin, unicodeRange: LATIN },
  { url: monoLatinExt, unicodeRange: LATIN_EXTENDED },
];
