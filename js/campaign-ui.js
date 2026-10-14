'use strict';
// World map screen for the campaign: draws provinces and armies, handles orders, and hands
// battles to the real-time game.

const SAVE_KEY = 'empires.campaign';
const CELL = 4; // world map is rasterised in 4px cells
const WORLD_W = 1000, WORLD_H = 640;

function loadCampaignSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

class CampaignUI {
  constructor(campaign, { onBattle, onQuit }) {
    this.c = campaign;
    this.onBattle = onBattle;
    this.onQuit = onQuit;
    this.canvas = $('cmp-map');
    this.ctx = this.canvas.getContext('2d');
    this.selProv = null;
    this.selArmy = null;
    this.pending = null; // battle awaiting the player's decision
    this.buildRegions();
    this.bind();
    this.save();
  }

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

  ownerColor(owner) {
    return owner === REBELS ? EMPIRES.rebels.color : this.c.empireOf(owner).color;
  }

  paintRegions() {
    const g = this.img.getContext('2d');
    g.fillStyle = '#1e3a4f';
    g.fillRect(0, 0, WORLD_W, WORLD_H);
    const { cw, ch, region } = this;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const r = region[y * cw + x];
      if (r < 0) continue;
      const owner = this.c.s.provinces[r].owner;
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
    this.paintedSig = this.c.s.provinces.map((p) => p.owner).join();
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

  armySlots(prov) {
    return this.c.armiesAt(prov).map((a, i, all) => ({ a, x: PROVINCES[prov].x + (i - (all.length - 1) / 2) * 34, y: PROVINCES[prov].y + 24 }));
  }

  draw() {
    const c = this.ctx, s = this.c.s;
    if (this.paintedSig !== s.provinces.map((p) => p.owner).join()) this.paintRegions();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#16232e';
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    c.setTransform(this.scale, 0, 0, this.scale, this.ox, this.oy);
    c.drawImage(this.img, 0, 0);

    // Roads
    c.strokeStyle = 'rgba(90,60,30,0.6)';
    c.lineWidth = 2;
    c.setLineDash([6, 5]);
    for (const [a, b] of LINKS) {
      c.beginPath(); c.moveTo(PROVINCES[a].x, PROVINCES[a].y); c.lineTo(PROVINCES[b].x, PROVINCES[b].y); c.stroke();
    }
    c.setLineDash([]);

    // Where the selected army can march
    const sel = this.selArmy && this.c.army(this.selArmy);
    const t = performance.now() / 1000;
    if (sel && !sel.moved && sel.owner === CAMPAIGN_HUMAN) {
      for (const n of this.c.adj[sel.prov]) {
        const hostile = this.c.armiesAt(n).some((x) => x.owner !== CAMPAIGN_HUMAN);
        c.strokeStyle = hostile ? '#ff6b5a' : '#f2e3b3';
        c.lineWidth = 3;
        c.beginPath(); c.arc(PROVINCES[n].x, PROVINCES[n].y, 22 + Math.sin(t * 4) * 3, 0, Math.PI * 2); c.stroke();
      }
    }

    // Settlements and names
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
    });

    // Armies as banners
    for (let i = 0; i < PROVINCES.length; i++) {
      for (const { a, x, y } of this.armySlots(i)) {
        const col = this.ownerColor(a.owner);
        if (a.id === this.selArmy) {
          c.strokeStyle = '#ffe680'; c.lineWidth = 3;
          c.strokeRect(x - 15, y - 3, 30, 36);
        }
        c.fillStyle = col;
        c.strokeStyle = '#1a120a'; c.lineWidth = 1.5;
        c.beginPath(); c.moveTo(x - 12, y); c.lineTo(x + 12, y); c.lineTo(x + 12, y + 18); c.lineTo(x, y + 30); c.lineTo(x - 12, y + 18); c.closePath(); c.fill(); c.stroke();
        c.fillStyle = '#fff';
        c.font = 'bold 12px Georgia';
        c.fillText(String(armySize(a.units)), x, y + 16);
        if (a.leader) { c.font = '12px serif'; c.fillText('👑', x, y - 2); }
        if (a.moved && a.owner === CAMPAIGN_HUMAN) { c.fillStyle = 'rgba(0,0,0,0.35)'; c.fill(); }
      }
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
    $('cmp-end').onclick = () => this.endTurn();
    $('cmp-quit').onclick = () => { this.save(); this.onQuit(); };
    $('cmp-fight').onclick = () => this.decide(true);
    $('cmp-auto').onclick = () => this.decide(false);
  }

  provinceAt(x, y) {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    if (cx < 0 || cy < 0 || cx >= this.cw || cy >= this.ch) return null;
    const r = this.region[cy * this.cw + cx];
    return r >= 0 ? r : null;
  }

