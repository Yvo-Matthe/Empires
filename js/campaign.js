'use strict';
// The world map campaign: a turn-based layer in the spirit of Total War. Countries own
// provinces, collect gold, recruit armies and march them across the map. When armies meet,
// the battle is fought in real time (Game with `battle`) or auto-resolved here.
// No DOM access, so it runs headless in the tests.

const CAMPAIGN_HUMAN = 0;
const CAMPAIGN_AI = 1;
const REBELS = 2;
const MAX_ARMY = 40;

// Gold price to recruit one unit on the world map.
const RECRUIT_COST = { spearman: 35, manatarms: 60, archer: 55, knight: 95, paladin: 125, longbowman: 75 };
// Rough fighting value of each unit, used by auto-resolve and the AI.
const UNIT_POWER = { spearman: 1, manatarms: 1.6, archer: 1.3, knight: 2.4, paladin: 3.3, longbowman: 1.7, leader: 4 };

// Map coordinates are in a 1000 x 640 space. Owner: 0 = west country, 1 = east country, 2 = free lords.
const PROVINCES = [
  { name: 'Aldenhall', x: 150, y: 320, owner: 0, capital: true, income: 120 },
  { name: 'Wheatmere', x: 245, y: 165, owner: 0, income: 60 },
  { name: 'Lancefield', x: 270, y: 465, owner: 0, income: 55 },
  { name: 'Highcrag', x: 90, y: 140, owner: 0, income: 45 },
  { name: 'Saltmarsh', x: 115, y: 515, owner: 0, income: 45 },
  { name: 'Thornwood', x: 385, y: 230, owner: REBELS, income: 55, garrison: { spearman: 4, archer: 2 } },
  { name: 'Greyford', x: 495, y: 360, owner: REBELS, income: 90, garrison: { spearman: 6, manatarms: 3, archer: 3 } },
  { name: 'Ravenmoor', x: 575, y: 165, owner: REBELS, income: 55, garrison: { spearman: 3, archer: 3 } },
  { name: 'Stonebridge', x: 410, y: 520, owner: REBELS, income: 55, garrison: { spearman: 4, archer: 2 } },
  { name: 'Kingsreach', x: 600, y: 510, owner: REBELS, income: 60, garrison: { spearman: 3, manatarms: 1, archer: 3 } },
  { name: 'Valcourt', x: 850, y: 320, owner: 1, capital: true, income: 120 },
  { name: 'Elmshade', x: 755, y: 165, owner: 1, income: 60 },
  { name: 'Mirewatch', x: 730, y: 465, owner: 1, income: 55 },
  { name: 'Pinecrest', x: 910, y: 140, owner: 1, income: 45 },
  { name: 'Duskvale', x: 885, y: 515, owner: 1, income: 45 },
];
const LINKS = [
  [0, 1], [0, 2], [0, 3], [0, 4], [1, 3], [2, 4],
  [1, 5], [2, 8], [2, 6],
  [5, 6], [5, 7], [6, 7], [6, 8], [6, 9], [8, 9],
  [11, 7], [12, 9], [12, 6],
  [10, 11], [10, 12], [10, 13], [10, 14], [11, 13], [12, 14],
];
const STARTING_ARMY = { spearman: 6, manatarms: 4, archer: 4, knight: 2 };

function armyPower(units, leader) {
  let p = leader ? UNIT_POWER.leader : 0;
  for (const t in units) p += (UNIT_POWER[t] || 1) * units[t];
  return p;
}
function armySize(units) { return Object.values(units).reduce((a, b) => a + b, 0); }

class Campaign {
  // New campaign: { empire, seed }. Loading: pass a saved state as { state }.
  constructor({ empire = 'aldermark', seed = 1, state } = {}) {
    if (state) { this.s = state; this.adj = Campaign.adjacency(); return; }
    const other = PLAYABLE_EMPIRES.find((k) => k !== empire) || empire;
    this.s = {
      version: 1, seed, turn: 1, empires: [empire, other, 'rebels'],
      gold: [400, 400], provinces: PROVINCES.map((p, id) => ({ id, owner: p.owner, recruited: 0 })),
      armies: [], nextArmy: 1, log: [], over: null, aiQueue: null,
    };
    this.adj = Campaign.adjacency();
    // Each country starts with its leader's army in its capital; the free lords garrison theirs.
    for (const owner of [CAMPAIGN_HUMAN, CAMPAIGN_AI]) {
      const cap = PROVINCES.findIndex((p) => p.capital && p.owner === owner);
      this.addArmy(owner, cap, { ...STARTING_ARMY }, true);
    }
    PROVINCES.forEach((p, id) => { if (p.garrison) this.addArmy(REBELS, id, { ...p.garrison }, false); });
    this.log(`Turn 1. ${this.empireOf(CAMPAIGN_HUMAN).leader} rides out from ${this.capitalName(CAMPAIGN_HUMAN)}.`);
  }

