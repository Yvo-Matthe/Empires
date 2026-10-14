'use strict';
// The world map campaign: a real-time layer in the spirit of Total War. Two countries own
// provinces, collect gold every month, recruit armies and march them along the roads while the
// calendar runs. When armies meet, the battle is fought in real time (Game with `battle`) or
// auto-resolved here. At the end of every year the World Council votes: a country that wins a
// majority is elected World Leader and wins. No DOM access, so it runs in the browser (single
// player), on the server (multiplayer worlds) and in the tests.

const COUNTRIES = [0, 1];
const REBELS = 2;
const MAX_ARMY = 40;
const START_YEAR = 1200;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Real-time length of one game year. Every year ends with a World Council vote.
const YEAR_LENGTHS = [
  { key: 'quick', seconds: 15 * 60, name: '15 minutes' },
  { key: 'hour', seconds: 60 * 60, name: '1 hour' },
  { key: 'long', seconds: 4 * 60 * 60, name: '4 hours' },
];
const DECISION_SECONDS = 30; // how long a player has to choose "fight" or "auto-resolve"
const ENVOY_COST = 80;
const ENVOY_FAVOR = 12;
const FAVOR_TO_VOTE = 25; // a free province votes for the country it favors most, once favor reaches this
const CONQUEST_FAVOR_LOSS = 10; // conquering a free province makes the others wary
const CAPITAL_VOTES = 3;
// Characters hired at a province's city hall. Only armies led by a general (or the king) can march.
const GENERAL_COST = 150;
const GOVERNOR_COST = 120;
const GOVERNOR_INCOME = 0.5; // +50% income
const GOVERNOR_RECRUITS = 2; // extra recruits per month
const GENERAL_POWER = 3;
const CHARACTER_NAMES = ['Sir Aldric', 'Lady Maren', 'Sir Godfrey', 'Lady Elsbeth', 'Sir Roland', 'Lady Ysolde', 'Sir Baldwin',
  'Lady Rowena', 'Sir Tristan', 'Lady Mathilde', 'Sir Percival', 'Lady Gwendolyn', 'Sir Osric', 'Lady Isabeau', 'Sir Edmund',
  'Lady Adela', 'Sir Hugo', 'Lady Sibylla', 'Sir Reynard', 'Lady Cecily', 'Sir Walter', 'Lady Joan', 'Sir Geoffrey', 'Lady Agnes'];

// Gold price to recruit one unit on the world map.
const RECRUIT_COST = { spearman: 35, manatarms: 60, archer: 55, knight: 95, paladin: 125, longbowman: 75 };
// Rough fighting value of each unit, used by auto-resolve and the AI.
const UNIT_POWER = { spearman: 1, manatarms: 1.6, archer: 1.3, knight: 2.4, paladin: 3.3, longbowman: 1.7, leader: 4 };

// Map coordinates are in a 1000 x 640 space. Owner: 0 = west country, 1 = east country, 2 = free lords.
// Income is paid every month.
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
// Each country starts with a field army under a general, and the king with a guard in the capital.
const STARTING_ARMY = { spearman: 6, manatarms: 4, archer: 4, knight: 2 };
const ROYAL_GUARD = { spearman: 6, manatarms: 2, archer: 6 };
const CAPITAL_WALLS = 1.8; // defenders of their own capital fight behind walls
const TOTAL_VOTES = PROVINCES.reduce((n, p) => n + (p.capital ? CAPITAL_VOTES : 1), 0);
// A two-thirds majority: diplomacy alone is not enough, a country has to win land from its rival too.
const VOTES_TO_WIN = Math.ceil((TOTAL_VOTES * 2) / 3);

function armyPower(units, leader, general) {
  let p = (leader ? UNIT_POWER.leader : 0) + (general ? GENERAL_POWER : 0);
  for (const t in units) p += (UNIT_POWER[t] || 1) * units[t];
  return general ? p * 1.1 : p;
}
function armySize(units) { return Object.values(units).reduce((a, b) => a + b, 0); }
function yearLength(key) { return (YEAR_LENGTHS.find((y) => y.key === key) || YEAR_LENGTHS[0]).seconds; }

