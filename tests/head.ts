// Shared helpers for the metadata tests: read index.html's <head> and the files in public/.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

export const ORIGIN = 'https://merlin.aravhawk.com';
export const root = new URL('../', import.meta.url);

export const html = readFileSync(new URL('index.html', root), 'utf8');
export const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
export const title = /<title>([^<]*)<\/title>/.exec(head)?.[1] ?? '';

export type Attrs = Record<string, string>;

export function tags(name: 'meta' | 'link'): Attrs[] {
  return [...head.matchAll(new RegExp(`<${name}\\s([^>]*?)/?>`, 'g'))].map((m) => {
    const attrs: Attrs = {};
    for (const a of m[1].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    return attrs;
  });
}

export const metas = tags('meta');
export const links = tags('link');

/** Content of the one meta tag whose `key` attribute (property or name) equals `value`. */
export function meta(key: 'property' | 'name', value: string): string {
  const found = metas.filter((m) => m[key] === value);
  assert.equal(found.length, 1, `expected exactly one <meta ${key}="${value}">, found ${found.length}`);
  return found[0].content;
}

/** href of the <link> tags with this rel (optionally narrowed by a predicate). */
export function linksFor(rel: string, pick: (l: Attrs) => boolean = () => true): Attrs[] {
  return links.filter((l) => l.rel === rel && pick(l));
}

export const readPublic = (name: string): Buffer => readFileSync(new URL(`public/${name}`, root));
export const publicSize = (name: string): number => statSync(new URL(`public/${name}`, root)).size;

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(png: Buffer): { width: number; height: number } {
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG', 'not a PNG');
  assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Turns a site URL into the file it is served from in public/. */
export function publicFileFor(href: string): string {
  const url = new URL(href, `${ORIGIN}/`);
  assert.equal(url.origin, ORIGIN, `${href} is not on the production origin`);
  return url.pathname.replace(/^\//, '');
}
