'use strict';
// Empires game server: serves the game files and hosts multiplayer battle rooms and
// multiplayer world campaigns (versus or co-op, saved to disk so players can rejoin).
// Usage: npm start  (then open http://localhost:8080, or http://<your-ip>:8080 from another PC)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { loadSim } = require('./sim');

const S = loadSim();
const MAX_PLAYERS = S.MAX_PLAYERS;
const MAX_WORLD_PLAYERS = 8;
const PORT = Number(process.env.PORT) || 8080;
const ROOT = path.join(__dirname, '..');
const WORLD_DIR = process.env.WORLD_DIR || path.join(ROOT, 'data', 'worlds');
// Test knobs: run world clocks and battles faster than real time.
const WORLD_SPEED = Number(process.env.WORLD_SPEED) || 1;
const MATCH_SPEED = Number(process.env.MATCH_SPEED) || 1;
const PUBLIC = ['index.html', 'style.css', 'js'];
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

// ---------- static files ----------
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  rel = path.relative(ROOT, file);
  const allowed = PUBLIC.some((p) => rel === p || rel.startsWith(p + path.sep)) && MIME[path.extname(file)];
  if (!allowed) { res.writeHead(404); res.end('Not found'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); }
function cleanName(n) { return String(n || '').replace(/[^\w \-'.]/g, '').trim().slice(0, 16) || 'Lord'; }
function cleanEmpire(e) { return S.PLAYABLE_EMPIRES.includes(e) ? e : 'aldermark'; }
function cleanTeam(t) { return Number.isInteger(t) && t >= 1 && t <= MAX_PLAYERS ? t : 1; }

// ---------- matches: one running real-time game and the sockets playing it ----------
class Match {
  constructor(game, onEnd) {
    this.game = game;
    this.onEnd = onEnd;
    this.seats = new Map(); // ws -> player id
    this.timer = null;
    game.nodeById = new Map(game.map.nodes.map((n) => [n.id, n]));
  }

  seat(ws, pid) { this.seats.set(ws, pid); ws.match = this; }

  // A player leaves the battle. Returns the player id they controlled.
  unseat(ws) {
    const pid = this.seats.get(ws);
    this.seats.delete(ws);
    if (ws.match === this) ws.match = null;
    return pid;
  }

  humans(pid) { return [...this.seats.values()].filter((p) => p === pid).length; }

  start() {
    let tick = 0;
    this.timer = setInterval(() => {
      try {
        for (let i = 0; i < MATCH_SPEED && !this.game.over; i++) this.game.step();
        if (++tick % 2 === 0 || this.game.over) {
          const snap = JSON.stringify(S.makeSnapshot(this.game));
          for (const ws of this.seats.keys()) send(ws, snap);
        }
        if (this.game.over) this.finish();
      } catch (err) {
        console.error('Simulation error', err);
        this.stop();
      }
    }, 1000 * S.TICK);
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  finish() {
    this.stop();
    for (const ws of [...this.seats.keys()]) if (ws.match === this) ws.match = null;
    if (this.onEnd) this.onEnd(this.game);
  }

  broadcastSnapshot() {
    const snap = JSON.stringify(S.makeSnapshot(this.game));
    for (const ws of this.seats.keys()) send(ws, snap);
  }

  // Resolve ids from a client command, keeping only what that player may control.
  command(ws, m) {
    const g = this.game, slot = this.seats.get(ws);
    if (slot === undefined || g.over) return;
    const notice = (text) => send(ws, { t: 'notice', text });
    const own = (e) => e && !e.dead && e.owner === slot;
    const units = Array.isArray(m.u) ? m.u.map((id) => g.byId.get(id)).filter((e) => own(e) && e.entity === 'unit') : [];
    const lookup = (id) => (typeof id !== 'number' ? null : id < 0 ? g.nodeById.get(id) : g.byId.get(id)) || null;
    const num = (v) => (Number.isFinite(v) ? v : 0);
    const target = lookup(m.tg);
    const b = lookup(m.b);
    switch (m.c) {
      case 'smart': g.cmdSmart(slot, units, num(m.x), num(m.y), target && !target.dead ? target : null); break;
      case 'move': if (units.length) g.cmdMove(units, num(m.x), num(m.y), !!m.am); break;
      case 'stop': g.cmdStop(units); break;
      case 'place': {
        if (!S.BUILDINGS[m.type]) return;
        const r = g.cmdPlace(slot, m.type, num(m.tx) | 0, num(m.ty) | 0, units);
        if (r.error) notice(r.error);
        break;
      }
      case 'train': if (own(b) && b.entity === 'building') { const r = g.cmdTrain(b, m.type); if (r.error) notice(r.error); } break;
      case 'cancel': if (own(b) && b.entity === 'building') g.cmdCancel(b, num(m.i)); break;
      case 'rally': if (own(b) && b.entity === 'building') g.cmdRally(b, num(m.x), num(m.y), target && !target.dead ? target : null); break;
      case 'delete': { const e = lookup(m.id); if (own(e)) g.cmdDelete(e); break; }
    }
  }
}

// ---------- rooms (battle lobbies) and worlds share one code space ----------
const rooms = new Map();

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  while (rooms.has(code));
  return code;
}

// ---------- battle rooms ----------
function broadcast(room, msg) { const s = JSON.stringify(msg); for (const p of room.players) send(p.ws, s); }

function roomState(room) {
  broadcast(room, {
    t: 'lobby', code: room.code, difficulty: room.difficulty, max: MAX_PLAYERS,
    players: room.players.map((p) => ({ name: p.name, empire: p.empire, team: p.team, ai: !!p.ai })),
  });
  room.players.forEach((p, i) => send(p.ws, { t: 'you', slot: i, host: p.ws === room.host }));
}

function freeTeam(room) {
  for (let t = 1; t <= MAX_PLAYERS; t++) if (!room.players.some((p) => p.team === t)) return t;
  return 1;
}
function aiName(room) { return `Computer (${S.DIFFICULTY[room.difficulty].name})`; }

function leaveRoom(ws, room) {
  const me = room.players.find((p) => p.ws === ws);
  if (!me) return;
  if (room.match) {
    // Leaving a running game forfeits it; allies and AI players keep fighting.
    me.ws = null;
    room.match.unseat(ws);
    const g = room.match.game;
    if (!g.over) {
      g.forfeit(me.slot, `${me.name} left the game`);
      room.match.broadcastSnapshot();
    }
    if (g.over || !room.players.some((p) => p.ws)) room.match.stop();
  } else {
    room.players.splice(room.players.indexOf(me), 1);
    if (room.host === ws) room.host = (room.players.find((p) => p.ws) || {}).ws || null;
  }
  if (!room.players.some((p) => p.ws)) { if (room.match) room.match.stop(); rooms.delete(room.code); return; }
  if (!room.match) roomState(room);
}

function startRoom(room) {
  const seed = Math.floor(Math.random() * 1e9);
  const empires = room.players.map((p) => p.empire);
  const names = room.players.map((p) => p.name);
  const teams = room.players.map((p) => p.team);
  const ai = room.players.map((p) => !!p.ai);
  const game = new S.Game({ seed, empires, teams, ai, difficulty: room.difficulty, viewer: -1 });
  game.players.forEach((p, i) => { p.name = names[i]; });
  room.match = new Match(game);
  room.players.forEach((p, i) => {
    p.slot = i;
    if (p.ws) room.match.seat(p.ws, i);
    send(p.ws, { t: 'start', seed, empires, names, teams, ai, difficulty: room.difficulty, you: i });
  });
  room.match.start();
}

function roomMessage(ws, room, m) {
  const me = room.players.find((p) => p.ws === ws);
  const isHost = !!me && room.host === ws;
  switch (m.t) {
    case 'empire':
      if (me && !room.match) { me.empire = cleanEmpire(m.empire); roomState(room); }
      break;
    case 'team':
      if (me && !room.match) { me.team = cleanTeam(m.team); roomState(room); }
      break;
    // Host-only lobby settings: AI players and difficulty.
    case 'addAi':
      if (isHost && !room.match && room.players.length < MAX_PLAYERS) {
        const keys = S.PLAYABLE_EMPIRES;
        room.players.push({ team: freeTeam(room), ws: null, ai: true, name: aiName(room), empire: keys[Math.floor(Math.random() * keys.length)] });
        roomState(room);
      }
      break;
    case 'setAi': {
      const p = isHost && !room.match && room.players[m.i];
      if (p && p.ai) {
        if (m.empire !== undefined) p.empire = cleanEmpire(m.empire);
        if (m.team !== undefined) p.team = cleanTeam(m.team);
        roomState(room);
      }
      break;
    }
    case 'removeAi': {
      const p = isHost && !room.match && room.players[m.i];
      if (p && p.ai) { room.players.splice(m.i, 1); roomState(room); }
      break;
    }
    case 'difficulty':
      if (isHost && !room.match && S.DIFFICULTY[m.difficulty]) {
        room.difficulty = m.difficulty;
        for (const p of room.players) if (p.ai) p.name = aiName(room);
        roomState(room);
      }
      break;
    case 'start':
      if (isHost && !room.match) {
        if (room.players.length < 2) { send(ws, { t: 'error', text: 'Add an AI player or wait for someone to join.' }); return; }
        if (new Set(room.players.map((p) => p.team)).size < 2) { send(ws, { t: 'error', text: 'Everyone is on the same team. Put someone on another team.' }); return; }
        startRoom(room);
      }
      break;
    case 'chat':
      if (me) broadcast(room, { t: 'chat', from: me.name, text: String(m.text || '').slice(0, 200) });
      break;
  }
}

// ---------- world campaigns ----------
// A world keeps running while at least one of its players is online. Several players on the
// same country rule it together (co-op); a country without anyone online is ruled by the computer.
function worldFile(code) { return path.join(WORLD_DIR, `${code}.json`); }

function saveWorld(wr) {
  try {
    fs.mkdirSync(WORLD_DIR, { recursive: true });
    const data = { code: wr.code, s: wr.w.s, players: wr.players.map((p) => ({ name: p.name, country: p.country })) };
    fs.writeFileSync(worldFile(wr.code) + '.tmp', JSON.stringify(data));
    fs.renameSync(worldFile(wr.code) + '.tmp', worldFile(wr.code));
    wr.savedAt = Date.now();
  } catch (err) { console.error('Could not save world', wr.code, err.message); }
}

function loadWorlds() {
  let files = [];
  try { files = fs.readdirSync(WORLD_DIR).filter((f) => /^[A-Z]{4}\.json$/.test(f)); } catch { return; }
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(WORLD_DIR, f), 'utf8'));
      if (!data.s || data.s.version !== 2 || data.s.over) continue;
      const wr = makeWorldRoom(data.code, new S.World({ state: data.s, humans: [] }));
      wr.players = data.players.map((p) => ({ ...p, ws: null }));
      // Battles that were being fought when the server stopped are settled by the dice.
      for (const b of [...wr.w.s.battles]) if (b.state === 'fighting') wr.w.autoResolve(b);
    } catch (err) { console.error('Could not load world', f, err.message); }
  }
}