  static adjacency() {
    const adj = PROVINCES.map(() => []);
    for (const [a, b] of LINKS) { adj[a].push(b); adj[b].push(a); }
    return adj;
  }

  // ---------- queries ----------
  empireOf(owner) { return EMPIRES[this.s.empires[owner]]; }
  capitalName(owner) { return PROVINCES[PROVINCES.findIndex((p) => p.capital && p.owner === owner)].name; }
  province(id) { return { ...PROVINCES[id], ...this.s.provinces[id] }; }
  armyAt(prov, owner) { return this.s.armies.find((a) => a.prov === prov && (owner === undefined || a.owner === owner)); }
  armiesAt(prov) { return this.s.armies.filter((a) => a.prov === prov); }
  army(id) { return this.s.armies.find((a) => a.id === id); }
  income(owner) {
    return this.s.provinces.reduce((s, p) => s + (p.owner === owner ? PROVINCES[p.id].income : 0), 0);
  }
  power(a) { return armyPower(a.units, a.leader); }
  recruitLimit(prov) { return PROVINCES[prov].capital ? 8 : 4; }
  recruitable(owner) {
    const unique = this.empireOf(owner).unique;
    return ['spearman', 'manatarms', 'archer', 'knight', unique].map((t) => ({ type: t, cost: this.recruitCost(owner, t) }));
  }
  // Empire weaknesses carry over: a unit that costs more in battle costs more here too.
  recruitCost(owner, type) {
    return Math.round(RECRUIT_COST[type] * ((this.empireOf(owner).mods.unitCost || {})[type] || 1));
  }

  log(text) {
    this.s.log.push({ turn: this.s.turn, text });
    if (this.s.log.length > 60) this.s.log.shift();
  }

  addArmy(owner, prov, units, leader) {
    const a = { id: this.s.nextArmy++, owner, prov, units, leader: !!leader, moved: false };
    this.s.armies.push(a);
    return a;
  }

  removeEmpty() {
    this.s.armies = this.s.armies.filter((a) => a.leader || armySize(a.units) > 0);
  }

  // ---------- player actions ----------
  recruit(owner, prov, type) {
    const p = this.s.provinces[prov];
    const cost = this.recruitCost(owner, type);
    if (this.s.over) return { error: 'The campaign is over' };
    if (p.owner !== owner) return { error: 'You can only recruit in your own provinces' };
    if (!this.recruitable(owner).some((r) => r.type === type)) return { error: 'Cannot recruit that' };
    if (p.recruited >= this.recruitLimit(prov)) return { error: `${PROVINCES[prov].name} has no more recruits this turn` };
    if (this.s.gold[owner] < cost) return { error: 'Not enough gold' };
    let a = this.armyAt(prov, owner);
    if (a && armySize(a.units) >= MAX_ARMY) return { error: `Armies are limited to ${MAX_ARMY} troops` };
    if (!a) { a = this.addArmy(owner, prov, {}, false); a.moved = true; }
    this.s.gold[owner] -= cost;
    a.units[type] = (a.units[type] || 0) + 1;
    p.recruited++;
    return { army: a };
  }

  // Split off half of every troop type (never the leader) into a new army in the same province.
  split(armyId) {
    const a = this.army(armyId);
    if (!a || armySize(a.units) < 2) return { error: 'Not enough troops to split' };
    const units = {};
    for (const t in a.units) {
      const n = Math.floor(a.units[t] / 2);
      if (n) { units[t] = n; a.units[t] -= n; }
    }
    if (!armySize(units)) {
      const t = Object.keys(a.units).find((k) => a.units[k] > 0);
      units[t] = 1; a.units[t]--;
    }
    const b = this.addArmy(a.owner, a.prov, units, false);
    b.moved = a.moved;
    return { army: b };
  }

  canMove(a, to) {
    return !this.s.over && a && !a.moved && this.adj[a.prov].includes(to);
  }

  /**
   * Move an army one province. Returns { moved } for a plain move or capture, or
   * { battle } when the destination is defended: resolve it with fight results or autoResolve().
   */
  move(armyId, to) {
    const a = this.army(armyId);
    if (!this.canMove(a, to)) return { error: 'That army cannot move there' };
    const defender = this.armiesAt(to).find((d) => d.owner !== a.owner);
    if (defender) {
      a.moved = true;
      return { battle: { attacker: a.id, defender: defender.id, prov: to, from: a.prov } };
    }
    this.enter(a, to);
    return { moved: true };
  }

