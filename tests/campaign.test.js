'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadSim } = require('../server/sim');

const S = loadSim();
const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };

test('a new campaign has two countries, free lords and two leader armies', () => {
  const c = new S.Campaign({ empire: 'valmont', seed: 3 });
  assert.deepStrictEqual([...c.s.empires], ['valmont', 'aldermark', 'rebels']);
  const leaders = c.s.armies.filter((a) => a.leader);
  assert.strictEqual(leaders.length, 2);
  assert.ok(c.s.armies.some((a) => a.owner === 2));
  assert.strictEqual(c.income(0), c.income(1));
});

test('recruiting costs gold, respects weaknesses and limits', () => {
  const c = new S.Campaign({ empire: 'aldermark', seed: 1 });
  const before = c.s.gold[0];
  assert.ok(c.recruit(0, 0, 'archer').army);
  assert.strictEqual(c.s.gold[0], before - Math.round(55 * 1.25), 'Aldermark archers cost more');
  assert.ok(c.recruit(0, 10, 'spearman').error, 'cannot recruit in enemy land');
  assert.ok(c.recruit(0, 0, 'longbowman').error, 'cannot recruit the enemy unique unit');
});

test('armies capture provinces and fight battles', () => {
  const c = new S.Campaign({ empire: 'aldermark', seed: 1 });
  const lead = c.s.armies.find((a) => a.owner === 0 && a.leader);
  assert.ok(c.move(lead.id, 1).moved);
  assert.ok(c.move(lead.id, 5).error, 'one move per turn');
  c.endTurn();
  const r = c.move(lead.id, 5);
  assert.ok(r.battle, 'Thornwood is garrisoned');
  c.autoResolve(r.battle, seq(0, 0.99));
  assert.strictEqual(c.province(5).owner, 0);
  assert.strictEqual(c.army(lead.id).prov, 5);
});

test('if the leader falls in battle the campaign is lost', () => {
  const c = new S.Campaign({ empire: 'aldermark', seed: 1 });
  const lead = c.s.armies.find((a) => a.owner === 0 && a.leader);
  c.move(lead.id, 1); c.endTurn();
  const r = c.move(lead.id, 5);
  c.applyFought(r.battle, [{ units: {}, leader: false }, { units: { spearman: 2 }, leader: false }], false);
  assert.strictEqual(c.s.over.winner, 1);
  assert.match(c.s.over.reason, /King Edric has fallen/);
});

test('the AI expands over many turns and the state survives a save', () => {
  const c = new S.Campaign({ empire: 'aldermark', seed: 9 });
  for (let t = 0; t < 40 && !c.s.over; t++) {
    let battle = c.endTurn();
    while (battle) { c.autoResolve(battle); battle = c.continueAi(); }
  }
  assert.ok(c.s.provinces.filter((p) => p.owner === 1).length > 5, 'the AI took neutral land');
  const copy = new S.Campaign({ state: JSON.parse(JSON.stringify(c.toJSON())) });
  assert.strictEqual(copy.s.turn, c.s.turn);
  assert.ok(c.s.turn > 5);
});

test('a world map battle can be fought in real time', () => {
  const c = new S.Campaign({ empire: 'aldermark', seed: 1 });
  const lead = c.s.armies.find((a) => a.owner === 0 && a.leader);
  c.move(lead.id, 1); c.endTurn();
  const { battle } = c.move(lead.id, 5);
  const setup = c.battleSetup(battle);
  setup.ai = [true, true];
  const g = new S.Game(setup);
  assert.strictEqual(g.entities.filter((e) => e.owner === 0).length, 17);
  assert.strictEqual(g.entities.filter((e) => e.owner === 1).length, 6);
  for (let i = 0; i < 20 * 300 && !g.over; i++) g.step();
  assert.ok(g.over, 'the battle ends');
  assert.strictEqual(g.over.winner, 0, 'the bigger army wins');
  c.applyFought(battle, g.survivors(), true);
  assert.strictEqual(c.province(5).owner, 0);
  assert.ok(c.army(lead.id).leader);
});
