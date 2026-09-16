import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import refine from './refine.js';

// record-only: serves and stores records and feedback, never proposes updates.
const basic = {
  name: 'basic',
  description: 'Record-only: serve, store interactions and feedback, never update the harness.',
  triggers: () => false,
  select: () => [],
  grow: async () => ({ summary: 'record-only', rationale: '', changes: [], addresses: [], skipped: [] }),
};

const BUILTIN = { refine, basic };

/**
 * A recipe is a built-in name or a path to a module whose default export has
 * { name, triggers(report, open), select(open), grow(ctx) }.
 */
export async function loadRecipe(spec = 'refine') {
  if (BUILTIN[spec]) return BUILTIN[spec];
  const file = isAbsolute(spec) ? spec : resolve(process.cwd(), spec);
  const mod = await import(pathToFileURL(file).href);
  const recipe = mod.default ?? mod;
  for (const fn of ['triggers', 'select', 'grow']) {
    if (typeof recipe[fn] !== 'function') throw new Error(`recipe ${spec} must export ${fn}()`);
  }
  recipe.name ??= spec;
  return recipe;
}

export const builtinRecipes = Object.values(BUILTIN).map(({ name, description }) => ({ name, description }));
