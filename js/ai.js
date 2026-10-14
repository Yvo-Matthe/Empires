'use strict';
// A scripted opponent: grows an economy, builds an army and attacks in waves.

class AIController {
  constructor(game, pid) {
    this.g = game;
    this.pid = pid;
    this.timer = 1 + pid * 0.37;
    this.diff = game.difficulty;
    this.waveSize = this.diff.waveStart;
    this.nextAttack = this.diff.firstAttack;
    this.alarm = null;
    this.wave = new Set();
    this.rng = mulberry32(game.seed * 31 + pid);
  }

  update(dt) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 1;
    this.think();
  }

  onAttacked(target, attacker) {
    const home = this.home();
    if (!home) return;
    // Only raise the alarm for fights near our base.
    if (dist(target.x, target.y, home.x, home.y) < 22 * TILE) this.alarm = { time: this.g.time, attacker };
  }

  home() {
    return this.g.entities.find((e) => e.owner === this.pid && e.entity === 'building' && e.type === 'towncenter') ||
      this.g.entities.find((e) => e.owner === this.pid && e.entity === 'building');
  }

  think() {
    const g = this.g, pid = this.pid, p = g.players[pid];
    if (p.defeated) return;
    const mine = g.entities.filter((e) => e.owner === pid && !e.dead);
    const units = mine.filter((e) => e.entity === 'unit');
    const peasants = units.filter((u) => u.def.worker);
    const army = units.filter((u) => !u.def.worker && u.type !== 'leader');
    const leader = units.find((u) => u.type === 'leader');
    const blds = mine.filter((e) => e.entity === 'building');
    if (g.battle) { this.battleThink(army, leader); return; }
    const home = this.home();
    if (!home) return;
    this.ctx = { p, peasants, army, blds, home };

    this.guardLeader(leader, home);
    this.trainPeasants();
    this.ensureBuilders();
    this.planBuildings();
    this.assignIdle();
    this.trainArmy();
    this.useArmy();
  }

  // Battle mode: advance on the enemy army, keeping the leader a little behind the line.
  battleThink(army, leader) {
    const g = this.g;
    const foes = g.entities.filter((e) => e.entity === 'unit' && !e.dead && g.isEnemy(this.pid, e.owner));
    if (!foes.length) return;
    const near = (from) => foes.reduce((b, e) => (dist(e.x, e.y, from.x, from.y) < dist(b.x, b.y, from.x, from.y) ? e : b));
    const idle = army.filter((u) => !u.order);
    if (idle.length) {
      const t = near(idle[0]);
      g.cmdMove(idle, t.x, t.y, true);
    }
    if (leader && (!leader.order || leader.order.type === 'move')) {
      const threat = near(leader);
      if (!army.length || dist(threat.x, threat.y, leader.x, leader.y) < 4 * TILE) {
        if (!leader.order) g.cmdAttack([leader], threat);
      } else if (this.rng() < 0.3) {
        const cx = army.reduce((s, u) => s + u.x, 0) / army.length, cy = army.reduce((s, u) => s + u.y, 0) / army.length;
        const a = Math.atan2(cy - threat.y, cx - threat.x);
        g.cmdMove([leader], cx + Math.cos(a) * 3 * TILE, cy + Math.sin(a) * 3 * TILE);
      }
    }
  }

  // The AI keeps its leader safe behind its Town Center.
  guardLeader(leader, home) {
    if (!leader || leader.order) return;
    const enemy = this.enemyStart();
    const a = Math.atan2(enemy.y * TILE - home.y, enemy.x * TILE - home.x) + Math.PI;
    const x = home.x + Math.cos(a) * 4 * TILE, y = home.y + Math.sin(a) * 4 * TILE;
    if (dist(leader.x, leader.y, x, y) > 3 * TILE) this.g.cmdMove([leader], x, y);
  }

  count(type, completeOnly = false) {
    return this.ctx.blds.filter((b) => b.type === type && (!completeOnly || b.complete)).length;
  }

  trainPeasants() {
    const { peasants, blds } = this.ctx;
    const queued = blds.reduce((s, b) => s + b.queue.filter((q) => q.type === 'peasant').length, 0);
    if (peasants.length + queued >= this.diff.workers) return;
    for (const tc of blds) if (tc.type === 'towncenter' && tc.complete && tc.queue.length < 2) this.g.cmdTrain(tc, 'peasant');
  }

  // Every foundation should have someone working on it.
  ensureBuilders() {
    const { peasants, blds } = this.ctx;
    for (const b of blds) {
      if (b.complete && b.hp >= b.maxHp * 0.6) continue;
      const working = peasants.filter((u) => u.order && u.order.type === 'build' && u.order.target === b).length;
      const want = b.complete ? 1 : b.size >= 3 ? 2 : 1;
      if (working >= want) continue;
      const helpers = this.pickWorkers(want - working, b.x, b.y);
      this.g.cmdBuild(helpers, b);
    }
  }

  pickWorkers(n, x, y) {
    const { peasants } = this.ctx;
    const score = (u) => {
      const busy = !u.order ? 0 : u.order.type === 'build' ? 1e6 : u.carry.amount > 6 ? 5000 : 1000;
      return busy + dist(u.x, u.y, x, y);
    };
    return peasants.slice().sort((a, b) => score(a) - score(b)).slice(0, n).filter((u) => score(u) < 1e6);
  }

  planBuildings() {
    const g = this.g, { p, peasants, blds, home } = this.ctx;
    const building = blds.filter((b) => !b.complete).length;
    if (building >= 2) return;
    const n = peasants.length, t = g.time;
    const want = [];
    const houseBuilding = blds.some((b) => b.type === 'house' && !b.complete);
    if (p.popCap - p.pop <= 4 && p.popCap < MAX_POP && !houseBuilding) want.push('house');
    if (n >= 5 && !this.count('lumbercamp')) want.push('lumbercamp');
    if (n >= 7 && !this.count('mill') && this.nearest('food', home, 14)) want.push('mill');
    if (n >= 8 && !this.count('miningcamp')) want.push('miningcamp');
    if (n >= 10 && !this.count('barracks')) want.push('barracks');
    if (this.needFarm()) want.push('farm');
    if (n >= 13 && !this.count('archeryrange')) want.push('archeryrange');
    if (n >= 16 && !this.count('stable')) want.push('stable');
    if (t > 540 && this.count('miningcamp') < 2) want.push('miningcamp');
    if (t > 600 && this.count('tower') < 2) want.push('tower');
    if (t > 780 && !this.count('castle')) want.push('castle');
    if (t > 720 && this.count('barracks') < 2 && p.res.wood > 350) want.push('barracks');
    if (t > 900 && this.count('lumbercamp') < 2) want.push('lumbercamp');

    for (const type of want) {
      if (!g.buildingUnlocked(this.pid, type)) continue;
      if (!canAfford(p.res, g.buildingCost(this.pid, type))) {
        if (type === 'house' || type === 'farm') return; // save up for essentials
        continue;
      }
      const spot = this.findSpot(type);
      if (!spot) continue;
      const builders = this.pickWorkers(type === 'house' || type === 'farm' ? 1 : 2, spot[0] * TILE, spot[1] * TILE);
      if (!builders.length) return;
      const r = g.cmdPlace(this.pid, type, spot[0], spot[1], builders);
      if (r.building) return;
    }
  }

  needFarm() {
    const { peasants, blds, home } = this.ctx;
    if (peasants.length < 8) return false;
    const farms = blds.filter((b) => b.type === 'farm').length;
    const berries = this.g.map.nodes.some((n) => n.kind === 'berries' && dist(n.x, n.y, home.x, home.y) < 14 * TILE);
    const target = Math.round(peasants.length * (berries ? 0.15 : 0.4));
    return farms < target;
  }

  nearest(res, from, maxTiles) {
    let best = null, bestD = maxTiles * TILE;
    for (const n of this.g.map.nodes) {
      if (n.res !== res) continue;
      const d = dist(n.x, n.y, from.x, from.y);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  // Search rings of tiles around an anchor for a valid footprint with a one-tile margin.
  findSpot(type) {
    const g = this.g, { home } = this.ctx;
    const size = BUILDINGS[type].size;
    let anchor = home, minR = 3, maxR = 14;
    const near = { lumbercamp: 'wood', mill: 'food', miningcamp: this.count('miningcamp') ? 'stone' : 'gold' }[type];
    if (near) {
      const n = this.nearest(near, home, 24);
      if (!n) return null;
      anchor = n; minR = 1; maxR = 5;
    } else if (type === 'farm') {
      anchor = this.ctx.blds.find((b) => b.type === 'mill' && b.complete) || home;
      minR = 2; maxR = 12;
    } else if (type === 'tower') {
      const enemy = this.enemyStart();
      const a = Math.atan2(enemy.y * TILE - home.y, enemy.x * TILE - home.x) + (this.rng() - 0.5) * 1.6;
      anchor = { x: home.x + Math.cos(a) * 8 * TILE, y: home.y + Math.sin(a) * 8 * TILE };
      minR = 0; maxR = 5;
    }
    const ax = Math.floor(anchor.x / TILE), ay = Math.floor(anchor.y / TILE);
    for (let r = minR; r <= maxR; r++) {
      const cands = [];
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        cands.push([ax + dx - Math.floor(size / 2), ay + dy - Math.floor(size / 2)]);
      }
      for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [cands[i], cands[j]] = [cands[j], cands[i]]; }
      for (const [tx, ty] of cands) if (this.spotOk(type, tx, ty)) return [tx, ty];
    }
    return null;
  }

  spotOk(type, tx, ty) {
    const g = this.g, size = BUILDINGS[type].size;
    if (!g.canPlace(this.pid, type, tx, ty)) return false;
    // Leave a walkable ring so the base does not wall itself in.
    for (let y = ty - 1; y <= ty + size; y++) for (let x = tx - 1; x <= tx + size; x++) {
      if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return false;
      const i = y * MAP_W + x;
      if (g.occupied[i] || (type !== 'lumbercamp' && type !== 'miningcamp' && type !== 'mill' && g.map.block[i] === B_NODE)) return false;
    }
    return true;
  }

  assignIdle() {
    const g = this.g, { peasants, home } = this.ctx;
    const t = g.time;
    const ratio = t < 300 ? { food: 0.5, wood: 0.4, gold: 0.1, stone: 0 }
      : t < 700 ? { food: 0.4, wood: 0.32, gold: 0.2, stone: 0.08 }
        : { food: 0.38, wood: 0.27, gold: 0.22, stone: 0.13 };
    const have = { food: 0, wood: 0, gold: 0, stone: 0 };
    const idle = [];
    for (const u of peasants) {
      const o = u.order;
      if (!o) { idle.push(u); continue; }
      if (o.type === 'gather' && o.target) have[o.target.entity === 'node' ? o.target.res : 'food']++;
      else if (o.type === 'return' && u.carry.res) have[u.carry.res]++;
    }
    for (const u of idle) {
      const order = RESOURCES.slice().sort((a, b) => (have[a] - ratio[a] * peasants.length) - (have[b] - ratio[b] * peasants.length));
      for (const res of order) {
        const target = g.findGatherTarget(u, res, home.x, home.y, 26 * TILE);
        if (target) {
          g.cmdGather([u], target);
          have[res]++;
          break;
        }
      }
    }
  }

  trainArmy() {
    const g = this.g, { p, blds, army } = this.ctx;
    // Keep a reserve for houses and new peasants.
    const reserve = { food: 60, wood: 40, stone: 0, gold: 0 };
    const foes = g.entities.filter((e) => e.entity === 'unit' && g.isEnemy(this.pid, e.owner));
    const enemyCav = foes.filter((e) => e.def.tags.includes('cavalry')).length;
    const enemyArch = foes.filter((e) => e.def.tags.includes('ranged')).length;
    if (army.length >= 60) return;
    for (const b of blds) {
      if (!b.complete || !b.def.trains || b.type === 'towncenter' || b.queue.length >= 2) continue;
      const options = g.trainable(b);
      let type = options[0];
      if (b.type === 'barracks') type = enemyCav > 3 && this.rng() < 0.6 ? 'spearman' : this.rng() < 0.65 ? 'manatarms' : 'spearman';
      if (b.type === 'stable' && enemyArch > 4) type = 'knight';
      const cost = g.unitDef(this.pid, type).cost;
      let ok = true;
      for (const k in cost) if (p.res[k] - cost[k] < reserve[k]) ok = false;
      if (ok) g.cmdTrain(b, type);
    }
  }

  useArmy() {
    const g = this.g, { army, home } = this.ctx;
    for (const id of this.wave) if (!g.byId.has(id)) this.wave.delete(id);

    // Defend the base.
    if (this.alarm && g.time - this.alarm.time < 8 && !this.alarm.attacker.dead) {
      const a = this.alarm.attacker;
      for (const u of army) {
        if (this.wave.has(u.id)) continue;
        if (!u.order || u.order.type === 'move') g.cmdAttack([u], a);
      }
    }

    // Launch an attack wave.
    const free = army.filter((u) => !this.wave.has(u.id));
    if (g.time >= this.nextAttack && free.length >= this.waveSize) {
      const target = this.attackTarget();
      if (target) {
        g.cmdMove(free, target.x, target.y, true);
        free.forEach((u) => this.wave.add(u.id));
        this.waveSize = Math.min(30, this.waveSize + 3);
        this.nextAttack = g.time + 100;
      }
    }

    // Wave members that have finished their orders push on to the next target.
    const idleWave = army.filter((u) => this.wave.has(u.id) && !u.order);
    if (idleWave.length) {
      const target = this.attackTarget(idleWave[0]);
      if (target) g.cmdMove(idleWave, target.x, target.y, true);
    }

    // Everyone else gathers at a rally point in front of the base.
    const enemy = this.enemyStart();
    const a = Math.atan2(enemy.y * TILE - home.y, enemy.x * TILE - home.x);
    const rx = home.x + Math.cos(a) * 6 * TILE, ry = home.y + Math.sin(a) * 6 * TILE;
    const loiter = army.filter((u) => !this.wave.has(u.id) && !u.order && dist(u.x, u.y, rx, ry) > 4 * TILE);
    if (loiter.length) g.cmdMove(loiter, rx, ry);
  }

  // Start position of the nearest player still in the fight against us.
  enemyStart() {
    const g = this.g, me = START_POS[this.pid];
    const foes = g.players.filter((p) => g.isEnemy(this.pid, p.id) && !p.defeated).map((p) => START_POS[p.id]);
    if (!foes.length) return START_POS[(this.pid + 1) % g.players.length];
    return foes.sort((a, b) => dist(a.x, a.y, me.x, me.y) - dist(b.x, b.y, me.x, me.y))[0];
  }

  attackTarget(from) {
    const g = this.g;
    const origin = from || this.ctx.home;
    let best = null, bestD = Infinity;
    for (const e of g.entities) {
      if (!this.g.isEnemy(this.pid, e.owner) || e.dead || e.entity !== 'building') continue;
      const d = dist(e.x, e.y, origin.x, origin.y) + (e.type === 'tower' || e.type === 'castle' ? 15 * TILE : 0);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }
}
