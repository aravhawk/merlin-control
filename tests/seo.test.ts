// Guards the technical SEO surface: robots, sitemap, structured data, icons, manifest and language.
// The site is one English page on one domain, so there is no hreflang and no per-route head.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ORIGIN, head, html, linksFor, meta, metas, pngSize, publicFileFor, readPublic } from './head.ts';

const text = (name: string) => readPublic(name).toString('utf8');
const emDash = String.fromCharCode(0x2014);

// ── language and robots ───────────────────────────────────────────────────────

test('the document language is declared, and every other language hint agrees with it', () => {
  assert.match(html, /<html lang="en">/);
  assert.equal(meta('property', 'og:locale'), 'en_US');
  assert.equal(JSON.parse(text('manifest.webmanifest')).lang, 'en');
});

test('production is indexable: robots meta says index, follow and never noindex', () => {
  const robots = meta('name', 'robots').toLowerCase();
  const directives = robots.split(',').map((d) => d.trim());
  assert.ok(directives.includes('index'), robots);
  assert.ok(directives.includes('follow'), robots);
  assert.ok(!/noindex|nofollow|none/.test(robots), robots);
  assert.ok(directives.includes('max-image-preview:large'), 'large previews are what the share card is for');
  const markup = head.replace(/<!--[\s\S]*?-->/g, ''); // a comment may mention the word, a tag may not
  assert.ok(!/noindex/i.test(markup), 'no noindex anywhere in the head');
});

test('there is no hreflang, because the site is not multilingual', () => {
  assert.equal(linksFor('alternate').filter((l) => 'hreflang' in l).length, 0);
});

// ── robots.txt and sitemap.xml ────────────────────────────────────────────────

test('robots.txt allows crawling and points at the sitemap on the production domain', () => {
  const lines = text('robots.txt').split('\n').map((l) => l.trim());
  assert.ok(lines.includes('User-agent: *'));
  assert.ok(lines.includes('Allow: /'));
  assert.ok(!lines.includes('Disallow: /'), 'robots.txt must not block the whole site');
  assert.ok(lines.includes(`Sitemap: ${ORIGIN}/sitemap.xml`));
});

test('sitemap.xml lists the canonical URL and nothing off the production domain', () => {
  const xml = text('sitemap.xml');
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const canonical = linksFor('canonical')[0].href;
  assert.deepEqual(locs, [canonical], 'one page, one URL, and it is the canonical one');
  assert.equal((xml.match(/<url>/g) ?? []).length, locs.length);
});

// ── structured data ───────────────────────────────────────────────────────────

type Node = Record<string, unknown>;
const ldBlocks = [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test('JSON-LD is one valid graph with a WebSite, a WebApplication and a Person', () => {
  assert.equal(ldBlocks.length, 1);
  const doc = JSON.parse(ldBlocks[0]) as { '@context': string; '@graph': Node[] };
  assert.equal(doc['@context'], 'https://schema.org');
  const byType = (t: string) => doc['@graph'].filter((n) => n['@type'] === t);
  assert.equal(byType('WebSite').length, 1);
  assert.equal(byType('WebApplication').length, 1);
  assert.equal(byType('Person').length, 1);
  // Nothing that does not exist here: there is no organization and no article.
  assert.equal(doc['@graph'].length, 3);
});

test('JSON-LD agrees with the page and every reference resolves', () => {
  const doc = JSON.parse(ldBlocks[0]) as { '@graph': Node[] };
  const nodes = doc['@graph'];
  const ids = new Set(nodes.map((n) => n['@id']));
  const app = nodes.find((n) => n['@type'] === 'WebApplication')!;
  const site = nodes.find((n) => n['@type'] === 'WebSite')!;

  assert.equal(site.url, `${ORIGIN}/`);
  assert.equal(app.url, `${ORIGIN}/`);
  assert.equal(app.name, meta('property', 'og:site_name'));
  assert.equal(app.description, meta('name', 'description'));
  assert.equal(app.image, meta('property', 'og:image'));
  assert.equal(app.inLanguage, 'en');
  for (const key of ['applicationCategory', 'operatingSystem', 'browserRequirements']) {
    assert.equal(typeof app[key], 'string', `${key} is required`);
  }
  assert.deepEqual(app.offers, { '@type': 'Offer', price: '0', priceCurrency: 'USD' });

  // Every {"@id": ...} reference points at a node that is in the graph.
  const refs: unknown[] = [];
  const walk = (v: unknown, top: boolean): void => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, false));
    if (v && typeof v === 'object') {
      const o = v as Node;
      if (!top && Object.keys(o).length === 1 && '@id' in o) refs.push(o['@id']);
      Object.values(o).forEach((x) => walk(x, false));
    }
  };
  nodes.forEach((n) => walk(n, true));
  assert.ok(refs.length >= 3, 'the graph should link its nodes together');
  for (const ref of refs) assert.ok(ids.has(ref), `unresolved @id ${String(ref)}`);

  // Site-owned ids and urls stay on the production domain.
  for (const n of [site, app]) assert.ok(String(n['@id']).startsWith(`${ORIGIN}/`));
  assert.ok(!ldBlocks[0].includes(emDash));
});