class World {
  /**
   * New world: { empires: [west, east] | empire, seed, yearLen (seconds), humans: [country ids] }.
   * Loading: { state, humans }. `humans` lists the countries people control right now; the
   * computer rules the others (and answers their battles). It is not saved: the host sets it.
   */
  constructor({ empire = 'aldermark', empires, seed = 1, yearLen = YEAR_LENGTHS[0].seconds, humans = [0], state } = {}) {
    this.adj = World.adjacency();
    this.humans = new Set(humans);
    this.events = [];
    if (state) { this.s = state; return; }
    if (!empires) empires = [empire, PLAYABLE_EMPIRES.find((k) => k !== empire) || empire];
    this.s = {
      version: 3, seed, time: 0, yearLen, empires: [empires[0], empires[1], 'rebels'],
      gold: [400, 400],
      provinces: PROVINCES.map((p, id) => ({ id, owner: p.owner, recruited: 0, favor: [0, 0], envoy: [-1, -1], governor: null })),
      armies: [], battles: [], council: [], nextArmy: 1, nextBattle: 1, nextName: seed % CHARACTER_NAMES.length,
      log: [], over: null, aiT: 0,
    };
    // Each country starts with its king and a guard in the capital, and a field army under a general.
    // The free lords garrison their provinces.
    for (const owner of COUNTRIES) {
      this.addArmy(owner, this.capitalOf(owner), { ...ROYAL_GUARD }, true);
      this.addArmy(owner, this.capitalOf(owner), { ...STARTING_ARMY }, false).general = this.newName();
    }
    PROVINCES.forEach((p, id) => { if (p.garrison) this.addArmy(REBELS, id, { ...p.garrison }, false); });
    this.log(`${this.empireOf(0).leader} and ${this.empireOf(1).leader} claim the realm. The World Council meets at the end of every year.`);
  }

  static adjacency() {
    const adj = PROVINCES.map(() => []);
    for (const [a, b] of LINKS) { adj[a].push(b); adj[b].push(a); }
    return adj;
  }

  // ---------- calendar ----------
  get monthLen() { return this.s.yearLen / 12; }
  monthIndex(t = this.s.time) { return Math.floor(t / this.monthLen + 1e-9); }
  date(t = this.s.time) {
    const m = this.monthIndex(t);
    return { year: START_YEAR + Math.floor(m / 12), month: m % 12 };
  }
  dateText(t) { const d = this.date(t); return `${MONTHS[d.month]} ${d.year}`; }
  untilCouncil() { return this.s.yearLen - (this.s.time % this.s.yearLen); }
  // Seconds a march along one road takes: an average road is 1/48 of a year.
  legTime(a, b) {
    return (this.s.yearLen / 48) * (Math.hypot(PROVINCES[a].x - PROVINCES[b].x, PROVINCES[a].y - PROVINCES[b].y) / 150);
  }