function makeWorldRoom(code, w) {
  const wr = { kind: 'world', code, w, players: [], battles: new Map(), lastSent: 0, savedAt: Date.now() };
  rooms.set(code, wr);
  wr.timer = setInterval(() => worldTick(wr, 0.25), 250);
  return wr;
}

function worldHumans(wr) { return new Set(wr.players.filter((p) => p.ws).map((p) => p.country)); }

function worldState(wr) {
  const msg = JSON.stringify({
    t: 'world', code: wr.code, s: wr.w.s,
    players: wr.players.map((p) => ({ name: p.name, country: p.country, online: !!p.ws, battle: !!(p.ws && p.ws.match) })),
  });
  for (const p of wr.players) send(p.ws, msg);
  wr.lastSent = Date.now();
}

function worldTick(wr, dt) {
  const w = wr.w;
  w.humans = worldHumans(wr);
  if (!w.humans.size || w.s.over) return; // the clock stops while nobody is playing
  w.tick(dt * WORLD_SPEED);
  let changed = false;
  for (const ev of w.events.splice(0)) {
    changed = true;
    if (ev.type === 'fight') startWorldBattle(wr, ev.id);
  }
  if (changed || Date.now() - wr.lastSent > 1000) worldState(wr);
  if (w.s.over || Date.now() - wr.savedAt > 30000) saveWorld(wr);
}