  enter(a, to) {
    a.moved = true;
    a.prov = to;
    const p = this.s.provinces[to];
    if (p.owner !== a.owner) {
      const prev = p.owner;
      p.owner = a.owner;
      this.log(`${this.empireOf(a.owner).name} takes ${PROVINCES[to].name}${prev === REBELS ? ' from the free lords' : ''}.`);
    }
    // Merge with a friendly army already there.
    const other = this.s.armies.find((b) => b !== a && b.prov === to && b.owner === a.owner);
    if (other) {
      for (const t in a.units) other.units[t] = (other.units[t] || 0) + a.units[t];
      other.leader = other.leader || a.leader;
      a.units = {}; a.leader = false;
      this.removeEmpty();
    }
    this.checkOver();
  }

  // Odds for the attacker winning an auto-resolved battle.
  odds(battle) {
    const a = this.army(battle.attacker), d = this.army(battle.defender);
    const pa = this.power(a), pd = this.power(d) * 1.1; // defenders hold the ground
    const r = pa / (pa + pd);
    return (r * r) / (r * r + (1 - r) * (1 - r));
  }

  autoResolve(battle, rng = Math.random) {
    const a = this.army(battle.attacker), d = this.army(battle.defender);
    const attackerWon = rng() < this.odds(battle);
    const [win, lose] = attackerWon ? [a, d] : [d, a];
    // The winner loses a share of troops depending on how hard the fight was.
    const share = Math.min(0.9, (0.6 * this.power(lose)) / Math.max(1, this.power(win)));
    const units = {};
    for (const t in win.units) {
      let n = 0;
      for (let i = 0; i < win.units[t]; i++) if (rng() >= share) n++;
      if (n) units[t] = n;
    }
    const winner = { units, leader: win.leader && rng() >= share * 0.3 };
    if (win.leader && !winner.leader && !armySize(units)) winner.leader = true; // someone has to hold the field
    const loser = { units: {}, leader: false };
    return this.applyBattle(battle, attackerWon ? [winner, loser] : [loser, winner], attackerWon);
  }

  /** Apply a battle outcome. survivors = [attacker, defender] as { units, leader }. */
  applyBattle(battle, survivors, attackerWon) {
    const a = this.army(battle.attacker), d = this.army(battle.defender);
    const name = PROVINCES[battle.prov].name;
    const fallen = [];
    [a, d].forEach((army, i) => {
      if (army.leader && !survivors[i].leader) fallen.push(army.owner);
      army.units = survivors[i].units;
      army.leader = survivors[i].leader;
    });
    const winner = attackerWon ? a : d;
    this.log(`Battle of ${name}: ${this.empireOf(winner.owner).name} ${attackerWon ? 'storms' : 'holds'} ${name}.`);
    for (const owner of fallen) {
      if (owner === REBELS) continue;
      this.log(`${this.empireOf(owner).leader} has fallen at ${name}!`);
      this.s.over = { winner: 1 - owner, reason: `${this.empireOf(owner).leader} has fallen at the Battle of ${name}.` };
    }
    // The loser is destroyed; a winning attacker marches in.
    if (attackerWon) { d.units = {}; d.leader = false; } else { a.units = {}; a.leader = false; }
    this.removeEmpty();
    if (attackerWon && this.army(a.id) && !this.s.over) this.enter(a, battle.prov);
    this.checkOver();
    return { attackerWon };
  }

  checkOver() {
    if (this.s.over) return this.s.over;
    for (const owner of [CAMPAIGN_HUMAN, CAMPAIGN_AI]) {
      if (!this.s.provinces.some((p) => p.owner === owner)) {
        this.s.over = { winner: 1 - owner, reason: `${this.empireOf(owner).name} has lost all its lands.` };
      }
    }
    return this.s.over;
  }

  // ---------- turns ----------
  /** End the human's turn and start the AI's. Returns the first battle the human must decide on, if any. */
  endTurn() {
    if (this.s.over) return null;
    this.s.aiQueue = this.planAi();
    return this.continueAi();
  }

  /** Run queued AI moves until one attacks the human (returned) or the turn finishes (null). */
  continueAi() {
    while (this.s.aiQueue && this.s.aiQueue.length && !this.s.over) {
      const { army, to } = this.s.aiQueue.shift();
      const a = this.army(army);
      if (!this.canMove(a, to)) continue;
      const r = this.move(a.id, to);
      if (r.battle) {
        const d = this.army(r.battle.defender);
        if (d.owner === CAMPAIGN_HUMAN) return r.battle;
        this.autoResolve(r.battle);
      }
    }
    this.finishRound();
    return null;
  }