  // ---------- queries ----------
  empireOf(owner) { return EMPIRES[this.s.empires[owner]]; }
  capitalOf(owner) { return PROVINCES.findIndex((p) => p.capital && p.owner === owner); }
  province(id) { return { ...PROVINCES[id], ...this.s.provinces[id] }; }
  army(id) { return this.s.armies.find((a) => a.id === id); }
  battle(id) { return this.s.battles.find((b) => b.id === id); }
  battleOf(armyId) { return this.s.battles.find((b) => b.attacker === armyId || b.defender === armyId); }
  // Armies standing in a province (not on the road).
  armiesAt(prov) { return this.s.armies.filter((a) => a.prov === prov && a.to === null); }
  // A standing army to put recruits in: a general's army first, then troops without a leader, the king's guard last.
  idleArmyAt(prov, owner) {
    const here = this.armiesAt(prov).filter((a) => a.owner === owner && !this.battleOf(a.id));
    return here.find((a) => a.general) || here.find((a) => !a.leader) || here[0];
  }
  newName() { return CHARACTER_NAMES[this.s.nextName++ % CHARACTER_NAMES.length]; }
  provinceIncome(id) {
    const p = this.s.provinces[id];
    return Math.round(PROVINCES[id].income * (p.governor ? 1 + GOVERNOR_INCOME : 1));
  }
  income(owner) {
    return this.s.provinces.reduce((s, p) => s + (p.owner === owner ? this.provinceIncome(p.id) : 0), 0);
  }
  power(a) { return armyPower(a.units, a.leader, a.general); }
  canMarch(a) { return a.leader || !!a.general; }
  armyName(a) {
    const e = this.empireOf(a.owner);
    return a.leader ? `${e.leader}'s army` : a.general ? `${a.general}'s army` : `${e.name} troops`;
  }
  recruitLimit(prov) { return (PROVINCES[prov].capital ? 8 : 4) + (this.s.provinces[prov].governor ? GOVERNOR_RECRUITS : 0); }
  recruitable(owner) {
    const unique = this.empireOf(owner).unique;
    return ['spearman', 'manatarms', 'archer', 'knight', unique].map((t) => ({ type: t, cost: this.recruitCost(owner, t) }));
  }
  // Empire weaknesses carry over: a unit that costs more in battle costs more here too.
  recruitCost(owner, type) {
    return Math.round(RECRUIT_COST[type] * ((this.empireOf(owner).mods.unitCost || {})[type] || 1));
  }
  // Where an army is on the map right now, in world coordinates.
  armyPos(a, prog = a.prog) {
    const p = PROVINCES[a.prov];
    if (a.to === null) return { x: p.x, y: p.y };
    const q = PROVINCES[a.to];
    return { x: p.x + (q.x - p.x) * prog, y: p.y + (q.y - p.y) * prog };
  }

  /** Who each province would vote for if the Council met now. */
  votes() {
    const counts = [0, 0];
    let abstain = 0;
    const byProv = this.s.provinces.map((p) => {
      const weight = PROVINCES[p.id].capital ? CAPITAL_VOTES : 1;
      let vote = p.owner === REBELS ? null : p.owner;
      if (p.owner === REBELS) {
        const [a, b] = p.favor;
        if (Math.max(a, b) >= FAVOR_TO_VOTE && a !== b) vote = a > b ? 0 : 1;
      }
      if (vote === null) abstain += weight; else counts[vote] += weight;
      return vote;
    });
    return { counts, abstain, total: TOTAL_VOTES, need: VOTES_TO_WIN, byProv };
  }

  log(text) {
    this.s.log.push({ t: this.s.time, text });
    if (this.s.log.length > 80) this.s.log.shift();
  }

  addArmy(owner, prov, units, leader) {
    const a = { id: this.s.nextArmy++, owner, prov, units, leader: !!leader, general: null, to: null, prog: 0, path: [] };
    this.s.armies.push(a);
    return a;
  }

  removeEmpty() {
    this.s.armies = this.s.armies.filter((a) => a.leader || armySize(a.units) > 0);
  }

  // ---------- player orders (all check that `owner` may give them) ----------
  recruit(owner, prov, type) {
    const p = this.s.provinces[prov];
    if (this.s.over) return { error: 'The war is over' };
    if (!p || p.owner !== owner) return { error: 'You can only recruit in your own provinces' };
    if (!RECRUIT_COST[type] || !this.recruitable(owner).some((r) => r.type === type)) return { error: 'Cannot recruit that' };
    if (p.recruited >= this.recruitLimit(prov)) return { error: `${PROVINCES[prov].name} has no more recruits this month` };
    const cost = this.recruitCost(owner, type);
    if (this.s.gold[owner] < cost) return { error: 'Not enough gold' };
    if (this.s.battles.some((b) => b.prov === prov)) return { error: 'A battle is raging there' };
    let a = this.idleArmyAt(prov, owner);
    if (a && armySize(a.units) >= MAX_ARMY) return { error: `Armies are limited to ${MAX_ARMY} troops` };
    if (!a) a = this.addArmy(owner, prov, {}, false);
    this.s.gold[owner] -= cost;
    a.units[type] = (a.units[type] || 0) + 1;
    p.recruited++;
    return { army: a };
  }

