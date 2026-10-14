'use strict';
// Game balance and content. Adding a new empire only needs an entry in EMPIRES
// (plus its unique unit in UNITS if it has one).

const TILE = 32;
const MAP_W = 96;
const MAP_H = 96;
const TICK = 1 / 20; // fixed simulation step (seconds)
const MAX_POP = 200;
const CARRY_CAP = 10;
const RESOURCES = ['food', 'wood', 'stone', 'gold'];
const RES_ICON = { food: '🍖', wood: '🪵', stone: '🪨', gold: '🪙' };

// Gather rates in resource per second, keyed by node kind.
const GATHER_RATE = { berries: 0.6, farm: 0.45, tree: 0.5, stone: 0.4, gold: 0.45 };
const NODE_AMOUNT = { berries: 125, tree: 100, stone: 350, gold: 400 };
const NODE_RES = { berries: 'food', farm: 'food', tree: 'wood', stone: 'stone', gold: 'gold' };

// range is in tiles, measured edge to edge. speed in px/s. bonus is extra damage vs a tag.
const UNITS = {
  peasant: {
    name: 'Peasant', icon: '👨‍🌾', hp: 40, atk: 3, armor: 0, range: 0.4, cooldown: 1.5, speed: 56,
    sight: 6, cost: { food: 50 }, time: 10, tags: ['civilian'], worker: true,
    desc: 'Gathers resources and constructs buildings.',
  },
  spearman: {
    name: 'Spearman', icon: '🔱', hp: 55, atk: 4, armor: 0, range: 0.5, cooldown: 1.8, speed: 54,
    sight: 6, cost: { food: 35, wood: 25 }, time: 12, tags: ['infantry'], bonus: { cavalry: 12 },
    desc: 'Cheap infantry. Deals heavy bonus damage to cavalry.',
  },
  manatarms: {
    name: 'Man-at-Arms', icon: '⚔️', hp: 75, atk: 8, armor: 2, range: 0.4, cooldown: 1.8, speed: 52,
    sight: 6, cost: { food: 60, gold: 20 }, time: 14, tags: ['infantry'], bonus: { civilian: 3 },
    desc: 'Armoured swordsman. Solid all-round infantry.',
  },
  archer: {
    name: 'Archer', icon: '🏹', hp: 35, atk: 5, armor: 0, range: 5, cooldown: 2, speed: 56,
    sight: 7, cost: { wood: 25, gold: 45 }, time: 14, tags: ['ranged'], bonus: { infantry: 2 },
    projectile: true, desc: 'Ranged unit. Strong against infantry, weak against cavalry.',
  },
  knight: {
    name: 'Knight', icon: '🐎', hp: 120, atk: 10, armor: 2, range: 0.4, cooldown: 1.8, speed: 84,
    sight: 7, cost: { food: 60, gold: 75 }, time: 20, tags: ['cavalry'], bonus: { ranged: 4 },
    desc: 'Fast heavy cavalry. Runs down archers, fears spearmen.',
  },
  // Unique units, trained at the Castle by their empire only.
  paladin: {
    name: 'Royal Paladin', icon: '🛡️', hp: 170, atk: 13, armor: 4, range: 0.4, cooldown: 1.7, speed: 80,
    sight: 7, cost: { food: 70, gold: 90 }, time: 24, tags: ['cavalry'], bonus: { ranged: 5, infantry: 2 },
    unique: true, desc: 'Aldermark unique unit. Elite holy cavalry in gilded plate.',
  },
  longbowman: {
    name: 'Longbowman', icon: '🎯', hp: 40, atk: 6, armor: 1, range: 7, cooldown: 2, speed: 54,
    sight: 8, cost: { wood: 35, gold: 40 }, time: 16, tags: ['ranged'], bonus: { infantry: 3 },
    projectile: true, unique: true, desc: 'Valmont unique unit. Outranges every other archer.',
  },
};

