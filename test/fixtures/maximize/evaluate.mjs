import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

try {
  const { x } = await import(pathToFileURL(resolve('solution.mjs')).href);
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 10) {
    console.log(JSON.stringify({ valid: false, feedback: `x must be a number in [0, 10], got ${x}` }));
  } else {
    const score = 10 - (x - 3.7) ** 2;
    console.log(JSON.stringify({ valid: true, score, feedback: `x = ${x}` }));
  }
} catch (e) {
  console.log(JSON.stringify({ valid: false, feedback: `solution failed: ${e.message}` }));
}