  /** Hire a general at the city hall to lead an army standing in one of your provinces. */
  appointGeneral(owner, armyId) {
    const a = this.army(armyId);
    if (this.s.over) return { error: 'The war is over' };
    if (!a || a.owner !== owner) return { error: 'That is not your army' };
    if (a.leader || a.general) return { error: 'That army already has a commander' };
    if (a.to !== null || this.battleOf(a.id) || this.s.provinces[a.prov].owner !== owner) return { error: 'Generals are hired at the city hall of your own provinces' };
    if (this.s.gold[owner] < GENERAL_COST) return { error: 'Not enough gold' };
    this.s.gold[owner] -= GENERAL_COST;
    a.general = this.newName();
    this.log(`${a.general} takes command of an army of the ${this.empireOf(owner).name} in ${PROVINCES[a.prov].name}.`);
    return { ok: true, general: a.general };
  }

  /** Hire a governor to manage a province: more gold and more recruits there. */
  appointGovernor(owner, prov) {
    const p = this.s.provinces[prov];
    if (this.s.over) return { error: 'The war is over' };
    if (!p || p.owner !== owner) return { error: 'Governors only manage your own provinces' };
    if (PROVINCES[prov].capital && this.capitalOf(owner) === prov) return { error: 'The king rules the capital' };
    if (p.governor) return { error: `${p.governor} already governs ${PROVINCES[prov].name}` };
    if (this.s.gold[owner] < GOVERNOR_COST) return { error: 'Not enough gold' };
    this.s.gold[owner] -= GOVERNOR_COST;
    p.governor = this.newName();
    this.log(`${p.governor} becomes governor of ${PROVINCES[prov].name}.`);
    return { ok: true, governor: p.governor };
  }

  // Split off half of every troop type (never the king or the general) into a new army in the same
  // province. The new army needs its own general before it can march.
  split(owner, armyId) {
    const a = this.army(armyId);
    if (!a || a.owner !== owner || a.to !== null || this.battleOf(a.id)) return { error: 'That army cannot split now' };
    if (armySize(a.units) < 2) return { error: 'Not enough troops to split' };
    const units = {};
    for (const t in a.units) {
      const n = Math.floor(a.units[t] / 2);
      if (n) { units[t] = n; a.units[t] -= n; }
    }
    if (!armySize(units)) {
      const t = Object.keys(a.units).find((k) => a.units[k] > 0);
      units[t] = 1; a.units[t]--;
    }
    return { army: this.addArmy(a.owner, a.prov, units, false) };
  }

  // Shortest road path from one province to another (excluding `from`).
  route(from, dest) {
    if (from === dest) return [];
    const prev = new Map([[from, null]]);
    const q = [from];
    while (q.length) {
      const cur = q.shift();
      if (cur === dest) break;
      for (const n of this.adj[cur]) if (!prev.has(n)) { prev.set(n, cur); q.push(n); }
    }
    if (!prev.has(dest)) return null;
    const path = [];
    for (let s = dest; s !== from; s = prev.get(s)) path.unshift(s);
    return path;
  }

  /** March an army to any province; it follows the roads and keeps going until it arrives. */
  move(owner, armyId, dest) {
    const a = this.army(armyId);
    if (this.s.over) return { error: 'The war is over' };
    if (!a || a.owner !== owner) return { error: 'That is not your army' };
    if (!PROVINCES[dest]) return { error: 'No such province' };
    if (this.battleOf(a.id)) return { error: 'That army is in battle' };
    if (!this.canMarch(a)) return { error: 'Troops cannot march without a general. Hire one at the city hall' };
    if (a.to === null) {
      const path = this.route(a.prov, dest);
      if (!path || !path.length) return { error: 'Already there' };
      a.to = path.shift(); a.prog = 0; a.path = path;
      return { ok: true };
    }
    // On the road: carry on, or turn back if that is shorter.
    const ahead = this.route(a.to, dest), back = this.route(a.prov, dest);
    if (back && (back.length + a.prog < ahead.length + 1 - a.prog) && back[0] !== a.to) {
      [a.prov, a.to] = [a.to, a.prov];
      a.prog = 1 - a.prog;
      a.path = back;
    } else a.path = ahead;
    return { ok: true };
  }

