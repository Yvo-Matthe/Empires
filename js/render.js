'use strict';
// Canvas renderer. All art is drawn procedurally, so the game ships without image assets.

const SKIN = '#e8b98f';

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => clamp(Math.round(c + amt * 255), 0, 255);
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

class Renderer {
  constructor(canvas, game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = game;
    this.cam = { x: 0, y: 0, zoom: 1 };
    this.rng = mulberry32(game.seed + 99);
    this.tileNoise = new Float32Array(MAP_W * MAP_H).map(() => this.rng());
    this.markers = []; // command feedback
    this.pings = []; // minimap alerts
    this.buildTerrain();
    this.fog = document.createElement('canvas');
    this.fog.width = MAP_W;
    this.fog.height = MAP_H;
    this.fogCtx = this.fog.getContext('2d');
    this.fogImg = this.fogCtx.createImageData(MAP_W, MAP_H);
    this.miniBase = null;
  }

  get viewW() { return this.canvas.width / this.cam.zoom; }
  get viewH() { return this.canvas.height / this.cam.zoom; }

  centerOn(x, y) {
    this.cam.x = x - this.viewW / 2;
    this.cam.y = y - this.viewH / 2;
    this.clampCam();
  }
  clampCam() {
    this.cam.x = clamp(this.cam.x, -64, MAP_W * TILE - this.viewW + 64);
    this.cam.y = clamp(this.cam.y, -64, MAP_H * TILE - this.viewH + 64);
  }
  toWorld(sx, sy) { return { x: this.cam.x + sx / this.cam.zoom, y: this.cam.y + sy / this.cam.zoom }; }

