'use strict';
// Loads the browser game scripts into a Node vm context so the simulation can run
// on the server (multiplayer) and in tests, from the very same source files.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SIM_FILES = ['util.js', 'data.js', 'map.js', 'pathfinding.js', 'game.js', 'ai.js', 'net.js'];

function loadSim() {
  const ctx = vm.createContext({ console, Math, Date });
  for (const f of SIM_FILES) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');
    vm.runInContext(src, ctx, { filename: f });
  }
  // Script-level const/class declarations are not properties of the context, so collect them.
  return vm.runInContext(`({ Game, Pathfinder, generateMap, mapConnected, makeSnapshot, EMPIRES, UNITS, BUILDINGS,
    DIFFICULTY, TILE, MAP_W, MAP_H, TICK, START_POS, MAX_PLAYERS })`, ctx);
}

module.exports = { loadSim };
