'use strict';
// HUD, selection and input handling. Talks to the simulation only through `cmd`,
// so the same UI drives a local game or a networked one.

const SLOT_KEYS = 'QWERASDFZXCV';
const $ = (id) => document.getElementById(id);

class UI {
  constructor({ game, renderer, cmd, player, multiplayer = false, onPause }) {
    this.game = game;
    this.r = renderer;
    this.cmd = cmd;
    this.player = player;
    this.multiplayer = multiplayer;
    this.onPause = onPause;
    this.selection = [];
    this.hover = null;
    this.placing = null;
    this.mode = null; // 'attackMove'
    this.drag = null;
    this.mouse = { x: 0, y: 0, inside: false };
    this.mouseWorld = null;
    this.keys = new Set();
    this.groups = {};
    this.lastGroupKey = { key: null, t: 0 };
    this.lastClick = { t: 0, id: null };
    this.panelT = 0;
    this.panelSig = '';
    this.idleIndex = 0;
    this.bind();
    this.buildTopbar();
  }

  get me() { return this.game.players[this.player]; }

  // ---------- events from the game ----------
  handleEvent(ev) {
    if (ev.type === 'alert' && ev.owner === this.player) {
      this.message('⚠️ We are under attack!', 'warn');
      this.r.pings.push({ x: ev.x, y: ev.y, t: performance.now() });
    } else if (ev.type === 'built' && ev.owner === this.player) {
      this.message(`${BUILDINGS[ev.btype].name} completed.`);
    } else if (ev.type === 'defeated') {
      const p = this.game.players[ev.player];
      if (ev.player !== this.player) this.message(`${ev.reason || (p.name || p.empire.name) + ' has been defeated'}!`, 'good');
    }
  }

  message(text, kind = '') {
    const el = document.createElement('div');
    el.className = 'msg ' + kind;
    el.textContent = text;
    $('messages').appendChild(el);
    setTimeout(() => el.classList.add('fade'), 3500);
    setTimeout(() => el.remove(), 4300);
    while ($('messages').children.length > 5) $('messages').firstChild.remove();
  }

  // ---------- input ----------
  bind() {
    const cv = this.r.canvas;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('mousedown', (e) => this.onDown(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
    cv.addEventListener('mousemove', (e) => this.onMove(e));
    cv.addEventListener('mouseenter', (e) => { this.mouse.x = e.offsetX; this.mouse.y = e.offsetY; this.mouse.inside = true; });
    cv.addEventListener('mouseleave', () => { this.mouse.inside = false; });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const before = this.r.toWorld(e.offsetX, e.offsetY);
      this.r.cam.zoom = clamp(this.r.cam.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 0.5, 1.6);
      this.r.cam.x = before.x - e.offsetX / this.r.cam.zoom;
      this.r.cam.y = before.y - e.offsetY / this.r.cam.zoom;
      this.r.clampCam();
    }, { passive: false });
    this.keyDown = (e) => this.onKey(e);
    this.keyUp = (e) => this.keys.delete(e.key);
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);

