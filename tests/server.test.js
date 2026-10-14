'use strict';
// Starts the multiplayer server and plays the opening of a match with two socket clients.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 18000 + Math.floor(Math.random() * 1000);

function client(port = PORT) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    inbox.push(m);
    for (const w of waiters.splice(0)) w();
  });
  const next = async (type, pred = () => true) => {
    for (;;) {
      const i = inbox.findIndex((m) => m.t === type && pred(m));
      if (i >= 0) return inbox.splice(i, 1)[0];
      await new Promise((r) => waiters.push(r));
    }
  };
  return { ws, next, send: (m) => ws.send(JSON.stringify(m)), open: new Promise((r) => ws.on('open', r)) };
}

test('two players can create, join and play a room', async (t) => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT } });
  t.after(() => srv.kill());
  await new Promise((r) => srv.stdout.once('data', r));

  const a = client(), b = client();
  await Promise.all([a.open, b.open]);
  a.send({ t: 'create', name: 'Host', empire: 'aldermark' });
  const lobby = await a.next('lobby');
  assert.match(lobby.code, /^[A-Z]{4}$/);
  b.send({ t: 'join', code: lobby.code, name: 'Guest', empire: 'valmont' });
  await a.next('lobby', (m) => m.players.length === 2);
  a.send({ t: 'start' });
  const [sa, sb] = await Promise.all([a.next('start'), b.next('start')]);
  assert.strictEqual(sa.seed, sb.seed);
  assert.deepStrictEqual([sa.you, sb.you], [0, 1]);

  const snap = await b.next('snap');
  const tc = snap.e.find((e) => e.t === 'towncenter' && e.o === 0);
  const enemyTc = snap.e.find((e) => e.t === 'towncenter' && e.o === 1);
  // A player may only command their own buildings.
  b.send({ t: 'cmd', c: 'train', b: tc.i, type: 'peasant' });
  a.send({ t: 'cmd', c: 'train', b: tc.i, type: 'peasant' });
  const after = await a.next('snap', (s) => s.e.find((e) => e.i === tc.i).q.length > 0);
  assert.strictEqual(after.pl[0].r.food, 150);
  assert.strictEqual(after.pl[1].r.food, 200);
  assert.strictEqual(after.e.find((e) => e.i === enemyTc.i).q.length, 0);

  // Leaving forfeits the match.
  b.ws.close();
  const end = await a.next('snap', (s) => s.over);
  assert.strictEqual(end.over.winner, 0);
  a.ws.close();
});

test('a host can fill a room with AI players and teams', async (t) => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: PORT + 1 } });
  t.after(() => srv.kill());
  await new Promise((r) => srv.stdout.once('data', r));
  const a = client(PORT + 1), b = client(PORT + 1);
  await Promise.all([a.open, b.open]);
  a.send({ t: 'create', name: 'Host', empire: 'aldermark' });
  const { code } = await a.next('lobby');
  b.send({ t: 'join', code, name: 'Guest', empire: 'valmont' });
  await a.next('lobby', (m) => m.players.length === 2);
  // Guests cannot add AI players.
  b.send({ t: 'addAi' });
  a.send({ t: 'addAi' });
  a.send({ t: 'addAi' });
  let l = await a.next('lobby', (m) => m.players.length === 4);
  assert.ok(l.players[2].ai && l.players[3].ai);
  // Humans together on team 1 against two AIs on team 2.
  b.send({ t: 'team', team: 1 });
  a.send({ t: 'setAi', i: 2, team: 2, empire: 'valmont' });
  a.send({ t: 'setAi', i: 3, team: 2 });
  a.send({ t: 'difficulty', difficulty: 'hard' });
  l = await a.next('lobby', (m) => m.difficulty === 'hard' && m.players.map((p) => p.team).join() === '1,1,2,2');
  a.send({ t: 'start' });
  const st = await b.next('start');
  assert.deepStrictEqual(st.teams, [1, 1, 2, 2]);
  assert.deepStrictEqual(st.ai, [false, false, true, true]);
  // The AI players are running on the server: they train peasants.
  await a.next('snap', (s) => s.e.filter((e) => e.t === 'peasant' && e.o >= 2).length > 8);
  // One human leaving does not end a team game.
  b.ws.close();
  const s = await a.next('snap', (x) => x.pl[1].d);
  assert.strictEqual(s.over, null);
  a.ws.close();
});
