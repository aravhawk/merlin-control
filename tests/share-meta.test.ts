// Guards the Open Graph / Twitter card metadata in index.html and the share image it points at.
// The app is a single page (no router), so one document head covers every URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const ORIGIN = 'https://merlin.aravhawk.com';
const root = new URL('../', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');
const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));

type Attrs = Record<string, string>;

function tags(name: 'meta' | 'link'): Attrs[] {
  return [...head.matchAll(new RegExp(`<${name}\\s([^>]*?)/?>`, 'g'))].map((m) => {
    const attrs: Attrs = {};
    for (const a of m[1].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    return attrs;
  });
}

const metas = tags('meta');
const links = tags('link');

/** Content of the one meta tag whose `key` attribute (property or name) equals `value`. */
function meta(key: 'property' | 'name', value: string): string {
  const found = metas.filter((m) => m[key] === value);
  assert.equal(found.length, 1, `expected exactly one <meta ${key}="${value}">, found ${found.length}`);
  return found[0].content;
}

const title = /<title>([^<]*)<\/title>/.exec(head)?.[1] ?? '';

test('canonical link points at the production domain', () => {
  const canonical = links.filter((l) => l.rel === 'canonical');
  assert.equal(canonical.length, 1);
  assert.equal(canonical[0].href, `${ORIGIN}/`);
});

test('Open Graph text tags are complete and consistent', () => {
  assert.equal(meta('property', 'og:type'), 'website');
  assert.equal(meta('property', 'og:site_name'), 'Merlin 1D');
  assert.equal(meta('property', 'og:locale'), 'en_US');
  assert.equal(meta('property', 'og:url'), `${ORIGIN}/`);
  assert.equal(meta('property', 'og:title'), title);
  assert.equal(meta('property', 'og:description'), meta('name', 'description'));
});

test('Open Graph image is absolute, 1200x630, and has alt text', () => {
  const image = meta('property', 'og:image');
  assert.equal(image, `${ORIGIN}/og-image.png`);
  assert.equal(meta('property', 'og:image:secure_url'), image);
  assert.equal(meta('property', 'og:image:type'), 'image/png');
  assert.equal(meta('property', 'og:image:width'), '1200');
  assert.equal(meta('property', 'og:image:height'), '630');
  assert.ok(meta('property', 'og:image:alt').length >= 40, 'og:image:alt should describe the picture');
});

test('Twitter card is summary_large_image and mirrors the Open Graph values', () => {
  assert.equal(meta('name', 'twitter:card'), 'summary_large_image');
  assert.equal(meta('name', 'twitter:title'), meta('property', 'og:title'));
  assert.equal(meta('name', 'twitter:description'), meta('property', 'og:description'));
  assert.equal(meta('name', 'twitter:image'), meta('property', 'og:image'));
  assert.equal(meta('name', 'twitter:image:alt'), meta('property', 'og:image:alt'));
});

test('title and description fit search and share previews', () => {
  const description = meta('name', 'description');
  assert.ok(title.length > 0 && title.length <= 60, `title is ${title.length} chars`);
  assert.ok(description.length >= 70 && description.length <= 160, `description is ${description.length} chars`);
});

test('head copy has no em dashes', () => {
  const emDash = String.fromCharCode(0x2014);
  assert.ok(!head.includes(emDash), 'found an em dash in <head>');
});

test('every absolute URL in the head uses the production domain', () => {
  const urls = [...head.matchAll(/https?:\/\/[^\s"<]+/g)].map((m) => m[0]);
  assert.ok(urls.length > 0);
  for (const url of urls) assert.ok(url.startsWith(`${ORIGIN}/`), `unexpected origin in ${url}`);
});

test('the share image ships in public/ as a 1200x630 PNG', () => {
  const file = new URL('public/og-image.png', root);
  const png = readFileSync(file);
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
  assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR');
  assert.equal(png.readUInt32BE(16), 1200, 'width');
  assert.equal(png.readUInt32BE(20), 630, 'height');
  assert.ok(statSync(file).size < 600 * 1024, 'keep the share image under 600 kB so scrapers do not drop it');
});