  /** Stop at the next province on the way. */
  halt(owner, armyId) {
    const a = this.army(armyId);
    if (!a || a.owner !== owner) return { error: 'That is not your army' };
    a.path = [];
    return { ok: true };
  }

  /** Send an envoy with gifts to a free province: it favors you more at the next Council. */
  envoy(owner, prov) {
    const p = this.s.provinces[prov];
    if (this.s.over) return { error: 'The war is over' };
    if (!COUNTRIES.includes(owner)) return { error: 'Only countries send envoys' };
    if (!p || p.owner !== REBELS) return { error: 'Envoys only go to the free provinces' };
    if (p.envoy[owner] === this.monthIndex()) return { error: `Your envoy already visited ${PROVINCES[prov].name} this month` };
    if (this.s.gold[owner] < ENVOY_COST) return { error: 'Not enough gold' };
    this.s.gold[owner] -= ENVOY_COST;
    p.envoy[owner] = this.monthIndex();
    p.favor[owner] = Math.min(100, p.favor[owner] + ENVOY_FAVOR);
    return { ok: true };
  }

  /** A human on one side of a pending battle chooses to fight it in real time or auto-resolve it. */
  decide(owner, battleId, fight) {
    const b = this.battle(battleId);
    if (!b || b.state !== 'pending') return { error: 'That battle is not waiting for orders' };
    if (owner !== this.army(b.attacker).owner && owner !== this.army(b.defender).owner) return { error: 'Not your battle' };
    b.choices[owner] = fight ? 'fight' : 'auto';
    this.settle(b);
    return { ok: true };
  }

  // ---------- time ----------
  /** Advance the world by `dt` seconds of real time. */
  tick(dt) {
    while (dt > 1e-9 && !this.s.over) {
      const h = Math.min(dt, 1);
      this.advance(h);
      dt -= h;
    }
  }

  advance(h) {
    const s = this.s;
    const before = this.monthIndex();
    s.time += h;
    for (const a of [...s.armies]) {
      if (a.to === null || this.battleOf(a.id) || !this.army(a.id)) continue;
      a.prog += h / this.legTime(a.prov, a.to);
      if (a.prog >= 1) this.arrive(a);
      if (s.over) return;
    }
    this.contacts();
    for (const b of [...s.battles]) if (b.state === 'pending') this.settle(b);
    const now = this.monthIndex();
    for (let m = before + 1; m <= now && !s.over; m++) this.newMonth(m);
    s.aiT -= h;
    if (s.aiT <= 0 && !s.over) {
      s.aiT = Math.max(2, s.yearLen / 240);
      for (const owner of COUNTRIES) if (!this.humans.has(owner)) this.aiThink(owner);
    }
  }

  arrive(a) {
    a.prov = a.to; a.to = null; a.prog = 0;
    const prov = a.prov;
    // Enemies here: stop and fight (contacts() starts the battle).
    if (this.armiesAt(prov).some((o) => o.owner !== a.owner)) { a.path = []; return; }
    this.capture(a.owner, prov);
    if (a.path.length) { a.to = a.path.shift(); return; }
    // Journey's end: join a friendly army waiting here, unless both have a commander.
    const other = this.armiesAt(prov).find((b) => b !== a && b.owner === a.owner && !this.battleOf(b.id) && !b.path.length &&
      !((b.leader || b.general) && (a.leader || a.general)));
    if (other) {
      for (const t in a.units) other.units[t] = (other.units[t] || 0) + a.units[t];
      other.leader = other.leader || a.leader;
      other.general = other.general || a.general;
      a.units = {}; a.leader = false; a.general = null;
      this.removeEmpty();
    }
  }

