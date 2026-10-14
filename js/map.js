'use strict';
// Procedural, point-symmetric map so both empires start on equal ground.

const T_GRASS = 0;
const T_WATER = 1;
const T_DIRT = 2;

// Blocking values in map.block
const B_FREE = 0;
const B_WATER = 1;
const B_NODE = 2;
const B_BUILDING = 3;

// The map has 4-fold rotational symmetry, so up to four players start on equal ground.
// Players 0 and 1 sit in opposite corners, which keeps 1v1 games as far apart as possible.
const rotate = (x, y) => [MAP_W - 1 - y, x]; // 90 degrees around the map centre
const rotations = (x, y) => {
  const out = [[x, y]];
  for (let k = 0; k < 3; k++) out.push(rotate(...out[k]));
  return out; // [original, 90, 180, 270]
};
const START_POS = (() => {
  const r = rotations(13, 82);
  return [r[0], r[2], r[1], r[3]].map(([x, y]) => ({ x, y }));
})();
const MAX_PLAYERS = START_POS.length;

function makeNoise(rng, cell) {
  const gw = Math.ceil(MAP_W / cell) + 2;
  const gh = Math.ceil(MAP_H / cell) + 2;
  const g = new Float32Array(gw * gh).map(() => rng());
  const smooth = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = x / cell, fy = y / cell;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = smooth(fx - ix), ty = smooth(fy - iy);
    const a = g[iy * gw + ix], b = g[iy * gw + ix + 1];
    const c = g[(iy + 1) * gw + ix], d = g[(iy + 1) * gw + ix + 1];
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  };
}

function generateMap(seed) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const map = tryGenerateMap(seed + attempt * 7919);
    if (mapConnected(map)) return map;
  }
  throw new Error('Could not generate a connected map');
}

function tryGenerateMap(seed) {
  const rng = mulberry32(seed);
  const N = MAP_W * MAP_H;
  const terrain = new Uint8Array(N);
  const block = new Uint8Array(N);
  const nodeKind = new Array(N).fill(null); // 'tree' | 'berries' | 'stone' | 'gold'

  const forestA = makeNoise(rng, 9), forestB = makeNoise(rng, 4);
  const lake = makeNoise(rng, 13);
  const dirt = makeNoise(rng, 6);

  const baseDist = (x, y) => Math.min(...START_POS.map((p) => Math.hypot(x - p.x, y - p.y)));

  // Fill the bottom-left quadrant, then rotate it into the other three.
  for (let y = MAP_H / 2; y < MAP_H; y++) for (let x = 0; x < MAP_W / 2; x++) {
    const i = y * MAP_W + x;
    const bd = baseDist(x, y);
    let t = T_GRASS, kind = null;
    const edge = Math.min(x, y, MAP_W - 1 - x, MAP_H - 1 - y);
    if (lake(x, y) > 0.74 && bd > 14) t = T_WATER;
    else {
      if (dirt(x, y) > 0.68) t = T_DIRT;
      const f = forestA(x, y) * 0.75 + forestB(x, y) * 0.25;
      if ((f > 0.6 || edge < 2) && bd > 9) kind = 'tree';
    }
    for (const [rx, ry] of rotations(x, y)) {
      terrain[ry * MAP_W + rx] = t;
      nodeKind[ry * MAP_W + rx] = kind;
    }
  }

  // Starting resources around each base (defined for player 0, rotated for the others).
  const place = (x, y, kind) => {
    for (const [px, py] of rotations(x, y)) {
      if (px < 1 || py < 1 || px >= MAP_W - 1 || py >= MAP_H - 1) continue;
      const i = py * MAP_W + px;
      terrain[i] = T_GRASS;
      nodeKind[i] = kind;
    }
  };
  const cluster = (cx, cy, kind, count) => {
    const pts = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) pts.push([cx + dx, cy + dy, dx * dx + dy * dy + rng()]);
    pts.sort((a, b) => a[2] - b[2]);
    pts.slice(0, count).forEach(([x, y]) => place(x, y, kind));
  };
  const s = START_POS[0];
  cluster(s.x + 7, s.y - 5, 'berries', 6);
  cluster(s.x - 6, s.y - 8, 'gold', 5);
  cluster(s.x + 9, s.y + 5, 'stone', 4);
  // A guaranteed woodline near the base.
  for (let dy = -3; dy <= 3; dy++) for (let dx = 0; dx < 3; dx++) place(s.x + 12 + dx, s.y - 12 + dy + dx, 'tree');
  for (let dx = -4; dx <= 4; dx++) for (let dy = 0; dy < 2; dy++) place(s.x + dx, s.y - 13 - dy, 'tree');
  // Contested resources toward the middle.
  cluster(38, 58, 'gold', 6);
  cluster(26, 44, 'stone', 5);
  cluster(52, 72, 'gold', 4);
  cluster(44, 48, 'berries', 5);

  // Clear immediate surroundings of the Town Centers.
  for (const p of START_POS) {
    for (let y = p.y - 4; y <= p.y + 4; y++) for (let x = p.x - 4; x <= p.x + 4; x++) {
      const i = y * MAP_W + x;
      if (nodeKind[i] !== 'gold' && nodeKind[i] !== 'stone' && nodeKind[i] !== 'berries') nodeKind[i] = null;
      terrain[i] = T_GRASS;
    }
  }

  const nodes = [];
  const nodeAt = new Array(N).fill(null);
  let nid = 1;
  for (let i = 0; i < N; i++) {
    if (terrain[i] === T_WATER) { block[i] = B_WATER; continue; }
    const kind = nodeKind[i];
    if (!kind) continue;
    const x = i % MAP_W, y = Math.floor(i / MAP_W);
    const node = {
      id: -nid++, entity: 'node', kind, res: NODE_RES[kind], amount: NODE_AMOUNT[kind],
      tx: x, ty: y, x: (x + 0.5) * TILE, y: (y + 0.5) * TILE, variant: rng(),
    };
    nodes.push(node);
    nodeAt[i] = node;
    block[i] = B_NODE;
  }
  return { w: MAP_W, h: MAP_H, terrain, block, nodes, nodeAt, seed, version: 0 };
}

function mapConnected(map) {
  const N = map.w * map.h;
  const seen = new Uint8Array(N);
  const a = START_POS[0];
  const start = (a.y + 3) * map.w + a.x;
  // Every base must be reachable from the first one (checked just below each Town Center).
  const goals = new Set(START_POS.slice(1).map((p) => (p.y + 3) * map.w + p.x));
  const q = [start];
  seen[start] = 1;
  while (q.length) {
    const i = q.pop();
    if (goals.delete(i) && !goals.size) return true;
    const x = i % map.w, y = (i / map.w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
      const j = ny * map.w + nx;
      if (seen[j] || map.block[j]) continue;
      seen[j] = 1;
      q.push(j);
    }
  }
  return false;
}