const BUILDINGS = {
  towncenter: {
    name: 'Town Center', icon: '🏛️', size: 4, hp: 2400, armor: 3, cost: { wood: 275, stone: 100 }, time: 80,
    pop: 10, sight: 8, trains: ['peasant'], dropoff: ['food', 'wood', 'stone', 'gold'],
    attack: { atk: 5, range: 6, cooldown: 2, arrows: 1 },
    desc: 'Heart of your empire. Trains peasants and accepts every resource.',
  },
  house: { name: 'House', icon: '🏠', size: 2, hp: 500, armor: 1, cost: { wood: 30 }, time: 15, pop: 5, sight: 3,
    desc: 'Supports 5 population.' },
  farm: { name: 'Farm', icon: '🌾', size: 3, hp: 300, armor: 0, cost: { wood: 60 }, time: 12, sight: 2, farm: true,
    walkable: true, desc: 'An endless food source worked by one peasant.' },
  mill: { name: 'Mill', icon: '🌀', size: 2, hp: 600, armor: 1, cost: { wood: 100 }, time: 20, sight: 4,
    dropoff: ['food'], desc: 'Food drop-off point. Build it near berries and farms.' },
  lumbercamp: { name: 'Lumber Camp', icon: '🪓', size: 2, hp: 600, armor: 1, cost: { wood: 100 }, time: 20, sight: 4,
    dropoff: ['wood'], desc: 'Wood drop-off point. Build it next to a forest.' },
  miningcamp: { name: 'Mining Camp', icon: '⛏️', size: 2, hp: 600, armor: 1, cost: { wood: 100 }, time: 20, sight: 4,
    dropoff: ['stone', 'gold'], desc: 'Stone and gold drop-off point.' },
  barracks: { name: 'Barracks', icon: '⚔️', size: 3, hp: 1200, armor: 2, cost: { wood: 175 }, time: 35, sight: 5,
    trains: ['spearman', 'manatarms'], desc: 'Trains spearmen and men-at-arms.' },
  archeryrange: { name: 'Archery Range', icon: '🏹', size: 3, hp: 1200, armor: 2, cost: { wood: 175, gold: 25 },
    time: 35, sight: 5, trains: ['archer'], requires: 'barracks', desc: 'Trains archers.' },
  stable: { name: 'Stable', icon: '🐎', size: 3, hp: 1200, armor: 2, cost: { wood: 175, stone: 50 }, time: 35,
    sight: 5, trains: ['knight'], requires: 'barracks', desc: 'Trains knights.' },
  tower: { name: 'Watch Tower', icon: '🗼', size: 2, hp: 900, armor: 3, cost: { wood: 25, stone: 125 }, time: 40,
    sight: 9, attack: { atk: 6, range: 7, cooldown: 2, arrows: 1 }, desc: 'Defensive tower that shoots arrows.' },
  castle: {
    name: 'Castle', icon: '🏰', size: 4, hp: 4200, armor: 5, cost: { stone: 600, gold: 100 }, time: 120, pop: 10,
    sight: 10, trains: ['@unique'], requires: 'stable', attack: { atk: 7, range: 8, cooldown: 1.6, arrows: 3 },
    desc: 'Mighty fortress. Trains your empire\'s unique unit.',
  },
};

// Order of the peasant build menu (grid slots Q W E R / A S D F / Z X C V).
const BUILD_MENU = ['house', 'farm', 'mill', 'lumbercamp', 'miningcamp', 'barracks', 'archeryrange', 'stable',
  'tower', 'castle', 'towncenter'];

const EMPIRES = {
  aldermark: {
    name: 'Kingdom of Aldermark',
    motto: 'By crown and lance',
    color: '#2f6fd6',
    trim: '#f2c94c',
    unique: 'paladin',
    description: 'A proud highland kingdom of knightly orders and golden wheat fields.',
    bonuses: [
      'Chivalric Orders: Knights and Royal Paladins have +20% HP',
      'Royal Granaries: farmers gather 15% faster',
      'Crown Masons: Castles are built 25% faster',
    ],
    mods: {
      unitHp: { knight: 1.2, paladin: 1.2 },
      gather: { farm: 1.15 },
      buildTime: { castle: 0.75 },
    },
  },
  valmont: {
    name: 'Duchy of Valmont',
    motto: 'The forest remembers',
    color: '#c0392b',
    trim: '#ecf0f1',
    unique: 'longbowman',
    description: 'A wooded duchy famed for its bowmen and patient stonework.',
    bonuses: [
      'Forest Wardens: lumberjacks gather 15% faster',
      'Patient Stone: Towers and Castles cost 20% less stone',
      'Yeomanry: archers have +1 range',
    ],
    mods: {
      gather: { tree: 1.15 },
      buildCost: { tower: { stone: 0.8 }, castle: { stone: 0.8 } },
      unitRange: { archer: 1 },
    },
  },
};

const PLAYER_COLORS = ['#2f6fd6', '#c0392b', '#8e44ad', '#16a085', '#d35400', '#7f8c8d'];

function pickColor(preferred, used) {
  const c = used.includes(preferred) ? PLAYER_COLORS.find((x) => !used.includes(x)) : preferred;
  used.push(c);
  return c;
}

const DIFFICULTY = {
  easy: { name: 'Easy', gather: 0.8, firstAttack: 600, waveStart: 5, workers: 18 },
  normal: { name: 'Normal', gather: 1.0, firstAttack: 420, waveStart: 7, workers: 24 },
  hard: { name: 'Hard', gather: 1.25, firstAttack: 300, waveStart: 9, workers: 30 },
};
