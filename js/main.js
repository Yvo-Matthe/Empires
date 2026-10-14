'use strict';
// Menus, the game loop, and wiring between simulation, renderer and UI.

const App = {
  session: null, // { game, renderer, ui, mode: 'sp' | 'mp', net, paused }
  empire: 'aldermark',
  net: null,
  lobby: null,
};

function localCommands(game, pid) {
  return {
    smart: (units, x, y, target) => game.cmdSmart(pid, units, x, y, target),
    move: (units, x, y, am) => game.cmdMove(units, x, y, am),
    stop: (units) => game.cmdStop(units),
    place: (type, tx, ty, units) => game.cmdPlace(pid, type, tx, ty, units),
    train: (b, type) => game.cmdTrain(b, type),
    cancel: (b, i) => game.cmdCancel(b, i),
    rally: (b, x, y, target) => game.cmdRally(b, x, y, target),
    del: (e) => game.cmdDelete(e),
  };
}

// ---------- menu ----------
function buildMenu() {
  const cards = $('empire-cards');
  cards.innerHTML = '';
  for (const [key, emp] of Object.entries(EMPIRES)) {
    const u = UNITS[emp.unique];
    const card = document.createElement('button');
    card.className = 'empire-card';
    card.dataset.key = key;
    card.style.setProperty('--pc', emp.color);
    card.style.setProperty('--tc', emp.trim);
    card.innerHTML = `<div class="shield"></div><h3>${emp.name}</h3><div class="motto">“${emp.motto}”</div>
      <p>${emp.description}</p><ul>${emp.bonuses.map((b) => `<li>${b}</li>`).join('')}</ul>
      <div class="unique">Unique unit: <b>${u.icon} ${u.name}</b></div>`;
    card.onclick = () => selectEmpire(key);
    cards.appendChild(card);
  }
  selectEmpire(App.empire);

  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
      $('sp-panel').classList.toggle('hidden', t.dataset.tab !== 'sp');
      $('mp-panel').classList.toggle('hidden', t.dataset.tab !== 'mp');
    };
  });
  $('start-sp').onclick = startSinglePlayer;
  $('mp-create').onclick = () => mpConnect({ t: 'create' });
  $('mp-join').onclick = () => mpConnect({ t: 'join', code: $('mp-code').value });
  $('mp-start').onclick = () => App.net && App.net.send({ t: 'start' });
  $('mp-leave').onclick = () => mpDisconnect();
  try { $('mp-name').value = localStorage.getItem('empires.name') || ''; } catch { /* storage unavailable */ }
  if (location.protocol === 'file:') {
    $('mp-offline').classList.remove('hidden');
    $('mp-form').classList.add('hidden');
  }
}

function selectEmpire(key) {
  App.empire = key;
  document.querySelectorAll('.empire-card').forEach((c) => c.classList.toggle('selected', c.dataset.key === key));
  if (App.net && App.lobby) App.net.send({ t: 'empire', empire: key });
}

function showScreen(id) {
  for (const s of ['menu', 'pause', 'end']) $(s).classList.toggle('hidden', s !== id);
  $('app').classList.toggle('hidden', id === 'menu');
}

// ---------- single player ----------
function startSinglePlayer() {
  const other = Object.keys(EMPIRES).find((k) => k !== App.empire) || App.empire;
  const game = new Game({
    seed: Math.floor(Math.random() * 1e9),
    empires: [App.empire, other],
    difficulty: $('difficulty').value,
    ai: [false, true],
  });
  launch(game, 0, localCommands(game, 0), 'sp');
}

// ---------- multiplayer ----------
async function mpConnect(first) {
  const name = $('mp-name').value.trim() || 'Lord';
  try { localStorage.setItem('empires.name', name); } catch { /* storage unavailable */ }
  setMpStatus('Connecting…');
  if (!App.net) {
    App.net = new NetClient();
    try { await App.net.connect(); } catch (err) { App.net = null; setMpStatus(err.message, true); return; }
    App.net.on('error', (m) => setMpStatus(m.text, true));
    App.net.on('lobby', (m) => { App.lobby = m; renderLobby(); });
    App.net.on('you', (m) => { App.slot = m.slot; App.host = m.host; renderLobby(); });
    App.net.on('start', (m) => mpStart(m));
    App.net.on('close', () => {
      App.net = null;
      App.lobby = null;
      if (App.session && App.session.mode === 'mp' && !App.session.game.over) {
        App.session.ui.message('Disconnected from the server.', 'warn');
        App.session.game.over = { winner: -1, reason: 'Disconnected from the server' };
      }
      renderLobby();
      setMpStatus('Disconnected.', true);
    });
  }
  App.net.send({ ...first, name, empire: App.empire });
  setMpStatus('');
}

function mpDisconnect() {
  if (App.net) { App.net.send({ t: 'leave' }); App.net.close(); }
  App.net = null;
  App.lobby = null;
  renderLobby();
}

function setMpStatus(text, bad) {
  $('mp-status').textContent = text;
  $('mp-status').classList.toggle('bad', !!bad);
}