  click(x, y, right) {
    if (this.pending || this.c.s.over) return;
    // Clicking an army banner selects that army.
    for (let i = 0; i < PROVINCES.length; i++) {
      for (const slot of this.armySlots(i)) {
        if (Math.abs(x - slot.x) < 14 && y > slot.y - 4 && y < slot.y + 32) {
          if (!right || slot.a.owner === CAMPAIGN_HUMAN) {
            if (slot.a.owner !== CAMPAIGN_HUMAN && this.tryMove(i)) return;
            this.selArmy = slot.a.id; this.selProv = i; this.refresh(); return;
          }
        }
      }
    }
    const prov = this.provinceAt(x, y);
    if (prov === null) return;
    if (this.tryMove(prov)) return;
    this.selProv = prov;
    const mine = this.c.armyAt(prov, CAMPAIGN_HUMAN);
    this.selArmy = mine ? mine.id : null;
    this.refresh();
  }

  tryMove(prov) {
    const a = this.selArmy && this.c.army(this.selArmy);
    if (!a || a.owner !== CAMPAIGN_HUMAN || !this.c.canMove(a, prov)) return false;
    const r = this.c.move(a.id, prov);
    if (r.battle) this.askBattle(r.battle, false);
    else { this.selProv = prov; this.selArmy = a.id; }
    this.afterAction();
    return true;
  }

  endTurn() {
    if (this.pending || this.c.s.over) return;
    this.selArmy = null;
    const battle = this.c.endTurn();
    if (battle) this.askBattle(battle, true);
    this.afterAction();
  }

  // ---------- battles ----------
  askBattle(battle, aiTurn) {
    this.pending = { battle, aiTurn };
    const a = this.c.army(battle.attacker), d = this.c.army(battle.defender);
    const side = (army) => {
      const e = army.owner === REBELS ? EMPIRES.rebels : this.c.empireOf(army.owner);
      const units = Object.entries(army.units).filter(([, n]) => n > 0).map(([t, n]) => `${UNITS[t].icon} ${n} ${UNITS[t].name}`);
      if (army.leader) units.unshift(`👑 ${e.leader}`);
      return `<div class="side" style="--pc:${e.color}"><h3>${e.name}</h3><ul>${units.map((u) => `<li>${u}</li>`).join('')}</ul></div>`;
    };
    const odds = Math.round(this.c.odds(battle) * 100);
    const myOdds = a.owner === CAMPAIGN_HUMAN ? odds : 100 - odds;
    $('cmp-battle-title').textContent = `Battle of ${PROVINCES[battle.prov].name}`;
    $('cmp-battle-sides').innerHTML = side(a) + '<div class="vs">vs</div>' + side(d);
    const leaderAtRisk = (a.owner === CAMPAIGN_HUMAN ? a : d).leader;
    $('cmp-battle-odds').innerHTML = `Auto-resolve chance of victory: <b>${myOdds}%</b>` +
      (leaderAtRisk ? '<br><span class="warn">Your leader is in this army. If the battle is lost, so is your reign.</span>' : '');
    $('cmp-battle').classList.remove('hidden');
  }

  decide(fight) {
    const p = this.pending;
    if (!p) return;
    $('cmp-battle').classList.add('hidden');
    if (fight) {
      this.fighting = p;
      this.onBattle(this.c.battleSetup(p.battle), `Battle of ${PROVINCES[p.battle.prov].name}`);
      return;
    }
    this.autoResolve(p);
  }

  autoResolve(p) {
    const r = this.c.autoResolve(p.battle);
    const won = p.aiTurn ? !r.attackerWon : r.attackerWon;
    this.toast(won ? `Victory at ${PROVINCES[p.battle.prov].name}!` : `Defeat at ${PROVINCES[p.battle.prov].name}.`);
    this.resume(p);
  }

  // Called when the real-time battle ends, or with retreat=true when the player leaves it early
  // (the battle is then auto-resolved).
  battleOver(survivors, humanWon, retreat) {
    const p = this.fighting;
    this.fighting = null;
    if (!p) return;
    if (retreat) { this.autoResolve(p); return; }
    this.c.applyFought(p.battle, survivors, humanWon);
    this.resume(p);
  }

  resume(p) {
    this.pending = null;
    if (!p.aiTurn) this.selProv = p.battle.prov;
    if (p.aiTurn && !this.c.s.over) {
      const next = this.c.continueAi();
      if (next) this.askBattle(next, true);
    }
    this.afterAction();
  }

  // ---------- panels ----------
  afterAction() {
    if (this.selArmy && !this.c.army(this.selArmy)) this.selArmy = null;
    this.save();
    this.refresh();
  }

  save() {
    try {
      if (this.c.s.over) localStorage.removeItem(SAVE_KEY);
      else localStorage.setItem(SAVE_KEY, JSON.stringify(this.c.toJSON()));
    } catch { /* storage unavailable: the campaign just is not saved */ }
  }

