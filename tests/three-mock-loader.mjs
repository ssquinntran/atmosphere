/**
 * Node.js ESM loader hook that intercepts `'three'` and `'three/...'` imports
 * and redirects them to `./tests/three-mock.js` so tests run headlessly without a browser.
 */
import { pathToFileURL } from 'url';
import path from 'path';

const mockPath = pathToFileURL(path.resolve('./tests/three-mock.js')).href;

/** Resolve Three.js module specifiers to the deterministic mock implementation. */
export function resolve(specifier, context, defaultResolve) {
  if (specifier === 'three' || specifier.startsWith('three/')) {
    return { url: mockPath };
  }
  return defaultResolve(specifier, context, defaultResolve);
}
