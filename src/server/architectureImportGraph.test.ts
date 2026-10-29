import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * Layer dependency check, computed from the real import graph.
 *
 * `architecture-boundaries.test.ts` asserts "route file X must not contain function Y" as
 * strings, which is useful against re-inlining but blind to imports: adding
 * `import ... from '../services/foo.js'` into a transformer passes every string assertion.
 * This file reads the actual `from '...'` specifiers, resolves them to files, and compares
 * the layer-to-layer edges against a recorded allowlist.
 *
 * The allowlist is the CURRENT graph, so it fails on a NEW edge between layers. Adding one
 * is a deliberate act: record it here with a reason. The one upward edge (services ->
 * routes) is a re-export shim and is called out below; it may not spread.
 */

const SERVER_ROOT = __dirname;
const LAYERS = ['routes', 'proxy-core', 'services', 'transformers', 'db', 'shared', 'executors'] as const;
type Layer = (typeof LAYERS)[number];

function isLayer(value: string): value is Layer {
  return (LAYERS as readonly string[]).includes(value);
}

function layerOf(absolutePath: string): Layer | null {
  const top = relative(SERVER_ROOT, absolutePath).split(/[\\/]/)[0];
  return isLayer(top) ? top : null;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const IMPORT_SPECIFIER = /from\s+['"](\.[^'"]+)['"]/g;

function collectEdges(): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const file of sourceFiles(SERVER_ROOT)) {
    const from = layerOf(file);
    if (!from) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1];
      const target = specifier.replace(/\.js$/, '.ts');
      const to = layerOf(resolve(dirname(file), target));
      if (!to || to === from) continue;
      const key = `${from} -> ${to}`;
      const examples = edges.get(key) ?? [];
      if (examples.length < 3 && !examples.includes(relative(SERVER_ROOT, file))) {
        examples.push(relative(SERVER_ROOT, file));
      }
      edges.set(key, examples);
    }
  }
  return edges;
}

/** Layer pairs that exist today. A new pair means a new architectural direction. */
const ALLOWED_EDGES = [
  'db -> shared',
  'proxy-core -> db',
  'proxy-core -> services',
  'proxy-core -> shared',
  'proxy-core -> transformers',
  'routes -> db',
  'routes -> proxy-core',
  'routes -> services',
  'routes -> shared',
  'routes -> transformers',
  'services -> db',
  'services -> proxy-core',
  'services -> routes',
  'services -> shared',
  'services -> transformers',
  'transformers -> shared',
];

describe('layer dependency direction', () => {
  it('has exactly the recorded layer edges', () => {
    const edges = collectEdges();
    const actual = [...edges.keys()].sort();
    expect(actual).toEqual([...ALLOWED_EDGES].sort());
  });

  it('never lets a transformer reach above its own layer', () => {
    // transformers is the bottom of the protocol stack: it may depend on shared helpers and
    // on nothing that owns a request, a channel or a table.
    const edges = collectEdges();
    const upward = [...edges.keys()].filter((edge) => edge.startsWith('transformers -> ')).sort();
    expect(upward).toEqual(['transformers -> shared']);
  });

  it('keeps the single upward edge to one shim', () => {
    // services -> routes is a re-export shim (services/runtimeDispatch.ts forwards
    // dispatchRuntimeRequest from routes/proxy/runtimeExecutor.ts) so services can import
    // "the runtime dispatcher" without naming a route. It is the only upward edge in the
    // graph; moving that executor into services would delete it. Until then, it may not
    // become the pattern for reaching into routes.
    const edges = collectEdges();
    expect(edges.get('services -> routes')).toEqual(['services/runtimeDispatch.ts']);
  });
});
