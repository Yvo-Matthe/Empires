'use strict';
// World map screen: draws provinces, marching armies and the World Council, takes orders,
// and hands battles to the real-time game. In single player the world runs here; in a
// multiplayer world the server runs it and this screen shows its state and sends orders.

const SAVE_KEY = 'empires.world';
const CELL = 4; // world map is rasterised in 4px cells
const WORLD_W = 1000, WORLD_H = 640;

function loadCampaignSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    const st = raw ? JSON.parse(raw) : null;
    return st && st.version === 3 && !st.over ? st : null;
  } catch { return null; }
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(s).padStart(2, '0')}`;
}

class CampaignUI {
  /** opts: { me (country), net (multiplayer), onBattle(setup, battleId), onQuit } */
  constructor(world, { me = 0, net = null, onBattle, onQuit }) {
    this.w = world;
    this.me = me;
    this.net = net;
    this.mp = !!net;
    this.onBattle = onBattle;
    this.onQuit = onQuit;
    this.canvas = $('cmp-map');
    this.ctx = this.canvas.getContext('2d');
    this.selProv = null;
    this.selArmy = null;
    this.speed = 1;
    this.paused = false;
    this.players = [];
    this.chat = [];
    this.snapAt = performance.now();
    this.decided = new Set(); // battles this player already gave orders for (multiplayer)
    this.dialog = null; // battle id shown in the battle dialog
    this.fighting = null;
    this.logSeen = null;
    this.saveT = 0;
    this.refreshT = 0;
    this.hits = [];
    this.buildRegions();
    this.bind();
    this.save();
  }

  get s() { return this.w.s; }

  // ---------- multiplayer state ----------
  setState(m) {
    this.w.s = m.s;
    this.players = m.players || [];
    this.code = m.code;
    this.snapAt = performance.now();
    if (this.selArmy && !this.w.army(this.selArmy)) this.selArmy = null;
  }
  // Seconds since the last server update, so armies keep marching smoothly in between.
  elapsed() { return this.mp ? Math.min(2, (performance.now() - this.snapAt) / 1000) : 0; }
  now() { return this.s.time + this.elapsed(); }

  // ---------- map raster ----------
  buildRegions() {
    const cw = WORLD_W / CELL, ch = WORLD_H / CELL;
    this.cw = cw; this.ch = ch;
    this.region = new Int16Array(cw * ch).fill(-1);
    const rng = mulberry32(7);
    const wob = Array.from({ length: 64 }, () => rng());
    const coast = (x, y) => {
      // Wobbly coastline around the continent.
      const a = Math.atan2(y - WORLD_H / 2, x - WORLD_W / 2);
      const k = Math.floor(((a + Math.PI) / (2 * Math.PI)) * 64) % 64;
      const t = ((a + Math.PI) / (2 * Math.PI)) * 64 - Math.floor(((a + Math.PI) / (2 * Math.PI)) * 64);
      const w = wob[k] * (1 - t) + wob[(k + 1) % 64] * t;
      const dx = (x - WORLD_W / 2) / 470, dy = (y - WORLD_H / 2) / 290;
      return Math.hypot(dx, dy) < 0.95 + w * 0.12;
    };
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const px = x * CELL + CELL / 2, py = y * CELL + CELL / 2;
      if (!coast(px, py)) continue;
      let best = -1, bd = Infinity;
      PROVINCES.forEach((p, i) => {
        // A little noise makes the borders look hand drawn.
        const d = Math.hypot(px - p.x, py - p.y) + Math.sin(px * 0.05 + i) * 6 + Math.cos(py * 0.04 + i * 2) * 6;
        if (d < bd) { bd = d; best = i; }
      });
      if (bd < 170) this.region[y * cw + x] = best;
    }
    this.img = document.createElement('canvas');
    this.img.width = WORLD_W; this.img.height = WORLD_H;
  }

  ownerColor(owner) { return this.w.empireOf(owner).color; }

  paintRegions() {
    const g = this.img.getContext('2d');
    g.fillStyle = '#1e3a4f';
    g.fillRect(0, 0, WORLD_W, WORLD_H);
    const { cw, ch, region } = this;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const r = region[y * cw + x];
      if (r < 0) continue;
      const owner = this.s.provinces[r].owner;
      g.fillStyle = '#cdbb8f';
      g.fillRect(x * CELL, y * CELL, CELL, CELL);
      g.fillStyle = this.ownerColor(owner) + '66';
      g.fillRect(x * CELL, y * CELL, CELL, CELL);
      // Borders between provinces and along the coast.
      const right = x + 1 < cw ? region[y * cw + x + 1] : -1, down = y + 1 < ch ? region[(y + 1) * cw + x] : -1;
      if (right !== r || down !== r) {
        g.fillStyle = right === -1 || down === -1 ? '#7a6a48' : 'rgba(60,40,20,0.55)';
        g.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }
    // Sea waves
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    const rng = mulberry32(3);
    for (let i = 0; i < 90; i++) {
      const x = rng() * WORLD_W, y = rng() * WORLD_H;
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
      if (region[cy * cw + cx] >= 0) continue;
      g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + 6, y - 4, x + 12, y); g.stroke();
    }
    this.paintedSig = this.s.provinces.map((p) => p.owner).join();
  }

  // ---------- time (single player) ----------
  // Battles that need this player's orders, or are being fought: the world waits for them.
  myBattles() {
    return this.s.battles.filter((b) => {
      const a = this.w.army(b.attacker), d = this.w.army(b.defender);
      return a && d && (a.owner === this.me || d.owner === this.me);
    });
  }

  update(dt) {
    if (!this.mp && !this.s.over && !this.paused && !this.myBattles().length) {
      this.w.tick(dt * this.speed);
      this.w.events.length = 0;
      this.saveT -= dt;
      if (this.saveT <= 0) { this.saveT = 5; this.save(); }
    }
    // News from the chronicle.
    const last = this.s.log[this.s.log.length - 1];
    const key = last ? last.t + last.text : '';
    if (key !== this.logSeen) {
      if (this.logSeen !== null && last) this.toast(last.text);
      this.logSeen = key;
      this.refresh();
    }
    // Ask for orders when a battle involving us is waiting.
    const waiting = this.myBattles().find((b) => b.state === 'pending' && !this.decided.has(b.id));
    if (waiting && this.dialog !== waiting.id) this.askBattle(waiting);
    if (this.dialog !== null && !this.w.battle(this.dialog)) this.closeDialog();
    if (this.dialog !== null) this.updateCountdown();
    this.refreshT -= dt;
    if (this.refreshT <= 0) { this.refreshT = 0.5; this.refresh(); }
    if (this.s.over && !this.shownOver) this.showOver();
  }

  // ---------- drawing ----------
  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = r.width;
    this.canvas.height = r.height;
    this.scale = Math.min(r.width / WORLD_W, r.height / WORLD_H);
    this.ox = (r.width - WORLD_W * this.scale) / 2;
    this.oy = (r.height - WORLD_H * this.scale) / 2;
  }

  displayProg(a) {
    if (a.to === null || this.w.battleOf(a.id)) return a.prog;
    return Math.min(1, a.prog + (this.elapsed() * 1) / this.w.legTime(a.prov, a.to));
  }

  banner(c, a, x, y, small) {
    const k = small ? 0.75 : 1;
    if (a.id === this.selArmy) {
      c.strokeStyle = '#ffe680'; c.lineWidth = 3;
      c.strokeRect(x - 15 * k, y - 3 * k, 30 * k, 36 * k);
    }
    c.fillStyle = this.ownerColor(a.owner);
    c.strokeStyle = '#1a120a'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(x - 12 * k, y); c.lineTo(x + 12 * k, y); c.lineTo(x + 12 * k, y + 18 * k); c.lineTo(x, y + 30 * k); c.lineTo(x - 12 * k, y + 18 * k); c.closePath(); c.fill(); c.stroke();
    c.fillStyle = '#fff';
    c.font = `bold ${Math.round(12 * k)}px Georgia`;
    c.textAlign = 'center';
    c.fillText(String(armySize(a.units)), x, y + 16 * k);
    if (a.leader) { c.font = '12px serif'; c.fillText('👑', x, y - 2); }
    else if (a.general) { c.font = '11px serif'; c.fillText('⭐', x, y - 2); }
    this.hits.push({ a, x, y, k });
  }

  draw() {
    const c = this.ctx, s = this.s, w = this.w;
    if (this.paintedSig !== s.provinces.map((p) => p.owner).join()) this.paintRegions();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#16232e';
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    c.setTransform(this.scale, 0, 0, this.scale, this.ox, this.oy);
    c.drawImage(this.img, 0, 0);
    const t = performance.now() / 1000;

    // Roads
    c.strokeStyle = 'rgba(90,60,30,0.6)';
    c.lineWidth = 2;
    c.setLineDash([6, 5]);
    for (const [a, b] of LINKS) {
      c.beginPath(); c.moveTo(PROVINCES[a].x, PROVINCES[a].y); c.lineTo(PROVINCES[b].x, PROVINCES[b].y); c.stroke();
    }
    c.setLineDash([]);

    // The selected army's route
    const sel = this.selArmy && w.army(this.selArmy);
    if (sel && sel.to !== null) {
      const pos = w.armyPos(sel, this.displayProg(sel));
      c.strokeStyle = '#ffe680'; c.lineWidth = 3;
      c.beginPath(); c.moveTo(pos.x, pos.y);
      for (const id of [sel.to, ...sel.path]) c.lineTo(PROVINCES[id].x, PROVINCES[id].y);
      c.stroke();
      const end = PROVINCES[sel.path.length ? sel.path[sel.path.length - 1] : sel.to];
      c.beginPath(); c.arc(end.x, end.y, 20 + Math.sin(t * 4) * 3, 0, Math.PI * 2); c.stroke();
    }

    // Settlements, names and Council votes
    const votes = w.votes().byProv;
    PROVINCES.forEach((p, i) => {
      const owner = s.provinces[i].owner;
      c.fillStyle = this.ownerColor(owner);
      c.strokeStyle = '#2a1e12';
      c.lineWidth = 1.5;
      if (p.capital) {
        c.fillRect(p.x - 12, p.y - 14, 24, 14); c.strokeRect(p.x - 12, p.y - 14, 24, 14);
        for (const dx of [-12, -2, 8]) { c.fillRect(p.x + dx, p.y - 19, 4, 5); c.strokeRect(p.x + dx, p.y - 19, 4, 5); }
      } else {
        c.beginPath(); c.moveTo(p.x - 9, p.y); c.lineTo(p.x - 9, p.y - 8); c.lineTo(p.x, p.y - 15); c.lineTo(p.x + 9, p.y - 8); c.lineTo(p.x + 9, p.y); c.closePath(); c.fill(); c.stroke();
      }
      c.font = 'bold 14px Georgia';
      c.textAlign = 'center';
      c.lineWidth = 3;
      c.strokeStyle = 'rgba(30,20,10,0.8)';
      c.strokeText(p.name, p.x, p.y - 24);
      c.fillStyle = i === this.selProv ? '#ffe680' : '#f6ecd4';
      c.fillText(p.name, p.x, p.y - 24);
      // Ballot: whom this province would vote for, and how many votes it has.
      const v = votes[i], bx = p.x + (c.measureText(p.name).width / 2) + 10, by = p.y - 29;
      c.beginPath(); c.arc(bx, by, 7, 0, Math.PI * 2);
      c.fillStyle = v === null ? '#6d6a63' : this.ownerColor(v);
      c.fill(); c.lineWidth = 1.5; c.strokeStyle = '#f6ecd4'; c.stroke();
      c.fillStyle = '#fff'; c.font = 'bold 10px Georgia';
      c.fillText(p.capital ? String(CAPITAL_VOTES) : '1', bx, by + 3.5);
      // Favor of the free provinces
      if (owner === REBELS) {
        COUNTRIES.forEach((o, k) => {
          const f = s.provinces[i].favor[o];
          c.fillStyle = 'rgba(0,0,0,0.45)'; c.fillRect(p.x - 20, p.y + 3 + k * 5, 40, 4);
          c.fillStyle = this.ownerColor(o); c.fillRect(p.x - 20, p.y + 3 + k * 5, 40 * f / 100, 4);
        });
        c.fillStyle = '#f6ecd4'; c.fillRect(p.x - 20 + 40 * FAVOR_TO_VOTE / 100, p.y + 2, 1, 10);
      }
    });

    // Battles
    for (const b of s.battles) {
      const p = PROVINCES[b.prov];
      c.font = `${22 + Math.sin(t * 6) * 3}px serif`;
      c.fillText('⚔️', p.x + 30, p.y - 2);
    }

    // Armies: standing in provinces, or marching along the roads.
    this.hits = [];
    for (let i = 0; i < PROVINCES.length; i++) {
      const here = w.armiesAt(i);
      here.forEach((a, k) => this.banner(c, a, PROVINCES[i].x + (k - (here.length - 1) / 2) * 34, PROVINCES[i].y + 24));
    }
    for (const a of s.armies) {
      if (a.to === null) continue;
      const pos = w.armyPos(a, this.displayProg(a));
      this.banner(c, a, pos.x, pos.y - 12, true);
    }
  }

  // ---------- input ----------
  bind() {
    this.canvas.onmousedown = (e) => {
      const r = this.canvas.getBoundingClientRect();
      const x = (e.clientX - r.left - this.ox) / this.scale, y = (e.clientY - r.top - this.oy) / this.scale;
      this.click(x, y, e.button === 2);
    };
    this.canvas.oncontextmenu = (e) => e.preventDefault();
    $('cmp-quit').onclick = () => { this.save(); this.onQuit(); };
    $('cmp-quit').textContent = this.mp ? 'Leave World' : 'Save & Exit';
    $('cmp-fight').onclick = () => this.decide(true);
    $('cmp-auto').onclick = () => this.decide(false);
    $('cmp-speed').classList.toggle('hidden', this.mp);
    $('cmp-speed').querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        const v = +b.dataset.speed;
        if (v === 0) this.paused = !this.paused; else { this.speed = v; this.paused = false; }
        this.refresh();
      };
    });
    $('cmp-chat').classList.toggle('hidden', !this.mp);
    $('cmp-chat-input').onkeydown = (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter') return;
      const text = e.target.value.trim();
      if (text && this.net) this.net.send({ t: 'chat', text });
      e.target.value = '';
    };
    this.bindNet();
  }

  bindNet() {
    if (!this.net) return;
    this.net.on('notice', (n) => this.toast(n.text + '.'));
    this.net.on('chat', (m) => {
      this.chat.push(m);
      if (this.chat.length > 30) this.chat.shift();
      this.toast(`${m.from}: ${m.text}`);
      this.refresh();
    });
  }

  provinceAt(x, y) {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    if (cx < 0 || cy < 0 || cx >= this.cw || cy >= this.ch) return null;
    const r = this.region[cy * this.cw + cx];
    return r >= 0 ? r : null;
  }

  // Left click selects armies and provinces; right click marches the selected army.
  click(x, y, right) {
    if (this.s.over) return;
    if (!right) {
      for (const h of [...this.hits].reverse()) {
        if (Math.abs(x - h.x) < 14 * h.k && y > h.y - 4 && y < h.y + 32 * h.k) {
          this.selArmy = h.a.id;
          this.selProv = h.a.to === null ? h.a.prov : null;
          this.refresh();
          return;
        }
      }
    }
    const prov = this.provinceAt(x, y);
    if (prov === null) return;
    const a = this.selArmy && this.w.army(this.selArmy);
    if (right) {
      if (a && a.owner === this.me) this.act('move', { army: a.id, to: prov });
      return;
    }
    this.selProv = prov;
    const mine = this.w.idleArmyAt(prov, this.me);
    this.selArmy = mine ? mine.id : null;
    this.refresh();
  }

  // Give an order: directly in single player, through the server in multiplayer.
  act(c, args) {
    if (this.mp) { this.net.send({ t: 'wcmd', c, ...args }); return; }
    const w = this.w, me = this.me;
    let r;
    switch (c) {
      case 'move': r = w.move(me, args.army, args.to); break;
      case 'halt': r = w.halt(me, args.army); break;
      case 'recruit': r = w.recruit(me, args.prov, args.type); if (r.army) this.selArmy = r.army.id; break;
      case 'split': r = w.split(me, args.army); if (r.army) this.selArmy = r.army.id; break;
      case 'general': r = w.appointGeneral(me, args.army); break;
      case 'governor': r = w.appointGovernor(me, args.prov); break;
      case 'envoy': r = w.envoy(me, args.prov); if (r.ok) this.toast(`Your envoy brings gifts to ${PROVINCES[args.prov].name}.`); break;
      case 'decide': r = w.decide(me, args.battle, args.fight); break;
    }
    if (r && r.error) this.toast(r.error + '.');
    this.save();
    this.refresh();
  }

  // ---------- battles ----------
  askBattle(b) {
    this.dialog = b.id;
    const w = this.w, a = w.army(b.attacker), d = w.army(b.defender);
    const side = (army) => {
      const e = w.empireOf(army.owner);
      const units = Object.entries(army.units).filter(([, n]) => n > 0).map(([t, n]) => `${UNITS[t].icon} ${n} ${UNITS[t].name}`);
      if (army.general) units.unshift(`⭐ General ${army.general}`);
      if (army.leader) units.unshift(`👑 ${e.leader}`);
      return `<div class="side" style="--pc:${e.color}"><h3>${e.name}</h3><ul>${units.map((u) => `<li>${u}</li>`).join('')}</ul></div>`;
    };
    const odds = Math.round(w.odds(b) * 100);
    const mine = a.owner === this.me ? a : d;
    const myOdds = a.owner === this.me ? odds : 100 - odds;
    $('cmp-battle-title').textContent = `Battle of ${PROVINCES[b.prov].name}`;
    $('cmp-battle-sides').innerHTML = side(a) + '<div class="vs">vs</div>' + side(d);
    $('cmp-battle-odds').innerHTML = `${a.owner === this.me ? 'You attack.' : 'You are attacked!'} Auto-resolve chance of victory: <b>${myOdds}%</b>` +
      (mine.leader ? '<br><span class="warn">Your leader is in this army. If the battle is lost, so is your reign.</span>' : '');
    $('cmp-fight').disabled = $('cmp-auto').disabled = false;
    this.updateCountdown();
    $('cmp-battle').classList.remove('hidden');
  }

  updateCountdown() {
    const b = this.w.battle(this.dialog);
    if (!b) return;
    let text = '';
    if (this.mp) {
      text = this.decided.has(b.id) ? 'Orders given. Waiting for the other side…'
        : `Auto-resolves in ${Math.ceil(Math.max(0, b.deadline - this.now()))} s unless someone chooses to fight.`;
    }
    $('cmp-battle-timer').textContent = text;
  }

  closeDialog() {
    this.dialog = null;
    $('cmp-battle').classList.add('hidden');
  }

  decide(fight) {
    const id = this.dialog;
    if (id === null) return;
    this.decided.add(id);
    if (this.mp) {
      this.act('decide', { battle: id, fight });
      $('cmp-fight').disabled = $('cmp-auto').disabled = true;
      this.updateCountdown();
      return;
    }
    this.closeDialog();
    this.w.decide(this.me, id, fight);
    this.w.events.length = 0;
    const b = this.w.battle(id);
    if (b && b.state === 'fighting') {
      this.fighting = id;
      this.onBattle(this.w.battleSetup(b, this.me), id);
      return;
    }
    this.save();
    this.refresh();
  }

  // Single player: the real-time battle is over (winnerPid -1 when nobody is left), or the
  // player retreated from it (the battle is then auto-resolved).
  battleOver(survivors, winnerPid, retreat) {
    const id = this.fighting;
    this.fighting = null;
    const b = this.w.battle(id);
    if (!b) return;
    if (retreat) this.w.autoResolve(b);
    else {
      const setup = this.w.battleSetup(b, this.me);
      const winner = winnerPid >= 0 ? setup.owners[winnerPid] : this.w.army(b.defender).owner;
      this.w.applyFought(b, setup.owners, survivors, winner);
    }
    this.w.events.length = 0;
    if (this.selArmy && !this.w.army(this.selArmy)) this.selArmy = null;
    this.save();
    this.refresh();
  }

  // ---------- panels ----------
  save() {
    if (this.mp) return;
    try {
      if (this.s.over) localStorage.removeItem(SAVE_KEY);
      else localStorage.setItem(SAVE_KEY, JSON.stringify(this.w.toJSON()));
    } catch { /* storage unavailable: the campaign just is not saved */ }
  }

  toast(text) {
    const el = $('cmp-toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(this.toastT);
    this.toastT = setTimeout(() => el.classList.add('hidden'), 4000);
  }

  armyStatus(a) {
    const b = this.w.battleOf(a.id);
    if (b) return `⚔️ In battle at ${PROVINCES[b.prov].name}`;
    if (a.to === null) return `Standing in ${PROVINCES[a.prov].name}`;
    const dest = a.path.length ? a.path[a.path.length - 1] : a.to;
    return `🚩 Marching to ${PROVINCES[dest].name}`;
  }

  councilHtml() {
    const w = this.w, v = w.votes();
    const seg = (n, color) => `<span style="flex:${n};background:${color}"></span>`;
    let html = `<h3>World Council <small>(${v.need} of ${v.total} votes wins)</small></h3>
      <div class="council-bar">${seg(v.counts[0], this.ownerColor(0))}${seg(v.abstain, '#6d6a63')}${seg(v.counts[1], this.ownerColor(1))}
      <i style="left:${(v.need / v.total) * 100}%"></i><i style="right:${(v.need / v.total) * 100}%"></i></div>
      <div class="council-legend"><span style="color:${this.ownerColor(0)}">${w.empireOf(0).name} ${v.counts[0]}</span>
      <span class="muted">${v.abstain} undecided</span><span style="color:${this.ownerColor(1)}">${v.counts[1]} ${w.empireOf(1).name}</span></div>
      <div class="muted">The Council votes in ${fmtDuration(this.s.yearLen - (this.now() % this.s.yearLen))} (end of ${w.date(this.now()).year}).
      Your provinces vote for you (capitals ${CAPITAL_VOTES} votes). Free provinces vote for the country they favor most:
      send envoys (🪙 ${ENVOY_COST}) to win them over, or conquer them.</div>`;
    if (this.s.council.length) {
      html += `<div class="muted">${this.s.council.slice(-3).reverse().map((c) =>
        `Council of ${c.year}: ${c.counts[0]} : ${c.counts[1]}, ${c.abstain} abstained`).join('<br>')}</div>`;
    }
    return html;
  }

  refresh() {
    const w = this.w, s = this.s, me = w.empireOf(this.me), now = this.now();
    const v = w.votes();
    $('cmp-top-info').innerHTML = `<span class="crest" style="--pc:${me.color}"></span><b>${me.name}</b>
      <span>📅 ${w.dateText(now)}</span><span>🪙 ${s.gold[this.me]} <small>(+${w.income(this.me)} per month)</small></span>
      <span>🏰 ${s.provinces.filter((p) => p.owner === this.me).length} provinces</span>
      <span>🗳️ ${v.counts[this.me]} / ${v.need} votes <small>(Council in ${fmtDuration(s.yearLen - (now % s.yearLen))})</small></span>
      ${this.mp && this.code ? `<span>World code <b class="room-code">${this.code}</b></span>` : ''}`;
    $('cmp-speed').querySelectorAll('button').forEach((b) => {
      const sp = +b.dataset.speed;
      b.classList.toggle('active', sp === 0 ? this.paused : !this.paused && sp === this.speed);
    });

    let html = '';
    if (this.selProv !== null) {
      const p = w.province(this.selProv);
      const owner = w.empireOf(p.owner);
      const vote = v.byProv[p.id];
      html += `<h2>${p.name}${p.capital ? ' 🏰' : ''}</h2><div class="muted">Held by <b style="color:${owner.color}">${owner.name}</b> · 🪙 ${w.provinceIncome(p.id)} per month ·
        🗳️ ${p.capital ? CAPITAL_VOTES : 1} vote${p.capital ? 's' : ''} for ${vote === null ? 'nobody yet' : `<b style="color:${this.ownerColor(vote)}">${w.empireOf(vote).name}</b>`}</div>`;
      if (p.owner === REBELS) {
        html += `<h3>Favor of the free lords</h3>${COUNTRIES.map((o) => `<div class="favor"><span style="color:${this.ownerColor(o)}">${w.empireOf(o).name}</span>
          <div class="bar"><span style="width:${p.favor[o]}%;background:${this.ownerColor(o)}"></span><i style="left:${FAVOR_TO_VOTE}%"></i></div>${p.favor[o]}</div>`).join('')}
          <button class="envoy" ${s.over || s.gold[this.me] < ENVOY_COST || p.envoy[this.me] === w.monthIndex(now) ? 'disabled' : ''}>🕊️ Send an envoy (🪙 ${ENVOY_COST}, +${ENVOY_FAVOR} favor)</button>
          <div class="muted">One envoy per month. Conquering free provinces makes the others trust you less.</div>`;
      }
      if (p.owner === this.me && !s.over) {
        const isCap = w.capitalOf(this.me) === p.id;
        html += `<h3>City hall</h3><div class="muted">${isCap ? `👑 ${me.leader} rules from here.`
          : p.governor ? `🏛️ Governor: <b>${p.governor}</b> (+${GOVERNOR_INCOME * 100}% gold, +${GOVERNOR_RECRUITS} recruits a month)`
          : 'No governor. A governor brings in more gold and more recruits.'}</div>
          ${!isCap && !p.governor ? `<button class="governor" ${s.gold[this.me] < GOVERNOR_COST ? 'disabled' : ''}>🏛️ Appoint a governor (🪙 ${GOVERNOR_COST})</button>` : ''}`;
        const left = w.recruitLimit(p.id) - p.recruited;
        html += `<h3>Recruit <small>(${left} left this month)</small></h3><div class="recruit">${w.recruitable(this.me).map((r) =>
          `<button data-type="${r.type}" ${left <= 0 || s.gold[this.me] < r.cost ? 'disabled' : ''} title="${UNITS[r.type].desc}">${UNITS[r.type].icon} ${UNITS[r.type].name}<small>🪙 ${r.cost}</small></button>`).join('')}</div>`;
      }
    }
    const shown = this.selProv !== null ? w.armiesAt(this.selProv) : [];
    const sel = this.selArmy && w.army(this.selArmy);
    if (sel && !shown.includes(sel)) shown.unshift(sel);
    for (const a of shown) {
      const e = w.empireOf(a.owner);
      const list = Object.entries(a.units).filter(([, n]) => n > 0).map(([t, n]) => `<li>${UNITS[t].icon} ${n} × ${UNITS[t].name}</li>`).join('');
      const mine = a.owner === this.me, busy = !!w.battleOf(a.id);
      html += `<div class="army ${a.id === this.selArmy ? 'sel' : ''}" data-id="${a.id}" style="--pc:${e.color}">
        <div><b>${a.leader ? '👑 ' : a.general ? '⭐ ' : ''}${w.armyName(a)}</b> <span class="muted">strength ${Math.round(w.power(a))}</span></div>
        <div class="muted">${this.armyStatus(a)}</div>
        <ul>${list || '<li class="muted">No other troops</li>'}</ul>
        ${mine && !busy && w.canMarch(a) ? '<div class="muted">Right-click any province on the map to march there.</div>' : ''}
        ${mine && !busy && !w.canMarch(a) ? `<div class="muted">Troops without a general cannot march.</div>${a.to === null && s.provinces[a.prov].owner === this.me
          ? `<button class="general" ${s.gold[this.me] < GENERAL_COST ? 'disabled' : ''}>⭐ Hire a general (🪙 ${GENERAL_COST})</button>` : ''}` : ''}
        ${mine && !busy && a.to === null && armySize(a.units) > 1 ? '<button class="split">Split army</button>' : ''}
        ${mine && !busy && a.to !== null ? '<button class="halt">Halt at the next province</button>' : ''}</div>`;
    }
    if (this.selProv === null && !sel) {
      html += `<h2>${me.name}</h2><p class="muted">“${me.motto}”</p>
        <p>Click a province or an army banner to select it, then <b>right-click</b> any province to march there.
        Your provinces pay gold every month. Only armies led by a general or by ${me.leader} can march: hire generals,
        and governors to manage your provinces, at the city hall of each province.</p>`;
      if (this.mp) {
        html += `<h3>Rulers</h3>${COUNTRIES.map((o) => {
          const names = this.players.filter((p) => p.country === o)
            .map((p) => `${p.online ? '🟢' : '⚪'} ${escapeHtml(p.name)}${p.battle ? ' ⚔️' : ''}`);
          return `<div><b style="color:${this.ownerColor(o)}">${w.empireOf(o).name}</b>${o === this.me ? ' (you)' : ''}: ${names.length ? names.join(', ') : '🤖 computer'}</div>`;
        }).join('')}<div class="muted">A country with nobody online is ruled by the computer until its players return.</div>`;
      }
      html += `<p class="warn">${me.leader} starts in your capital. If your king falls, your reign ends; slay the enemy king to win.</p>`;
    }
    html += this.councilHtml();
    $('cmp-info').innerHTML = html;
    const info = $('cmp-info');
    info.querySelectorAll('.recruit button').forEach((b) => { b.onclick = () => this.act('recruit', { prov: this.selProv, type: b.dataset.type }); });
    const gov = info.querySelector('.governor');
    if (gov) gov.onclick = () => this.act('governor', { prov: this.selProv });
    const env = info.querySelector('.envoy');
    if (env) env.onclick = () => this.act('envoy', { prov: this.selProv });
    info.querySelectorAll('.army').forEach((el) => {
      el.onclick = (e) => {
        const id = +el.dataset.id;
        if (e.target.classList.contains('split')) { this.act('split', { army: id }); return; }
        if (e.target.classList.contains('halt')) { this.act('halt', { army: id }); return; }
        if (e.target.classList.contains('general')) { this.act('general', { army: id }); return; }
        this.selArmy = id; this.refresh();
      };
    });
    const chat = this.chat.slice(-6).map((m) => `<div><b>${escapeHtml(m.from)}:</b> ${escapeHtml(m.text)}</div>`).join('');
    $('cmp-log').innerHTML = chat + s.log.slice(-14).reverse().map((l) => `<div><span class="muted">${w.dateText(l.t).replace(/^(\w{3})\w*/, '$1')}</span> ${l.text}</div>`).join('');
  }

  showOver() {
    this.shownOver = true;
    this.closeDialog();
    this.save();
    const won = this.s.over.winner === this.me;
    $('cmp-over-title').textContent = won ? (this.s.over.vote ? 'World Leader!' : 'The Realm is Yours!') : 'Your Reign Has Ended';
    $('cmp-over-title').className = won ? 'win' : 'lose';
    $('cmp-over-reason').textContent = `${this.s.over.reason} (${this.w.dateText()})`;
    $('cmp-over').classList.remove('hidden');
  }
}