    const mm = $('minimap');
    const miniTo = (e) => {
      const rect = mm.getBoundingClientRect();
      return { x: ((e.clientX - rect.left) / rect.width) * MAP_W * TILE, y: ((e.clientY - rect.top) / rect.height) * MAP_H * TILE };
    };
    mm.oncontextmenu = (e) => e.preventDefault();
    mm.onmousedown = (e) => {
      const w = miniTo(e);
      if (e.button === 2) { this.commandAt(w.x, w.y, null, e.shiftKey); return; }
      this.r.centerOn(w.x, w.y);
      this.miniDrag = true;
    };
    mm.onmousemove = (e) => { if (this.miniDrag) { const w = miniTo(e); this.r.centerOn(w.x, w.y); } };
    window.addEventListener('mouseup', () => { this.miniDrag = false; });
  }

  unbind() {
    window.removeEventListener('keydown', this.keyDown);
    window.removeEventListener('keyup', this.keyUp);
  }

  onMove(e) {
    this.mouse.x = e.offsetX;
    this.mouse.y = e.offsetY;
    this.mouse.inside = true;
    this.mouseWorld = this.r.toWorld(e.offsetX, e.offsetY);
    if (this.drag) {
      this.drag.ex = e.offsetX;
      this.drag.ey = e.offsetY;
      if (Math.abs(this.drag.ex - this.drag.sx) + Math.abs(this.drag.ey - this.drag.sy) > 6) this.drag.active = true;
    }
  }

  onDown(e) {
    const w = this.r.toWorld(e.offsetX, e.offsetY);
    if (e.button === 2) {
      if (this.placing || this.mode) { this.placing = null; this.mode = null; return; }
      this.commandAt(w.x, w.y, this.pick(w.x, w.y), e.shiftKey);
      return;
    }
    if (e.button !== 0) return;
    if (this.placing) { this.tryPlace(e.shiftKey); return; }
    if (this.mode === 'attackMove') {
      const units = this.myUnits();
      const t = this.pick(w.x, w.y);
      if (t && t.entity !== 'node' && this.game.isEnemy(this.player, t.owner)) this.cmd.smart(units, w.x, w.y, t);
      else this.cmd.move(units, w.x, w.y, true);
      this.r.markers.push({ x: w.x, y: w.y, t: performance.now(), color: '#ff5a5a' });
      if (!e.shiftKey) this.mode = null;
      return;
    }
    this.drag = { sx: e.offsetX, sy: e.offsetY, ex: e.offsetX, ey: e.offsetY, active: false, shift: e.shiftKey, ctrl: e.ctrlKey };
  }

  onUp(e) {
    if (e.button !== 0 || !this.drag) return;
    const d = this.drag;
    this.drag = null;
    if (d.active) {
      const a = this.r.toWorld(Math.min(d.sx, d.ex), Math.min(d.sy, d.ey));
      const b = this.r.toWorld(Math.max(d.sx, d.ex), Math.max(d.sy, d.ey));
      const inBox = this.game.entities.filter((u) => u.entity === 'unit' && u.owner === this.player &&
        u.x + u.radius >= a.x && u.x - u.radius <= b.x && u.y + 6 >= a.y && u.y - 14 <= b.y);
      // Prefer soldiers over peasants when both are boxed.
      const army = inBox.filter((u) => !u.def.worker);
      const pick = army.length && !d.shift ? army : inBox;
      this.select(d.shift ? [...new Set([...this.selection, ...pick])] : pick);
      return;
    }
    const w = this.r.toWorld(d.sx, d.sy);
    const t = this.pick(w.x, w.y);
    const now = performance.now();
    if (t && t.owner === this.player && t.entity === 'unit' && now - this.lastClick.t < 350 && this.lastClick.id === t.id) {
      // Double click: everything of that type on screen.
      const same = this.game.entities.filter((u) => u.owner === this.player && u.type === t.type && this.onScreen(u));
      this.select(same);
    } else if (!t) {
      if (!d.shift) this.select([]);
    } else if (d.shift && t.owner === this.player && t.entity === 'unit') {
      this.select(this.selection.includes(t) ? this.selection.filter((s) => s !== t) : [...this.selection, t]);
    } else this.select([t]);
    this.lastClick = { t: now, id: t && t.id };
  }

  onScreen(e) {
    const c = this.r.cam;
    return e.x >= c.x && e.y >= c.y && e.x <= c.x + this.r.viewW && e.y <= c.y + this.r.viewH;
  }

  // Entity under a world point: units first, then buildings, then resources.
  pick(x, y) {
    const g = this.game;
    let best = null, bestD = 16;
    for (const e of g.entities) {
      if (e.entity !== 'unit' || (e.owner !== this.player && !g.isVisible(e))) continue;
      const d = dist(e.x, e.y - 6, x, y);
      if (d < bestD) { bestD = d; best = e; }
    }
    if (best) return best;
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return null;
    const i = ty * MAP_W + tx;
    const bid = g.occupied[i];
    if (bid && g.byId.get(bid) && (g.explored[i] || g.byId.get(bid).owner === this.player)) return g.byId.get(bid);
    // Tall buildings: also check the tile below the cursor.
    const below = ty + 1 < MAP_H ? g.occupied[i + MAP_W] : 0;
    if (below && g.byId.get(below) && g.explored[i + MAP_W] && !g.byId.get(below).def.walkable) return g.byId.get(below);
    if (g.explored[i] && g.map.nodeAt[i]) return g.map.nodeAt[i];
    return null;
  }

  myUnits() { return this.selection.filter((e) => e.entity === 'unit' && e.owner === this.player && !e.dead); }

  commandAt(x, y, target, shift) {
    const units = this.myUnits();
    const g = this.game;
    if (units.length) {
      const kind = this.cmd.smart(units, x, y, target);
      const color = target && target.entity !== 'node' && g.isEnemy(this.player, target.owner) ? '#ff5a5a' : target ? '#ffe680' : '#7CFC6A';
      this.r.markers.push({ x: target ? target.x : x, y: target ? target.y : y, t: performance.now(), color });
      return kind;
    }
    const blds = this.selection.filter((e) => e.entity === 'building' && e.owner === this.player && e.def.trains);
    for (const b of blds) this.cmd.rally(b, x, y, target && (target.entity === 'node' || target.owner === this.player) ? target : null);
    if (blds.length) this.r.markers.push({ x, y, t: performance.now(), color: g.players[this.player].color });
    return null;
  }

  select(list) {
    this.selection = list.filter((e) => e && !e.dead).slice(0, 60);
    this.placing = null;
    this.mode = null;
    this.panelSig = '';
  }

  startPlacing(type) {
    const g = this.game;
    if (!g.buildingUnlocked(this.player, type)) { this.message(`Requires ${BUILDINGS[BUILDINGS[type].requires].name}.`, 'warn'); return; }
    if (!canAfford(this.me.res, g.buildingCost(this.player, type))) { this.message('Not enough resources.', 'warn'); return; }
    this.placing = type;
    this.mode = null;
  }

  tryPlace(keep) {
    const pt = this.placeTile;
    if (!pt) return;
    if (!pt.ok) { this.message('Cannot build there.', 'warn'); return; }
    const builders = this.myUnits().filter((u) => u.def.worker);
    const r = this.cmd.place(this.placing, pt.tx, pt.ty, builders);
    if (r && r.error) { this.message(r.error + '.', 'warn'); this.placing = null; return; }
    if (!keep || !canAfford(this.me.res, this.game.buildingCost(this.player, this.placing))) this.placing = null;
  }

  onKey(e) {
    if (document.activeElement && document.activeElement.tagName === 'INPUT') {
      if (e.key === 'Enter' && document.activeElement.id === 'chat-input') this.sendChat();
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }
    const k = e.key;
    this.keys.add(k);
    if (k === 'Enter' && this.multiplayer) { $('chat').classList.remove('hidden'); $('chat-input').focus(); e.preventDefault(); return; }
    if (k === 'Escape') { if (this.placing || this.mode) { this.placing = null; this.mode = null; } else this.select([]); return; }
    if ((k === 'p' || k === 'P' || k === 'F10') && this.onPause) { e.preventDefault(); this.onPause(); return; }
    if (k === 'Delete') { for (const s of this.selection) if (s.owner === this.player) this.cmd.del(s); this.select([]); return; }
    if (k === 'h' || k === 'H') {
      const tc = this.game.entities.find((b) => b.owner === this.player && b.type === 'towncenter');
      if (tc) { this.select([tc]); this.r.centerOn(tc.x, tc.y); }
      return;
    }
    if (k === '.' || k === ',') { this.nextIdle(); return; }
    if (k === 'l' || k === 'L') {
      const ld = this.game.entities.find((u) => u.owner === this.player && u.type === 'leader');
      if (ld) { this.select([ld]); this.r.centerOn(ld.x, ld.y); }
      return;
    }
    if (/^[0-9]$/.test(k)) {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); this.groups[k] = this.selection.slice(); this.message(`Group ${k} set.`); return; }
      const grp = (this.groups[k] || []).filter((x) => !x.dead && this.game.byId.get(x.id) === x);
      if (!grp.length) return;
      const now = performance.now();
      if (this.lastGroupKey.key === k && now - this.lastGroupKey.t < 400) {
        const cx = grp.reduce((s, u) => s + u.x, 0) / grp.length, cy = grp.reduce((s, u) => s + u.y, 0) / grp.length;
        this.r.centerOn(cx, cy);
      }
      this.lastGroupKey = { key: k, t: now };
      this.select(grp);
      return;
    }
    const slot = SLOT_KEYS.indexOf(k.toUpperCase());
    if (slot >= 0 && !e.ctrlKey && !e.metaKey) {
      const c = this.commands()[slot];
      if (c && !c.disabled) c.action();
    }
  }

  nextIdle() {
    const idle = this.game.entities.filter((u) => u.owner === this.player && u.entity === 'unit' && u.def.worker && !u.order);
    if (!idle.length) { this.message('No idle villagers.'); return; }
    const u = idle[this.idleIndex++ % idle.length];
    this.select([u]);
    this.r.centerOn(u.x, u.y);
  }

  sendChat() {
    const inp = $('chat-input');
    const text = inp.value.trim();
    if (text && this.cmd.chat) this.cmd.chat(text);
    inp.value = '';
    inp.blur();
    $('chat').classList.add('hidden');
  }

  // ---------- per-frame ----------
  update(dt) {
    const g = this.game;
    this.selection = this.selection.filter((e) => !e.dead && (e.entity === 'node' ? e.amount > 0 : g.byId.get(e.id) === e));
    if (this.hover && (this.hover.dead || (this.hover.entity !== 'node' && g.byId.get(this.hover.id) !== this.hover))) this.hover = null;
    // Camera: arrows / WASD-free edge scrolling.
    const sp = 900 * dt / this.r.cam.zoom;
    let dx = 0, dy = 0;
    if (this.keys.has('ArrowLeft')) dx -= sp;
    if (this.keys.has('ArrowRight')) dx += sp;
    if (this.keys.has('ArrowUp')) dy -= sp;
    if (this.keys.has('ArrowDown')) dy += sp;
    if (this.mouse.inside && !this.drag) {
      const m = 12, W = this.r.canvas.width, H = this.r.canvas.height;
      if (this.mouse.x < m) dx -= sp;
      if (this.mouse.x > W - m) dx += sp;
      if (this.mouse.y < m) dy -= sp;
      if (this.mouse.y > H - m) dy += sp;
    }
    if (dx || dy) { this.r.cam.x += dx; this.r.cam.y += dy; this.r.clampCam(); }
    if (this.mouse.inside) {
      this.mouseWorld = this.r.toWorld(this.mouse.x, this.mouse.y);
      this.hover = this.placing ? null : this.pick(this.mouseWorld.x, this.mouseWorld.y);
    }
    this.r.canvas.style.cursor = this.mode === 'attackMove' ? 'crosshair' :
      this.hover && this.hover.entity !== 'node' && this.game.isEnemy(this.player, this.hover.owner) && this.myUnits().length ? 'crosshair' : 'default';

    this.panelT -= dt;
    if (this.panelT <= 0) {
      this.panelT = 0.2;
      this.updateTopbar();
      this.updatePanel();
    }
  }

  // ---------- HUD ----------
  buildTopbar() {
    const p = this.me;
    $('topbar').innerHTML = `
      <div class="empire" style="--pc:${p.color}"><span class="crest"></span>${p.empire.name}</div>
      ${this.game.battle ? `<div class="res">⚔️ <b>${this.game.battleName || 'Battle'}</b></div><div class="res" id="battle-count"></div>` :
    `${RESOURCES.map((r) => `<div class="res" title="${r}">${RES_ICON[r]} <b id="res-${r}">0</b></div>`).join('')}
      <div class="res" title="Population">👥 <b id="res-pop">0</b></div>`}
      <div class="clock" id="clock">00:00</div>
      <button id="menu-btn" title="Menu (P)">☰</button>`;
    $('menu-btn').onclick = () => this.onPause && this.onPause();
  }

  updateTopbar() {
    const p = this.me;
    if (this.game.battle) {
      const count = (pid) => this.game.entities.filter((e) => e.owner === pid && !e.dead).length;
      $('battle-count').innerHTML = this.game.players.map((pl) => `<span style="color:${pl.color}">${count(pl.id)}</span>`).join(' vs ');
    } else {
      for (const r of RESOURCES) $('res-' + r).textContent = Math.floor(p.res[r]);
      const popEl = $('res-pop');
      popEl.textContent = `${p.pop}/${p.popCap}`;
      popEl.classList.toggle('capped', p.pop >= p.popCap);
    }
    const t = Math.floor(this.game.time);
    $('clock').textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  }

  commands() {
    const g = this.game, sel = this.selection;
    const out = [];
    const mine = sel.filter((e) => e.owner === this.player);
    if (!mine.length) return out;
    const units = mine.filter((e) => e.entity === 'unit');
    if (units.length) {
      if (units.some((u) => u.def.worker)) {
        for (const type of BUILD_MENU) {
          const def = BUILDINGS[type];
          const cost = g.buildingCost(this.player, type);
          const locked = !g.buildingUnlocked(this.player, type);
          out.push({
            icon: def.icon, name: def.name, cost, desc: def.desc + (locked ? ` Requires ${BUILDINGS[def.requires].name}.` : ''),
            disabled: locked, poor: !canAfford(this.me.res, cost), action: () => this.startPlacing(type),
          });
        }
      } else {
        out.push({ icon: '⚔️', name: 'Attack-move', desc: 'Move and fight anything on the way.', action: () => { this.mode = 'attackMove'; this.placing = null; } });
      }
      out[SLOT_KEYS.length - 1] = { icon: '✋', name: 'Stop', desc: 'Stop current orders.', action: () => this.cmd.stop(units) };
      return out;
    }
    const b = mine[0];
    if (b.entity !== 'building' || !b.complete) return out;
    for (const type of g.trainable(b)) {
      const def = g.unitDef(this.player, type);
      out.push({
        icon: def.icon, name: def.name, cost: def.cost, desc: def.desc + ` (HP ${def.hp}, attack ${def.atk}, armor ${def.armor}${def.range > 1 ? `, range ${def.range}` : ''})`,
        poor: !canAfford(this.me.res, def.cost), action: () => {
          // Queue in whichever selected building of this type is least busy.
          const bb = mine.filter((x) => x.type === b.type && x.complete).sort((x, y) => x.queue.length - y.queue.length)[0];
          const r = this.cmd.train(bb, type);
          if (r && r.error) this.message(r.error + '.', 'warn');
        },
      });
    }
    return out;
  }

  updatePanel() {
    const sel = this.selection;
    const cmds = this.commands();
    // Command grid
    const sig = sel.map((e) => e.id).join(',') + '|' + cmds.map((c) => c && (c.name + c.poor + c.disabled)).join(',');
    if (sig !== this.panelSig) {
      this.panelSig = sig;
      const grid = $('commands');
      grid.innerHTML = '';
      for (let i = 0; i < SLOT_KEYS.length; i++) {
        const c = cmds[i];
        const btn = document.createElement('button');
        btn.className = 'cmd';
        if (c) {
          btn.innerHTML = `<span class="icon">${c.icon}</span><span class="key">${SLOT_KEYS[i]}</span>`;
          btn.classList.toggle('poor', !!c.poor);
          btn.disabled = !!c.disabled;
          btn.onclick = () => c.action();
          btn.onmouseenter = () => this.showTip(btn, c, SLOT_KEYS[i]);
          btn.onmouseleave = () => this.hideTip();
        } else btn.classList.add('empty');
        grid.appendChild(btn);
      }
    }
    this.updateInfo();
  }

  showTip(el, c, key) {
    const tip = $('tooltip');
    tip.innerHTML = `<b>${c.name}</b> <span class="k">[${key}]</span>` +
      (c.cost ? `<div class="cost">${RESOURCES.filter((r) => c.cost[r]).map((r) => `<span class="${this.me.res[r] < c.cost[r] ? 'short' : ''}">${RES_ICON[r]} ${c.cost[r]}</span>`).join(' ')}</div>` : '') +
      `<div>${c.desc}</div>`;
    const r = el.getBoundingClientRect();
    tip.style.left = Math.min(window.innerWidth - 270, r.left) + 'px';
    tip.style.bottom = window.innerHeight - r.top + 8 + 'px';
    tip.classList.remove('hidden');
  }
  hideTip() { $('tooltip').classList.add('hidden'); }

  updateInfo() {
    const g = this.game, sel = this.selection, info = $('info');
    if (!sel.length) {
      const p = this.me;
      info.innerHTML = `<div class="title">${p.empire.name}</div><div class="motto">“${p.empire.motto}”</div>
        <ul class="bonuses">${p.empire.bonuses.map((b) => `<li>${b}</li>`).join('')}${p.empire.weaknesses.map((b) => `<li class="weak">${b}</li>`).join('')}</ul>`;
      return;
    }
    if (sel.length > 1) {
      const groups = {};
      for (const e of sel) (groups[e.type] = groups[e.type] || []).push(e);
      info.innerHTML = `<div class="title">${sel.length} selected</div><div class="multi">${Object.entries(groups).map(([t, list]) =>
        `<button class="unit-chip" data-type="${t}">${(UNITS[t] || BUILDINGS[t]).icon}<b>${list.length}</b></button>`).join('')}</div>`;
      info.querySelectorAll('.unit-chip').forEach((b) => { b.onclick = () => this.select(groups[b.dataset.type]); });
      return;
    }
    const e = sel[0];
    if (e.entity === 'node') {
      const names = { tree: 'Tree', berries: 'Berry Bush', stone: 'Stone Deposit', gold: 'Gold Mine' };
      info.innerHTML = `<div class="title">${names[e.kind]}</div><div>${RES_ICON[e.res]} ${Math.ceil(e.amount)} ${e.res} remaining</div>`;
      return;
    }
    const owner = g.players[e.owner];
    const hpPct = Math.round((e.hp / e.maxHp) * 100);
    const title = e.def.worker ? `${e.def.name} (${e.female ? 'woman' : 'man'})` : e.def.name;
    let html = `<div class="title">${e.def.icon} ${title}${e.owner !== this.player ? ` <span class="enemy" style="color:${owner.color}">(${owner.name || owner.empire.name})</span>` : ''}</div>
      <div class="hpbar"><i style="width:${hpPct}%"></i><span>${Math.ceil(e.hp)} / ${e.maxHp}</span></div>`;
    if (e.entity === 'unit') {
      html += `<div class="stats">⚔️ ${e.def.atk} &nbsp; 🛡️ ${e.def.armor}${e.def.range > 1 ? ` &nbsp; 🎯 ${e.def.range}` : ''} &nbsp; 👁️ ${e.def.sight}</div>`;
      if (e.def.worker && e.owner === this.player) {
        const o = e.order;
        const what = !o ? 'Idle' : o.type === 'build' ? 'Building' : o.type === 'gather' ? `Gathering ${o.target && o.target.res ? o.target.res : 'food'}` :
          o.type === 'return' ? 'Returning resources' : 'Moving';
        html += `<div class="status">${what}${e.carry.amount > 0 ? ` · carrying ${Math.floor(e.carry.amount)} ${e.carry.res}` : ''}</div>`;
      }
      html += `<div class="desc">${e.def.desc}</div>`;
    } else {
      if (!e.complete) html += `<div class="status">Under construction: ${Math.floor(e.progress * 100)}%</div>`;
      else if (e.owner === this.player) {
        if (e.queue.length) {
          html += `<div class="queue">${e.queue.map((q, i) => `<button class="q" data-i="${i}" title="Click to cancel">${UNITS[q.type].icon}${i === 0 ? `<i style="width:${Math.floor(q.progress * 100)}%"></i>` : ''}</button>`).join('')}</div>`;
          if (e.blocked) html += `<div class="warn">Need more houses!</div>`;
        } else if (e.def.trains) html += `<div class="status">Right-click to set a rally point.</div>`;
        if (e.def.pop) html += `<div class="status">Supports ${e.def.pop} population.</div>`;
        if (e.def.dropoff) html += `<div class="status">Accepts ${e.def.dropoff.map((r) => RES_ICON[r]).join(' ')}</div>`;
        if (e.def.farm) html += `<div class="status">${e.worker ? 'Being farmed' : 'Needs a farmer'}</div>`;
      }
      html += `<div class="desc">${e.def.desc}</div>`;
    }
    info.innerHTML = html;
    info.querySelectorAll('.q').forEach((b) => { b.onclick = () => this.cmd.cancel(e, +b.dataset.i); });
  }

  drawMinimap() {
    const mm = $('minimap');
    this.r.drawMinimap(mm.getContext('2d'), mm.width, this.player);
  }
}