  capture(owner, prov) {
    const p = this.s.provinces[prov];
    if (p.owner === owner) return;
    const prev = p.owner;
    p.owner = owner;
    if (p.governor) this.log(`${p.governor}, governor of ${PROVINCES[prov].name}, flees.`);
    p.governor = null;
    p.recruited = this.recruitLimit(prov); // no recruits from freshly taken land this month
    this.log(`${this.empireOf(owner).name} takes ${PROVINCES[prov].name}${prev === REBELS ? ' from the free lords' : ''}.`);
    if (prev === REBELS) {
      for (const q of this.s.provinces) if (q.owner === REBELS) q.favor[owner] = Math.max(0, q.favor[owner] - CONQUEST_FAVOR_LOSS);
    }
    this.checkOver();
  }

  // Hostile armies standing in the same province fight.
  contacts() {
    for (let prov = 0; prov < PROVINCES.length; prov++) {
      if (this.s.battles.some((b) => b.prov === prov)) continue;
      const here = this.armiesAt(prov);
      if (here.length < 2) continue;
      const owner = this.s.provinces[prov].owner;
      const def = here.find((a) => a.owner === owner) || here[0];
      const att = here.find((a) => a.owner !== def.owner);
      if (att) this.startBattle(att, def, prov);
      if (this.s.over) return;
    }
  }

  startBattle(att, def, prov) {
    const b = { id: this.s.nextBattle++, prov, attacker: att.id, defender: def.id, state: 'pending', deadline: this.s.time + DECISION_SECONDS, choices: {} };
    this.s.battles.push(b);
    if (![att.owner, def.owner].some((o) => this.humans.has(o))) { this.autoResolve(b); return; }
    this.events.push({ type: 'battle', id: b.id });
  }

  // A pending battle goes ahead once every human side has chosen, or when time is up.
  settle(b) {
    const sides = [this.army(b.attacker).owner, this.army(b.defender).owner].filter((o) => this.humans.has(o));
    if (!sides.every((o) => b.choices[o]) && this.s.time < b.deadline) return;
    if (Object.values(b.choices).includes('fight')) {
      b.state = 'fighting';
      this.events.push({ type: 'fight', id: b.id });
    } else this.autoResolve(b);
  }

  newMonth(m) {
    const s = this.s;
    if (m % 12 === 0) { this.council(START_YEAR + m / 12 - 1); if (s.over) return; }
    for (const owner of COUNTRIES) s.gold[owner] += this.income(owner);
    for (const p of s.provinces) p.recruited = 0;
    for (const owner of COUNTRIES) if (!this.humans.has(owner)) { this.aiEnvoys(owner); this.aiAppoint(owner); this.aiRecruit(owner); }
  }

  /** The World Council: every province casts its votes; a majority elects the World Leader. */
  council(year) {
    const v = this.votes();
    this.s.council.push({ year, counts: v.counts, abstain: v.abstain });
    const winner = COUNTRIES.find((o) => v.counts[o] >= v.need);
    const tally = `${this.empireOf(0).name} ${v.counts[0]}, ${this.empireOf(1).name} ${v.counts[1]}, ${v.abstain} abstain`;
    if (winner !== undefined) {
      const e = this.empireOf(winner);
      this.log(`The Council of ${year} elects ${e.leader} World Leader (${tally}).`);
      this.s.over = { winner, vote: true, reason: `The Council of ${year} elects ${e.leader} of the ${e.name} World Leader with ${v.counts[winner]} of ${v.total} votes.` };
    } else this.log(`The Council of ${year} is divided (${tally}). ${v.need} votes are needed.`);
    this.events.push({ type: 'council', year, counts: v.counts, abstain: v.abstain, winner });
  }

  // ---------- battles ----------
  defenseBonus(prov, owner) {
    return PROVINCES[prov].capital && this.s.provinces[prov].owner === owner ? CAPITAL_WALLS : 1.1;
  }

