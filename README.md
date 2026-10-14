# Empires: Age of Crowns

A medieval real-time strategy game for the PC, played in the browser. Build up an economy,
raise an army and tear down the enemy's Town Center, against the computer or against a friend.

![An Aldermark town fourteen minutes into a match](docs/screenshot.png)

## Play

**Single player** needs nothing installed: open `index.html` in Chrome, Edge or Firefox.

**Multiplayer** (and single player) through the game server:

```sh
npm install
npm start            # serves http://localhost:8080
```

1. Both players open the game (`http://localhost:8080` on the host PC, `http://<host-ip>:8080`
   from another PC on the same network).
2. Choose an empire, open the **Multiplayer** tab and press **Create Room**.
3. Your opponent enters the four-letter room code and presses **Join Room**.
4. The host presses **Start Battle**.

To play over the internet, forward port 8080 on the host's router or deploy the server
to any Node host (set `PORT` if needed). The server runs the authoritative simulation,
so a player can only command their own units.

## Empires

| Empire | Bonuses | Unique unit |
| --- | --- | --- |
| **Kingdom of Aldermark** (blue) | Knights and Paladins +20% HP · farmers +15% · Castles built 25% faster | **Royal Paladin**: elite heavy cavalry |
| **Duchy of Valmont** (red) | Lumberjacks +15% · Towers and Castles cost 20% less stone · archers +1 range | **Longbowman**: very long range archer |

New empires are a single entry in `EMPIRES` in [`js/data.js`](js/data.js) (plus a unit in `UNITS`
if it has a unique unit).

## How to play

- **Economy:** peasants gather food (berries, farms), wood (trees), stone and gold, and carry it
  to a Town Center or a Mill / Lumber Camp / Mining Camp. Houses raise your population cap.
- **Army:** Barracks (Spearman, Man-at-Arms), Archery Range (Archer), Stable (Knight) and the
  Castle (your empire's unique unit). Spearmen counter cavalry, cavalry counters archers,
  archers counter infantry. Watch Towers, Town Centers and Castles shoot arrows.
- **Victory:** destroy every enemy Town Center and Castle.

### Controls

| Input | Action |
| --- | --- |
| Left click / drag | Select (double-click selects all of a type on screen) |
| Right click | Move, gather, build/repair, attack, or set a rally point |
| Arrow keys, screen edges, minimap | Scroll · mouse wheel zooms |
| `Q W E R` / `A S D F` / `Z X C V` | Command buttons (build menu, train units) |
| `Shift` while placing | Place several buildings |
| `H` / `.` | Select Town Center / next idle peasant |
| `Ctrl+1-9`, `1-9` | Assign / select control group (double-tap to jump) |
| `Del`, `Esc`, `P` | Delete selection, cancel, pause / menu |
| `Enter` | Chat (multiplayer) |

## Development

Plain JavaScript and Canvas, no build step. The simulation (`js/game.js`, `js/ai.js`, …) has no
DOM access, so the server and the tests load the same files with Node's `vm` module
(`server/sim.js`).

```sh
npm test   # map generation, empire bonuses, economy, AI-vs-AI game, multiplayer server
```

| File | Purpose |
| --- | --- |
| `js/data.js` | Units, buildings, empires, balance |
| `js/map.js` | Symmetric procedural map |
| `js/pathfinding.js` | A* on the tile grid |
| `js/game.js` | Simulation and player commands |
| `js/ai.js` | Computer opponent |
| `js/render.js` | Procedural canvas art, fog of war, minimap |
| `js/ui.js` | HUD, selection, input |
| `js/net.js` | Multiplayer snapshots and client |
| `server/index.js` | Static file server and multiplayer rooms |