// A battle the players chose to fight: everyone online for either side is pulled in.
function startWorldBattle(wr, battleId) {
  const w = wr.w, b = w.battle(battleId);
  if (!b) return;
  const setup = w.battleSetup(b);
  const seats = wr.players.filter((p) => p.ws && !p.ws.match && setup.owners.includes(p.country));
  if (!seats.length) { w.autoResolve(b); return; }
  const ai = setup.owners.map((o) => !seats.some((p) => p.country === o));
  const game = new S.Game({ seed: setup.seed, empires: setup.empires, ai, battle: setup.battle, difficulty: 'normal', viewer: -1 });
  const names = setup.owners.map((o) => {
    const rulers = wr.players.filter((p) => p.country === o).map((p) => p.name);
    return rulers.length ? rulers.join(' & ') : S.EMPIRES[w.s.empires[o]].name;
  });
  game.players.forEach((p, i) => { p.name = names[i]; });
  const match = new Match(game, (g) => {
    wr.battles.delete(battleId);
    const battle = w.battle(battleId);
    if (!battle) return;
    const winner = g.over.winner >= 0 ? setup.owners[g.over.winner] : w.army(battle.defender).owner;
    w.applyFought(battle, setup.owners, g.survivors(), winner);
    worldState(wr);
    saveWorld(wr);
  });
  wr.battles.set(battleId, match);
  for (const p of seats) {
    const pid = setup.owners.indexOf(p.country);
    match.seat(p.ws, pid);
    send(p.ws, {
      t: 'start', seed: setup.seed, empires: setup.empires, names, teams: [1, 2], ai, difficulty: 'normal', you: pid,
      battle: setup.battle, battleName: setup.name, world: true,
    });
  }
  match.start();
}

