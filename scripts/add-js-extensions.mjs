#!/usr/bin/env node
// Post-build: rewrite extensionless relative imports in dist/*.{js,d.ts}
// to point at concrete .js files (Node ESM requires explicit
// extensions). Source under src/ keeps the bundler-style extensionless
// form because Perry's AOT compiler expects that shape.
//
// Resolves:
//   ./foo        ->  ./foo.js          (if dist/.../foo.js exists)
//   ./foo        ->  ./foo/index.js    (if dist/.../foo/index.js exists)
//   ./foo.js     ->  unchanged
//
// Touches both `import` and `export … from` specifiers, in plain JS
// and in `.d.ts` declaration files.

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';

const DIST = resolve(new URL('..', import.meta.url).pathname, 'dist');

async function* walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(p);
        else yield p;
    }
}

async function exists(p) {
    try { await stat(p); return true; } catch { return false; }
}

async function resolveSpec(fileDir, spec) {
    if (!spec.startsWith('.') || spec.endsWith('.js') || spec.endsWith('.json')) return spec;
    const base = resolve(fileDir, spec);
    if (await exists(base + '.js')) return spec + '.js';
    if (await exists(join(base, 'index.js'))) return spec.endsWith('/') ? spec + 'index.js' : spec + '/index.js';
    return spec;  // leave alone — caller will see the error if it really is missing
}

const SPEC_RE = /(\bfrom\s+|\bimport\s*\(\s*)(['"])(\.[^'"]+)(['"])/g;

let touched = 0;
for await (const file of walk(DIST)) {
    if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue;
    const src = await readFile(file, 'utf8');
    const fileDir = dirname(file);
    const replacements = [];
    SPEC_RE.lastIndex = 0;
    let m;
    while ((m = SPEC_RE.exec(src)) !== null) {
        const resolved = await resolveSpec(fileDir, m[3]);
        if (resolved !== m[3]) {
            replacements.push({
                start: m.index,
                end: m.index + m[0].length,
                replacement: m[1] + m[2] + resolved + m[4],
            });
        }
    }
    if (replacements.length === 0) continue;
    let out = '';
    let cursor = 0;
    for (const r of replacements) {
        out += src.slice(cursor, r.start) + r.replacement;
        cursor = r.end;
    }
    out += src.slice(cursor);
    await writeFile(file, out);
    touched++;
}

console.log(`add-js-extensions: rewrote relative imports in ${touched} dist file(s)`);