// ── icons and manifest ────────────────────────────────────────────────────────

test('icon links resolve to real files of the declared size and type', () => {
  const icons = linksFor('icon');
  assert.ok(icons.some((l) => l.type === 'image/svg+xml'), 'an SVG icon for modern browsers');
  assert.ok(icons.some((l) => l.href === '/favicon.ico'), 'a legacy .ico at the site root');
  const apple = linksFor('apple-touch-icon');
  assert.equal(apple.length, 1);

  for (const l of [...icons, ...apple]) {
    const file = l.href.replace(/^\//, '');
    const data = readPublic(file);
    if (l.type === 'image/png' || file.endsWith('.png')) {
      const want = (l.sizes ?? '180x180').split('x').map(Number);
      const got = pngSize(data);
      assert.deepEqual([got.width, got.height], want, `${file} is ${got.width}x${got.height}`);
    }
  }
  const svg = text('favicon.svg');
  assert.match(svg, /<svg [^>]*viewBox="0 0 512 512"/);
});

test('favicon.ico holds 16, 32 and 48 pixel images', () => {
  const ico = readPublic('favicon.ico');
  assert.equal(ico.readUInt16LE(0), 0, 'reserved');
  assert.equal(ico.readUInt16LE(2), 1, 'type 1 is an icon');
  const count = ico.readUInt16LE(4);
  const sizes: number[] = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    sizes.push(ico[at]);
    const length = ico.readUInt32LE(at + 8);
    const offset = ico.readUInt32LE(at + 12);
    assert.equal(ico.subarray(offset + 1, offset + 4).toString('latin1'), 'PNG');
    assert.ok(offset + length <= ico.length);
  }
  assert.deepEqual(sizes.sort((a, b) => a - b), [16, 32, 48]);
});

test('the apple touch icon is opaque, because iOS fills transparency with black', () => {
  const png = readPublic('apple-touch-icon.png');
  assert.equal(png[25], 2, 'color type 2 is RGB with no alpha channel');
});

test('the web app manifest is linked, complete and consistent with the head', () => {
  const link = linksFor('manifest');
  assert.equal(link.length, 1);
  assert.equal(link[0].href, '/manifest.webmanifest');
  const manifest = JSON.parse(text('manifest.webmanifest')) as Record<string, unknown> & {
    icons: { src: string; sizes: string; type: string; purpose: string }[];
  };
  assert.equal(manifest.name, meta('property', 'og:site_name'));
  assert.equal(manifest.short_name, 'Merlin 1D');
  assert.equal(manifest.theme_color, meta('name', 'theme-color'));
  assert.equal(manifest.background_color, meta('name', 'theme-color'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './');

  const purposes = manifest.icons.map((i) => `${i.sizes}:${i.purpose}`);
  for (const need of ['192x192:any', '512x512:any', '512x512:maskable']) assert.ok(purposes.includes(need), `missing ${need}`);
  for (const icon of manifest.icons) {
    const { width, height } = pngSize(readPublic(icon.src));
    assert.equal(`${width}x${height}`, icon.sizes, icon.src);
    assert.equal(icon.type, 'image/png');
  }
});

// ── hygiene ───────────────────────────────────────────────────────────────────

test('absolute URLs in the SEO files stay on the production domain', () => {
  for (const file of ['robots.txt', 'sitemap.xml', 'manifest.webmanifest']) {
    for (const url of text(file).match(/https?:\/\/[^\s"<]+/g) ?? []) {
      if (url.startsWith('http://www.sitemaps.org/')) continue; // XML namespace, not a link
      assert.ok(url.startsWith(`${ORIGIN}/`), `${file} links to ${url}`);
    }
  }
});

test('no em dashes in any SEO file or in the head', () => {
  for (const file of ['robots.txt', 'sitemap.xml', 'manifest.webmanifest', 'favicon.svg']) {
    assert.ok(!text(file).includes(emDash), `${file} has an em dash`);
  }
  assert.ok(!head.includes(emDash));
});

test('every URL the head points at inside this site exists in public/', () => {
  const hrefs = [...linksFor('icon'), ...linksFor('apple-touch-icon'), ...linksFor('manifest')].map((l) => l.href);
  hrefs.push(meta('property', 'og:image'), meta('name', 'twitter:image'));
  for (const href of hrefs) assert.ok(readPublic(publicFileFor(href)).length > 0, `${href} is missing`);
  assert.ok(metas.length > 20);
});
