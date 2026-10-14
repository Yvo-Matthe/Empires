'use strict';
// A* over the tile grid with 8-way movement and no corner cutting.

const Pathfinder = (() => {
  const N = MAP_W * MAP_H;
  const g = new Float32Array(N);
  const parent = new Int32Array(N);
  const stamp = new Uint32Array(N);
  const closed = new Uint32Array(N);
  let gen = 0;
  const SQRT2 = Math.SQRT2;
  const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2]];

  // Binary heap of tile indices keyed by f.
  let heap = new Int32Array(N);
  const f = new Float32Array(N);
  let size = 0;
  function push(i) {
    let k = size++;
    heap[k] = i;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (f[heap[p]] <= f[heap[k]]) break;
      [heap[p], heap[k]] = [heap[k], heap[p]];
      k = p;
    }
  }
  function pop() {
    const top = heap[0];
    heap[0] = heap[--size];
    let k = 0;
    for (;;) {
      const l = 2 * k + 1, r = l + 1;
      let m = k;
      if (l < size && f[heap[l]] < f[heap[m]]) m = l;
      if (r < size && f[heap[r]] < f[heap[m]]) m = r;
      if (m === k) break;
      [heap[m], heap[k]] = [heap[k], heap[m]];
      k = m;
    }
    return top;
  }

  const passable = (map, x, y) => x >= 0 && y >= 0 && x < map.w && y < map.h && map.block[y * map.w + x] === B_FREE;

  // Chebyshev distance from a tile to a rect.
  function rectDist(x, y, r) {
    const dx = Math.max(r.x0 - x, 0, x - r.x1);
    const dy = Math.max(r.y0 - y, 0, y - r.y1);
    return Math.max(dx, dy);
  }
  function octile(x, y, r) {
    const dx = Math.max(r.x0 - x, 0, x - r.x1);
    const dy = Math.max(r.y0 - y, 0, y - r.y1);
    return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
  }

  /**
   * Find a path from tile (sx, sy) to any passable tile within `reach` tiles of rect r = {x0,y0,x1,y1}.
   * Returns an array of [tx, ty] (excluding start). If the goal is unreachable,
   * returns a path to the closest reachable tile.
   */
  function find(map, sx, sy, r, reach, maxNodes = 5000) {
    gen++;
    size = 0;
    const start = sy * map.w + sx;
    g[start] = 0;
    f[start] = octile(sx, sy, r);
    stamp[start] = gen;
    parent[start] = -1;
    push(start);
    let best = start, bestH = f[start], expanded = 0;
    while (size > 0 && expanded < maxNodes) {
      const cur = pop();
      if (closed[cur] === gen) continue;
      closed[cur] = gen;
      expanded++;
      const cx = cur % map.w, cy = (cur / map.w) | 0;
      if ((cur !== start || passable(map, cx, cy)) && rectDist(cx, cy, r) <= reach) { best = cur; bestH = 0; break; }
      const h = octile(cx, cy, r);
      if (h < bestH) { bestH = h; best = cur; }
      for (const [dx, dy, cost] of DIRS) {
        const nx = cx + dx, ny = cy + dy;
        if (!passable(map, nx, ny)) continue;
        if (dx && dy && (!passable(map, cx + dx, cy) || !passable(map, cx, cy + dy))) continue;
        const ni = ny * map.w + nx;
        if (closed[ni] === gen) continue;
        const ng = g[cur] + cost;
        if (stamp[ni] !== gen || ng < g[ni]) {
          stamp[ni] = gen;
          g[ni] = ng;
          parent[ni] = cur;
          f[ni] = ng + octile(nx, ny, r) * 1.01;
          push(ni);
        }
      }
    }
    const path = [];
    for (let i = best; i !== -1 && i !== start; i = parent[i]) path.push([i % map.w, (i / map.w) | 0]);
    path.reverse();
    return smooth(map, sx, sy, path);
  }

  // Drop waypoints that have a clear straight line between them.
  function lineClear(map, x0, y0, x1, y1) {
    const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 3);
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      // Check a little to either side so units do not clip corners.
      for (const [ox, oy] of [[0, 0], [0.3, 0.3], [-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3]]) {
        if (!passable(map, Math.floor(x + 0.5 + ox), Math.floor(y + 0.5 + oy))) return false;
      }
    }
    return true;
  }
  function smooth(map, sx, sy, path) {
    if (path.length < 3) return path;
    const out = [];
    let ax = sx, ay = sy, i = 0;
    while (i < path.length) {
      let j = path.length - 1;
      while (j > i && !lineClear(map, ax, ay, path[j][0], path[j][1])) j--;
      out.push(path[j]);
      [ax, ay] = path[j];
      i = j + 1;
    }
    return out;
  }

  return { find, passable };
})();
