// tests/providers/jobsch.test.mjs — provider for the jobs.ch public search API.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — jobsch');

try {
  const jobschModule = await import(pathToFileURL(join(ROOT, 'providers/jobsch.mjs')).href);
  const jobsch = jobschModule.default;
  const { normalizeJobsChDoc } = jobschModule;

  if (jobsch.id === 'jobsch') pass('jobsch.id is "jobsch"');
  else fail(`jobsch.id is ${JSON.stringify(jobsch.id)}`);

  // normalizeJobsChDoc — field mapping + trim + ISO date → epoch ms.
  const full = normalizeJobsChDoc(
    {
      title: '  ML Engineer  ',
      company_name: '  Acme AG  ',
      place: '  Zürich  ',
      publication_date: '2026-07-07T09:35:51+02:00',
      _links: { detail_en: { href: '  https://www.jobs.ch/en/vacancies/detail/abc/  ' } },
    },
    'Fallback',
  );
  if (full && full.title === 'ML Engineer' && full.url === 'https://www.jobs.ch/en/vacancies/detail/abc/'
      && full.company === 'Acme AG' && full.location === 'Zürich'
      && full.postedAt === Date.parse('2026-07-07T09:35:51+02:00')) {
    pass('normalizeJobsChDoc maps + trims title/company/place, picks detail link, parses ISO date → ms');
  } else {
    fail(`normalizeJobsChDoc full row = ${JSON.stringify(full)}`);
  }

  // Link preference: detail_en > detail_de > detail_fr.
  const enOverDe = normalizeJobsChDoc({
    title: 'T', _links: {
      detail_de: { href: 'https://www.jobs.ch/de/x/' },
      detail_en: { href: 'https://www.jobs.ch/en/x/' },
    },
  });
  const deOverFr = normalizeJobsChDoc({
    title: 'T', _links: {
      detail_fr: { href: 'https://www.jobs.ch/fr/x/' },
      detail_de: { href: 'https://www.jobs.ch/de/x/' },
    },
  });
  if (enOverDe?.url === 'https://www.jobs.ch/en/x/' && deOverFr?.url === 'https://www.jobs.ch/de/x/') {
    pass('normalizeJobsChDoc prefers detail_en, then detail_de, then detail_fr');
  } else {
    fail(`normalizeJobsChDoc link preference = ${JSON.stringify({ a: enOverDe?.url, b: deOverFr?.url })}`);
  }

  // company fallbacks: entry name, then "jobs.ch".
  const coFromEntry = normalizeJobsChDoc({ title: 'T', company_name: '', _links: { detail_de: { href: 'https://www.jobs.ch/de/c1/' } } }, 'Entry Name');
  const coDefault = normalizeJobsChDoc({ title: 'T', _links: { detail_de: { href: 'https://www.jobs.ch/de/c2/' } } });
  if (coFromEntry?.company === 'Entry Name' && coDefault?.company === 'jobs.ch') {
    pass('normalizeJobsChDoc falls back company → entry name → "jobs.ch"');
  } else {
    fail(`normalizeJobsChDoc company fallbacks = ${JSON.stringify({ a: coFromEntry?.company, b: coDefault?.company })}`);
  }

  // drops: empty title, no link, non-https link, off-host link, malformed link, non-object.
  const drops = [
    normalizeJobsChDoc({ title: '', _links: { detail_de: { href: 'https://www.jobs.ch/de/d1/' } } }),
    normalizeJobsChDoc({ title: 'No link' }),
    normalizeJobsChDoc({ title: 'Insecure', _links: { detail_de: { href: 'http://www.jobs.ch/de/d3/' } } }),
    normalizeJobsChDoc({ title: 'Off host', _links: { detail_de: { href: 'https://evil.example/de/d4/' } } }),
    normalizeJobsChDoc({ title: 'Malformed', _links: { detail_de: { href: 'not-a-url' } } }),
    normalizeJobsChDoc(null),
  ];
  if (drops.every(r => r === null)) pass('normalizeJobsChDoc drops empty-title / no-link / non-https / off-host / malformed / non-object');
  else fail(`normalizeJobsChDoc drops = ${JSON.stringify(drops)}`);

  // missing / unparseable publication_date → no postedAt key.
  const noDate = normalizeJobsChDoc({ title: 'T', _links: { detail_de: { href: 'https://www.jobs.ch/de/nd/' } } });
  const badDate = normalizeJobsChDoc({ title: 'T', publication_date: 'not-a-date', _links: { detail_de: { href: 'https://www.jobs.ch/de/bd/' } } });
  if (noDate && !('postedAt' in noDate) && badDate && !('postedAt' in badDate)) {
    pass('normalizeJobsChDoc omits postedAt when publication_date is absent or unparseable');
  } else {
    fail(`normalizeJobsChDoc postedAt presence = ${JSON.stringify({ a: noDate, b: badDate })}`);
  }

  // fetch(): builds ?query=&location=&rows=20&page=N, paginates, stops on num_pages, dedups by URL.
  const mk = (i) => ({ title: `Role ${i}`, company_name: `Co ${i}`, place: 'Zürich', publication_date: '2026-07-07T09:35:51+02:00', _links: { detail_en: { href: `https://www.jobs.ch/en/x${i}/` } } });
  const requested = [];
  const pagedFetch = async (url, opts) => {
    requested.push({ url, redirect: opts?.redirect });
    const u = new URL(url);
    const page = Number(u.searchParams.get('page'));
    if (page === 1) return { num_pages: 2, current_page: 1, documents: Array.from({ length: 20 }, (_, i) => mk(i)) };
    // page 2 repeats one doc (x0) to prove cross-page dedup, plus a fresh one.
    if (page === 2) return { num_pages: 2, current_page: 2, documents: [mk(0), mk(100)] };
    return { num_pages: 2, current_page: page, documents: [] };
  };
  const entry = { name: 'jobs.ch', jobsch: { keywords: ['Machine Learning'], location: 'Zürich', max_pages: 5 } };
  const paged = await jobsch.fetch(entry, { fetchJson: pagedFetch });

  if (requested.length === 2) {
    const u1 = new URL(requested[0].url);
    if (u1.origin + u1.pathname === 'https://www.jobs.ch/api/v1/public/search'
        && u1.searchParams.get('query') === 'Machine Learning'
        && u1.searchParams.get('location') === 'Zürich'
        && u1.searchParams.get('rows') === '20'
        && u1.searchParams.get('page') === '1') {
      pass('jobsch.fetch() builds query/location/rows=20/page params and stops at num_pages');
    } else {
      fail(`jobsch.fetch() page-1 URL = ${requested[0].url}`);
    }
  } else {
    fail(`jobsch.fetch() requested ${requested.length} pages (expected 2)`);
  }

  if (requested.every(r => r.redirect === 'error')) pass('jobsch.fetch() passes redirect:"error" on every page (SSRF guard)');
  else fail(`jobsch.fetch() redirect opts = ${JSON.stringify(requested.map(r => r.redirect))}`);

  // 20 from page 1 + 1 new from page 2 (the repeated x0 is deduped) = 21.
  if (paged.length === 21) pass('jobsch.fetch() aggregates across pages and dedups repeated URLs (20 + 1)');
  else fail(`jobsch.fetch() returned ${paged.length} jobs (expected 21)`);

  // max_pages cap: only the first page is requested even when num_pages is higher.
  const capRequested = [];
  await jobsch.fetch(
    { name: 'jobs.ch', jobsch: { keywords: ['ML'], location: 'Zürich', max_pages: 1 } },
    { fetchJson: async (url) => { capRequested.push(url); return { num_pages: 9, documents: Array.from({ length: 20 }, (_, i) => mk(i)) }; } },
  );
  if (capRequested.length === 1) pass('jobsch.fetch() honors max_pages (stops at the cap even with more pages available)');
  else fail(`jobsch.fetch() max_pages:1 requested ${capRequested.length} pages`);

  // multiple keywords → one pass each.
  const kwRequested = [];
  await jobsch.fetch(
    { name: 'jobs.ch', jobsch: { keywords: ['ML', 'AI'], location: '', max_pages: 1 } },
    { fetchJson: async (url) => { kwRequested.push(new URL(url).searchParams.get('query')); return { num_pages: 1, documents: [mk(0)] }; } },
  );
  if (kwRequested.length === 2 && kwRequested[0] === 'ML' && kwRequested[1] === 'AI') {
    pass('jobsch.fetch() issues one pass per keyword');
  } else {
    fail(`jobsch.fetch() keyword passes = ${JSON.stringify(kwRequested)}`);
  }

  // unexpected API response → throws.
  let badThrew = false;
  try {
    await jobsch.fetch({ name: 'X', jobsch: { keywords: ['ML'] } }, { fetchJson: async () => ({ wrong: true }) });
  } catch (e) {
    badThrew = /unexpected API response/.test(e.message);
  }
  if (badThrew) pass('jobsch.fetch() throws on unexpected API response shape');
  else fail('jobsch.fetch() should throw when the documents array is absent');

} catch (e) {
  fail(`jobsch provider tests crashed: ${e.message}`);
}