  finishRound() {
    this.s.aiQueue = null;
    if (this.s.over) return;
    for (const owner of [CAMPAIGN_HUMAN, CAMPAIGN_AI]) this.s.gold[owner] += this.income(owner);
    for (const p of this.s.provinces) p.recruited = 0;
    for (const a of this.s.armies) { a.moved = false; }
    this.s.turn++;
    this.aiRecruit(); // the AI spends at the start of its next turn's planning window
    this.log(`Turn ${this.s.turn}. Your treasury collects ${this.income(CAMPAIGN_HUMAN)} gold.`);
  }

  // ---------- computer opponent ----------
  aiRecruit() {
    const me = CAMPAIGN_AI;
    const owned = this.s.provinces.filter((p) => p.owner === me).map((p) => p.id);
    // Recruit at the frontier first, then the capital.
    const frontier = owned.filter((id) => this.adj[id].some((n) => this.s.provinces[n].owner !== me));
    const cap = PROVINCES.findIndex((p) => p.capital && p.owner === me);
    const spots = [...new Set([...frontier, ...(this.s.provinces[cap].owner === me ? [cap] : [])])];
    const rng = mulberry32(this.s.seed * 13 + this.s.turn);
    let guard = 200;
    while (guard-- > 0 && spots.length) {
      const prov = spots[Math.floor(rng() * spots.length)];
      const opts = this.recruitable(me);
      const pick = opts[Math.floor(rng() * opts.length)];
      if (this.s.gold[me] < 120) break; // keep a small reserve
      const r = this.recruit(me, prov, pick.type);
      if (r.error && /no more recruits|limited/.test(r.error)) spots.splice(spots.indexOf(prov), 1);
    }
  }

  planAi() {
    const me = CAMPAIGN_AI, plan = [];
    const mine = this.s.armies.filter((a) => a.owner === me && !a.moved);
    const cap = PROVINCES.findIndex((p) => p.capital && p.owner === me);
    for (const a of mine) {
      // The leader's army only leaves the capital when it is overwhelming.
      if (a.leader && this.power(a) < 30) continue;
      const targets = this.adj[a.prov]
        .filter((n) => this.s.provinces[n].owner !== me)
        .map((n) => {
          const d = this.armiesAt(n).find((x) => x.owner !== me);
          return { n, def: d ? this.power(d) : 0, value: PROVINCES[n].income + (PROVINCES[n].capital ? 200 : 0) };
        })
        .filter((t) => this.power(a) > t.def * 1.3)
        .sort((x, y) => y.value / (y.def + 1) - x.value / (x.def + 1));
      if (targets.length) { plan.push({ army: a.id, to: targets[0].n }); continue; }
      // Nothing to attack here: march toward the nearest province we do not hold.
      if (!a.leader) {
        const step = this.stepToward(a.prov, (id) => this.s.provinces[id].owner !== me);
        if (step !== null && step !== cap) plan.push({ army: a.id, to: step });
      }
    }
    return plan;
  }

  // First step of a shortest path from `from` to any province matching `goal`.
  stepToward(from, goal) {
    const prev = new Map([[from, null]]);
    const q = [from];
    while (q.length) {
      const cur = q.shift();
      if (cur !== from && goal(cur)) {
        let s = cur;
        while (prev.get(s) !== from) s = prev.get(s);
        return s;
      }
      for (const n of this.adj[cur]) if (!prev.has(n)) { prev.set(n, cur); q.push(n); }
    }
    return null;
  }

  // Everything a real-time battle needs, with the human always as player 0.
  battleSetup(battle) {
    const a = this.army(battle.attacker), d = this.army(battle.defender);
    const sides = a.owner === CAMPAIGN_HUMAN ? [a, d] : [d, a];
    return {
      seed: this.s.seed * 1000 + battle.prov * 37 + this.s.turn,
      empires: sides.map((x) => this.s.empires[x.owner]),
      ai: [false, true],
      battle: { armies: sides.map((x) => ({ units: { ...x.units }, leader: x.leader })) },
      humanIsAttacker: a.owner === CAMPAIGN_HUMAN,
    };
  }

  // Apply the result of a real-time battle (survivors from Game.survivors(), human first).
  applyFought(battle, survivors, humanWon) {
    const setup = this.battleSetup(battle);
    const [att, def] = setup.humanIsAttacker ? survivors : [survivors[1], survivors[0]];
    const attackerWon = setup.humanIsAttacker ? humanWon : !humanWon;
    return this.applyBattle(battle, [attackerWon ? att : { units: {}, leader: false }, attackerWon ? { units: {}, leader: false } : def], attackerWon);
  }

  toJSON() { return this.s; }
}
