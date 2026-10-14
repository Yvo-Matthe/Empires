'use strict';
// Small shared helpers. Loaded first; everything here is global.

function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

function canAfford(res, cost) {
  for (const k in cost) if ((res[k] || 0) < cost[k]) return false;
  return true;
}
function pay(res, cost) {
  for (const k in cost) res[k] -= cost[k];
}
function refund(res, cost, factor = 1) {
  for (const k in cost) res[k] += Math.floor(cost[k] * factor);
}
function costText(cost) {
  return RESOURCES.filter((r) => cost[r]).map((r) => `${cost[r]} ${r}`).join(', ');
}
