// Seed: staggered rows of centres, then every radius grown as far as the walls
// and its neighbours allow. The constants are the knobs to turn.
export function pack(n) {
  const rows = [5, 6, 5, 5, 5];
  const marginX = 0.1;
  const marginY = 0.1;
  const shift = 0.5;
  const centres = [];
  rows.forEach((count, r) => {
    const y = marginY + (r * (1 - 2 * marginY)) / (rows.length - 1);
    const width = 1 - 2 * marginX;
    for (let i = 0; i < count; i++) {
      const offset = count < 6 && r % 2 === 1 ? shift / count : 0;
      const x = marginX + (count === 1 ? width / 2 : (i * width) / (count - 1)) + offset * width * 0.2;
      centres.push([Math.min(0.999, Math.max(0.001, x)), y]);
    }
  });
  const pts = centres.slice(0, n);
  const wall = ([x, y]) => Math.min(x, 1 - x, y, 1 - y);
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  // Start from half the distance to the nearest neighbour (always valid), then grow greedily.
  const r = pts.map((p, i) => Math.min(wall(p), ...pts.filter((_, j) => j !== i).map((q) => d(p, q) / 2)));
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < pts.length; i++) {
      r[i] = Math.max(0, Math.min(wall(pts[i]), ...pts.map((q, j) => (j === i ? Infinity : d(pts[i], q) - r[j]))));
    }
  }
  return pts.map((p, i) => [p[0], p[1], r[i]]);
}
