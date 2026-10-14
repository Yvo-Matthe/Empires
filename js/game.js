'use strict';
// The simulation. No DOM access here, so it also runs headless (see tests/).

const INTERACT = 18; // px, edge distance at which peasants gather/build/drop off

class Game {
  constructor({ seed = 1, empires = ['aldermark', 'valmont'], difficulty = 'normal', ai = [false, true], teams, viewer, battle } = {}) {
    if (empires.length < 2 || empires.length > MAX_PLAYERS) throw new Error(`A game needs 2-${MAX_PLAYERS} players`);
    // Players on the same team are allies; by default everyone fights alone.
    teams = teams || empires.map((_, i) => i + 1);
    this.seed = seed;
    this.map = generateMap(seed);
    // Battle mode (from the world map): armies only, no economy. battle = { armies: [{ units: {type: n}, leader }] }
    this.battle = battle || null;
    this.time = 0;
    this.nextId = 1;
    this.entities = [];
    this.byId = new Map();
    this.projectiles = [];
    this.events = [];
    this.depleted = [];
    this.over = null; // { winner }
    this.difficulty = DIFFICULTY[difficulty];
    this.occupied = new Int32Array(MAP_W * MAP_H); // building id per tile (incl. walkable farms)
    this.visible = new Uint8Array(MAP_W * MAP_H);
    this.explored = new Uint8Array(MAP_W * MAP_H);
    this.visionT = 0;
    this.lastAlert = {};
    this.dirtyNodes = new Set(); // nodes whose amount changed (for network sync)
    // Whose eyes the fog of war uses: the first human by default, -1 for no fog.
    this.viewer = viewer !== undefined ? viewer : ai.indexOf(false);
    this.defCache = new Map();

    const usedColors = [];
    this.players = empires.map((key, id) => ({
      id, empireKey: key, empire: EMPIRES[key], trim: EMPIRES[key].trim, team: teams[id],
      // Players sharing an empire get distinct banner colors.
      color: pickColor(EMPIRES[key].color, usedColors),
      res: { food: 200, wood: 200, stone: 150, gold: 100 },
      pop: 0, popCap: 0, defeated: false, ai: ai[id],
      stats: { trained: 0, killed: 0, lost: 0, gathered: 0, built: 0 },
    }));

    if (battle) this.setupBattle(battle);
    else for (const p of this.players) {
      const s = START_POS[p.id];
      const tc = this.addBuilding(p.id, 'towncenter', s.x - 2, s.y - 2, true);
      // Two men and two women to work the land, and the leader: the player in the game.
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + (p.id ? Math.PI : 0);
        this.addUnit(p.id, 'peasant', tc.x + Math.cos(a) * 3 * TILE, tc.y + Math.sin(a) * 3 * TILE);
      }
      const toCenter = Math.atan2(MAP_H * TILE / 2 - tc.y, MAP_W * TILE / 2 - tc.x);
      p.leaderId = this.addUnit(p.id, 'leader', tc.x + Math.cos(toCenter) * 4 * TILE, tc.y + Math.sin(toCenter) * 4 * TILE).id;
    }
    this.ais = this.players.map((p) => (p.ai ? new AIController(this, p.id) : null));
    this.updatePop();
    this.computeVision();
  }

  // Armies face each other across the middle of the map.
  setupBattle(battle) {
    const c = MAP_W / 2;
    const spots = [[c - 14, c + 14], [c + 13, c - 13]];
    for (const p of this.players) {
      p.res = { food: 0, wood: 0, stone: 0, gold: 0 };
      const [sx, sy] = spots[p.id];
      this.clearArea(sx, sy, 8);
      const army = battle.armies[p.id];
      const types = Object.entries(army.units).flatMap(([t, n]) => Array(n).fill(t));
      // Ranged units in the back rows, the leader behind them.
      types.sort((a, b) => (UNITS[a].range > 1) - (UNITS[b].range > 1));
      const facing = Math.atan2(c - sy, c - sx), back = facing + Math.PI, side = facing + Math.PI / 2;
      const cols = Math.max(4, Math.ceil(Math.sqrt(types.length * 2)));
      types.forEach((t, i) => {
        const row = Math.floor(i / cols), col = i % cols - (cols - 1) / 2;
        const x = (sx + 0.5) * TILE + Math.cos(side) * col * 24 + Math.cos(back) * row * 26;
        const y = (sy + 0.5) * TILE + Math.sin(side) * col * 24 + Math.sin(back) * row * 26;
        this.addUnit(p.id, t, x, y);
      });
      if (army.leader) {
        const rows = Math.ceil(types.length / cols) + 1;
        p.leaderId = this.addUnit(p.id, 'leader', (sx + 0.5) * TILE + Math.cos(back) * rows * 26, (sy + 0.5) * TILE + Math.sin(back) * rows * 26).id;
      }
    }
    for (const e of this.entities) e.facing = e.x < MAP_W * TILE / 2 ? 1 : -1;
  }

  // Remove trees, rocks and water around a tile so armies have room to deploy.
  clearArea(cx, cy, r) {
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
      if (x < 1 || y < 1 || x >= MAP_W - 1 || y >= MAP_H - 1 || Math.hypot(x - cx, y - cy) > r) continue;
      const i = y * MAP_W + x;
      const n = this.map.nodeAt[i];
      if (n) { this.map.nodeAt[i] = null; n.dead = true; }
      this.map.terrain[i] = T_GRASS;
      this.map.block[i] = B_FREE;
    }
    this.map.nodes = this.map.nodes.filter((n) => !n.dead);
  }

  // Surviving troops per player once a battle is over.
  survivors() {
    return this.players.map((p) => {
      const units = {};
      let leader = false;
      for (const u of this.entities) {
        if (u.owner !== p.id || u.dead || u.entity !== 'unit') continue;
        if (u.type === 'leader') leader = true;
        else units[u.type] = (units[u.type] || 0) + 1;
      }
      return { units, leader };
    });
  }

  isEnemy(a, b) { return a !== b && this.players[a].team !== this.players[b].team; }
  isAlly(a, b) { return a === b || this.players[a].team === this.players[b].team; }

  // ---------- stats with empire modifiers ----------
  unitDef(pid, type) {
    const key = pid + ':' + type;
    let d = this.defCache.get(key);
    if (!d) {
      const mods = this.players[pid].empire.mods;
      d = { ...UNITS[type], type };
      d.hp = Math.round(d.hp * ((mods.unitHp || {})[type] || 1));
      d.range += (mods.unitRange || {})[type] || 0;
      d.speed *= (mods.unitSpeed || {})[type] || 1;
      const cm = (mods.unitCost || {})[type] || 1;
      d.cost = Object.fromEntries(Object.entries(d.cost).map(([k, v]) => [k, Math.round(v * cm)]));
      if (type === 'leader') d.name = this.players[pid].empire.leader;
      this.defCache.set(key, d);
    }
    return d;
  }
  buildingCost(pid, type) {
    const mods = (this.players[pid].empire.mods.buildCost || {})[type] || {};
    const cost = {};
    for (const k in BUILDINGS[type].cost) cost[k] = Math.round(BUILDINGS[type].cost[k] * (mods[k] || 1));
    return cost;
  }
  buildTime(pid, type) {
    return BUILDINGS[type].time * ((this.players[pid].empire.mods.buildTime || {})[type] || 1);
  }
  gatherRate(pid, kind) {
    const p = this.players[pid];
    return GATHER_RATE[kind] * ((p.empire.mods.gather || {})[kind] || 1) * (p.ai ? this.difficulty.gather : 1);
  }
  trainable(b) {
    if (!b.def.trains) return [];
    return b.def.trains.map((t) => (t === '@unique' ? this.players[b.owner].empire.unique : t));
  }
  hasBuilding(pid, type) {
    return this.entities.some((e) => e.entity === 'building' && e.owner === pid && e.type === type && e.complete && !e.dead);
  }
  buildingUnlocked(pid, type) {
    const req = BUILDINGS[type].requires;
    return !req || this.hasBuilding(pid, req);
  }

  // ---------- entity creation ----------
  addUnit(pid, type, x, y, id = this.nextId++) {
    const def = this.unitDef(pid, type);
    const u = {
      id, entity: 'unit', type, def, owner: pid, x, y, hp: def.hp, maxHp: def.hp,
      radius: def.tags.includes('cavalry') ? 10 : 7, order: null, path: [], finalPoint: null,
      carry: { res: null, amount: 0 }, cooldown: 0, scanT: Math.random() * 0.5, repathT: 0,
      facing: 1, moving: false, anim: Math.random() * 10, lastHit: -99, attackAnim: 0,
    };
    // The workforce is men and women in turn.
    if (def.worker) { const p = this.players[pid]; u.female = (p.workers = (p.workers || 0) + 1) % 2 === 0; }
    this.entities.push(u);
    this.byId.set(u.id, u);
    return u;
  }

  addBuilding(pid, type, tx, ty, complete = false, id = this.nextId++) {
    const def = BUILDINGS[type];
    const b = {
      id, entity: 'building', type, def, owner: pid, tx, ty, size: def.size,
      x: (tx + def.size / 2) * TILE, y: (ty + def.size / 2) * TILE,
      x0: tx * TILE, y0: ty * TILE, x1: (tx + def.size) * TILE, y1: (ty + def.size) * TILE,
      maxHp: def.hp, hp: complete ? def.hp : Math.max(1, def.hp * 0.1), complete, progress: complete ? 1 : 0,
      queue: [], rally: null, cooldown: 0, worker: null, lastHit: -99, blocked: false,
    };
    for (let y = ty; y < ty + def.size; y++) for (let x = tx; x < tx + def.size; x++) {
      const i = y * MAP_W + x;
      this.occupied[i] = b.id;
      if (!def.walkable) this.map.block[i] = B_BUILDING;
    }
    this.entities.push(b);
    this.byId.set(b.id, b);
    if (!def.walkable) this.ejectUnits(b);
    return b;
  }

  // Push units standing on a new foundation to the nearest free tile.
  ejectUnits(b) {
    for (const u of this.entities) {
      if (u.entity !== 'unit') continue;
      if (u.x < b.x0 || u.x >= b.x1 || u.y < b.y0 || u.y >= b.y1) continue;
      const t = this.freeTileNear(b, u.x, u.y);
      if (t) { u.x = (t[0] + 0.5) * TILE; u.y = (t[1] + 0.5) * TILE; u.path = []; }
    }
  }

  // Nearest passable tile on the rings around a building, preferring proximity to (px, py).
  freeTileNear(b, px, py) {
    let best = null, bestD = Infinity;
    for (let ring = 0; ring < 6 && !best; ring++) {
      const x0 = b.tx - 1 - ring, y0 = b.ty - 1 - ring, x1 = b.tx + b.size + ring, y1 = b.ty + b.size + ring;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        if (x !== x0 && x !== x1 && y !== y0 && y !== y1) continue;
        if (!Pathfinder.passable(this.map, x, y)) continue;
        const d = dist((x + 0.5) * TILE, (y + 0.5) * TILE, px, py);
        if (d < bestD) { bestD = d; best = [x, y]; }
      }
    }
    return best;
  }

  canPlace(pid, type, tx, ty) {
    const size = BUILDINGS[type].size;
    if (tx < 1 || ty < 1 || tx + size > MAP_W - 1 || ty + size > MAP_H - 1) return false;
    for (let y = ty; y < ty + size; y++) for (let x = tx; x < tx + size; x++) {
      const i = y * MAP_W + x;
      if (this.map.block[i] !== B_FREE || this.occupied[i]) return false;
      if (pid === this.viewer && !this.explored[i]) return false;
    }
    // Keep away from enemy units on the footprint.
    for (const u of this.entities) {
      if (u.entity === 'unit' && u.owner !== pid && u.x >= tx * TILE && u.x < (tx + size) * TILE &&
          u.y >= ty * TILE && u.y < (ty + size) * TILE) return false;
    }
    return true;
  }

  // ---------- player commands (used by the UI and by the AI) ----------
  cmdPlace(pid, type, tx, ty, builders) {
    const p = this.players[pid];
    const cost = this.buildingCost(pid, type);
    if (!this.buildingUnlocked(pid, type)) return { error: `Requires ${BUILDINGS[BUILDINGS[type].requires].name}` };
    if (!canAfford(p.res, cost)) return { error: 'Not enough resources' };
    if (!this.canPlace(pid, type, tx, ty)) return { error: 'Cannot build there' };
    pay(p.res, cost);
    const b = this.addBuilding(pid, type, tx, ty, false);
    this.cmdBuild(builders, b);
    return { building: b };
  }

  cmdBuild(units, b) {
    for (const u of units) if (u.def.worker) this.setOrder(u, { type: 'build', target: b });
  }

  cmdGather(units, target) {
    for (const u of units) if (u.def.worker) this.setOrder(u, { type: 'gather', target });
  }

  cmdAttack(units, target) {
    for (const u of units) this.setOrder(u, { type: 'attack', target });
  }

  cmdStop(units) {
    for (const u of units) this.setOrder(u, null);
  }

  cmdMove(units, x, y, attackMove = false) {
    // Spread the group in a loose square formation around the target point.
    const n = units.length;
    const cols = Math.ceil(Math.sqrt(n));
    const spacing = 22;
    const cx = units.reduce((s, u) => s + u.x, 0) / n, cy = units.reduce((s, u) => s + u.y, 0) / n;
    const order = units.slice().sort((a, b) => dist(a.x, a.y, x, y) - dist(b.x, b.y, x, y));
    order.forEach((u, i) => {
      let px = x, py = y;
      if (n > 1) {
        // Keep relative formation for nearby groups, otherwise use a grid.
        const r = Math.floor(i / cols), c = i % cols;
        px = x + (c - (cols - 1) / 2) * spacing;
        py = y + (r - (Math.ceil(n / cols) - 1) / 2) * spacing;
        if (dist(cx, cy, x, y) < 3 * TILE) { px = x + (u.x - cx) * 0.6; py = y + (u.y - cy) * 0.6; }
      }
      px = clamp(px, 4, MAP_W * TILE - 4);
      py = clamp(py, 4, MAP_H * TILE - 4);
      this.setOrder(u, { type: attackMove ? 'attackMove' : 'move', x: px, y: py });
    });
  }

  // Right-click style command: figure out what the player meant.
  cmdSmart(pid, units, x, y, target) {
    units = units.filter((u) => u.entity === 'unit' && u.owner === pid && !u.dead);
    if (!units.length) return null;
    if (target && target.entity !== 'node' && this.isEnemy(pid, target.owner)) {
      this.cmdAttack(units, target);
      return 'attack';
    }
    const workers = units.filter((u) => u.def.worker), others = units.filter((u) => !u.def.worker);
    let kind = 'move';
    if (target && target.entity === 'node') {
      this.cmdGather(workers, target);
      if (others.length) this.cmdMove(others, x, y);
      return 'gather';
    }
    if (target && target.entity === 'building' && target.owner === pid && workers.length) {
      if (!target.complete || target.hp < target.maxHp) {
        this.cmdBuild(workers, target);
        kind = 'build';
      } else if (target.def.farm) {
        this.cmdGather([workers[0]], target);
        if (workers.length > 1) this.cmdMove(workers.slice(1), x, y);
        kind = 'gather';
      } else if (target.def.dropoff) {
        for (const u of workers) {
          if (u.carry.amount > 0 && target.def.dropoff.includes(u.carry.res)) this.setOrder(u, { type: 'return', dropoff: target, next: u.lastNode });
          else this.cmdMove([u], x, y);
        }
        kind = 'return';
      } else this.cmdMove(workers, x, y);
      if (others.length) this.cmdMove(others, x, y);
      return kind;
    }
    this.cmdMove(units, x, y);
    return 'move';
  }

  cmdTrain(b, type) {
    const p = this.players[b.owner];
    if (!b.complete || !this.trainable(b).includes(type)) return { error: 'Cannot train that here' };
    if (b.queue.length >= 5) return { error: 'Queue is full' };
    const def = this.unitDef(b.owner, type);
    if (!canAfford(p.res, def.cost)) return { error: 'Not enough resources' };
    pay(p.res, def.cost);
    b.queue.push({ type, progress: 0 });
    return { ok: true };
  }

  cmdCancel(b, index) {
    const q = b.queue[index];
    if (!q) return;
    refund(this.players[b.owner].res, this.unitDef(b.owner, q.type).cost);
    b.queue.splice(index, 1);
  }

  cmdRally(b, x, y, target) {
    b.rally = { x, y, target: target || null };
  }

  cmdDelete(e) {
    if (e.type === 'leader') return; // a leader cannot abdicate
    if (e.entity === 'building' && !e.complete) refund(this.players[e.owner].res, this.buildingCost(e.owner, e.type), e.progress < 0.01 ? 1 : 0.5);
    this.kill(e, null);
  }

  setOrder(u, order) {
    this.releaseFarm(u);
    u.order = order;
    u.path = [];
    u.finalPoint = null;
    u.stuck = 0;
    u.repathT = 0;
    if (!order) return;
    if (order.type === 'move' || order.type === 'attackMove') {
      const tx = Math.floor(order.x / TILE), ty = Math.floor(order.y / TILE);
      const free = Pathfinder.passable(this.map, tx, ty);
      this.pathTo(u, { x0: tx, y0: ty, x1: tx, y1: ty }, free ? 0 : 1);
      if (free) u.finalPoint = { x: order.x, y: order.y };
    }
  }

  // ---------- movement ----------
  pathTo(u, rect, reach) {
    const tx = clamp(Math.floor(u.x / TILE), 0, MAP_W - 1), ty = clamp(Math.floor(u.y / TILE), 0, MAP_H - 1);
    u.path = Pathfinder.find(this.map, tx, ty, rect, reach);
    u.finalPoint = null;
  }
  rectOf(e) {
    if (e.entity === 'building') return { x0: e.tx, y0: e.ty, x1: e.tx + e.size - 1, y1: e.ty + e.size - 1 };
    if (e.entity === 'node') return { x0: e.tx, y0: e.ty, x1: e.tx, y1: e.ty };
    const tx = Math.floor(e.x / TILE), ty = Math.floor(e.y / TILE);
    return { x0: tx, y0: ty, x1: tx, y1: ty };
  }
  pathToEntity(u, e) {
    const walk = e.entity === 'building' && e.def.walkable;
    this.pathTo(u, this.rectOf(e), walk ? 0 : 1);
  }

  // Move along the current path. Returns true once the path is exhausted.
  follow(u, dt) {
    if (!u.path.length) { u.moving = false; return true; }
    const [tx, ty] = u.path[0];
    let px = (tx + 0.5) * TILE, py = (ty + 0.5) * TILE;
    if (u.path.length === 1 && u.finalPoint) { px = u.finalPoint.x; py = u.finalPoint.y; }
    const dx = px - u.x, dy = py - u.y, d = Math.hypot(dx, dy), step = u.def.speed * dt;
    if (d <= step) { u.x = px; u.y = py; u.path.shift(); } else { u.x += (dx / d) * step; u.y += (dy / d) * step; }
    if (Math.abs(dx) > 0.5) u.facing = dx < 0 ? -1 : 1;
    u.moving = true;
    return false;
  }

  // Straight-line step toward a point, used for the last few pixels of a chase.
  stepToward(u, x, y, dt) {
    const dx = x - u.x, dy = y - u.y, d = Math.hypot(dx, dy);
    if (d < 1) return;
    const step = Math.min(d, u.def.speed * dt);
    const nx = u.x + (dx / d) * step, ny = u.y + (dy / d) * step;
    if (Pathfinder.passable(this.map, Math.floor(nx / TILE), Math.floor(ny / TILE))) { u.x = nx; u.y = ny; }
    u.facing = dx < 0 ? -1 : 1;
    u.moving = true;
  }

  edgeDist(u, e) {
    if (e.entity === 'unit') return dist(u.x, u.y, e.x, e.y) - u.radius - e.radius;
    let x0, y0, x1, y1;
    if (e.entity === 'building') ({ x0, y0, x1, y1 } = e);
    else { x0 = e.tx * TILE; y0 = e.ty * TILE; x1 = x0 + TILE; y1 = y0 + TILE; }
    const dx = Math.max(x0 - u.x, 0, u.x - x1), dy = Math.max(y0 - u.y, 0, u.y - y1);
    return Math.hypot(dx, dy) - u.radius;
  }

  // ---------- main step ----------
  step(dt = TICK) {
    if (this.over) return;
    this.time += dt;
    this.updatePop();
    for (const ai of this.ais) if (ai) ai.update(dt);
    for (const e of this.entities) {
      if (e.dead) continue;
      if (e.entity === 'unit') this.updateUnit(e, dt);
      else this.updateBuilding(e, dt);
    }
    this.separate();
    this.updateProjectiles(dt);
    this.removeDead();
    this.visionT -= dt;
    if (this.visionT <= 0) { this.visionT = 0.25; this.computeVision(); }
    if (Math.floor(this.time) !== Math.floor(this.time - dt)) this.checkVictory();
  }

  updatePop() {
    for (const p of this.players) { p.pop = 0; p.popCap = 0; }
    for (const e of this.entities) {
      if (e.dead) continue;
      const p = this.players[e.owner];
      if (e.entity === 'unit') p.pop++;
      else {
        if (e.complete && e.def.pop) p.popCap += e.def.pop;
        if (e.queue.length && e.queue[0].progress > 0) p.pop++;
      }
    }
    for (const p of this.players) p.popCap = Math.min(MAX_POP, p.popCap);
  }

  updateUnit(u, dt) {
    u.anim += dt;
    if (u.cooldown > 0) u.cooldown -= dt;
    if (u.attackAnim > 0) u.attackAnim -= dt;
    u.moving = false;
    u.working = false;
    if (u.def.regen && u.hp < u.maxHp && this.time - u.lastHit > 6) u.hp = Math.min(u.maxHp, u.hp + u.def.regen * dt);
    const o = u.order;
    if (!o) return this.idle(u, dt);
    switch (o.type) {
      case 'move':
        if (this.follow(u, dt)) u.order = null;
        break;
      case 'attackMove': {
        u.scanT -= dt;
        if (u.scanT <= 0) {
          u.scanT = 0.4;
          const t = this.findEnemy(u, u.def.sight * TILE);
          if (t) { const resume = o; this.setOrder(u, { type: 'attack', target: t, resume }); break; }
        }
        if (this.follow(u, dt)) u.order = null;
        break;
      }
      case 'attack': this.doAttack(u, o, dt); break;
      case 'gather': this.doGather(u, o, dt); break;
      case 'return': this.doReturn(u, o, dt); break;
      case 'build': this.doBuild(u, o, dt); break;
    }
  }

  idle(u, dt) {
    u.scanT -= dt;
    if (u.scanT > 0) return;
    u.scanT = 0.5;
    if (u.def.worker) return;
    const t = this.findEnemy(u, u.def.sight * TILE);
    if (t) this.setOrder(u, { type: 'attack', target: t, auto: { x: u.x, y: u.y } });
  }

  // Nearest enemy unit (preferring armed ones) or building within radius.
  findEnemy(u, radius, includeBuildings = true) {
    let best = null, bestScore = Infinity;
    for (const e of this.entities) {
      if (e.dead || !this.isEnemy(u.owner, e.owner)) continue;
      if (e.entity === 'building' && !includeBuildings) continue;
      const d = this.edgeDist(u, e);
      if (d > radius) continue;
      let score = d;
      if (e.entity === 'building') score += 6 * TILE;
      else if (e.def.worker) score += 2 * TILE;
      if (score < bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  doAttack(u, o, dt) {
    const t = o.target;
    if (!t || t.dead) {
      if (o.resume) { this.setOrder(u, o.resume); return; }
      // Look for the next enemy nearby before giving up.
      const next = this.findEnemy(u, u.def.sight * TILE);
      if (next && !u.def.worker) { o.target = next; u.path = []; return; }
      if (o.auto) { this.setOrder(u, { type: 'move', x: o.auto.x, y: o.auto.y }); return; }
      u.order = null;
      return;
    }
    // Auto-acquired targets are not chased forever.
    if (o.auto && dist(u.x, u.y, o.auto.x, o.auto.y) > (u.def.sight + 4) * TILE) {
      this.setOrder(u, { type: 'move', x: o.auto.x, y: o.auto.y });
      return;
    }
    const range = u.def.range * TILE + 4;
    const d = this.edgeDist(u, t);
    if (d <= range) {
      u.path = [];
      u.facing = t.x < u.x ? -1 : 1;
      if (u.cooldown <= 0) {
        u.cooldown = u.def.cooldown;
        u.attackAnim = 0.25;
        if (u.def.projectile) this.fireArrow(u, t, this.damage(u.def, t), u.owner);
        else this.applyDamage(u, t, this.damage(u.def, t));
      }
      return;
    }
    u.repathT -= dt;
    if (t.entity === 'unit' && d < 1.5 * TILE) { this.stepToward(u, t.x, t.y, dt); return; }
    if (!u.path.length || (t.entity === 'unit' && u.repathT <= 0)) {
      u.repathT = 0.8;
      this.pathToEntity(u, t);
      if (!u.path.length) {
        u.stuck = (u.stuck || 0) + 1;
        if (u.stuck > 6) { u.order = null; return; }
      }
    }
    this.follow(u, dt);
  }

  damage(def, target) {
    let dmg = def.atk;
    const tags = target.entity === 'unit' ? target.def.tags : ['building'];
    if (def.bonus) for (const tag of tags) dmg += def.bonus[tag] || 0;
    return Math.max(1, dmg - (target.def.armor || 0));
  }

  fireArrow(src, target, dmg, owner) {
    this.projectiles.push({ x: src.x, y: src.y - 10, sx: src.x, sy: src.y - 10, target, dmg, owner, src: src.id, t: 0 });
  }

  updateProjectiles(dt) {
    for (const p of this.projectiles) {
      const t = p.target;
      if (t.dead) { p.done = true; continue; }
      const dx = t.x - p.x, dy = t.y - 6 - p.y, d = Math.hypot(dx, dy), step = 380 * dt;
      p.t += dt;
      if (d <= step + 4) {
        p.done = true;
        this.applyDamage(this.byId.get(p.src) || { owner: p.owner, entity: 'projectile' }, t, p.dmg);
      } else { p.x += (dx / d) * step; p.y += (dy / d) * step; }
    }
    this.projectiles = this.projectiles.filter((p) => !p.done);
  }

  applyDamage(attacker, target, amount) {
    if (target.dead) return;
    target.hp -= amount;
    target.lastHit = this.time;
    const owner = this.players[target.owner];
    if (!owner.ai && this.time - (this.lastAlert[owner.id] ?? -99) > 15) {
      this.lastAlert[owner.id] = this.time;
      this.events.push({ type: 'alert', owner: owner.id, x: target.x, y: target.y });
    }
    if (target.hp <= 0) { this.kill(target, attacker); return; }
    // Idle soldiers fight back; peasants keep working.
    if (target.entity === 'unit' && !target.def.worker && attacker && attacker.entity === 'unit' && !attacker.dead &&
        (!target.order || target.order.type === 'move' && this.players[target.owner].ai)) {
      this.setOrder(target, { type: 'attack', target: attacker, auto: { x: target.x, y: target.y } });
    }
    const ai = this.ais[target.owner];
    if (ai && attacker && attacker.entity === 'unit') ai.onAttacked(target, attacker);
  }

  kill(e, killer) {
    if (e.dead) return;
    e.dead = true;
    e.hp = 0;
    const p = this.players[e.owner];
    if (e.entity === 'unit') {
      p.stats.lost++;
      this.releaseFarm(e);
    } else {
      for (let y = e.ty; y < e.ty + e.size; y++) for (let x = e.tx; x < e.tx + e.size; x++) {
        const i = y * MAP_W + x;
        this.occupied[i] = 0;
        if (this.map.block[i] === B_BUILDING) this.map.block[i] = B_FREE;
      }
      for (const q of e.queue) if (q.progress === 0 && !killer) refund(p.res, this.unitDef(e.owner, q.type).cost);
      e.queue = [];
    }
    if (killer && killer.owner !== undefined && killer.owner !== e.owner) this.players[killer.owner].stats.killed++;
    this.events.push({ type: 'death', id: e.id, owner: e.owner });
    if (e.type === 'leader' && !p.defeated && killer !== null) this.forfeit(e.owner, `${e.def.name} has fallen in battle`);
  }

  removeDead() {
    if (!this.entities.some((e) => e.dead)) return;
    for (const e of this.entities) if (e.dead) this.byId.delete(e.id);
    this.entities = this.entities.filter((e) => !e.dead);
  }

  // Soft collision between units.
  separate() {
    const units = this.entities.filter((e) => e.entity === 'unit');
    const cell = 2 * TILE, cols = Math.ceil(MAP_W / 2);
    const grid = new Map();
    for (const u of units) {
      const k = Math.floor(u.y / cell) * cols + Math.floor(u.x / cell);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(u);
    }
    for (const u of units) {
      const gx = Math.floor(u.x / cell), gy = Math.floor(u.y / cell);
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const list = grid.get((gy + oy) * cols + gx + ox);
        if (!list) continue;
        for (const v of list) {
          if (v.id <= u.id) continue;
          const dx = v.x - u.x, dy = v.y - u.y, d = Math.hypot(dx, dy) || 0.01;
          const min = (u.radius + v.radius) * 0.85;
          if (d >= min) continue;
          const push = Math.min(2, (min - d) * 0.5);
          const nx = dx / d, ny = dy / d;
          // Busy workers are pushed less so they keep their spot at a resource.
          const wu = u.moving ? 1 : 0.5, wv = v.moving ? 1 : 0.5;
          this.nudge(u, -nx * push * wu, -ny * push * wu);
          this.nudge(v, nx * push * wv, ny * push * wv);
        }
      }
    }
  }
  nudge(u, dx, dy) {
    const nx = u.x + dx, ny = u.y + dy;
    const ok = Pathfinder.passable(this.map, Math.floor(nx / TILE), Math.floor(ny / TILE));
    const inside = !Pathfinder.passable(this.map, Math.floor(u.x / TILE), Math.floor(u.y / TILE));
    if (ok || inside) { u.x = clamp(nx, 2, MAP_W * TILE - 2); u.y = clamp(ny, 2, MAP_H * TILE - 2); }
  }

  // ---------- economy ----------
  releaseFarm(u) {
    const o = u.order;
    if (o && o.type === 'gather' && o.target && o.target.entity === 'building' && o.target.worker === u.id) o.target.worker = null;
  }

  validGatherTarget(u, t) {
    if (!t || t.dead) return false;
    if (t.entity === 'node') return t.amount > 0;
    if (t.entity === 'building' && t.def.farm && t.owner === u.owner && t.complete) {
      if (t.worker === null || t.worker === u.id) return true;
      const w = this.byId.get(t.worker);
      return !w || w.dead || !w.order || w.order.target !== t;
    }
    return false;
  }

  nodeKind(t) { return t.entity === 'node' ? t.kind : 'farm'; }

  // Nearest gatherable thing for a resource type.
  findGatherTarget(u, res, x = u.x, y = u.y, maxDist = 14 * TILE) {
    let best = null, bestD = maxDist;
    for (const n of this.map.nodes) {
      if (n.res !== res || n.amount <= 0) continue;
      const d = Math.abs(n.x - x) + Math.abs(n.y - y);
      if (d < bestD) { bestD = d; best = n; }
    }
    if (res === 'food') {
      for (const b of this.entities) {
        if (b.entity !== 'building' || !b.def.farm || b.owner !== u.owner || !this.validGatherTarget(u, b)) continue;
        if (b.worker !== null && b.worker !== u.id) continue;
        const d = Math.abs(b.x - x) + Math.abs(b.y - y);
        if (d < bestD) { bestD = d; best = b; }
      }
    }
    return best;
  }

  findDropoff(owner, res, x, y) {
    let best = null, bestD = Infinity;
    for (const b of this.entities) {
      if (b.entity !== 'building' || b.owner !== owner || !b.complete || b.dead || !b.def.dropoff || !b.def.dropoff.includes(res)) continue;
      const d = dist(b.x, b.y, x, y);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  doGather(u, o, dt) {
    let t = o.target;
    if (!this.validGatherTarget(u, t)) {
      const res = t ? (t.entity === 'node' ? t.res : 'food') : u.carry.res;
      const px = t ? t.x : u.x, py = t ? t.y : u.y;
      this.releaseFarm(u);
      t = res ? this.findGatherTarget(u, res, px, py) : null;
      if (!t) {
        if (u.carry.amount > 0) this.setOrder(u, { type: 'return', next: null });
        else u.order = null;
        return;
      }
      o.target = t;
      u.path = [];
      u.stuck = 0;
    }
    const res = t.entity === 'node' ? t.res : 'food';
    if (u.carry.amount > 0 && u.carry.res !== res) { u.carry.amount = 0; }
    if (u.carry.amount >= CARRY_CAP) {
      u.lastNode = t;
      this.releaseFarm(u);
      this.setOrder(u, { type: 'return', next: t });
      return;
    }
    const reach = t.entity === 'building' ? (u.x >= t.x0 && u.x < t.x1 && u.y >= t.y0 && u.y < t.y1) : this.edgeDist(u, t) <= INTERACT;
    if (reach) {
      u.path = [];
      if (t.entity === 'building') t.worker = u.id;
      u.facing = t.x < u.x ? -1 : 1;
      u.carry.res = res;
      const amt = Math.min(this.gatherRate(u.owner, this.nodeKind(t)) * dt, t.entity === 'node' ? t.amount : Infinity);
      u.carry.amount += amt;
      u.working = true;
      if (t.entity === 'node') {
        t.amount -= amt;
        this.dirtyNodes.add(t);
        if (t.amount <= 0.0001) this.depleteNode(t);
      }
      return;
    }
    u.working = false;
    if (!u.path.length) {
      if (t.entity === 'node' && this.edgeDist(u, t) < 1.5 * TILE) { this.stepToward(u, t.x, t.y, dt); return; }
      this.pathToEntity(u, t);
      if (t.entity === 'building') { u.finalPoint = { x: t.x, y: t.y }; }
      if (!u.path.length) {
        u.stuck = (u.stuck || 0) + 1;
        if (u.stuck > 3) {
          // Try a different node of the same type.
          const other = this.findGatherTarget(u, res, u.x, u.y);
          if (other && other !== t && u.stuck < 8) { o.target = other; return; }
          u.order = null;
        }
        return;
      }
    }
    this.follow(u, dt);
  }

  depleteNode(n) {
    n.amount = 0;
    n.dead = true;
    const i = n.ty * MAP_W + n.tx;
    this.map.block[i] = B_FREE;
    this.map.nodeAt[i] = null;
    this.map.nodes = this.map.nodes.filter((m) => m !== n);
    this.depleted.push(n);
  }

  doReturn(u, o, dt) {
    if (!u.carry.amount) { this.afterDropoff(u, o); return; }
    let d = o.dropoff;
    if (!d || d.dead) {
      d = o.dropoff = this.findDropoff(u.owner, u.carry.res, u.x, u.y);
      u.path = [];
      if (!d) { u.order = null; return; }
    }
    if (this.edgeDist(u, d) <= INTERACT) {
      const p = this.players[u.owner];
      p.res[u.carry.res] += u.carry.amount;
      p.stats.gathered += u.carry.amount;
      u.carry.amount = 0;
      this.afterDropoff(u, o);
      return;
    }
    if (!u.path.length) {
      if (this.edgeDist(u, d) < 1.5 * TILE) { this.stepToward(u, d.x, d.y, dt); return; }
      this.pathToEntity(u, d);
      if (!u.path.length) {
        u.stuck = (u.stuck || 0) + 1;
        if (u.stuck > 5) { o.dropoff = null; u.order = null; }
        return;
      }
    }
    this.follow(u, dt);
  }

  afterDropoff(u, o) {
    const next = o.next && this.validGatherTarget(u, o.next) ? o.next : this.findGatherTarget(u, u.carry.res || (o.next && o.next.res) || 'food', o.next ? o.next.x : u.x, o.next ? o.next.y : u.y);
    if (next) this.setOrder(u, { type: 'gather', target: next });
    else u.order = null;
  }

  doBuild(u, o, dt) {
    const b = o.target;
    if (!b || b.dead || (b.complete && b.hp >= b.maxHp)) {
      if (b && !b.dead && b.complete) this.afterBuild(u, b);
      else u.order = null;
      return;
    }
    if (this.edgeDist(u, b) <= INTERACT || (b.def.walkable && u.x >= b.x0 && u.x < b.x1 && u.y >= b.y0 && u.y < b.y1)) {
      u.path = [];
      u.working = true;
      u.facing = b.x < u.x ? -1 : 1;
      if (!b.complete) {
        const t = this.buildTime(b.owner, b.type);
        b.progress += dt / t;
        b.hp = Math.min(b.maxHp, b.hp + (b.maxHp * 0.9 * dt) / t);
        if (b.progress >= 1) {
          b.progress = 1;
          b.complete = true;
          this.players[b.owner].stats.built++;
          this.events.push({ type: 'built', owner: b.owner, btype: b.type });
        }
      } else {
        b.hp = Math.min(b.maxHp, b.hp + 15 * dt);
      }
      return;
    }
    u.working = false;
    if (!u.path.length) {
      if (this.edgeDist(u, b) < 1.5 * TILE) { this.stepToward(u, b.x, b.y, dt); return; }
      this.pathToEntity(u, b);
      if (!u.path.length) {
        u.stuck = (u.stuck || 0) + 1;
        if (u.stuck > 5) u.order = null;
        return;
      }
    }
    this.follow(u, dt);
  }

  // What a peasant does after finishing a building.
  afterBuild(u, b) {
    const want = { farm: 'food', mill: 'food', lumbercamp: 'wood', miningcamp: b.owner % 2 ? 'stone' : 'gold' }[b.type];
    if (b.type === 'farm' && this.validGatherTarget(u, b)) { this.setOrder(u, { type: 'gather', target: b }); return; }
    // Help with another nearby foundation first.
    const other = this.entities.find((e) => e.entity === 'building' && e.owner === u.owner && !e.complete && !e.dead && dist(e.x, e.y, u.x, u.y) < 8 * TILE);
    if (other) { this.setOrder(u, { type: 'build', target: other }); return; }
    if (want) {
      const t = this.findGatherTarget(u, want, b.x, b.y, 10 * TILE);
      if (t) { this.setOrder(u, { type: 'gather', target: t }); return; }
    }
    u.order = null;
  }

  // ---------- buildings ----------
  updateBuilding(b, dt) {
    if (!b.complete) return;
    if (b.queue.length) {
      const q = b.queue[0];
      const p = this.players[b.owner];
      if (q.progress === 0 && p.pop >= p.popCap) b.blocked = true;
      else {
        if (q.progress === 0) p.pop++;
        b.blocked = false;
        q.progress += dt / this.unitDef(b.owner, q.type).time;
        if (q.progress >= 1) {
          b.queue.shift();
          this.spawnFrom(b, q.type);
        }
      }
    }
    const atk = b.def.attack;
    if (atk) {
      b.cooldown -= dt;
      if (b.cooldown <= 0) {
        b.cooldown = 0.4;
        let best = null, bestD = atk.range * TILE;
        for (const e of this.entities) {
          if (e.entity !== 'unit' || e.dead || !this.isEnemy(b.owner, e.owner)) continue;
          const dx = Math.max(b.x0 - e.x, 0, e.x - b.x1), dy = Math.max(b.y0 - e.y, 0, e.y - b.y1);
          const d = Math.hypot(dx, dy);
          if (d < bestD) { bestD = d; best = e; }
        }
        if (best) {
          b.cooldown = atk.cooldown;
          const dmg = Math.max(1, atk.atk - (best.def.armor || 0));
          for (let i = 0; i < atk.arrows; i++) {
            this.fireArrow({ x: b.x + (i - (atk.arrows - 1) / 2) * 16, y: b.y - b.size * 6, id: b.id }, best, dmg, b.owner);
          }
        }
      }
    }
  }

  spawnFrom(b, type) {
    const p = this.players[b.owner];
    const rx = b.rally ? b.rally.x : b.x - TILE, ry = b.rally ? b.rally.y : b.y1 + TILE;
    const t = this.freeTileNear(b, rx, ry) || [b.tx - 1, b.ty + b.size];
    const u = this.addUnit(b.owner, type, (t[0] + 0.5) * TILE, (t[1] + 0.5) * TILE);
    p.stats.trained++;
    if (b.rally) {
      const rt = b.rally.target;
      if (rt && !rt.dead && u.def.worker && (rt.entity === 'node' || (rt.entity === 'building' && rt.owner === b.owner))) {
        this.cmdSmart(b.owner, [u], b.rally.x, b.rally.y, rt);
      } else this.setOrder(u, { type: 'move', x: b.rally.x, y: b.rally.y });
    }
    this.events.push({ type: 'trained', owner: u.owner, utype: u.type });
    return u;
  }

  // ---------- vision & victory ----------
  computeVision() {
    const human = this.viewer;
    if (human < 0) { this.visible.fill(1); this.explored.fill(1); return; }
    this.visible.fill(0);
    for (const e of this.entities) {
      if (e.dead || !this.isAlly(e.owner, human)) continue;
      const r = e.def.sight + (e.entity === 'building' ? e.size / 2 : 0);
      const cx = e.x / TILE, cy = e.y / TILE;
      const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(MAP_W - 1, Math.ceil(cx - 1 + r));
      const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(MAP_H - 1, Math.ceil(cy - 1 + r));
      const r2 = r * r;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) { const i = y * MAP_W + x; this.visible[i] = 1; this.explored[i] = 1; }
      }
    }
  }

  isVisible(e) {
    const i = Math.floor(e.y / TILE) * MAP_W + Math.floor(e.x / TILE);
    return this.visible[i] === 1;
  }

  // A player is out when their leader dies (see kill) or nothing of theirs is left standing.
  checkVictory() {
    for (const p of this.players) {
      if (p.defeated) continue;
      if (!this.entities.some((e) => e.owner === p.id && !e.dead)) this.forfeit(p.id, `${p.empire.name} has been wiped out`);
    }
    this.checkTeams();
  }

  // The game ends once every surviving player is on one team.
  checkTeams(reason) {
    if (this.over) return;
    const left = this.players.filter((p) => !p.defeated);
    if (new Set(left.map((p) => p.team)).size <= 1) {
      this.over = { winner: left.length ? left[0].id : -1, team: left.length ? left[0].team : null, time: this.time, reason };
    }
  }

  forfeit(pid, reason) {
    const p = this.players[pid];
    if (p.defeated) return;
    p.defeated = true;
    p.defeatReason = reason;
    // A fallen realm crumbles: everything it still owns is gone.
    for (const e of this.entities) if (e.owner === pid && !e.dead) this.kill(e, null);
    this.events.push({ type: 'defeated', player: pid, reason });
    this.checkTeams(reason);
  }
}