  toast(text) {
    const el = $('cmp-toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(this.toastT);
    this.toastT = setTimeout(() => el.classList.add('hidden'), 3000);
  }

  refresh() {
    const c = this.c, s = c.s, me = c.empireOf(CAMPAIGN_HUMAN);
    $('cmp-top-info').innerHTML = `<span class="crest" style="--pc:${me.color}"></span><b>${me.name}</b>
      <span>Turn ${s.turn}</span><span>🪙 ${s.gold[CAMPAIGN_HUMAN]} <small>(+${c.income(CAMPAIGN_HUMAN)} per turn)</small></span>
      <span>🏰 ${s.provinces.filter((p) => p.owner === CAMPAIGN_HUMAN).length} provinces</span>`;

    let html = '';
    if (this.selProv !== null) {
      const p = c.province(this.selProv);
      const owner = p.owner === REBELS ? EMPIRES.rebels : c.empireOf(p.owner);
      html += `<h2>${p.name}${p.capital ? ' 🏰' : ''}</h2><div class="muted">Held by <b style="color:${owner.color}">${owner.name}</b> · 🪙 ${p.income} per turn</div>`;
      if (p.owner === CAMPAIGN_HUMAN && !s.over) {
        const left = c.recruitLimit(p.id) - p.recruited;
        html += `<h3>Recruit <small>(${left} left this turn)</small></h3><div class="recruit">${c.recruitable(CAMPAIGN_HUMAN).map((r) =>
          `<button data-type="${r.type}" ${left <= 0 || s.gold[CAMPAIGN_HUMAN] < r.cost ? 'disabled' : ''} title="${UNITS[r.type].desc}">${UNITS[r.type].icon} ${UNITS[r.type].name}<small>🪙 ${r.cost}</small></button>`).join('')}</div>`;
      }
      for (const a of c.armiesAt(p.id)) {
        const e = a.owner === REBELS ? EMPIRES.rebels : c.empireOf(a.owner);
        const list = Object.entries(a.units).filter(([, n]) => n > 0).map(([t, n]) => `<li>${UNITS[t].icon} ${n} × ${UNITS[t].name}</li>`).join('');
        const mine = a.owner === CAMPAIGN_HUMAN;
        html += `<div class="army ${a.id === this.selArmy ? 'sel' : ''}" data-id="${a.id}" style="--pc:${e.color}">
          <div><b>${a.leader ? `👑 ${e.leader}'s army` : `${e.name} army`}</b> <span class="muted">strength ${Math.round(c.power(a))}</span></div>
          <ul>${list || '<li class="muted">No troops</li>'}</ul>
          ${mine ? (a.moved ? '<div class="muted">Has marched this turn.</div>' : '<div class="muted">Click a highlighted province to march.</div>') : ''}
          ${mine && armySize(a.units) > 1 ? '<button class="split">Split army</button>' : ''}</div>`;
      }
    } else {
      html += `<h2>${me.name}</h2><p class="muted">“${me.motto}”</p>
        <p>Lead ${me.leader} to victory. Take the free provinces in the middle, then march on the enemy.
        Click a province to inspect it, click your army to select it, then click a highlighted neighbour to march.</p>
        <p class="warn">If your leader falls in battle, your campaign ends.</p>`;
    }
    $('cmp-info').innerHTML = html;
    $('cmp-info').querySelectorAll('.recruit button').forEach((b) => {
      b.onclick = () => {
        const r = c.recruit(CAMPAIGN_HUMAN, this.selProv, b.dataset.type);
        if (r.error) this.toast(r.error + '.');
        else this.selArmy = r.army.id;
        this.afterAction();
      };
    });
    $('cmp-info').querySelectorAll('.army').forEach((el) => {
      el.onclick = (e) => {
        if (e.target.classList.contains('split')) { const r = c.split(+el.dataset.id); if (r.army) this.selArmy = r.army.id; this.afterAction(); return; }
        this.selArmy = +el.dataset.id; this.refresh();
      };
    });
    $('cmp-log').innerHTML = s.log.slice(-12).reverse().map((l) => `<div><span class="muted">T${l.turn}</span> ${l.text}</div>`).join('');
    $('cmp-end').disabled = !!s.over || !!this.pending;

    if (s.over && !this.shownOver) {
      this.shownOver = true;
      const won = s.over.winner === CAMPAIGN_HUMAN;
      $('cmp-over-title').textContent = won ? 'The Realm is Yours!' : 'Your Reign Has Ended';
      $('cmp-over-title').className = won ? 'win' : 'lose';
      $('cmp-over-reason').textContent = s.over.reason + ` (turn ${s.turn})`;
      $('cmp-over').classList.remove('hidden');
    }
  }
}
