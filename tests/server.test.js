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

function startServer(t, port, env = {}) {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT: port, ...env } });
  t.after(() => srv.kill());
  return new Promise((r) => srv.stdout.once('data', () => r(srv)));
}

test('a multiplayer world: co-op rulers, a rival, real-time battles and rejoining after a restart', async (t) => {
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'empires-worlds-'));
  const env = { WORLD_DIR: dir, WORLD_SPEED: 20, MATCH_SPEED: 10 };
  const port = PORT + 2;
  const srv = await startServer(t, port, env);
  const a = client(port), b = client(port), c = client(port);
  await Promise.all([a.open, b.open, c.open]);

  a.send({ t: 'createWorld', name: 'Anna', empire: 'aldermark', year: 'quick' });
  const you = await a.next('wyou');
  assert.strictEqual(you.country, 0);
  const { code } = await a.next('world');
  // Picking the same empire joins that country (co-op); the other empire is the rival.
  b.send({ t: 'join', code, name: 'Bram', empire: 'aldermark' });
  c.send({ t: 'join', code, name: 'Cleo', empire: 'valmont' });
  assert.strictEqual((await b.next('wyou')).country, 0);
  assert.strictEqual((await c.next('wyou')).country, 1);
  await a.next('world', (m) => m.players.length === 3 && m.players.every((p) => p.online));

  // Co-op rulers share the treasury and the armies; the rival cannot command them.
  a.send({ t: 'wcmd', c: 'recruit', prov: 0, type: 'spearman' });
  await b.next('world', (m) => m.s.armies.some((x) => x.owner === 0 && x.general && x.units.spearman === 7));
  let w = (await a.next('world'));
  const lead = w.s.armies.find((x) => x.owner === 0 && x.general);
  c.send({ t: 'wcmd', c: 'move', army: lead.id, to: 5 });
  assert.match((await c.next('notice')).text, /not your army/);
  b.send({ t: 'wcmd', c: 'move', army: lead.id, to: 5 });
  w = await a.next('world', (m) => m.s.battles.length > 0, 20000);
  const battle = w.s.battles[0];
  assert.strictEqual(battle.prov, 5);

  // Anna chooses to fight: both rulers of Aldermark are pulled into the same real-time battle.
  a.send({ t: 'wcmd', c: 'decide', battle: battle.id, fight: true });
  const [sa, sb] = await Promise.all([a.next('start'), b.next('start')]);
  assert.ok(sa.world && sa.battle);
  assert.strictEqual(sa.you, 0);
  assert.strictEqual(sb.you, 0);
  assert.deepStrictEqual(sa.ai, [false, true]);
  await a.next('snap');
  // Both leave the battle: the computer finishes it for them and the world takes the result.
  a.send({ t: 'leaveBattle' });
  b.send({ t: 'leaveBattle' });
  w = await c.next('world', (m) => m.s.battles.length === 0 && m.s.provinces[5].owner === 0, 60000);
  assert.ok(w.s.armies.find((x) => x.id === lead.id).general, 'the general survived');

  // Cleo drops out and comes back to the same country.
  c.ws.close();
  await a.next('world', (m) => m.players.some((p) => p.name === 'Cleo' && !p.online));
  const c2 = client(port);
  await c2.open;
  c2.send({ t: 'join', code, name: 'cleo', empire: 'aldermark' });
  assert.strictEqual((await c2.next('wyou')).country, 1);

  // The world is saved to disk and survives a server restart.
  const date = (await c2.next('world')).s.time;
  for (const x of [a, b, c2]) x.ws.close();
  await new Promise((r) => setTimeout(r, 300));
  srv.kill();
  await startServer(t, port + 1, env);
  const d = client(port + 1);
  await d.open;
  d.send({ t: 'join', code, name: 'Anna', empire: 'valmont' });
  assert.strictEqual((await d.next('wyou')).country, 0);
  const back = await d.next('world');
  assert.ok(back.s.time >= date - 1);
  assert.strictEqual(back.s.provinces[5].owner, 0);
  d.ws.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
