// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// jobs.ch provider — the largest Swiss job board, public JSON search API:
// GET https://www.jobs.ch/api/v1/public/search?query=<kw>&location=<loc>&rows=20&page=<n>
// Response shape: { start, rows, num_pages, current_page, total_hits,
//   documents: [ { title, company_name, place, publication_date, is_active,
//   _links: { detail_de|detail_fr|detail_en: { href } } } ], ... }
//
// Bundesagentur (the primary German feed) never returns Swiss roles, so this
// fills the Zürich/Switzerland gap alongside the direct Swiss ATS anchors
// (Lakera, Scandit, Cradle, NVIDIA-CH). Zero-token: a public JSON endpoint.
//
// Config (portals.yml, `provider: jobsch`):
//   jobsch:
//     keywords: ["Machine Learning", "AI Engineer", ...]   # OR-searched, one pass each
//     location: "Zürich"                                    # server-side place filter (optional)
//     max_pages: 5                                          # per-keyword page cap (optional)
//
// Notes: the API rejects rows > 20 (HTTP 422), so pages are 20 rows each.

const SEARCH_BASE = 'https://www.jobs.ch/api/v1/public/search';
const TRUSTED_HOST = 'www.jobs.ch';
const PER_PAGE = 20;            // hard server cap — larger `rows` returns 422
const DEFAULT_MAX_PAGES = 5;
const MAX_PAGES_CAP = 15;

/** Resolve the per-keyword page cap: a positive integer `max_pages`, capped. */
function resolveMaxPages(entry) {
  const v = entry?.jobsch?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/** Keywords to OR-search; falls back to a single empty query (whole board). */
function resolveKeywords(entry) {
  const kw = entry?.jobsch?.keywords;
  if (Array.isArray(kw)) {
    const cleaned = kw.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim());
    if (cleaned.length) return cleaned;
  }
  return ['']; // no keywords → let title_filter in scan.mjs do the gating
}

/**
 * Normalize a single jobs.ch document. Exported for unit tests.
 *
 * Field mapping → the normalized Job shape:
 *   - title:    `title`, trimmed (items without one are dropped).
 *   - url:      first available `_links.detail_{en,de,fr}.href` — an absolute
 *               `https:` posting URL host-locked to www.jobs.ch (off-host or
 *               non-https drops the item). It is the dedup key, display-only.
 *   - company:  `company_name`, falling back to the portal entry name, then "jobs.ch".
 *   - location: `place`, trimmed.
 *   - postedAt: `publication_date` (ISO 8601) → epoch ms (omitted if unparseable).
 *
 * @param {any} j
 * @param {string} [fallbackCompany]
 * @returns {{ title: string, url: string, company: string, location: string, postedAt?: number } | null}
 */
export function normalizeJobsChDoc(j, fallbackCompany) {
  if (!j || typeof j !== 'object') return null;

  const title = typeof j.title === 'string' ? j.title.trim() : '';
  if (!title) return null;

  // Pick the first detail link that is an absolute https URL on www.jobs.ch.
  const links = (j._links && typeof j._links === 'object') ? j._links : {};
  let url = '';
  for (const key of ['detail_en', 'detail_de', 'detail_fr']) {
    const raw = links[key] && typeof links[key].href === 'string' ? links[key].href.trim() : '';
    if (!raw) continue;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'https:' && parsed.hostname === TRUSTED_HOST) { url = parsed.href; break; }
    } catch {
      // malformed → try the next link
    }
  }
  if (!url) return null;

  const company =
    typeof j.company_name === 'string' && j.company_name.trim()
      ? j.company_name.trim()
      : fallbackCompany || 'jobs.ch';

  const location = typeof j.place === 'string' ? j.place.trim() : '';

  /** @type {{ title: string, url: string, company: string, location: string, postedAt?: number }} */
  const job = { title, url, company, location };
  if (typeof j.publication_date === 'string') {
    const ms = Date.parse(j.publication_date);
    if (Number.isFinite(ms)) job.postedAt = ms;
  }
  return job;
}

/** @param {string} keyword @param {string} location @param {number} page */
function buildSearchUrl(keyword, location, page) {
  const params = new URLSearchParams({ rows: String(PER_PAGE), page: String(page) });
  if (keyword) params.set('query', keyword);
  if (location) params.set('location', location);
  return `${SEARCH_BASE}?${params.toString()}`;
}

/** @type {Provider} */
export default {
  id: 'jobsch',

  async fetch(entry, ctx) {
    const maxPages = resolveMaxPages(entry);
    const keywords = resolveKeywords(entry);
    const location = typeof entry?.jobsch?.location === 'string' ? entry.jobsch.location.trim() : '';
    const fallbackCompany = entry?.name;

    const out = [];
    const seen = new Set(); // dedup by posting URL across overlapping keyword passes

    for (const keyword of keywords) {
      for (let page = 1; page <= maxPages; page++) {
        const url = buildSearchUrl(keyword, location, page);
        // redirect:'error' prevents SSRF via server-side redirects
        const json = await ctx.fetchJson(url, { redirect: 'error' });
        if (!json || !Array.isArray(json.documents)) {
          throw new Error(
            `jobsch: unexpected API response on "${keyword}" page ${page} — expected { documents: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`,
          );
        }
        for (const doc of json.documents) {
          const normalized = normalizeJobsChDoc(doc, fallbackCompany);
          if (normalized && !seen.has(normalized.url)) {
            seen.add(normalized.url);
            out.push(normalized);
          }
        }
        // Stop when the API reports the last page, or a short/empty page arrives.
        const numPages = Number.isFinite(json.num_pages) ? json.num_pages : null;
        if (json.documents.length < PER_PAGE) break;
        if (numPages !== null && page >= numPages) break;
      }
    }
    return out;
  },
};
