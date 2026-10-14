'use strict';
// Empires game server: serves the game files and hosts multiplayer rooms.
// Usage: npm start  (then open http://localhost:8080, or http://<your-ip>:8080 from another PC)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { loadSim } = require('./sim');

const S = loadSim();
const MAX_PLAYERS = S.MAX_PLAYERS;
const PORT = Number(process.env.PORT) || 8080;
const ROOT = path.join(__dirname, '..');
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

// ---------- rooms ----------
const rooms = new Map();

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  while (rooms.has(code));
  return code;
}

function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); }
function broadcast(room, msg) { const s = JSON.stringify(msg); for (const p of room.players) send(p.ws, s); }

function roomState(room) {
  broadcast(room, {
    t: 'lobby', code: room.code, difficulty: room.difficulty, max: MAX_PLAYERS,
    players: room.players.map((p) => ({ name: p.name, empire: p.empire, team: p.team, ai: !!p.ai })),
  });
  room.players.forEach((p, i) => send(p.ws, { t: 'you', slot: i, host: p.ws === room.host }));
}

function cleanName(n) { return String(n || '').replace(/[^\w \-'.]/g, '').trim().slice(0, 16) || 'Lord'; }
function cleanEmpire(e) { return S.EMPIRES[e] ? e : 'aldermark'; }
function cleanTeam(t) { return Number.isInteger(t) && t >= 1 && t <= MAX_PLAYERS ? t : 1; }
function freeTeam(room) {
  for (let t = 1; t <= MAX_PLAYERS; t++) if (!room.players.some((p) => p.team === t)) return t;
  return 1;
}
function aiName(room) { return `Computer (${S.DIFFICULTY[room.difficulty].name})`; }

function addPlayer(room, entry) {
  room.players.push({ team: freeTeam(room), ...entry });
}

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  const me = room.players.find((p) => p.ws === ws);
  if (!me) return;
  if (room.game) {
    // Leaving a running game forfeits it; allies and AI players keep fighting.
    me.ws = null;
    const g = room.game;
    if (!g.over) {
      g.forfeit(me.slot, `${me.name} left the game`);
      broadcast(room, S.makeSnapshot(g));
    }
    if (g.over || !room.players.some((p) => p.ws)) stopGame(room);
  } else {
    room.players.splice(room.players.indexOf(me), 1);
    if (room.host === ws) room.host = (room.players.find((p) => p.ws) || {}).ws || null;
  }
  if (!room.players.some((p) => p.ws)) { stopGame(room); rooms.delete(room.code); return; }
  if (!room.game) roomState(room);
}

function stopGame(room) {
  if (room.timer) clearInterval(room.timer);
  room.timer = null;
}

function startGame(room) {
  const seed = Math.floor(Math.random() * 1e9);
  const empires = room.players.map((p) => p.empire);
  const names = room.players.map((p) => p.name);
  const teams = room.players.map((p) => p.team);
  const ai = room.players.map((p) => !!p.ai);
  const game = new S.Game({ seed, empires, teams, ai, difficulty: room.difficulty, viewer: -1 });
  game.players.forEach((p, i) => { p.name = names[i]; });
  game.nodeById = new Map(game.map.nodes.map((n) => [n.id, n]));
  room.game = game;
  room.players.forEach((p, i) => { p.slot = i; send(p.ws, { t: 'start', seed, empires, names, teams, ai, difficulty: room.difficulty, you: i }); });
  let tick = 0;
  room.timer = setInterval(() => {
    try {
      game.step();
      if (++tick % 2 === 0 || game.over) broadcast(room, S.makeSnapshot(game));
      if (game.over) stopGame(room);
    } catch (err) {
      console.error('Simulation error in room', room.code, err);
      stopGame(room);
    }
  }, 1000 * S.TICK);
}

function notice(room, slot, text) { send((room.players.find((p) => p.slot === slot) || {}).ws, { t: 'notice', text }); }

// Resolve ids from a client command, keeping only what that player may control.
function handleCommand(room, slot, m) {
  const g = room.game;
  if (!g || g.over) return;
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
      if (r.error) notice(room, slot, r.error);
      break;
    }
    case 'train': if (own(b) && b.entity === 'building') { const r = g.cmdTrain(b, m.type); if (r.error) notice(room, slot, r.error); } break;
    case 'cancel': if (own(b) && b.entity === 'building') g.cmdCancel(b, num(m.i)); break;
    case 'rally': if (own(b) && b.entity === 'building') g.cmdRally(b, num(m.x), num(m.y), target && !target.dead ? target : null); break;
    case 'delete': { const e = lookup(m.id); if (own(e)) g.cmdDelete(e); break; }
  }
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const room = ws.room;
    const me = room && room.players.find((p) => p.ws === ws);
    const isHost = !!me && room.host === ws;
    switch (m.t) {
      case 'create': {
        leave(ws);
        const r = { code: newCode(), players: [], game: null, timer: null, host: ws, difficulty: 'normal' };
        rooms.set(r.code, r);
        addPlayer(r, { ws, name: cleanName(m.name), empire: cleanEmpire(m.empire) });
        ws.room = r;
        roomState(r);
        break;
      }
      case 'join': {
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r) { send(ws, { t: 'error', text: 'No room with that code.' }); return; }
        if (r.game) { send(ws, { t: 'error', text: 'That game has already started.' }); return; }
        if (r.players.length >= MAX_PLAYERS) { send(ws, { t: 'error', text: 'That room is full.' }); return; }
        leave(ws);
        addPlayer(r, { ws, name: cleanName(m.name), empire: cleanEmpire(m.empire) });
        ws.room = r;
        roomState(r);
        break;
      }
      case 'empire':
        if (me && !room.game) { me.empire = cleanEmpire(m.empire); roomState(room); }
        break;
      case 'team':
        if (me && !room.game) { me.team = cleanTeam(m.team); roomState(room); }
        break;
      // Host-only lobby settings: AI players and difficulty.
      case 'addAi':
        if (isHost && !room.game && room.players.length < MAX_PLAYERS) {
          const keys = Object.keys(S.EMPIRES);
          addPlayer(room, { ws: null, ai: true, name: aiName(room), empire: keys[Math.floor(Math.random() * keys.length)] });
          roomState(room);
        }
        break;
      case 'setAi': {
        const p = isHost && !room.game && room.players[m.i];
        if (p && p.ai) {
          if (m.empire !== undefined) p.empire = cleanEmpire(m.empire);
          if (m.team !== undefined) p.team = cleanTeam(m.team);
          roomState(room);
        }
        break;
      }
      case 'removeAi': {
        const p = isHost && !room.game && room.players[m.i];
        if (p && p.ai) { room.players.splice(m.i, 1); roomState(room); }
        break;
      }
      case 'difficulty':
        if (isHost && !room.game && S.DIFFICULTY[m.difficulty]) {
          room.difficulty = m.difficulty;
          for (const p of room.players) if (p.ai) p.name = aiName(room);
          roomState(room);
        }
        break;
      case 'start':
        if (isHost && !room.game) {
          if (room.players.length < 2) { send(ws, { t: 'error', text: 'Add an AI player or wait for someone to join.' }); return; }
          if (new Set(room.players.map((p) => p.team)).size < 2) { send(ws, { t: 'error', text: 'Everyone is on the same team. Put someone on another team.' }); return; }
          startGame(room);
        }
        break;
      case 'cmd':
        if (me && room.game) handleCommand(room, me.slot, m);
        break;
      case 'chat':
        if (me) broadcast(room, { t: 'chat', from: me.name, text: String(m.text || '').slice(0, 200) });
        break;
      case 'leave':
        leave(ws);
        break;
    }
  });
  ws.on('close', () => leave(ws));
});

server.listen(PORT, () => {
  console.log(`Empires server running on http://localhost:${PORT}`);
  console.log('Friends on your network can join via http://<this-computer-ip>:' + PORT);
});
