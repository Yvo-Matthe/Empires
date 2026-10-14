'use strict';
// Starts the multiplayer server and plays the opening of a match with two socket clients.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 18000 + Math.floor(Math.random() * 1000);

function client() {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
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
