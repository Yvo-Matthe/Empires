'use strict';
// Multiplayer. The server (server/index.js) runs the authoritative simulation and
// streams snapshots; clients render them and send commands back. The snapshot format
// lives here so the server and the browser share one definition.

const SNAPSHOT_MS = 100;

// ---------- server side ----------
function makeSnapshot(game) {
  const r2 = (v) => Math.round(v * 100) / 100;
  const e = game.entities.map((en) => {
    const lh = game.time - en.lastHit < 3 ? r2(en.lastHit) : 0;
    if (en.entity === 'unit') {
      const o = en.order, t = o && o.target;
      return {
        i: en.id, k: 0, t: en.type, o: en.owner, x: Math.round(en.x), y: Math.round(en.y), h: Math.ceil(en.hp),
        f: en.facing, m: en.moving ? 1 : 0, a: en.attackAnim > 0 ? 1 : 0, w: en.working ? 1 : 0, lh,
        c: en.carry.amount > 0 ? [en.carry.res, Math.floor(en.carry.amount)] : 0,
        r: o ? [o.type, t && t.entity === 'node' ? t.res : t && t.def && t.def.farm ? 'food' : 0] : 0,
      };
    }
    return {
      i: en.id, k: 1, t: en.type, o: en.owner, tx: en.tx, ty: en.ty, h: Math.ceil(en.hp), lh,
      c: en.complete ? 1 : 0, p: r2(en.progress), q: en.queue.map((q) => [q.type, r2(q.progress)]),
      ry: en.rally ? [Math.round(en.rally.x), Math.round(en.rally.y)] : 0, b: en.blocked ? 1 : 0, wk: en.worker ? 1 : 0,
    };
  });
  const snap = {
    t: 'snap', time: r2(game.time), e,
    dep: game.depleted.map((n) => n.id),
    nd: [...game.dirtyNodes].filter((n) => !n.dead).map((n) => [n.id, Math.ceil(n.amount)]),
    pr: game.projectiles.map((p) => [Math.round(p.x), Math.round(p.y), p.target.id]),
    pl: game.players.map((p) => ({
      r: Object.fromEntries(RESOURCES.map((k) => [k, Math.floor(p.res[k])])), p: p.pop, c: p.popCap, d: p.defeated, s: p.stats,
    })),
    ev: game.events.filter((ev) => ev.type === 'alert' || ev.type === 'built' || ev.type === 'defeated')
      .map((ev) => ({ ...ev, x: ev.x && Math.round(ev.x), y: ev.y && Math.round(ev.y) })),
    over: game.over,
  };
  game.depleted.length = 0;
  game.dirtyNodes.clear();
  game.events.length = 0;
  return snap;
}

// ---------- client side ----------
function applySnapshot(game, s) {
  const now = performance.now();
  game.time = s.time;
  const seen = new Set();
  for (const d of s.e) {
    seen.add(d.i);
    let en = game.byId.get(d.i);
    if (!en) {
      en = d.k === 0 ? game.addUnit(d.o, d.t, d.x, d.y, d.i) : game.addBuilding(d.o, d.t, d.tx, d.ty, !!d.c, d.i);
      en.nx = en.fx = d.x;
      en.ny = en.fy = d.y;
    }
    en.hp = d.h;
    en.lastHit = d.lh || -99;
    if (d.k === 0) {
      en.fx = en.x; en.fy = en.y; en.nx = d.x; en.ny = d.y; en.t0 = now;
      if (Math.abs(en.nx - en.x) + Math.abs(en.ny - en.y) > 96) { en.x = en.fx = en.nx; en.y = en.fy = en.ny; }
      en.facing = d.f;
      en.moving = !!d.m;
      if (d.a && !(en.attackAnim > 0)) en.attackAnim = 0.25;
      en.working = !!d.w;
      en.carry = d.c ? { res: d.c[0], amount: d.c[1] } : { res: null, amount: 0 };
      en.order = d.r ? { type: d.r[0], target: d.r[1] ? { res: d.r[1] } : null } : null;
    } else {
      en.complete = !!d.c;
      en.progress = d.p;
      en.queue = d.q.map(([type, progress]) => ({ type, progress }));
      en.rally = d.ry ? { x: d.ry[0], y: d.ry[1] } : null;
      en.blocked = !!d.b;
      en.worker = d.wk ? 1 : null;
    }
  }
  for (const en of game.entities) if (!seen.has(en.id)) game.kill(en, null);
  game.removeDead();
  game.events.length = 0;

  if (!game.nodeById) game.nodeById = new Map(game.map.nodes.map((n) => [n.id, n]));
  for (const id of s.dep) { const n = game.nodeById.get(id); if (n && !n.dead) game.depleteNode(n); }
  for (const [id, amt] of s.nd) { const n = game.nodeById.get(id); if (n) n.amount = amt; }

  game.projectiles = s.pr.map(([x, y, tid]) => ({ x, y, target: game.byId.get(tid) })).filter((p) => p.target);
  s.pl.forEach((p, i) => {
    const pl = game.players[i];
    pl.res = p.r; pl.pop = p.p; pl.popCap = p.c; pl.defeated = p.d; pl.stats = p.s;
  });
  game.over = s.over;
  return s.ev;
}

