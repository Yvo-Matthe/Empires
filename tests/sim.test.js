'use strict';
// Headless checks: run with `node --test tests/`.
const test = require('node:test');
const assert = require('node:assert');
const { loadSim } = require('../server/sim');

const S = loadSim();

test('maps are connected and symmetric for several seeds', () => {
  for (const seed of [1, 2, 3, 42, 1234]) {
    const m = S.generateMap(seed);
    assert.ok(S.mapConnected(m));
    const N = S.MAP_W * S.MAP_H;
    for (let i = 0; i < N; i++) assert.strictEqual(m.block[i], m.block[N - 1 - i]);
  }
});

test('empires apply their bonuses', () => {
  const g = new S.Game({ seed: 3, empires: ['aldermark', 'valmont'] });
  assert.strictEqual(g.unitDef(0, 'knight').hp, Math.round(S.UNITS.knight.hp * 1.2));
  assert.strictEqual(g.unitDef(1, 'knight').hp, S.UNITS.knight.hp);
  assert.strictEqual(g.unitDef(1, 'archer').range, S.UNITS.archer.range + 1);
  assert.strictEqual(g.buildingCost(1, 'castle').stone, 480);
  assert.strictEqual(JSON.stringify(g.trainable({ def: S.BUILDINGS.castle, owner: 0 })), JSON.stringify(['paladin']));
  assert.strictEqual(JSON.stringify(g.trainable({ def: S.BUILDINGS.castle, owner: 1 })), JSON.stringify(['longbowman']));
});

test('a peasant gathers and drops off wood', () => {
  const g = new S.Game({ seed: 5, ai: [false, false] });
  const p = g.players[0];
  const u = g.entities.find((e) => e.owner === 0 && e.entity === 'unit');
  const tree = g.findGatherTarget(u, 'wood', u.x, u.y, 40 * S.TILE);
  assert.ok(tree, 'a tree is reachable');
  const before = p.res.wood;
  g.cmdGather([u], tree);
  for (let i = 0; i < 20 * 120; i++) g.step();
  assert.ok(p.res.wood > before + 15, `wood went from ${before} to ${p.res.wood}`);
});

test('training respects cost and population', () => {
  const g = new S.Game({ seed: 5, ai: [false, false] });
  const tc = g.entities.find((e) => e.owner === 0 && e.type === 'towncenter');
  assert.ok(g.cmdTrain(tc, 'peasant').ok);
  assert.strictEqual(g.players[0].res.food, 150);
  for (let i = 0; i < 20 * 11; i++) g.step();
  assert.strictEqual(g.entities.filter((e) => e.owner === 0 && e.type === 'peasant').length, 5);
  assert.ok(g.cmdTrain(tc, 'knight').error);
});

test('two AIs play a full game without errors', () => {
  const g = new S.Game({ seed: 7, ai: [true, true], difficulty: 'hard' });
  let maxArmy = 0, maxBuildings = 0;
  for (let i = 0; i < 20 * 60 * 25 && !g.over; i++) {
    g.step();
    g.events.length = 0;
    if (i % 200 === 0) {
      for (const p of g.players) {
        const mine = g.entities.filter((e) => e.owner === p.id);
        maxArmy = Math.max(maxArmy, mine.filter((e) => e.entity === 'unit' && !e.def.worker).length);
        maxBuildings = Math.max(maxBuildings, mine.filter((e) => e.entity === 'building').length);
      }
    }
  }
  const summary = g.players.map((p) => ({ id: p.id, ...p.stats, pop: p.pop, res: Object.fromEntries(Object.entries(p.res).map(([k, v]) => [k, Math.round(v)])) }));
  console.log('time', Math.round(g.time), 'over', JSON.stringify(g.over), 'maxArmy', maxArmy, 'maxBuildings', maxBuildings);
  console.log(JSON.stringify(summary));
  assert.ok(maxBuildings >= 8, 'AI expands its base');
  assert.ok(maxArmy >= 8, 'AI raises an army');
  assert.ok(g.players.some((p) => p.stats.killed > 0), 'armies fight');
});

test('four players in two teams: allies share vision and do not fight', () => {
  const g = new S.Game({ seed: 11, empires: ['aldermark', 'valmont', 'aldermark', 'valmont'], teams: [1, 2, 1, 2], ai: [true, true, true, true], difficulty: 'hard' });
  assert.strictEqual(new Set(g.players.map((p) => p.color)).size, 4, 'every player gets a distinct color');
  assert.ok(g.isAlly(0, 2) && g.isEnemy(0, 1) && !g.isEnemy(1, 3));
  const tcs = g.entities.filter((e) => e.type === 'towncenter');
  assert.strictEqual(tcs.length, 4);
  for (let i = 0; i < 20 * 60 * 12 && !g.over; i++) { g.step(); g.events.length = 0; }
  // Kills only ever happen between teams: allies never attack each other.
  for (const e of g.entities) {
    if (e.entity === 'unit' && e.order && e.order.type === 'attack' && e.order.target.owner !== undefined) {
      assert.ok(g.isEnemy(e.owner, e.order.target.owner), 'unit is attacking an ally');
    }
  }
  assert.ok(g.players.every((p) => p.stats.built > 3), 'all four AIs build');
});

test('forfeit ends the game only when one team is left', () => {
  const g = new S.Game({ seed: 4, empires: ['aldermark', 'valmont', 'valmont'], teams: [1, 2, 2], ai: [false, false, true] });
  g.forfeit(1, 'left');
  assert.strictEqual(g.over, null);
  g.forfeit(2, 'left');
  assert.strictEqual(g.over.team, 1);
});

test('each player starts with two men, two women and a leader', () => {
  const g = new S.Game({ seed: 8, ai: [false, false] });
  const mine = g.entities.filter((e) => e.owner === 0 && e.entity === 'unit');
  assert.strictEqual(mine.filter((u) => u.type === 'peasant' && u.female).length, 2);
  assert.strictEqual(mine.filter((u) => u.type === 'peasant' && !u.female).length, 2);
  const leader = mine.find((u) => u.type === 'leader');
  assert.strictEqual(leader.def.name, 'King Edric');
  assert.strictEqual(g.unitDef(1, 'leader').name, 'Duchess Isolde');
  g.cmdDelete(leader);
  assert.ok(!leader.dead, 'leaders cannot be deleted');
});

test('when a leader dies, that player is out', () => {
  const g = new S.Game({ seed: 8, ai: [false, false] });
  const leader = g.entities.find((u) => u.owner === 1 && u.type === 'leader');
  const knight = g.addUnit(0, 'knight', leader.x + 20, leader.y);
  g.applyDamage(knight, leader, 10000);
  g.step();
  assert.ok(g.players[1].defeated);
  assert.strictEqual(g.over.winner, 0);
  assert.match(g.over.reason, /Duchess Isolde has fallen/);
  assert.strictEqual(g.entities.filter((e) => e.owner === 1 && !e.dead).length, 0, 'the fallen realm crumbles');
});

test('empire weaknesses apply', () => {
  const g = new S.Game({ seed: 3, empires: ['aldermark', 'valmont'] });
  assert.strictEqual(g.unitDef(0, 'archer').cost.gold, Math.round(S.UNITS.archer.cost.gold * 1.25));
  assert.strictEqual(g.unitDef(1, 'knight').cost.gold, Math.round(S.UNITS.knight.cost.gold * 1.25));
  assert.ok(g.unitDef(0, 'manatarms').speed < S.UNITS.manatarms.speed);
  assert.ok(g.gatherRate(1, 'farm') < g.gatherRate(0, 'farm'));
});
