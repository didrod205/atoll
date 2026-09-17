Place 26 non-overlapping circles inside the unit square [0, 1] × [0, 1] so that
the sum of their radii is as large as possible.

Write `solution.mjs` as an ES module exporting `pack(n)`, which returns an array
of `n` triples `[x, y, r]`: centre coordinates and radius. Every circle must lie
fully inside the square and no two circles may overlap (touching is fine). The
evaluator checks this with a tolerance of 1e-9 and scores the sum of radii.

The function may compute the layout however it likes — a fixed construction,
an optimization loop, or both — but must finish within the time limit and use
only the Node.js standard library. The best known sum for 26 circles is about
2.635.