  // Odds for the attacker winning an auto-resolved battle.
  odds(battle) {
    const a = this.army(battle.attacker), d = this.army(battle.defender);
    const pa = this.power(a), pd = this.power(d) * this.defenseBonus(battle.prov, d.owner); // defenders hold the ground
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
    const winner = { units, leader: win.leader && rng() >= share * 0.3, general: !!win.general && rng() >= share * 0.3 };
    if (win.leader && !winner.leader && !armySize(units)) winner.leader = true; // someone has to hold the field
    if (win.general && !winner.general && !winner.leader && !armySize(units)) winner.general = true;
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
      army.units = { ...survivors[i].units };
      army.leader = survivors[i].leader;
      // A general falls with the army, or in a hard fight (survivors say so when known).
      const lives = survivors[i].general !== undefined ? survivors[i].general : armySize(army.units) > 0 || army.leader;
      if (army.general && !lives) { this.log(`${army.general} falls at ${name}.`); army.general = null; }
    });
    const winner = attackerWon ? a : d;
    this.s.battles = this.s.battles.filter((b) => b !== battle && b.id !== battle.id);
    this.log(`Battle of ${name}: the ${this.empireOf(winner.owner).name} ${attackerWon ? 'storm' : 'hold'} ${name}.`);
    this.events.push({ type: 'resolved', id: battle.id, prov: battle.prov, winner: winner.owner, loser: (attackerWon ? d : a).owner });
    for (const owner of fallen) {
      if (owner === REBELS) continue;
      this.log(`${this.empireOf(owner).leader} has fallen at ${name}!`);
      this.s.over = { winner: 1 - owner, reason: `${this.empireOf(owner).leader} has fallen at the Battle of ${name}.` };
    }
    // The loser is destroyed; a winning attacker takes the province.
    if (attackerWon) { d.units = {}; d.leader = false; d.general = null; } else { a.units = {}; a.leader = false; a.general = null; }
    this.removeEmpty();
    if (attackerWon && this.army(a.id) && !this.s.over) this.capture(a.owner, battle.prov);
    this.checkOver();
    return { attackerWon };
  }

  checkOver() {
    if (this.s.over) return this.s.over;
    for (const owner of COUNTRIES) {
      if (!this.s.provinces.some((p) => p.owner === owner)) {
        this.s.over = { winner: 1 - owner, reason: `The ${this.empireOf(owner).name} has lost all its lands.` };
      }
    }
    return this.s.over;
  }

  // Everything a real-time battle needs. `first` is the country that plays as player 0
  // (the human in single player); by default the attacker.
  battleSetup(battle, first) {
    const a = this.army(battle.attacker), d = this.army(battle.defender);
    const sides = first === d.owner ? [d, a] : [a, d];
    return {
      seed: this.s.seed * 1000 + battle.prov * 37 + battle.id,
      empires: sides.map((x) => this.s.empires[x.owner]),
      owners: sides.map((x) => x.owner),
      battle: { armies: sides.map((x) => ({ units: { ...x.units }, leader: x.leader })) },
      name: `Battle of ${PROVINCES[battle.prov].name}`,
    };
  }

  /** Apply the result of a real-time battle: survivors from Game.survivors() and the winning country. */
  applyFought(battle, owners, survivors, winnerOwner) {
    const att = this.army(battle.attacker);
    const iAtt = owners.indexOf(att.owner);
    const attackerWon = winnerOwner === att.owner;
    const empty = { units: {}, leader: false };
    const sa = survivors[iAtt], sd = survivors[1 - iAtt];
    return this.applyBattle(battle, [attackerWon ? sa : empty, attackerWon ? empty : sd], attackerWon);
  }

  // ---------- computer rulers ----------
  aiRecruit(owner) {
    const owned = this.s.provinces.filter((p) => p.owner === owner).map((p) => p.id);
    // Recruit at the frontier first, then the capital.
    const frontier = owned.filter((id) => this.adj[id].some((n) => this.s.provinces[n].owner !== owner));
    const cap = this.capitalOf(owner);
    const spots = [...new Set([...frontier, ...(this.s.provinces[cap].owner === owner ? [cap] : [])])];
    const rng = mulberry32(this.s.seed * 13 + this.monthIndex() * 7 + owner);
    let guard = 200;
    while (guard-- > 0 && spots.length && this.s.gold[owner] >= 120) { // keep a small reserve
      const prov = spots[Math.floor(rng() * spots.length)];
      const opts = this.recruitable(owner);
      const r = this.recruit(owner, prov, opts[Math.floor(rng() * opts.length)].type);
      if (r.error && !/gold/.test(r.error)) spots.splice(spots.indexOf(prov), 1);
    }
  }

  // Court the free provinces that could swing the Council.
  aiEnvoys(owner) {
    const v = this.votes();
    if (v.counts[owner] >= v.need + 2) return;
    const other = 1 - owner;
    const free = this.s.provinces.filter((p) => p.owner === REBELS)
      .sort((a, b) => (a.favor[owner] - a.favor[other]) - (b.favor[owner] - b.favor[other]));
    let sent = 0;
    for (const p of free) {
      if (sent >= 2 || this.s.gold[owner] < ENVOY_COST + 150) break;
      if (p.favor[owner] - p.favor[other] > 20) continue;
      if (!this.envoy(owner, p.id).error) sent++;
    }
  }

  // Generals for armies big enough to march, governors for the richest provinces.
  aiAppoint(owner) {
    for (const a of this.s.armies) {
      if (a.owner !== owner || a.leader || a.general || armySize(a.units) < 6) continue;
      if (this.s.gold[owner] < GENERAL_COST + 100) return;
      this.appointGeneral(owner, a.id);
    }
    const ungoverned = this.s.provinces.filter((p) => p.owner === owner && !p.governor && p.id !== this.capitalOf(owner))
      .sort((x, y) => PROVINCES[y.id].income - PROVINCES[x.id].income);
    if (ungoverned.length && this.s.gold[owner] >= GOVERNOR_COST + 250) this.appointGovernor(owner, ungoverned[0].id);
  }

  aiThink(owner) {
    const cap = this.capitalOf(owner);
    for (const a of this.s.armies) {
      if (a.owner !== owner || a.to !== null || this.battleOf(a.id)) continue;
      // The king stays home in the capital unless his army is overwhelming.
      if (a.leader && this.power(a) < 40) {
        if (a.prov !== cap && this.s.provinces[cap].owner === owner) this.move(owner, a.id, cap);
        continue;
      }
      if (!this.canMarch(a)) continue;
      const targets = this.adj[a.prov]
        .filter((n) => this.s.provinces[n].owner !== owner)
        // Free provinces that already back us at the Council are left in peace.
        .filter((n) => { const p = this.s.provinces[n]; return !(p.owner === REBELS && p.favor[owner] >= FAVOR_TO_VOTE && p.favor[owner] > p.favor[1 - owner]); })
        .map((n) => {
          const d = this.armiesAt(n).filter((x) => x.owner !== owner).reduce((t, x) => t + this.power(x), 0) * this.defenseBonus(n, this.s.provinces[n].owner);
          return { n, def: d, value: PROVINCES[n].income + (PROVINCES[n].capital ? 200 : 0) };
        })
        .filter((t) => this.power(a) > t.def * 1.3)
        .sort((x, y) => y.value / (y.def + 1) - x.value / (x.def + 1));
      if (targets.length) { this.move(owner, a.id, targets[0].n); continue; }
      // Nothing to attack here: march toward the nearest province we do not hold.
      if (!a.leader) {
        const step = this.stepToward(a.prov, (id) => this.s.provinces[id].owner !== owner);
        if (step !== null && step !== cap && this.s.provinces[step].owner === owner) this.move(owner, a.id, step);
      }
    }
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

  toJSON() { return this.s; }
}
