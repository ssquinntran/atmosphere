import { pathToFileURL } from 'url';
import path from 'path';

const mockPath = pathToFileURL(path.resolve('./tests/three-mock.js')).href;

export function resolve(specifier, context, defaultResolve) {
  if (specifier === 'three' || specifier.startsWith('three/')) {
    return { url: mockPath };
  }
  return defaultResolve(specifier, context, defaultResolve);
}
