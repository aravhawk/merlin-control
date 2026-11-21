// Guards the Open Graph / Twitter card metadata in index.html and the share image it points at.
// The app is a single page (no router), so one document head covers every URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ORIGIN, head, links, meta, metas, pngSize, publicSize, readPublic, title } from './head.ts';

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

test('every absolute URL in a meta or link tag uses the production domain', () => {
  const urls = [...metas, ...links].flatMap((a) => Object.values(a)).filter((v) => /^https?:\/\//.test(v));
  assert.ok(urls.length > 0);
  for (const url of urls) assert.ok(url === ORIGIN || url.startsWith(`${ORIGIN}/`), `unexpected origin in ${url}`);
});

test('the share image ships in public/ as a 1200x630 PNG', () => {
  assert.deepEqual(pngSize(readPublic('og-image.png')), { width: 1200, height: 630 });
  assert.ok(publicSize('og-image.png') < 600 * 1024, 'keep the share image under 600 kB so scrapers do not drop it');
});