// A player leaves a world battle: the computer takes over their troops if nobody else is left.
function leaveBattle(ws) {
  const match = ws.match;
  if (!match) return;
  const pid = match.unseat(ws);
  if (pid !== undefined && !match.humans(pid) && !match.game.over) match.game.setAi(pid, true);
}

function joinWorld(ws, wr, name, empire) {
  let me = wr.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (me && me.ws) { send(ws, { t: 'error', text: 'Someone with that name is already playing in this world.' }); return; }
  if (!me) {
    if (wr.players.length >= MAX_WORLD_PLAYERS) { send(ws, { t: 'error', text: 'That world is full.' }); return; }
    // Players join the country of the empire they picked; pick the same one as a friend to rule together.
    let country = wr.w.s.empires.indexOf(empire);
    if (country < 0 || country > 1) {
      const counts = [0, 1].map((c) => wr.players.filter((p) => p.country === c).length);
      country = counts[0] <= counts[1] ? 0 : 1;
    }
    me = { name, country, ws: null };
    wr.players.push(me);
  }
  me.ws = ws;
  ws.world = wr;
  send(ws, { t: 'wyou', code: wr.code, country: me.country, name: me.name });
  worldState(wr);
  saveWorld(wr);
}

function leaveWorld(ws) {
  const wr = ws.world;
  ws.world = null;
  leaveBattle(ws);
  const me = wr.players.find((p) => p.ws === ws);
  if (me) me.ws = null;
  worldState(wr);
  saveWorld(wr);
}