// Smoothly move units between snapshots.
function interpolate(game, dt) {
  const now = performance.now();
  for (const u of game.entities) {
    if (u.entity !== 'unit' || u.nx === undefined) continue;
    const k = Math.min(1, (now - (u.t0 || 0)) / SNAPSHOT_MS);
    u.x = u.fx + (u.nx - u.fx) * k;
    u.y = u.fy + (u.ny - u.fy) * k;
    u.anim += dt;
    if (u.attackAnim > 0) u.attackAnim -= dt;
  }
}

class NetClient {
  constructor() {
    this.handlers = {};
  }
  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      this.ws = new WebSocket(`${proto}://${location.host}/ws`);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('Could not reach the game server.'));
      this.ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        const h = this.handlers[msg.t];
        if (h) h(msg);
      };
      this.ws.onclose = () => this.handlers.close && this.handlers.close();
    });
  }
  on(type, fn) { this.handlers[type] = fn; }
  send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  close() { this.handlers = {}; if (this.ws) this.ws.close(); }
}

// Same interface as the local commands in main.js, but sent to the server by id.
function netCommands(net, game, pid) {
  const ids = (list) => list.map((e) => e.id);
  const send = (c, extra) => net.send({ t: 'cmd', c, ...extra });
  return {
    smart(units, x, y, target) {
      send('smart', { u: ids(units), x, y, tg: target ? target.id : null });
      return target ? (target.entity === 'node' ? 'gather' : game.isEnemy(pid, target.owner) ? 'attack' : 'build') : 'move';
    },
    move(units, x, y, attackMove) { send('move', { u: ids(units), x, y, am: !!attackMove }); },
    stop(units) { send('stop', { u: ids(units) }); },
    place(type, tx, ty, units) {
      const p = game.players[pid];
      if (!game.buildingUnlocked(pid, type)) return { error: `Requires ${BUILDINGS[BUILDINGS[type].requires].name}` };
      if (!canAfford(p.res, game.buildingCost(pid, type))) return { error: 'Not enough resources' };
      if (!game.canPlace(pid, type, tx, ty)) return { error: 'Cannot build there' };
      pay(p.res, game.buildingCost(pid, type)); // optimistic, corrected by the next snapshot
      send('place', { type, tx, ty, u: ids(units) });
      return { ok: true };
    },
    train(b, type) {
      const p = game.players[pid], cost = game.unitDef(pid, type).cost;
      if (!canAfford(p.res, cost)) return { error: 'Not enough resources' };
      if (b.queue.length >= 5) return { error: 'Queue is full' };
      pay(p.res, cost);
      b.queue.push({ type, progress: 0 });
      send('train', { b: b.id, type });
      return { ok: true };
    },
    cancel(b, i) { send('cancel', { b: b.id, i }); },
    rally(b, x, y, target) { b.rally = { x, y }; send('rally', { b: b.id, x, y, tg: target ? target.id : null }); },
    del(e) { send('delete', { id: e.id }); },
    chat(text) { net.send({ t: 'chat', text }); },
  };
}
