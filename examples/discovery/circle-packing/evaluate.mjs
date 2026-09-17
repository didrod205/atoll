// Scores a circle packing: {"valid", "score", "feedback"} as the last stdout line.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const N = 26;
const EPS = 1e-9;
const say = (result) => console.log(JSON.stringify(result));

try {
  const mod = await import(pathToFileURL(resolve(process.argv[2] ?? 'solution.mjs')).href);
  if (typeof mod.pack !== 'function') throw new Error('solution.mjs must export pack(n)');
  const circles = await mod.pack(N);
  if (!Array.isArray(circles) || circles.length !== N) throw new Error(`pack(${N}) must return ${N} circles, got ${Array.isArray(circles) ? circles.length : typeof circles}`);
  circles.forEach((c, i) => {
    if (!Array.isArray(c) || c.length !== 3 || !c.every(Number.isFinite)) throw new Error(`circle ${i} is not [x, y, r] with finite numbers`);
    const [x, y, r] = c;
    if (r < 0) throw new Error(`circle ${i} has negative radius ${r}`);
    if (x - r < -EPS || x + r > 1 + EPS || y - r < -EPS || y + r > 1 + EPS) throw new Error(`circle ${i} (${x.toFixed(4)}, ${y.toFixed(4)}, r=${r.toFixed(4)}) crosses the square's edge`);
  });
  let worst = null;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const [xi, yi, ri] = circles[i];
      const [xj, yj, rj] = circles[j];
      const gap = Math.hypot(xi - xj, yi - yj) - ri - rj;
      if (gap < -EPS) throw new Error(`circles ${i} and ${j} overlap by ${(-gap).toExponential(2)}`);
      if (worst == null || gap < worst.gap) worst = { i, j, gap };
    }
  }
  const radii = circles.map((c) => c[2]);
  const score = radii.reduce((a, b) => a + b, 0);
  say({
    valid: true,
    score,
    feedback: `sum of radii ${score.toFixed(6)}; radii from ${Math.min(...radii).toFixed(4)} to ${Math.max(...radii).toFixed(4)}; tightest pair ${worst.i}-${worst.j} gap ${worst.gap.toExponential(2)}`,
  });
} catch (e) {
  say({ valid: false, score: null, feedback: e.message });
}
