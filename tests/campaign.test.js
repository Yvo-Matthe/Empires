'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadSim } = require('../server/sim');

const S = loadSim();
const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };
const YEAR = 900; // 15 minute years
const run = (w, seconds) => { for (let i = 0; i < seconds && !w.s.over; i++) w.tick(1); };
const runUntil = (w, cond, max = 600) => { for (let i = 0; i < max && !cond() && !w.s.over; i++) w.tick(1); };

test('a new world has two countries, free lords and two leader armies', () => {
  const w = new S.World({ empire: 'valmont', seed: 3, yearLen: YEAR });
  assert.deepStrictEqual([...w.s.empires], ['valmont', 'aldermark', 'rebels']);
  assert.strictEqual(w.s.armies.filter((a) => a.leader).length, 2);
  assert.ok(w.s.armies.some((a) => a.owner === 2));
  assert.strictEqual(w.income(0), w.income(1));
  assert.strictEqual(w.dateText(), 'January 1200');
  const v = w.votes();
  assert.deepStrictEqual([...v.counts], [7, 7]);
  assert.strictEqual(v.total, 19);
  assert.strictEqual(v.need, 10);
});

test('the calendar pays gold every month', () => {
  const w = new S.World({ seed: 1, yearLen: YEAR, humans: [0, 1] });
  const gold = w.s.gold[0];
  run(w, YEAR / 12 + 1);
  assert.strictEqual(w.dateText(), 'February 1200');
  assert.strictEqual(w.s.gold[0], gold + w.income(0));
});

test('recruiting costs gold, respects weaknesses and limits', () => {
  const w = new S.World({ empire: 'aldermark', seed: 1, yearLen: YEAR });
  const before = w.s.gold[0];
  assert.ok(w.recruit(0, 0, 'archer').army);
  assert.strictEqual(w.s.gold[0], before - Math.round(55 * 1.25), 'Aldermark archers cost more');
  assert.ok(w.recruit(0, 10, 'spearman').error, 'cannot recruit in enemy land');
  assert.ok(w.recruit(0, 0, 'longbowman').error, 'cannot recruit the enemy unique unit');
  assert.ok(w.recruit(1, 0, 'spearman').error, 'cannot recruit for another country');
});

test('armies march along the roads in real time and fight where they meet', () => {
  const w = new S.World({ empire: 'aldermark', seed: 1, yearLen: YEAR, humans: [0, 1] });
  const lead = w.s.armies.find((a) => a.owner === 0 && a.leader);
  assert.ok(w.move(1, lead.id, 5).error, 'only the owner gives orders');
  assert.ok(w.move(0, lead.id, 5).ok);
  assert.deepStrictEqual([lead.to, ...lead.path], [1, 5], 'Aldenhall to Thornwood goes via Wheatmere');
  run(w, 5);
  assert.ok(lead.prog > 0 && lead.prog < 1, 'on the road');
  runUntil(w, () => w.s.battles.length);
  assert.strictEqual(lead.prov, 5);
  const b = w.s.battles.find((x) => x.prov === 5);
  assert.ok(b && b.state === 'pending', 'the garrison of Thornwood blocks the way');
  assert.ok(w.move(0, lead.id, 0).error, 'armies in battle cannot leave');
  // Nobody gives orders: the battle auto-resolves when time is up.
  w.autoResolve(b, seq(0, 0.99));
  assert.strictEqual(w.province(5).owner, 0);
  assert.ok(w.s.provinces.filter((p) => p.owner === 2).every((p) => p.favor[0] === 0), 'conquest costs favor');
});

test('envoys win over free provinces and the Council elects a World Leader', () => {
  const w = new S.World({ empire: 'aldermark', seed: 1, yearLen: YEAR, humans: [0, 1] });
  assert.ok(w.envoy(0, 6).ok);
  assert.ok(w.envoy(0, 6).error, 'one envoy per month');
  assert.ok(w.envoy(0, 0).error, 'envoys only go to free provinces');
  // Three free provinces won over give 7 + 3 = 10 votes, a majority.
  for (let m = 0; m < 3; m++) {
    for (const p of [5, 6, 7]) { w.s.gold[0] = 1000; w.envoy(0, p); }
    w.s.time = (m + 1) * (YEAR / 12) - 1;
    w.tick(1);
  }
  assert.ok([5, 6, 7].every((p) => w.votes().byProv[p] === 0));
  w.humans = new Set([0, 1]);
  w.s.time = YEAR - 1;
  w.tick(2);
  assert.ok(w.s.over, 'the Council voted');
  assert.strictEqual(w.s.over.winner, 0);
  assert.ok(w.s.over.vote);
  assert.match(w.s.over.reason, /Council of 1200 elects King Edric/);
});

test('if the leader falls in battle the war is lost', () => {
  const w = new S.World({ empire: 'aldermark', seed: 1, yearLen: YEAR, humans: [0, 1] });
  const lead = w.s.armies.find((a) => a.owner === 0 && a.leader);
  w.move(0, lead.id, 5);
  runUntil(w, () => w.s.battles.length);
  const b = w.s.battles[0];
  w.applyBattle(b, [{ units: {}, leader: false }, { units: { spearman: 2 }, leader: false }], false);
  assert.strictEqual(w.s.over.winner, 1);
  assert.match(w.s.over.reason, /King Edric has fallen/);
});

test('computer rulers expand, send envoys and finish a war; the state survives a save', () => {
  let votes = 0;
  for (const seed of [9, 10, 11]) {
    const w = new S.World({ empire: 'aldermark', seed, yearLen: YEAR, humans: [] });
    run(w, YEAR * 6);
    assert.ok(w.s.over, 'the war ends');
    if (w.s.over.vote) votes++;
    assert.ok(w.s.provinces.filter((p) => p.owner === 2).length < 5, 'neutral land was taken');
    const copy = new S.World({ state: JSON.parse(JSON.stringify(w.toJSON())) });
    assert.strictEqual(copy.dateText(), w.dateText());
  }
  assert.ok(votes > 0, 'some wars are won at the Council');
});

test('a world map battle can be fought in real time', () => {
  const w = new S.World({ empire: 'aldermark', seed: 1, yearLen: YEAR, humans: [0] });
  const lead = w.s.armies.find((a) => a.owner === 0 && a.leader);
  w.move(0, lead.id, 5);
  runUntil(w, () => w.s.battles.length);
  const b = w.s.battles[0];
  assert.ok(b, 'battle waits for the human');
  w.decide(0, b.id, true);
  assert.strictEqual(b.state, 'fighting');
  const setup = w.battleSetup(b, 0);
  const g = new S.Game({ ...setup, ai: [true, true] });
  assert.strictEqual(g.entities.filter((e) => e.owner === 0).length, 17);
  assert.strictEqual(g.entities.filter((e) => e.owner === 1).length, 6);
  for (let i = 0; i < 20 * 300 && !g.over; i++) g.step();
  assert.ok(g.over, 'the battle ends');
  assert.strictEqual(g.over.winner, 0, 'the bigger army wins');
  w.applyFought(b, setup.owners, g.survivors(), setup.owners[g.over.winner]);
  assert.strictEqual(w.province(5).owner, 0);
  assert.ok(w.army(lead.id).leader);
  assert.strictEqual(w.s.battles.length, 0);
});