function renderLobby() {
  const l = App.lobby;
  $('mp-form').classList.toggle('hidden', !!l || location.protocol === 'file:');
  $('mp-lobby').classList.toggle('hidden', !l);
  if (!l) return;
  $('mp-room-code').textContent = l.code;
  $('mp-players').innerHTML = [0, 1].map((i) => {
    const p = l.players[i];
    if (!p) return '<li class="open">Waiting for a player to join…</li>';
    const e = EMPIRES[p.empire];
    return `<li><span class="dot" style="background:${e.color}"></span><b>${escapeHtml(p.name)}</b> ${i === 0 ? '(host)' : ''} · ${e.name}${i === App.slot ? ' · you' : ''}</li>`;
  }).join('');
  $('mp-start').classList.toggle('hidden', !App.host);
  $('mp-start').disabled = l.players.length < 2;
  $('mp-wait').classList.toggle('hidden', !!App.host);
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`); }

function mpStart(m) {
  const game = new Game({ seed: m.seed, empires: m.empires, ai: m.empires.map(() => false), viewer: m.you });
  game.players.forEach((p, i) => { p.name = m.names[i]; });
  const net = App.net;
  launch(game, m.you, netCommands(net, game, m.you), 'mp');
  const ui = App.session.ui;
  net.on('snap', (s) => { for (const ev of applySnapshot(game, s)) ui.handleEvent(ev); });
  net.on('notice', (n) => ui.message(n.text + '.', 'warn'));
  net.on('chat', (c) => ui.message(`${c.from}: ${c.text}`, 'chat'));
  net.on('lobby', (l) => { App.lobby = l; });
  ui.message(`Battle begins! You lead the ${EMPIRES[m.empires[m.you]].name}. Press Enter to chat.`);
}

// ---------- session ----------
function launch(game, player, cmd, mode) {
  if (App.session) App.session.ui.unbind();
  showScreen(null);
  $('app').classList.remove('hidden');
  const canvas = $('view');
  const renderer = new Renderer(canvas, game);
  const ui = new UI({ game, renderer, cmd, player, multiplayer: mode === 'mp', onPause: () => togglePause() });
  App.session = { game, renderer, ui, mode, paused: false, acc: 0, last: performance.now(), miniT: 0, ended: false };
  resize();
  const tc = game.entities.find((e) => e.owner === player && e.type === 'towncenter');
  renderer.centerOn(tc.x, tc.y + 40);
  ui.select(game.entities.filter((e) => e.owner === player && e.entity === 'unit'));
  $('chat').classList.add('hidden');
  if (mode === 'sp') ui.message(`Long live the ${game.players[player].empire.name}! Gather resources and destroy the enemy Town Center.`);
}

function togglePause() {
  const s = App.session;
  if (!s || s.ended) return;
  const showing = !$('pause').classList.contains('hidden');
  if (showing) { $('pause').classList.add('hidden'); s.paused = false; return; }
  s.paused = s.mode === 'sp';
  $('pause-title').textContent = s.mode === 'sp' ? 'Paused' : 'Menu';
  $('pause').classList.remove('hidden');
}

function quitToMenu() {
  const s = App.session;
  if (s) s.ui.unbind();
  App.session = null;
  if (App.net) mpDisconnect();
  showScreen('menu');
}

function showEnd() {
  const s = App.session;
  s.ended = true;
  const g = s.game, me = s.ui.player, over = g.over;
  const won = over.winner === me;
  $('end-title').textContent = won ? 'Victory!' : over.winner === -1 ? 'Game Over' : 'Defeat';
  $('end-title').className = won ? 'win' : 'lose';
  $('end-reason').textContent = over.reason || (won ? 'The enemy Town Center has fallen. Your empire reigns supreme.' : 'Your strongholds have fallen.');
  const t = Math.floor(over.time || g.time);
  $('end-stats').innerHTML = `<tr><th></th>${g.players.map((p) => `<th style="color:${p.color}">${escapeHtml(p.name || p.empire.name)}</th>`).join('')}</tr>` +
    [['Units trained', 'trained'], ['Enemies killed', 'killed'], ['Units/buildings lost', 'lost'], ['Resources gathered', 'gathered'], ['Buildings built', 'built']]
      .map(([label, k]) => `<tr><td>${label}</td>${g.players.map((p) => `<td>${Math.floor(p.stats[k])}</td>`).join('')}</tr>`).join('') +
    `<tr><td>Game time</td><td colspan="${g.players.length}">${Math.floor(t / 60)}m ${t % 60}s</td></tr>`;
  $('end').classList.remove('hidden');
}

function resize() {
  const c = $('view');
  c.width = c.clientWidth;
  c.height = c.clientHeight;
  if (App.session) App.session.renderer.clampCam();
}

function frame(now) {
  requestAnimationFrame(frame);
  const s = App.session;
  if (!s) return;
  const dt = Math.min(0.1, (now - s.last) / 1000);
  s.last = now;
  const g = s.game;
  if (s.mode === 'sp') {
    if (!s.paused && !g.over) {
      s.acc += dt;
      let steps = 0;
      while (s.acc >= TICK && steps < 5) { g.step(); s.acc -= TICK; steps++; }
      if (steps === 5) s.acc = 0;
      for (const ev of g.events) s.ui.handleEvent(ev);
      g.events.length = 0;
    }
  } else {
    interpolate(g, dt);
    g.visionT -= dt;
    if (g.visionT <= 0) { g.visionT = 0.25; g.computeVision(); }
  }
  if (!s.paused) s.ui.update(dt);
  s.renderer.render(s.ui);
  s.miniT -= dt;
  if (s.miniT <= 0) { s.miniT = 0.25; s.ui.drawMinimap(); }
  if (g.over && !s.ended) showEnd();
}

window.addEventListener('resize', resize);
window.addEventListener('load', () => {
  buildMenu();
  $('resume').onclick = () => togglePause();
  $('quit').onclick = () => quitToMenu();
  $('end-menu').onclick = () => quitToMenu();
  showScreen('menu');
  requestAnimationFrame(frame);
});