function worldCommand(ws, wr, m) {
  const me = wr.players.find((p) => p.ws === ws);
  if (!me) return;
  const w = wr.w, c = me.country;
  const int = (v) => (Number.isInteger(v) ? v : -1);
  let r;
  switch (m.c) {
    case 'move': r = w.move(c, int(m.army), int(m.to)); break;
    case 'halt': r = w.halt(c, int(m.army)); break;
    case 'recruit': r = w.recruit(c, int(m.prov), String(m.type)); break;
    case 'split': r = w.split(c, int(m.army)); break;
    case 'envoy': r = w.envoy(c, int(m.prov)); break;
    case 'decide': r = w.decide(c, int(m.battle), !!m.fight); break;
    default: return;
  }
  if (r && r.error) send(ws, { t: 'notice', text: r.error });
  for (const ev of w.events.splice(0)) if (ev.type === 'fight') startWorldBattle(wr, ev.id);
  worldState(wr);
}

// ---------- connections ----------
function leaveAll(ws) {
  if (ws.room) { const r = ws.room; ws.room = null; leaveRoom(ws, r); }
  if (ws.world) leaveWorld(ws);
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'create': {
        leaveAll(ws);
        const r = { kind: 'room', code: newCode(), players: [], match: null, host: ws, difficulty: 'normal' };
        rooms.set(r.code, r);
        r.players.push({ team: 1, ws, name: cleanName(m.name), empire: cleanEmpire(m.empire) });
        ws.room = r;
        roomState(r);
        return;
      }
      case 'createWorld': {
        leaveAll(ws);
        const empire = cleanEmpire(m.empire);
        const w = new S.World({ empire, seed: Math.floor(Math.random() * 1e6), yearLen: S.yearLength(m.year), humans: [] });
        joinWorld(ws, makeWorldRoom(newCode(), w), cleanName(m.name), empire);
        return;
      }
      case 'join': {
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r) { send(ws, { t: 'error', text: 'No room or world with that code.' }); return; }
        if (r.kind === 'world') {
          if (r.w.s.over) { send(ws, { t: 'error', text: 'That war is over.' }); return; }
          leaveAll(ws);
          joinWorld(ws, r, cleanName(m.name), cleanEmpire(m.empire));
          return;
        }
        if (r.match) { send(ws, { t: 'error', text: 'That game has already started.' }); return; }
        if (r.players.length >= MAX_PLAYERS) { send(ws, { t: 'error', text: 'That room is full.' }); return; }
        leaveAll(ws);
        r.players.push({ team: freeTeam(r), ws, name: cleanName(m.name), empire: cleanEmpire(m.empire) });
        ws.room = r;
        roomState(r);
        return;
      }
      case 'cmd':
        if (ws.match) ws.match.command(ws, m);
        return;
      case 'wcmd':
        if (ws.world) worldCommand(ws, ws.world, m);
        return;
      case 'leaveBattle':
        if (ws.world) { leaveBattle(ws); worldState(ws.world); }
        return;
      case 'leave':
        leaveAll(ws);
        return;
      case 'chat':
        if (ws.world) {
          const me = ws.world.players.find((p) => p.ws === ws);
          const msg = { t: 'chat', from: me ? me.name : '?', text: String(m.text || '').slice(0, 200) };
          for (const p of ws.world.players) send(p.ws, msg);
          return;
        }
        break;
    }
    if (ws.room) roomMessage(ws, ws.room, m);
  });
  ws.on('close', () => leaveAll(ws));
});

loadWorlds();
server.listen(PORT, () => {
  console.log(`Empires server running on http://localhost:${PORT}`);
  console.log('Friends on your network can join via http://<this-computer-ip>:' + PORT);
});
