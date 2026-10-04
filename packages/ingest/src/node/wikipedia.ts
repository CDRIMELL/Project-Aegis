import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { CuratedAircraftType, ExtractedAttributesFile } from '../sources/aircraft';
import { extractAircraftSpecs } from '../sources/wikipedia-specs';
import { CURATED_ATTRIBUTES, REPO_ROOT } from './raw';

const API = 'https://en.wikipedia.org/w/api.php';
/**
 * Wikimedia asks automated clients to identify themselves. Set AEGIS_CONTACT to an address or URL
 * where the operator can be reached; it is sent only to Wikipedia, in this header.
 */
const USER_AGENT = `AEGIS-reference-data/0.1 (aircraft specification extract; contact: ${process.env.AEGIS_CONTACT ?? 'not provided'})`;
/** One request per article, spaced out. The whole run is about forty requests. */
const REQUEST_SPACING_MS = 3000;
const MAX_RETRIES = 4;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function request(query: URLSearchParams): Promise<Response> {
  return fetch(`${API}?${query.toString()}`, { headers: { 'User-Agent': USER_AGENT } });
}

const apiResponse = z.object({
  query: z.object({
    pages: z.array(
      z.object({
        title: z.string(),
        missing: z.boolean().optional(),
        revisions: z
          .array(
            z.object({
              revid: z.int(),
              timestamp: z.string(),
              slots: z.object({ main: z.object({ content: z.string() }) }),
            }),
          )
          .optional(),
      }),
    ),
  }),
});

async function fetchArticle(title: string) {
  const query = new URLSearchParams({
    action: 'query',
    prop: 'revisions',
    rvprop: 'ids|timestamp|content',
    rvslots: 'main',
    redirects: '1',
    titles: title,
    format: 'json',
    formatversion: '2',
  });
  let response = await request(query);
  for (let attempt = 1; response.status === 429 && attempt <= MAX_RETRIES; attempt++) {
    const retryAfter = Number(response.headers.get('retry-after'));
    await pause(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 5000);
    response = await request(query);
  }
  if (!response.ok) {
    throw new Error(`Wikipedia returned HTTP ${response.status} for "${title}"`);
  }
  const page = apiResponse.parse(await response.json()).query.pages[0];
  const revision = page?.revisions?.[0];
  if (!page || page.missing || !revision) {
    return null;
  }
  return {
    page: page.title,
    revisionId: revision.revid,
    revisionTimestamp: revision.timestamp,
    wikitext: revision.slots.main.content,
  };
}

export interface SpecsOutcome {
  readonly slug: string;
  readonly page: string;
  readonly status: 'extracted' | 'no_template' | 'missing_article' | 'not_applicable';
  readonly heading: string | null;
  readonly attributeCount: number;
}

/**
 * Retrieves each curated type's article and writes the extracted characteristics to
 * `data/curated/aircraft-attributes.wikipedia.json`, recording the exact revision read.
 *
 * This is the only step that contacts Wikipedia. Imports read the committed file, so they are
 * reproducible and work offline.
 */
export async function refreshAircraftSpecs(
  types: readonly CuratedAircraftType[],
  now: () => Date,
): Promise<SpecsOutcome[]> {
  const outcomes: SpecsOutcome[] = [];
  const extracted: ExtractedAttributesFile['types'] = {};
  let requested = false;

  for (const type of [...types].sort((a, b) => a.slug.localeCompare(b.slug))) {
    if (type.specsNotApplicable) {
      outcomes.push({
        slug: type.slug,
        page: type.wikipedia,
        status: 'not_applicable',
        heading: null,
        attributeCount: 0,
      });
      continue;
    }
    if (requested) await pause(REQUEST_SPACING_MS);
    requested = true;
    const article = await fetchArticle(type.wikipedia);
    if (!article) {
      outcomes.push({
        slug: type.slug,
        page: type.wikipedia,
        status: 'missing_article',
        heading: null,
        attributeCount: 0,
      });
      continue;
    }
    const specs = extractAircraftSpecs(article.wikitext);
    outcomes.push({
      slug: type.slug,
      page: article.page,
      status: specs ? 'extracted' : 'no_template',
      heading: specs?.heading ?? null,
      attributeCount: specs?.attributes.length ?? 0,
    });
    if (specs && specs.attributes.length > 0) {
      extracted[type.slug] = {
        page: article.page,
        revisionId: article.revisionId,
        revisionTimestamp: article.revisionTimestamp,
        heading: specs.heading,
        attributes: specs.attributes,
      };
    }
  }

  const file: ExtractedAttributesFile = { retrievedAt: now().toISOString(), types: extracted };
  writeFileSync(join(REPO_ROOT, CURATED_ATTRIBUTES), `${JSON.stringify(file, null, 2)}\n`);
  return outcomes;
}