  // ---------- terrain ----------
  buildTerrain() {
    this.terrain = document.createElement('canvas');
    this.terrain.width = MAP_W * TILE;
    this.terrain.height = MAP_H * TILE;
    this.tctx = this.terrain.getContext('2d');
    for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) this.drawGround(x, y);
    for (const n of this.game.map.nodes) this.drawNode(this.tctx, n);
  }

  drawGround(tx, ty) {
    const c = this.tctx, map = this.game.map, i = ty * MAP_W + tx;
    const nz = this.tileNoise[i];
    const px = tx * TILE, py = ty * TILE;
    const t = map.terrain[i];
    if (t === T_WATER) {
      c.fillStyle = `hsl(205, 55%, ${32 + nz * 5}%)`;
      c.fillRect(px, py, TILE, TILE);
      c.strokeStyle = 'rgba(255,255,255,0.12)';
      c.beginPath();
      c.moveTo(px + 4 + nz * 8, py + 10 + nz * 10);
      c.quadraticCurveTo(px + 12 + nz * 6, py + 6 + nz * 10, px + 20 + nz * 6, py + 10 + nz * 10);
      c.stroke();
      // Sandy shore on land-facing edges.
      c.fillStyle = '#c9b47a';
      const land = (x, y) => x >= 0 && y >= 0 && x < MAP_W && y < MAP_H && map.terrain[y * MAP_W + x] !== T_WATER;
      if (land(tx, ty - 1)) c.fillRect(px, py, TILE, 4);
      if (land(tx, ty + 1)) c.fillRect(px, py + TILE - 4, TILE, 4);
      if (land(tx - 1, ty)) c.fillRect(px, py, 4, TILE);
      if (land(tx + 1, ty)) c.fillRect(px + TILE - 4, py, 4, TILE);
      return;
    }
    if (t === T_DIRT) c.fillStyle = `hsl(${38 + nz * 6}, 32%, ${36 + nz * 5}%)`;
    else c.fillStyle = `hsl(${92 + nz * 14}, ${38 + nz * 8}%, ${33 + nz * 5}%)`;
    c.fillRect(px, py, TILE, TILE);
    // Grass tufts / pebbles
    const r = mulberry32(i * 7 + 3);
    c.fillStyle = t === T_DIRT ? 'rgba(80,60,30,0.35)' : 'rgba(30,60,20,0.35)';
    for (let k = 0; k < 4; k++) c.fillRect(px + r() * 30, py + r() * 30, 2, 2);
    if (t !== T_DIRT && r() < 0.15) {
      c.fillStyle = ['#f4e04d', '#ffffff', '#c86dd7'][Math.floor(r() * 3)];
      c.fillRect(px + 4 + r() * 24, py + 4 + r() * 24, 2, 2);
    }
  }

  drawNode(c, n) {
    const px = n.tx * TILE, py = n.ty * TILE, v = n.variant;
    c.save();
    if (n.kind === 'tree') {
      c.fillStyle = 'rgba(0,0,0,0.25)';
      c.beginPath(); c.ellipse(px + 17, py + 25, 12, 5, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#5b3a1e';
      c.fillRect(px + 14, py + 18, 4, 10);
      if (v < 0.45) {
        // pine
        const g = `hsl(${130 + v * 20}, 40%, ${20 + v * 10}%)`;
        c.fillStyle = g;
        for (let k = 0; k < 3; k++) {
          c.beginPath();
          c.moveTo(px + 16, py + 1 + k * 6);
          c.lineTo(px + 4 + k, py + 16 + k * 4);
          c.lineTo(px + 28 - k, py + 16 + k * 4);
          c.closePath(); c.fill();
        }
      } else {
        const g = `hsl(${95 + v * 30}, 42%, ${24 + v * 8}%)`;
        c.fillStyle = g;
        for (const [ox, oy, r] of [[10, 13, 8], [22, 12, 8], [16, 7, 9], [16, 16, 9]]) {
          c.beginPath(); c.arc(px + ox, py + oy, r, 0, Math.PI * 2); c.fill();
        }
        c.fillStyle = 'rgba(255,255,255,0.08)';
        c.beginPath(); c.arc(px + 13, py + 7, 5, 0, Math.PI * 2); c.fill();
      }
    } else if (n.kind === 'berries') {
      c.fillStyle = '#2f6b2a';
      c.beginPath(); c.arc(px + 16, py + 17, 11, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#3d8a35';
      c.beginPath(); c.arc(px + 13, py + 14, 7, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#c0233a';
      const r = mulberry32(n.tx * 31 + n.ty);
      for (let k = 0; k < 9; k++) { c.beginPath(); c.arc(px + 8 + r() * 16, py + 9 + r() * 16, 2, 0, Math.PI * 2); c.fill(); }
    } else {
      const base = n.kind === 'gold' ? '#8a7f6a' : '#8d9298';
      const r = mulberry32(n.tx * 17 + n.ty * 3);
      for (let k = 0; k < 3; k++) {
        const cx = px + 8 + r() * 16, cy = py + 10 + r() * 14, rad = 6 + r() * 5;
        c.fillStyle = 'rgba(0,0,0,0.25)';
        c.beginPath(); c.ellipse(cx + 2, cy + 3, rad, rad * 0.6, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = base;
        c.beginPath();
        c.moveTo(cx - rad, cy + 2); c.lineTo(cx - rad * 0.4, cy - rad); c.lineTo(cx + rad * 0.6, cy - rad * 0.8);
        c.lineTo(cx + rad, cy + 2); c.lineTo(cx, cy + rad * 0.6); c.closePath(); c.fill();
        c.fillStyle = 'rgba(255,255,255,0.18)';
        c.fillRect(cx - rad * 0.3, cy - rad * 0.6, rad * 0.5, 2);
        if (n.kind === 'gold') {
          c.fillStyle = '#ffd34d';
          for (let s = 0; s < 3; s++) c.fillRect(cx - rad * 0.6 + r() * rad, cy - rad * 0.5 + r() * rad * 0.8, 3, 2);
        }
      }
    }
    c.restore();
  }

  refreshDepleted() {
    const d = this.game.depleted;
    if (!d.length) return;
    for (const n of d) {
      this.drawGround(n.tx, n.ty);
      // Stump
      if (n.kind === 'tree') {
        this.tctx.fillStyle = '#6b4a2b';
        this.tctx.beginPath(); this.tctx.ellipse(n.tx * TILE + 16, n.ty * TILE + 20, 4, 3, 0, 0, Math.PI * 2); this.tctx.fill();
      }
      if (this.miniBase) this.setMiniPixel(n.tx, n.ty);
    }
    d.length = 0;
  }

  // ---------- frame ----------
  render(ui) {
    const c = this.ctx, g = this.game, cam = this.cam;
    this.refreshDepleted();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#0b0d10';
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    c.setTransform(cam.zoom, 0, 0, cam.zoom, -cam.x * cam.zoom, -cam.y * cam.zoom);
    c.imageSmoothingEnabled = false;
    const vx0 = Math.max(0, cam.x), vy0 = Math.max(0, cam.y);
    const vx1 = Math.min(MAP_W * TILE, cam.x + this.viewW), vy1 = Math.min(MAP_H * TILE, cam.y + this.viewH);
    c.drawImage(this.terrain, vx0, vy0, vx1 - vx0, vy1 - vy0, vx0, vy0, vx1 - vx0, vy1 - vy0);

    const inView = (e, pad) => e.x > cam.x - pad && e.x < cam.x + this.viewW + pad && e.y > cam.y - pad && e.y < cam.y + this.viewH + pad;
    const shown = (e) => g.isAlly(e.owner, ui.player) || (e.entity === 'building' ? g.explored[Math.floor(e.y / TILE) * MAP_W + Math.floor(e.x / TILE)] : g.isVisible(e));
    const sel = ui.selection;

    // Ground-level things first.
    const list = [];
    for (const e of g.entities) {
      if (!inView(e, 160) || !shown(e)) continue;
      if (e.entity === 'building' && e.def.walkable) this.drawBuilding(c, e);
      else list.push(e);
    }
    // Selection rings under units.
    for (const e of sel) if (!e.dead) this.drawSelection(c, e, e.owner === ui.player ? '#7CFC6A' : e.owner === undefined ? '#ffe680' : g.isAlly(e.owner, ui.player) ? '#6ab0ff' : '#ff5a5a');
    if (ui.hover && !sel.includes(ui.hover) && !ui.hover.dead) this.drawSelection(c, ui.hover, 'rgba(255,255,255,0.5)');

    list.sort((a, b) => (a.entity === 'building' ? a.y1 - 4 : a.y) - (b.entity === 'building' ? b.y1 - 4 : b.y));
    for (const e of list) {
      if (e.entity === 'building') this.drawBuilding(c, e);
      else this.drawUnit(c, e);
    }

    // Projectiles (arrows)
    c.strokeStyle = '#2b1d0e';
    c.lineWidth = 1.5;
    for (const p of g.projectiles) {
      const t = p.target;
      const a = Math.atan2(t.y - p.y, t.x - p.x);
      c.beginPath();
      c.moveTo(p.x - Math.cos(a) * 7, p.y - Math.sin(a) * 7);
      c.lineTo(p.x + Math.cos(a) * 4, p.y + Math.sin(a) * 4);
      c.stroke();
    }

    // Health bars
    for (const e of list) {
      if (e.entity === 'node') continue;
      const recent = g.time - e.lastHit < 3;
      if (sel.includes(e) || recent || (e.entity === 'building' && e.hp < e.maxHp && e.complete) || ui.hover === e) this.drawHp(c, e);
    }

    // Rally point
    for (const e of sel) {
      if (e.entity === 'building' && e.rally && e.owner === ui.player) {
        c.strokeStyle = 'rgba(255,255,255,0.35)';
        c.setLineDash([4, 4]);
        c.beginPath(); c.moveTo(e.x, e.y); c.lineTo(e.rally.x, e.rally.y); c.stroke();
        c.setLineDash([]);
        this.drawFlag(c, e.rally.x, e.rally.y, g.players[e.owner].color);
      }
    }

    // Command markers
    const now = performance.now();
    this.markers = this.markers.filter((m) => now - m.t < 600);
    for (const m of this.markers) {
      const k = (now - m.t) / 600;
      c.strokeStyle = m.color;
      c.globalAlpha = 1 - k;
      c.lineWidth = 2;
      c.beginPath(); c.ellipse(m.x, m.y, 4 + k * 10, (4 + k * 10) * 0.6, 0, 0, Math.PI * 2); c.stroke();
      c.globalAlpha = 1;
    }

    this.drawFog(c);

    // Placement ghost
    if (ui.placing && ui.mouseWorld) {
      const def = BUILDINGS[ui.placing];
      const tx = Math.floor(ui.mouseWorld.x / TILE - def.size / 2 + 0.5), ty = Math.floor(ui.mouseWorld.y / TILE - def.size / 2 + 0.5);
      const ok = g.canPlace(ui.player, ui.placing, tx, ty);
      const ghost = { entity: 'building', type: ui.placing, def, owner: ui.player, tx, ty, size: def.size,
        x: (tx + def.size / 2) * TILE, y: (ty + def.size / 2) * TILE, x0: tx * TILE, y0: ty * TILE,
        x1: (tx + def.size) * TILE, y1: (ty + def.size) * TILE, complete: true, progress: 1, hp: 1, maxHp: 1, queue: [] };
      c.globalAlpha = 0.6;
      this.drawBuilding(c, ghost);
      c.globalAlpha = 1;
      c.fillStyle = ok ? 'rgba(80,255,80,0.18)' : 'rgba(255,40,40,0.35)';
      c.fillRect(ghost.x0, ghost.y0, def.size * TILE, def.size * TILE);
      ui.placeTile = { tx, ty, ok };
    }

    // Drag box (screen space)
    c.setTransform(1, 0, 0, 1, 0, 0);
    if (ui.drag && ui.drag.active) {
      const { sx, sy, ex, ey } = ui.drag;
      c.strokeStyle = '#7CFC6A';
      c.lineWidth = 1;
      c.fillStyle = 'rgba(124,252,106,0.08)';
      c.fillRect(Math.min(sx, ex), Math.min(sy, ey), Math.abs(ex - sx), Math.abs(ey - sy));
      c.strokeRect(Math.min(sx, ex) + 0.5, Math.min(sy, ey) + 0.5, Math.abs(ex - sx), Math.abs(ey - sy));
    }
  }

  drawFog(c) {
    const g = this.game, d = this.fogImg.data;
    for (let i = 0; i < MAP_W * MAP_H; i++) {
      d[i * 4 + 3] = g.visible[i] ? 0 : g.explored[i] ? 120 : 255;
    }
    this.fogCtx.putImageData(this.fogImg, 0, 0);
    c.imageSmoothingEnabled = true;
    c.drawImage(this.fog, -0.5 * TILE, -0.5 * TILE, MAP_W * TILE + TILE, MAP_H * TILE + TILE);
    c.imageSmoothingEnabled = false;
  }

  drawSelection(c, e, color) {
    c.strokeStyle = color;
    c.lineWidth = 1.5;
    if (e.entity === 'unit') {
      c.beginPath(); c.ellipse(e.x, e.y + 6, e.radius + 4, (e.radius + 4) * 0.5, 0, 0, Math.PI * 2); c.stroke();
    } else if (e.entity === 'building') {
      c.strokeRect(e.x0 + 1, e.y0 + 1, e.x1 - e.x0 - 2, e.y1 - e.y0 - 2);
    } else {
      c.strokeRect(e.tx * TILE + 1, e.ty * TILE + 1, TILE - 2, TILE - 2);
    }
  }

  drawHp(c, e) {
    const w = e.entity === 'building' ? Math.min(80, e.size * 18) : 22;
    const top = e.entity === 'building' ? e.y0 - 6 : e.y - (e.def.tags.includes('cavalry') ? 30 : 24);
    const k = clamp(e.hp / e.maxHp, 0, 1);
    c.fillStyle = 'rgba(0,0,0,0.6)';
    c.fillRect(e.x - w / 2 - 1, top - 1, w + 2, 5);
    c.fillStyle = k > 0.6 ? '#4cd137' : k > 0.3 ? '#fbc531' : '#e84118';
    c.fillRect(e.x - w / 2, top, w * k, 3);
  }

  drawFlag(c, x, y, color) {
    c.strokeStyle = '#3b2a1a';
    c.lineWidth = 2;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x, y - 22); c.stroke();
    c.fillStyle = color;
    const wave = Math.sin(performance.now() / 200) * 2;
    c.beginPath(); c.moveTo(x, y - 22); c.lineTo(x + 12, y - 18 + wave); c.lineTo(x, y - 13); c.closePath(); c.fill();
  }

  // ---------- buildings ----------
  drawBuilding(c, b) {
    const p = this.game.players[b.owner];
    const col = p.color, trim = p.trim;
    const x = b.x0, y = b.y0, w = b.x1 - b.x0, h = b.y1 - b.y0;
    if (!b.complete) {
      // Foundation, then the building rising as it is constructed.
      c.fillStyle = '#7a6448';
      c.fillRect(x + 2, y + 2, w - 4, h - 4);
      c.strokeStyle = '#4e3d28';
      c.lineWidth = 1;
      for (let k = 6; k < w; k += 8) { c.beginPath(); c.moveTo(x + k, y + 2); c.lineTo(x + k, y + h - 2); c.stroke(); }
      if (b.progress > 0.02) {
        c.save();
        const hh = (h + 30) * b.progress;
        c.beginPath(); c.rect(x - 20, y + h - hh, w + 40, hh); c.clip();
        c.globalAlpha *= 0.85;
        this.drawBuildingArt(c, b, x, y, w, h, col, trim);
        c.restore();
      }
      // Scaffolding
      c.strokeStyle = '#a07c4a';
      c.lineWidth = 2;
      c.strokeRect(x + 3, y + 3, w - 6, h - 6);
      c.beginPath(); c.moveTo(x + 3, y + 3); c.lineTo(x + w - 3, y + h - 3); c.moveTo(x + w - 3, y + 3); c.lineTo(x + 3, y + h - 3); c.stroke();
      return;
    }
    this.drawBuildingArt(c, b, x, y, w, h, col, trim);
  }

  drawBuildingArt(c, b, x, y, w, h, col, trim) {
    const t = performance.now() / 1000;
    const shadow = () => { c.fillStyle = 'rgba(0,0,0,0.28)'; c.fillRect(x + 6, y + 8, w - 4, h - 6); };
    const walls = (wx, wy, ww, wh, color) => {
      c.fillStyle = color; c.fillRect(wx, wy, ww, wh);
      c.fillStyle = 'rgba(0,0,0,0.15)'; c.fillRect(wx, wy + wh - 4, ww, 4);
    };
    const roof = (rx, ry, rw, rh, color) => {
      c.fillStyle = color;
      c.beginPath(); c.moveTo(rx - 3, ry + rh); c.lineTo(rx + rw * 0.18, ry); c.lineTo(rx + rw * 0.82, ry); c.lineTo(rx + rw + 3, ry + rh); c.closePath(); c.fill();
      c.fillStyle = 'rgba(0,0,0,0.18)';
      c.beginPath(); c.moveTo(rx + rw / 2, ry); c.lineTo(rx + rw * 0.82, ry); c.lineTo(rx + rw + 3, ry + rh); c.lineTo(rx + rw / 2, ry + rh); c.closePath(); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.2)'; c.lineWidth = 1;
      for (let k = 1; k < 4; k++) { c.beginPath(); c.moveTo(rx, ry + (rh * k) / 4); c.lineTo(rx + rw, ry + (rh * k) / 4); c.stroke(); }
    };
    const door = (dx, dy, dw, dh) => {
      c.fillStyle = '#3a2614';
      c.beginPath(); c.moveTo(dx, dy + dh); c.lineTo(dx, dy + dw / 2); c.arc(dx + dw / 2, dy + dw / 2, dw / 2, Math.PI, 0); c.lineTo(dx + dw, dy + dh); c.closePath(); c.fill();
    };
    const banner = (bx, by, len = 18) => {
      c.strokeStyle = '#2b2b2b'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(bx, by); c.lineTo(bx, by - len); c.stroke();
      const wv = Math.sin(t * 4 + bx) * 2;
      c.fillStyle = col;
      c.beginPath(); c.moveTo(bx, by - len); c.lineTo(bx + 13, by - len + 3 + wv); c.lineTo(bx, by - len + 8); c.closePath(); c.fill();
      c.fillStyle = trim; c.fillRect(bx + 2, by - len + 3, 3, 2);
    };
    const crenel = (cx, cy, cw, color) => {
      c.fillStyle = color;
      for (let k = 0; k < cw; k += 6) c.fillRect(cx + k, cy - 4, 4, 4);
    };
    const stone = '#a9a39a', stoneD = '#8a847a', wood = '#c8a26b', woodD = '#8a6a3e';

    switch (b.type) {
      case 'farm': {
        c.fillStyle = '#6b4f2c'; c.fillRect(x + 2, y + 2, w - 4, h - 4);
        const grow = (Math.sin(this.game.time / 20 + b.id) + 1) / 2;
        c.fillStyle = `hsl(${100 - grow * 55}, 55%, ${35 + grow * 12}%)`;
        for (let k = 6; k < h - 4; k += 6) c.fillRect(x + 5, y + k, w - 10, 3);
        c.strokeStyle = '#9b7a4b'; c.lineWidth = 2; c.strokeRect(x + 2, y + 2, w - 4, h - 4);
        c.fillStyle = col; c.fillRect(x + 2, y + 2, 5, 5);
        break;
      }
      case 'house':
        shadow();
        walls(x + 6, y + 22, w - 12, h - 26, '#d9c8a0');
        c.fillStyle = woodD; c.fillRect(x + 6, y + 22, 3, h - 26); c.fillRect(x + w - 9, y + 22, 3, h - 26);
        roof(x + 4, y + 4, w - 8, 20, '#8b4a2b');
        door(x + w / 2 - 5, y + h - 16, 10, 12);
        c.fillStyle = col; c.fillRect(x + w / 2 - 6, y + 4, 12, 3);
        break;
      case 'mill': {
        shadow();
        walls(x + 10, y + 18, w - 20, h - 22, '#d9c8a0');
        roof(x + 8, y + 8, w - 16, 12, '#8b4a2b');
        door(x + w / 2 - 4, y + h - 14, 8, 10);
        const cx = x + w / 2, cy = y + 14, a = t * 1.2;
        c.strokeStyle = '#5a3e22'; c.lineWidth = 3;
        for (let k = 0; k < 4; k++) {
          const aa = a + (k * Math.PI) / 2;
          c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(aa) * 22, cy + Math.sin(aa) * 22); c.stroke();
          c.fillStyle = 'rgba(240,230,210,0.85)';
          c.save(); c.translate(cx, cy); c.rotate(aa); c.fillRect(8, -1, 14, 6); c.restore();
        }
        c.fillStyle = col; c.beginPath(); c.arc(cx, cy, 3, 0, Math.PI * 2); c.fill();
        break;
      }
      case 'lumbercamp':
        shadow();
        walls(x + 4, y + 16, w - 8, h - 20, wood);
        roof(x + 2, y + 4, w - 4, 14, woodD);
        c.fillStyle = '#7a5230';
        for (let k = 0; k < 3; k++) { c.beginPath(); c.ellipse(x + 14 + k * 9, y + h - 8, 5, 4, 0, 0, Math.PI * 2); c.fill(); }
        c.fillStyle = '#c49a68';
        for (let k = 0; k < 3; k++) { c.beginPath(); c.ellipse(x + 14 + k * 9, y + h - 8, 2.5, 2, 0, 0, Math.PI * 2); c.fill(); }
        banner(x + w - 6, y + 14);
        break;
      case 'miningcamp':
        shadow();
        walls(x + 4, y + 16, w - 8, h - 20, stoneD);
        roof(x + 2, y + 4, w - 4, 14, woodD);
        c.fillStyle = '#5c4026'; c.fillRect(x + 10, y + h - 16, 20, 10);
        c.fillStyle = '#ffd34d'; c.fillRect(x + 12, y + h - 19, 6, 4);
        c.fillStyle = '#9aa0a6'; c.fillRect(x + 20, y + h - 19, 7, 4);
        c.fillStyle = '#222'; c.beginPath(); c.arc(x + 13, y + h - 5, 3, 0, Math.PI * 2); c.arc(x + 27, y + h - 5, 3, 0, Math.PI * 2); c.fill();
        banner(x + w - 6, y + 14);
        break;
      case 'barracks':
      case 'archeryrange':
      case 'stable': {
        shadow();
        const wallC = b.type === 'stable' ? wood : '#cbbd9c';
        walls(x + 6, y + 30, w - 12, h - 34, wallC);
        c.fillStyle = woodD;
        for (let k = x + 6; k < x + w - 6; k += 16) c.fillRect(k, y + 30, 3, h - 34);
        roof(x + 4, y + 8, w - 8, 24, b.type === 'stable' ? '#7a5a33' : '#6d3b2a');
        c.fillStyle = col; c.fillRect(x + 10, y + 30, w - 20, 4);
        door(x + w / 2 - 8, y + h - 22, 16, 18);
        if (b.type === 'barracks') {
          c.strokeStyle = '#ccc'; c.lineWidth = 2;
          c.beginPath(); c.moveTo(x + 14, y + h - 6); c.lineTo(x + 20, y + h - 24); c.moveTo(x + 22, y + h - 6); c.lineTo(x + 16, y + h - 24); c.stroke();
        } else if (b.type === 'archeryrange') {
          for (const [cx, cy] of [[x + 16, y + h - 14], [x + w - 16, y + h - 14]]) {
            c.fillStyle = '#f5f0e0'; c.beginPath(); c.arc(cx, cy, 7, 0, Math.PI * 2); c.fill();
            c.fillStyle = '#c0392b'; c.beginPath(); c.arc(cx, cy, 4.5, 0, Math.PI * 2); c.fill();
            c.fillStyle = '#f5f0e0'; c.beginPath(); c.arc(cx, cy, 2, 0, Math.PI * 2); c.fill();
          }
        } else {
          c.fillStyle = '#e1c25a';
          c.fillRect(x + 8, y + h - 14, 14, 9); c.fillRect(x + w - 22, y + h - 14, 14, 9);
          c.strokeStyle = '#b8962e'; c.lineWidth = 1;
          c.strokeRect(x + 8, y + h - 14, 14, 9); c.strokeRect(x + w - 22, y + h - 14, 14, 9);
        }
        banner(x + w - 10, y + 12, 20);
        break;
      }
      case 'tower': {
        c.fillStyle = 'rgba(0,0,0,0.28)'; c.beginPath(); c.ellipse(x + w / 2 + 6, y + h - 6, w / 2, 8, 0, 0, Math.PI * 2); c.fill();
        const tx = x + 14, tw = w - 28;
        walls(tx, y - 14, tw, h + 8, stone);
        c.fillStyle = stoneD;
        for (let k = 0; k < 6; k++) c.fillRect(tx + (k % 2) * 10 + 4, y - 8 + k * 12, 10, 3);
        crenel(tx - 3, y - 14, tw + 6, stone);
        c.fillStyle = '#222'; c.fillRect(x + w / 2 - 2, y + 4, 4, 9);
        c.fillStyle = col;
        c.beginPath(); c.moveTo(tx - 3, y - 18); c.lineTo(x + w / 2, y - 38); c.lineTo(tx + tw + 3, y - 18); c.closePath(); c.fill();
        banner(x + w / 2, y - 36, 12);
        break;
      }
      case 'towncenter': {
        shadow();
        walls(x + 8, y + 40, w - 16, h - 46, stone);
        c.fillStyle = stoneD;
        for (let k = 0; k < 8; k++) c.fillRect(x + 12 + (k % 4) * 26, y + 48 + Math.floor(k / 4) * 22, 16, 3);
        roof(x + 4, y + 18, w - 8, 26, shade(col, -0.15));
        // Central keep
        walls(x + w / 2 - 20, y + 6, 40, 40, '#bdb6ab');
        c.fillStyle = col;
        c.beginPath(); c.moveTo(x + w / 2 - 24, y + 8); c.lineTo(x + w / 2, y - 20); c.lineTo(x + w / 2 + 24, y + 8); c.closePath(); c.fill();
        c.fillStyle = 'rgba(0,0,0,0.18)';
        c.beginPath(); c.moveTo(x + w / 2, y - 20); c.lineTo(x + w / 2 + 24, y + 8); c.lineTo(x + w / 2, y + 8); c.closePath(); c.fill();
        c.fillStyle = '#2a1e12'; c.fillRect(x + w / 2 - 4, y + 20, 8, 10);
        door(x + w / 2 - 10, y + h - 26, 20, 22);
        c.fillStyle = trim; c.fillRect(x + w / 2 - 14, y + 40, 28, 3);
        banner(x + w / 2, y - 18, 14);
        banner(x + 12, y + 40); banner(x + w - 12, y + 40);
        break;
      }
      case 'castle': {
        shadow();
        walls(x + 4, y + 22, w - 8, h - 26, stone);
        crenel(x + 4, y + 22, w - 8, stone);
        c.fillStyle = stoneD;
        for (let k = 0; k < 12; k++) c.fillRect(x + 12 + (k % 4) * 26, y + 34 + Math.floor(k / 4) * 22, 14, 3);
        // Keep
        walls(x + w / 2 - 26, y - 6, 52, 52, '#b9b2a6');
        crenel(x + w / 2 - 26, y - 6, 52, '#b9b2a6');
        c.fillStyle = '#222'; c.fillRect(x + w / 2 - 3, y + 8, 6, 12);
        // Corner towers
        for (const [cx, cy] of [[x + 2, y + 10], [x + w - 22, y + 10], [x + 2, y + h - 30], [x + w - 22, y + h - 30]]) {
          walls(cx, cy, 20, 30, '#b0a99e');
          c.fillStyle = col;
          c.beginPath(); c.moveTo(cx - 2, cy); c.lineTo(cx + 10, cy - 16); c.lineTo(cx + 22, cy); c.closePath(); c.fill();
        }
        c.fillStyle = '#3a2614'; c.beginPath(); c.moveTo(x + w / 2 - 12, y + h - 4); c.lineTo(x + w / 2 - 12, y + h - 18); c.arc(x + w / 2, y + h - 18, 12, Math.PI, 0); c.lineTo(x + w / 2 + 12, y + h - 4); c.fill();
        c.strokeStyle = '#777'; c.lineWidth = 1;
        for (let k = -9; k <= 9; k += 4) { c.beginPath(); c.moveTo(x + w / 2 + k, y + h - 26); c.lineTo(x + w / 2 + k, y + h - 4); c.stroke(); }
        // Hanging banners in empire colors
        for (const bx of [x + w / 2 - 22, x + w / 2 + 14]) {
          c.fillStyle = col; c.fillRect(bx, y + 6, 8, 22);
          c.fillStyle = trim; c.fillRect(bx + 2, y + 12, 4, 4);
        }
        banner(x + w / 2, y - 10, 20);
        break;
      }
    }
  }

  // ---------- units ----------
  drawUnit(c, u) {
    const p = this.game.players[u.owner];
    const col = p.color, trim = p.trim;
    const cav = u.def.tags.includes('cavalry');
    const bob = u.moving ? Math.sin(u.anim * 14) * 1.5 : 0;
    const swing = u.attackAnim > 0 ? Math.sin((u.attackAnim / 0.25) * Math.PI) : (u.working ? Math.abs(Math.sin(u.anim * 6)) : 0);
    c.save();
    c.translate(Math.round(u.x), Math.round(u.y));
    c.fillStyle = 'rgba(0,0,0,0.3)';
    c.beginPath(); c.ellipse(0, 7, cav ? 13 : 7, cav ? 4 : 3, 0, 0, Math.PI * 2); c.fill();
    c.scale(u.facing, 1);

    if (cav) {
      // Horse
      const leg = u.moving ? Math.sin(u.anim * 16) * 4 : 0;
      const horse = u.type === 'paladin' ? '#ece6da' : '#6b4226';
      c.strokeStyle = shade(horse === '#6b4226' ? horse : '#a8a090', -0.1);
      c.lineWidth = 2.5;
      c.beginPath();
      c.moveTo(-7, 0); c.lineTo(-7 + leg, 7); c.moveTo(-3, 0); c.lineTo(-3 - leg, 7);
      c.moveTo(5, 0); c.lineTo(5 + leg, 7); c.moveTo(8, 0); c.lineTo(8 - leg, 7);
      c.stroke();
      c.fillStyle = horse;
      c.beginPath(); c.ellipse(0, -3 + bob * 0.5, 11, 5.5, 0, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.moveTo(7, -6); c.lineTo(14, -13); c.lineTo(17, -11); c.lineTo(11, -3); c.closePath(); c.fill();
      c.fillStyle = '#2a1a10'; c.fillRect(-12, -6, 2, 7);
      // Caparison in player colors
      c.fillStyle = col;
      c.beginPath(); c.moveTo(-9, -6); c.lineTo(7, -6); c.lineTo(8, 1); c.lineTo(-10, 1); c.closePath(); c.fill();
      c.fillStyle = trim; c.fillRect(-9, 0, 17, 1.5);
      c.translate(0, -10 + bob * 0.5);
    } else {
      // Legs
      const leg = u.moving ? Math.sin(u.anim * 14) * 3 : 0;
      c.strokeStyle = '#3a2c20'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(-2, 1); c.lineTo(-2 + leg, 7); c.moveTo(2, 1); c.lineTo(2 - leg, 7); c.stroke();
      c.translate(0, bob);
    }

    // Body / tabard
    const peasant = u.type === 'peasant';
    c.fillStyle = peasant ? '#9c7b52' : (u.def.armor >= 2 ? '#9aa1a8' : '#7a6a55');
    c.beginPath(); c.roundRect(-5, -11, 10, 12, 3); c.fill();
    c.fillStyle = col;
    if (peasant) c.fillRect(-5, -4, 10, 2.5);
    else { c.beginPath(); c.roundRect(-3.5, -10, 7, 11, 2); c.fill(); c.fillStyle = trim; c.fillRect(-1, -8, 2, 6); }

    // Head
    c.fillStyle = SKIN;
    c.beginPath(); c.arc(0, -14, 3.6, 0, Math.PI * 2); c.fill();
    if (peasant) {
      c.fillStyle = '#d8c070';
      c.beginPath(); c.ellipse(0, -16.5, 6, 1.8, 0, 0, Math.PI * 2); c.fill();
      c.fillRect(-3, -19, 6, 3);
    } else if (u.type === 'archer' || u.type === 'longbowman') {
      c.fillStyle = u.type === 'longbowman' ? '#2e5d34' : '#5b6b3a';
      c.beginPath(); c.arc(0, -15, 4.2, Math.PI, 0); c.lineTo(4, -12); c.lineTo(-4, -12); c.fill();
    } else {
      c.fillStyle = u.type === 'paladin' ? '#e6c25a' : '#8e969e';
      c.beginPath(); c.arc(0, -15, 4.2, Math.PI, 0); c.fill();
      c.fillRect(-4.2, -15, 8.4, 2);
      if (u.type === 'knight' || u.type === 'paladin') {
        c.fillStyle = u.type === 'paladin' ? '#fff' : col;
        c.fillRect(-0.8, -22, 1.6, 4);
      }
    }

    // Weapon / tool
    c.save();
    c.translate(4, -8);
    c.lineCap = 'round';
    switch (u.type) {
      case 'peasant': {
        c.rotate(-0.6 + swing * 1.2);
        const carry = u.carry.res, building = u.order && u.order.type === 'build';
        c.strokeStyle = '#6b4a2b'; c.lineWidth = 1.6;
        c.beginPath(); c.moveTo(0, 2); c.lineTo(0, -9); c.stroke();
        if (building) { c.fillStyle = '#777'; c.fillRect(-3, -11, 6, 3); }
        else if (u.order && u.order.type === 'gather' && u.order.target && u.order.target.res && u.order.target.res !== 'food') {
          c.strokeStyle = '#999'; c.lineWidth = 2;
          c.beginPath();
          if (u.order.target.res === 'wood') { c.moveTo(0, -9); c.lineTo(3.5, -7); }
          else { c.moveTo(-4, -8); c.quadraticCurveTo(0, -11, 4, -8); }
          c.stroke();
        }
        c.restore();
        if (u.carry.amount > 0) {
          const cc = { food: '#d84a3a', wood: '#8a5a2b', stone: '#a0a4a8', gold: '#f1c40f' }[carry];
          c.fillStyle = cc;
          c.beginPath(); c.arc(-5, -8, 3 + (u.carry.amount / CARRY_CAP) * 1.5, 0, Math.PI * 2); c.fill();
        }
        break;
      }
      case 'spearman':
        c.rotate(-0.15 + swing * 0.9);
        c.strokeStyle = '#7a5530'; c.lineWidth = 1.6;
        c.beginPath(); c.moveTo(-2, 8); c.lineTo(4, -18); c.stroke();
        c.fillStyle = '#ccc'; c.beginPath(); c.moveTo(4, -18); c.lineTo(3, -23); c.lineTo(6, -18); c.fill();
        c.restore();
        c.fillStyle = shade(col, -0.2); c.beginPath(); c.arc(-5, -6, 4, 0, Math.PI * 2); c.fill();
        break;
      case 'manatarms':
      case 'paladin':
        c.rotate(-0.8 + swing * 1.8);
        c.strokeStyle = '#ddd'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -13); c.stroke();
        c.strokeStyle = u.type === 'paladin' ? '#e6c25a' : '#6b4a2b';
        c.beginPath(); c.moveTo(-3, -1); c.lineTo(3, -1); c.stroke();
        c.restore();
        c.fillStyle = col;
        c.beginPath(); c.moveTo(-9, -11); c.lineTo(-2, -11); c.lineTo(-2, -4); c.lineTo(-5.5, 0); c.lineTo(-9, -4); c.closePath(); c.fill();
        c.fillStyle = trim; c.fillRect(-6.5, -10, 2, 7);
        break;
      case 'archer':
      case 'longbowman': {
        const big = u.type === 'longbowman' ? 1.4 : 1;
        c.translate(1, 0);
        c.strokeStyle = '#6b4a2b'; c.lineWidth = 1.6;
        c.beginPath(); c.arc(0, -2, 8 * big, -1.2, 1.2); c.stroke();
        c.strokeStyle = 'rgba(240,240,240,0.8)'; c.lineWidth = 0.7;
        const pull = swing * 4;
        c.beginPath(); c.moveTo(Math.cos(-1.2) * 8 * big, -2 + Math.sin(-1.2) * 8 * big); c.lineTo(-pull, -2); c.lineTo(Math.cos(1.2) * 8 * big, -2 + Math.sin(1.2) * 8 * big); c.stroke();
        c.restore();
        c.fillStyle = '#5b3a1e'; c.fillRect(-6, -12, 3, 9);
        break;
      }
      case 'knight':
        c.rotate(0.15 - swing * 0.4);
        c.strokeStyle = '#7a5530'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(-6, 2); c.lineTo(18, -4); c.stroke();
        c.fillStyle = trim; c.beginPath(); c.moveTo(-2, 0); c.lineTo(2, -3); c.lineTo(3, 1); c.fill();
        c.restore();
        c.fillStyle = col; c.beginPath(); c.arc(-5, -6, 4, 0, Math.PI * 2); c.fill();
        break;
      default:
        c.restore();
    }
    c.restore();
  }

  // ---------- minimap ----------
  setMiniPixel(tx, ty) {
    const g = this.game, i = ty * MAP_W + tx, d = this.miniBase.data;
    const n = g.map.nodeAt[i];
    let rgb;
    if (g.map.terrain[i] === T_WATER) rgb = [40, 90, 140];
    else if (n) rgb = { tree: [28, 70, 30], berries: [170, 60, 70], stone: [170, 170, 170], gold: [235, 200, 60] }[n.kind];
    else if (g.map.terrain[i] === T_DIRT) rgb = [110, 96, 64];
    else rgb = [70, 110, 50];
    d.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  }

  drawMinimap(mc, size, player) {
    const g = this.game;
    if (!this.miniBase) {
      this.miniBase = mc.createImageData(MAP_W, MAP_H);
      for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) this.setMiniPixel(x, y);
      this.miniCanvas = document.createElement('canvas');
      this.miniCanvas.width = MAP_W; this.miniCanvas.height = MAP_H;
    }
    const m = this.miniCanvas.getContext('2d');
    m.putImageData(this.miniBase, 0, 0);
    for (const e of g.entities) {
      if (e.owner !== player && !(e.entity === 'building' ? g.explored[Math.floor(e.y / TILE) * MAP_W + Math.floor(e.x / TILE)] : g.isVisible(e))) continue;
      m.fillStyle = g.players[e.owner].color;
      if (e.entity === 'building') m.fillRect(e.tx, e.ty, e.size, e.size);
      else m.fillRect(Math.floor(e.x / TILE), Math.floor(e.y / TILE), 1, 1);
    }
    // Fog
    const fd = m.getImageData(0, 0, MAP_W, MAP_H), d = fd.data;
    for (let i = 0; i < MAP_W * MAP_H; i++) {
      if (g.visible[i]) continue;
      const k = g.explored[i] ? 0.55 : 0;
      d[i * 4] *= k; d[i * 4 + 1] *= k; d[i * 4 + 2] *= k;
    }
    m.putImageData(fd, 0, 0);
    mc.imageSmoothingEnabled = false;
    mc.clearRect(0, 0, size, size);
    mc.drawImage(this.miniCanvas, 0, 0, size, size);
    const s = size / (MAP_W * TILE);
    mc.strokeStyle = '#fff';
    mc.lineWidth = 1;
    mc.strokeRect(this.cam.x * s + 0.5, this.cam.y * s + 0.5, this.viewW * s, this.viewH * s);
    const now = performance.now();
    this.pings = this.pings.filter((pg) => now - pg.t < 3000);
    for (const pg of this.pings) {
      const k = ((now - pg.t) % 1000) / 1000;
      mc.strokeStyle = `rgba(255,60,60,${1 - k})`;
      mc.lineWidth = 2;
      mc.beginPath(); mc.arc(pg.x * s, pg.y * s, 3 + k * 10, 0, Math.PI * 2); mc.stroke();
    }
  }
}
