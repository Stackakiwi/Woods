'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC = path.join(__dirname, 'public');
const TICK_MS = 50;
const BROADCAST_MS = 50;
const MAP_W = 80;
const MAP_H = 80;
const TS = 16;
const DAY_SECONDS = 300;
const MAX_PLAYERS = 6;

const TILE = Object.freeze({ GRASS: 0, FOREST: 1, WATER: 2, PATH: 3, BRIDGE: 4, RUINS: 5 });
const passable = new Set([TILE.GRASS, TILE.PATH, TILE.BRIDGE, TILE.RUINS]);

const rooms = new Map();
const clients = new Map();
let lastTick = Date.now();
let lastBroadcast = 0;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
function sanitizeName(v) {
  return String(v || 'Ranger').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 18) || 'Ranger';
}
function sanitizeChat(v) {
  return String(v || '').replace(/[<>]/g, '').trim().slice(0, 160);
}
function id(prefix = '') { return prefix + crypto.randomBytes(5).toString('hex'); }
function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  do {
    out = '';
    for (let i = 0; i < 5; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  } while (rooms.has(out));
  return out;
}
function hash2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 69069) >>> 0;
  h = (h ^ (h >>> 13)) * 1274126177 >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function clearCircle(terrain, cx, cy, r, tile = TILE.GRASS) {
  for (let y = Math.max(0, cy - r); y <= Math.min(MAP_H - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(MAP_W - 1, cx + r); x++) {
      if ((x-cx)*(x-cx) + (y-cy)*(y-cy) <= r*r) terrain[y * MAP_W + x] = tile;
    }
  }
}
function carvePath(terrain, ax, ay, bx, by) {
  let x = ax, y = ay;
  while (x !== bx || y !== by) {
    terrain[y * MAP_W + x] = TILE.PATH;
    if (Math.abs(bx - x) > Math.abs(by - y)) x += Math.sign(bx - x);
    else if (y !== by) y += Math.sign(by - y);
    else x += Math.sign(bx - x);
    if (x >= 1 && y >= 1 && x < MAP_W-1 && y < MAP_H-1) terrain[y * MAP_W + x] = TILE.PATH;
  }
}
function generateWorld(seed) {
  const terrain = new Array(MAP_W * MAP_H).fill(TILE.GRASS);
  const r = rng(seed);

  // Dense woods around the playable glades.
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const edge = Math.min(x, y, MAP_W - 1 - x, MAP_H - 1 - y);
      const n = (hash2(Math.floor(x / 3), Math.floor(y / 3), seed) * 0.62 + hash2(x, y, seed + 17) * 0.38);
      if (edge < 3 || (edge < 7 && n > 0.35) || n > 0.73) terrain[y * MAP_W + x] = TILE.FOREST;
    }
  }

  // Winding river and a single bridge corridor.
  const bridgeY = 40;
  for (let y = 3; y < MAP_H - 3; y++) {
    const center = Math.round(54 + Math.sin((y + seed % 19) * 0.16) * 5 + Math.sin(y * 0.055) * 3);
    const width = 2 + (hash2(y, 91, seed) > 0.78 ? 1 : 0);
    for (let x = center - width; x <= center + width; x++) {
      if (x > 1 && x < MAP_W - 2) terrain[y * MAP_W + x] = TILE.WATER;
    }
    if (Math.abs(y - bridgeY) <= 1) {
      for (let x = center - width - 1; x <= center + width + 1; x++) terrain[y * MAP_W + x] = TILE.BRIDGE;
    }
  }

  const spawn = { x: 30, y: 40 };
  const altars = [
    { id: 'altar-nw', x: 13, y: 14, label: 'Moss Altar', status: 'dormant' },
    { id: 'altar-ne', x: 68, y: 14, label: 'River Altar', status: 'dormant' },
    { id: 'altar-se', x: 68, y: 66, label: 'Ash Altar', status: 'dormant' }
  ];
  const gate = { id: 'old-gate', x: 26, y: 40, label: 'Old Gate' };

  clearCircle(terrain, spawn.x, spawn.y, 7);
  clearCircle(terrain, gate.x, gate.y, 3, TILE.RUINS);
  for (const a of altars) clearCircle(terrain, a.x, a.y, 3, TILE.RUINS);
  carvePath(terrain, spawn.x, spawn.y, gate.x, gate.y);
  carvePath(terrain, spawn.x, spawn.y, 51, bridgeY);
  carvePath(terrain, 59, bridgeY, altars[1].x, altars[1].y);

  const resources = new Map();
  const spots = [
    ['wood', 75], ['stone', 45], ['berry', 50], ['herb', 38]
  ];
  for (const [kind, count] of spots) {
    let made = 0, tries = 0;
    while (made < count && tries++ < 5000) {
      const x = 5 + Math.floor(r() * (MAP_W - 10));
      const y = 5 + Math.floor(r() * (MAP_H - 10));
      if (!passable.has(terrain[y * MAP_W + x])) continue;
      if (dist2(x, y, spawn.x, spawn.y) < 36) continue;
      if (altars.some(a => dist2(x, y, a.x, a.y) < 16)) continue;
      const rid = `r-${kind}-${x}-${y}-${made}`;
      resources.set(rid, { id: rid, kind, x: x * TS + 8, y: y * TS + 8, active: true, respawnAt: 0 });
      made++;
    }
  }

  return { terrain, spawn, altars, gate, resources };
}
function tileAt(room, px, py) {
  const x = Math.floor(px / TS), y = Math.floor(py / TS);
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return TILE.FOREST;
  return room.terrain[y * MAP_W + x];
}
function canStand(room, px, py) {
  const pad = 5;
  return passable.has(tileAt(room, px-pad, py-pad)) && passable.has(tileAt(room, px+pad, py-pad)) &&
         passable.has(tileAt(room, px-pad, py+pad)) && passable.has(tileAt(room, px+pad, py+pad));
}
function createRoom(solo = false) {
  const code = makeCode();
  const seed = crypto.randomBytes(4).readUInt32LE(0);
  const w = generateWorld(seed);
  const room = {
    code, seed, solo, terrain: w.terrain, spawn: w.spawn, altars: w.altars, gate: w.gate,
    resources: w.resources,
    players: new Map(), structures: new Map(), enemies: new Map(),
    createdAt: Date.now(), worldClock: 66, day: 1, shards: 0,
    gateDefense: null, bossSpawned: false, victory: false,
    message: 'Find the three Moon Shards and bring them back to the Old Gate.',
    nextAmbientSpawn: Date.now() + 2500
  };
  room.structures.set('basefire', { id: 'basefire', type: 'campfire', x: (w.spawn.x + 3) * TS, y: (w.spawn.y + 2) * TS, owner: 'forest', lit: true });
  room.structures.set('basetent', { id: 'basetent', type: 'shelter', x: (w.spawn.x + 1) * TS, y: (w.spawn.y - 3) * TS, owner: 'forest' });
  rooms.set(code, room);
  return room;
}
function publicPlayer(p) {
  return {
    id: p.id, name: p.name, x: p.x, y: p.y, dir: p.dir, hp: p.hp, maxHp: p.maxHp,
    hunger: p.hunger, stamina: p.stamina, xp: p.xp, level: p.level, downed: p.downed,
    selected: p.selected, voice: !!p.voice, color: p.color
  };
}
function publicRoom(room, selfId) {
  const self = room.players.get(selfId);
  return {
    t: 'state', code: room.code, seed: room.seed, selfId,
    clock: room.worldClock, day: room.day, shards: room.shards,
    gateDefense: room.gateDefense ? { remaining: Math.max(0, room.gateDefense.endsAt - Date.now()), bossAlive: [...room.enemies.values()].some(e => e.type === 'stag') } : null,
    victory: room.victory,
    message: room.message,
    self: self ? { ...publicPlayer(self), inventory: self.inventory } : null,
    players: [...room.players.values()].map(publicPlayer),
    resources: [...room.resources.values()].filter(v => v.active),
    structures: [...room.structures.values()],
    enemies: [...room.enemies.values()].map(e => ({ id:e.id, type:e.type, x:e.x, y:e.y, hp:e.hp, maxHp:e.maxHp, facing:e.facing, altarId:e.altarId || null })),
    altars: room.altars.map(a => ({...a})), gate: room.gate
  };
}
function initialPayload(room, selfId) {
  const state = publicRoom(room, selfId);
  return { ...state, t: 'init', map: { w: MAP_W, h: MAP_H, ts: TS, terrain: room.terrain }, daySeconds: DAY_SECONDS };
}
function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(room, obj, exceptId = null) {
  const raw = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.id === exceptId) continue;
    const c = clients.get(p.id);
    if (c && c.readyState === 1) c.send(raw);
  }
}
function roomStateBroadcast(room) {
  for (const p of room.players.values()) send(clients.get(p.id), publicRoom(room, p.id));
}
function joinRoom(ws, room, name) {
  if (room.players.size >= (room.solo ? 1 : MAX_PLAYERS)) return send(ws, {t:'error', message:'That grove is full.'});
  const pid = id('p-');
  const slot = room.players.size;
  const sx = room.spawn.x * TS + 8 + (slot % 3) * 10;
  const sy = room.spawn.y * TS + 8 + Math.floor(slot / 3) * 10;
  const player = {
    id: pid, name: sanitizeName(name), x: sx, y: sy, dir: 'down',
    hp: 100, maxHp: 100, hunger: 100, stamina: 100, xp: 0, level: 1, damageMult: 1,
    input: {up:false,down:false,left:false,right:false,sprint:false},
    inventory: { spear:1, hatchet:1, torch:1, berry:4, bandage:1, wood:0, stone:0, herb:0 },
    selected: 'spear', attackAt: 0, interactAt: 0, downed: false, respawnAt: 0,
    voice: false, color: slot % 6, lastSeen: Date.now(), spawnX: sx, spawnY: sy
  };
  room.players.set(pid, player);
  clients.set(pid, ws);
  ws.pid = pid; ws.roomCode = room.code;
  send(ws, initialPayload(room, pid));
  broadcast(room, {t:'toast', message:`${player.name} entered the woods.`}, pid);
  broadcast(room, {t:'peer-joined', id:pid, name:player.name}, pid);
}
function leave(ws) {
  const pid = ws.pid, code = ws.roomCode;
  if (!pid || !code || !rooms.has(code)) return;
  const room = rooms.get(code);
  const p = room.players.get(pid);
  room.players.delete(pid); clients.delete(pid);
  broadcast(room, {t:'peer-left', id:pid});
  if (p) broadcast(room, {t:'toast', message:`${p.name} left the grove.`});
  if (room.players.size === 0) room.emptyAt = Date.now();
}
function gainXp(p, amount) {
  p.xp += amount;
  const need = p.level * 100;
  if (p.xp >= need) {
    p.xp -= need; p.level++; p.maxHp += 10; p.hp = p.maxHp; p.damageMult += 0.06;
    send(clients.get(p.id), {t:'toast', message:`Level ${p.level}! Health and attack increased.`});
  }
}
function spawnEnemy(room, type, x, y, extra = {}) {
  const stats = {
    spider: {hp:30, speed:42, damage:8, range:16, xp:18},
    wolf: {hp:65, speed:48, damage:16, range:18, xp:34},
    shadow: {hp:48, speed:38, damage:13, range:17, xp:28},
    guardian: {hp:80, speed:34, damage:17, range:18, xp:55},
    stag: {hp:520, speed:31, damage:26, range:25, xp:260}
  }[type];
  if (!stats) return null;
  const eid = id('e-');
  room.enemies.set(eid, { id:eid, type, x, y, hp:stats.hp, maxHp:stats.hp, ...stats, attackAt:0, facing:'down', ...extra });
  return eid;
}
function spawnAround(room, p, type) {
  for (let tries = 0; tries < 20; tries++) {
    const ang = Math.random() * Math.PI * 2;
    const d = 110 + Math.random() * 130;
    const x = p.x + Math.cos(ang) * d, y = p.y + Math.sin(ang) * d;
    if (canStand(room, x, y)) return spawnEnemy(room, type, x, y);
  }
  return null;
}
function nearestAlivePlayer(room, x, y) {
  let best = null, bd = Infinity;
  for (const p of room.players.values()) {
    if (p.downed) continue;
    const d = dist2(x,y,p.x,p.y);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
function damagePlayer(room, p, amount, source) {
  if (p.downed || room.victory) return;
  p.hp = Math.max(0, p.hp - amount);
  if (p.hp <= 0) {
    p.downed = true; p.respawnAt = Date.now() + 10000;
    p.inventory.wood = Math.floor((p.inventory.wood || 0) * 0.7);
    p.inventory.stone = Math.floor((p.inventory.stone || 0) * 0.7);
    p.inventory.herb = Math.floor((p.inventory.herb || 0) * 0.7);
    send(clients.get(p.id), {t:'toast', message:`You were knocked down by ${source}. A teammate can revive you.`});
    broadcast(room, {t:'toast', message:`${p.name} was knocked down.`}, p.id);
  }
}
function handleAttack(room, p) {
  const now = Date.now();
  const weapon = p.selected;
  const spec = {
    spear:{cool:520, dmg:26, range:38}, hatchet:{cool:650, dmg:20, range:31}, torch:{cool:700, dmg:12, range:29},
    berry:{cool:700,dmg:7,range:24}, bandage:{cool:700,dmg:7,range:24}
  }[weapon] || {cool:650,dmg:8,range:24};
  if (now - p.attackAt < spec.cool) return;
  p.attackAt = now;
  let fx = 0, fy = 0;
  if (p.dir === 'up') fy = -1; else if (p.dir === 'down') fy = 1; else if (p.dir === 'left') fx = -1; else fx = 1;
  const tx = p.x + fx * 18, ty = p.y + fy * 18;
  let target = null, bd = spec.range * spec.range;
  for (const e of room.enemies.values()) {
    const d = dist2(tx, ty, e.x, e.y);
    if (d < bd) { bd = d; target = e; }
  }
  if (!target) return;
  let dmg = spec.dmg * p.damageMult;
  if (weapon === 'torch' && (target.type === 'shadow' || target.type === 'guardian')) dmg *= 1.8;
  target.hp -= Math.round(dmg);
  broadcast(room, {t:'hit', x:target.x, y:target.y, amount:Math.round(dmg)});
  if (target.hp <= 0) {
    room.enemies.delete(target.id);
    gainXp(p, target.xp || 10);
    if (target.altarId) {
      const a = room.altars.find(v => v.id === target.altarId);
      if (a && a.status === 'awakened' && ![...room.enemies.values()].some(e => e.altarId === target.altarId)) {
        a.status = 'cleansed';
        room.message = `${a.label} is quiet now. Touch it again to take its Moon Shard.`;
        broadcast(room, {t:'toast', message:`${a.label} has been cleansed.`});
      }
    }
  }
}
function gather(room, p) {
  const now = Date.now();
  if (now - p.interactAt < 350) return false;
  p.interactAt = now;
  let best = null, bd = 28 * 28;
  for (const r of room.resources.values()) {
    if (!r.active) continue;
    const d = dist2(p.x,p.y,r.x,r.y);
    if (d < bd) { bd=d; best=r; }
  }
  if (!best) return false;
  best.active = false; best.respawnAt = now + 120000 + Math.random()*60000;
  const gain = best.kind === 'wood' ? 3 : best.kind === 'stone' ? 2 : best.kind === 'berry' ? 3 : 2;
  p.inventory[best.kind] = (p.inventory[best.kind] || 0) + gain;
  gainXp(p, best.kind === 'herb' ? 8 : 5);
  send(clients.get(p.id), {t:'toast', message:`+${gain} ${best.kind}${gain>1?'s':''}`});
  return true;
}
function interactLandmark(room, p) {
  // Teammate revive has priority.
  for (const q of room.players.values()) {
    if (q.id !== p.id && q.downed && dist2(p.x,p.y,q.x,q.y) < 34*34) {
      q.downed = false; q.hp = Math.max(40, Math.floor(q.maxHp * .4)); q.respawnAt = 0;
      broadcast(room, {t:'toast', message:`${p.name} revived ${q.name}.`});
      return true;
    }
  }
  for (const a of room.altars) {
    if (dist2(p.x,p.y,a.x*TS+8,a.y*TS+8) > 42*42) continue;
    if (a.status === 'dormant') {
      a.status = 'awakened';
      room.message = `${a.label} woke something in the trees. Defeat its guardians.`;
      for (let i=0;i<3;i++) {
        const ang = (Math.PI*2/3)*i + .4;
        spawnEnemy(room,'guardian',a.x*TS+8+Math.cos(ang)*48,a.y*TS+8+Math.sin(ang)*48,{altarId:a.id});
      }
      broadcast(room,{t:'toast',message:`${a.label} awakened three guardians.`});
      return true;
    }
    if (a.status === 'cleansed') {
      a.status='claimed'; room.shards++;
      room.message = room.shards < 3 ? `Moon Shard ${room.shards}/3 recovered.` : 'All Moon Shards recovered. Return to the Old Gate.';
      broadcast(room,{t:'toast',message:`Moon Shard recovered (${room.shards}/3).`});
      return true;
    }
    return true;
  }
  const gx=room.gate.x*TS+8, gy=room.gate.y*TS+8;
  if (dist2(p.x,p.y,gx,gy) < 46*46) {
    if (room.shards < 3) {
      send(clients.get(p.id),{t:'toast',message:`The Old Gate needs three Moon Shards (${room.shards}/3).`});
      return true;
    }
    if (!room.gateDefense && !room.victory) {
      room.gateDefense = { endsAt: Date.now()+60000, nextWave:Date.now(), startedBy:p.id };
      room.message='The gate is opening. Survive for one minute.';
      broadcast(room,{t:'toast',message:'THE OLD GATE IS OPENING — SURVIVE.'});
      return true;
    }
    return true;
  }
  return false;
}
function useItem(room,p,item) {
  const it = item || p.selected;
  if (it === 'berry' && (p.inventory.berry||0)>0) {
    p.inventory.berry--; p.hunger=clamp(p.hunger+24,0,100); p.hp=clamp(p.hp+4,0,p.maxHp);
    send(clients.get(p.id),{t:'toast',message:'Wild berries restored hunger.'});
  } else if (it === 'bandage' && (p.inventory.bandage||0)>0 && p.hp < p.maxHp) {
    p.inventory.bandage--; p.hp=clamp(p.hp+40,0,p.maxHp);
    send(clients.get(p.id),{t:'toast',message:'Bandaged +40 health.'});
  }
}
function craft(room,p,recipe) {
  const recipes = {
    torch:{cost:{wood:2,herb:1}, out:{torch:1}, label:'Torch'},
    bandage:{cost:{herb:3}, out:{bandage:1}, label:'Bandage'},
    spear:{cost:{wood:4,stone:2}, out:{spear:1}, label:'Spear'},
    campfire:{cost:{wood:6,stone:4}, structure:'campfire', label:'Campfire'},
    shelter:{cost:{wood:12,herb:4}, structure:'shelter', label:'Shelter'}
  };
  const r = recipes[recipe]; if (!r) return;
  for (const [k,v] of Object.entries(r.cost)) if ((p.inventory[k]||0)<v) return send(clients.get(p.id),{t:'toast',message:`Not enough materials for ${r.label}.`});
  for (const [k,v] of Object.entries(r.cost)) p.inventory[k]-=v;
  if (r.out) for (const [k,v] of Object.entries(r.out)) p.inventory[k]=(p.inventory[k]||0)+v;
  if (r.structure) {
    const sx=Math.round(p.x/TS)*TS, sy=Math.round(p.y/TS)*TS;
    if (!canStand(room,sx,sy)) { for (const [k,v] of Object.entries(r.cost)) p.inventory[k]+=v; return send(clients.get(p.id),{t:'toast',message:'Move to an open clearing to build that.'}); }
    const sid=id('s-'); room.structures.set(sid,{id:sid,type:r.structure,x:sx,y:sy,owner:p.id,lit:true});
    if (r.structure==='shelter') { p.spawnX=sx; p.spawnY=sy+18; }
  }
  send(clients.get(p.id),{t:'toast',message:`Crafted ${r.label}.`});
}
function handleMessage(ws, data) {
  let m; try { m=JSON.parse(data); } catch { return; }
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'create') return joinRoom(ws, createRoom(!!m.solo), m.name);
  if (m.t === 'join') {
    const code=String(m.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,5);
    const room=rooms.get(code); if (!room) return send(ws,{t:'error',message:'No grove found with that code.'});
    return joinRoom(ws,room,m.name);
  }
  const room=rooms.get(ws.roomCode), p=room && room.players.get(ws.pid); if (!room || !p) return;
  p.lastSeen=Date.now();
  if (m.t==='input') {
    p.input={up:!!m.up,down:!!m.down,left:!!m.left,right:!!m.right,sprint:!!m.sprint};
  } else if (m.t==='select') {
    const allowed=['spear','hatchet','torch','berry','bandage']; if (allowed.includes(m.item) && (p.inventory[m.item]||0)>0) p.selected=m.item;
  } else if (m.t==='attack') handleAttack(room,p);
  else if (m.t==='interact') { if (!interactLandmark(room,p)) gather(room,p); }
  else if (m.t==='use') useItem(room,p,m.item);
  else if (m.t==='craft') craft(room,p,m.recipe);
  else if (m.t==='chat') { const txt=sanitizeChat(m.text); if (txt) broadcast(room,{t:'chat',from:p.name,id:p.id,text:txt}); }
  else if (m.t==='voice') { p.voice=!!m.enabled; broadcast(room,{t:'voice-state',id:p.id,enabled:p.voice}); }
  else if (m.t==='signal') {
    const target=clients.get(String(m.to||''));
    if (target && target.roomCode===room.code) send(target,{t:'signal',from:p.id,data:m.data});
  }
}
function updateRoom(room,dt,now) {
  room.worldClock += dt; room.day=Math.floor(room.worldClock/DAY_SECONDS)+1;
  const phase=(room.worldClock%DAY_SECONDS)/DAY_SECONDS;
  const night=phase>0.65 || phase<0.10;
  const dusk=phase>0.55;

  for (const r of room.resources.values()) if (!r.active && r.respawnAt<=now) { r.active=true; r.respawnAt=0; }

  for (const p of room.players.values()) {
    if (p.downed) {
      if (p.respawnAt && now>=p.respawnAt) {
        p.downed=false; p.hp=Math.max(45,Math.floor(p.maxHp*.45)); p.hunger=Math.max(p.hunger,35); p.x=p.spawnX; p.y=p.spawnY; p.respawnAt=0;
        send(clients.get(p.id),{t:'toast',message:'You woke up back at camp.'});
      }
      continue;
    }
    let dx=(p.input.right?1:0)-(p.input.left?1:0), dy=(p.input.down?1:0)-(p.input.up?1:0);
    if (dx||dy) {
      const len=Math.hypot(dx,dy); dx/=len; dy/=len;
      if (Math.abs(dx)>Math.abs(dy)) p.dir=dx<0?'left':'right'; else p.dir=dy<0?'up':'down';
      let speed=80;
      if (p.input.sprint && p.stamina>2) { speed=126; p.stamina=Math.max(0,p.stamina-23*dt); }
      else p.stamina=Math.min(100,p.stamina+15*dt);
      const nx=p.x+dx*speed*dt, ny=p.y+dy*speed*dt;
      if (canStand(room,nx,p.y)) p.x=nx;
      if (canStand(room,p.x,ny)) p.y=ny;
    } else p.stamina=Math.min(100,p.stamina+20*dt);
    p.hunger=Math.max(0,p.hunger-.055*dt);
    if (p.hunger<=0) damagePlayer(room,p,3.5*dt,'starvation');

    // Warm campfires slowly heal at night.
    if (night && p.hp<p.maxHp && [...room.structures.values()].some(s=>s.type==='campfire'&&s.lit&&dist2(p.x,p.y,s.x,s.y)<76*76)) p.hp=Math.min(p.maxHp,p.hp+1.2*dt);
  }

  // Ambient danger scales with darkness, day, and party size.
  const alive=[...room.players.values()].filter(p=>!p.downed);
  if (alive.length && now>=room.nextAmbientSpawn && room.enemies.size < Math.min(28, 5 + room.day*2 + alive.length*3)) {
    const p=alive[Math.floor(Math.random()*alive.length)];
    let type='spider';
    if (night) type=Math.random()<.72?'shadow':'wolf'; else if (dusk && Math.random()<.55) type='wolf';
    spawnAround(room,p,type);
    room.nextAmbientSpawn=now+(night?2200:4800)+Math.random()*2200;
  }

  if (room.gateDefense && !room.victory) {
    if (now>=room.gateDefense.nextWave) {
      room.gateDefense.nextWave=now+5200;
      const target=alive[0];
      if (target) {
        const n=2+Math.min(5,Math.floor((60000-Math.max(0,room.gateDefense.endsAt-now))/12000));
        for(let i=0;i<n;i++) spawnAround(room,target,Math.random()<.75?'shadow':'wolf');
      }
    }
    const rem=room.gateDefense.endsAt-now;
    if (rem<30000 && !room.bossSpawned && alive.length) {
      room.bossSpawned=true;
      const gx=room.gate.x*TS+8, gy=room.gate.y*TS+8;
      spawnEnemy(room,'stag',gx-120,gy-50);
      room.message='The Hollow Stag is blocking the gate.';
      broadcast(room,{t:'toast',message:'THE HOLLOW STAG EMERGED.'});
    }
    const bossAlive=[...room.enemies.values()].some(e=>e.type==='stag');
    if (rem<=0 && !bossAlive && alive.length) {
      room.victory=true; room.message='The gate is open. The forest releases you — for now.';
      broadcast(room,{t:'victory'});
    }
  }

  for (const e of [...room.enemies.values()]) {
    const p=nearestAlivePlayer(room,e.x,e.y); if (!p) continue;
    const dx=p.x-e.x, dy=p.y-e.y, d=Math.hypot(dx,dy)||1;
    if (Math.abs(dx)>Math.abs(dy)) e.facing=dx<0?'left':'right'; else e.facing=dy<0?'up':'down';
    if (d>e.range) {
      const step=e.speed*dt;
      const nx=e.x+dx/d*step, ny=e.y+dy/d*step;
      if (e.type==='shadow' || e.type==='guardian') { e.x=nx; e.y=ny; }
      else { if (canStand(room,nx,e.y)) e.x=nx; if (canStand(room,e.x,ny)) e.y=ny; }
    } else if (now-e.attackAt>900) {
      e.attackAt=now; damagePlayer(room,p,e.damage,e.type==='stag'?'the Hollow Stag':e.type);
    }
  }
}

const server=http.createServer((req,res)=>{
  const raw=(req.url||'/').split('?')[0];
  const wanted=raw==='/'?'/index.html':raw;
  const file=path.normalize(path.join(PUBLIC,wanted));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file,(err,data)=>{
    if(err){res.writeHead(404);return res.end('Not found');}
    const ext=path.extname(file).toLowerCase();
    const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.svg':'image/svg+xml'};
    res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-cache'});res.end(data);
  });
});

// Tiny dependency-free WebSocket server. It supports the text, close, and ping
// frames this game needs, so players can run the project with plain Node.js.
const WS_GUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
class MiniSocket extends EventEmitter {
  constructor(sock){
    super(); this.sock=sock; this.readyState=1; this.buffer=Buffer.alloc(0);
    sock.on('data',d=>this._data(d));
    sock.on('close',()=>this._closed());
    sock.on('end',()=>this._closed());
    sock.on('error',e=>this.emit('error',e));
  }
  _closed(){if(this.readyState===3)return;this.readyState=3;this.emit('close');}
  send(data){
    if(this.readyState!==1)return;
    const payload=Buffer.from(String(data)); let head;
    if(payload.length<126){head=Buffer.alloc(2);head[0]=0x81;head[1]=payload.length;}
    else if(payload.length<65536){head=Buffer.alloc(4);head[0]=0x81;head[1]=126;head.writeUInt16BE(payload.length,2);}
    else {head=Buffer.alloc(10);head[0]=0x81;head[1]=127;head.writeBigUInt64BE(BigInt(payload.length),2);}
    this.sock.write(Buffer.concat([head,payload]));
  }
  _pong(payload){if(this.readyState!==1)return;const h=Buffer.from([0x8A,payload.length]);this.sock.write(Buffer.concat([h,payload]));}
  close(){if(this.readyState!==1)return;this.readyState=2;try{this.sock.end(Buffer.from([0x88,0x00]));}catch{} }
  _data(chunk){
    this.buffer=Buffer.concat([this.buffer,chunk]);
    while(this.buffer.length>=2){
      const b0=this.buffer[0],b1=this.buffer[1],opcode=b0&0x0f,masked=!!(b1&0x80);let len=b1&0x7f,off=2;
      if(len===126){if(this.buffer.length<4)return;len=this.buffer.readUInt16BE(2);off=4;}
      else if(len===127){if(this.buffer.length<10)return;const n=this.buffer.readBigUInt64BE(2);if(n>BigInt(1024*1024)){this.sock.destroy();return;}len=Number(n);off=10;}
      const maskLen=masked?4:0;if(this.buffer.length<off+maskLen+len)return;
      let mask=null;if(masked){mask=this.buffer.subarray(off,off+4);off+=4;}
      const payload=Buffer.from(this.buffer.subarray(off,off+len));this.buffer=this.buffer.subarray(off+len);
      if(masked)for(let i=0;i<payload.length;i++)payload[i]^=mask[i&3];
      if(opcode===0x8){this.close();this._closed();return;}
      if(opcode===0x9){if(payload.length<126)this._pong(payload);continue;}
      if(opcode===0x1)this.emit('message',payload.toString('utf8'));
    }
  }
}
server.on('upgrade',(req,sock)=>{
  const key=req.headers['sec-websocket-key'];
  if(!key||String(req.headers.upgrade||'').toLowerCase()!=='websocket'){sock.destroy();return;}
  const accept=crypto.createHash('sha1').update(key+WS_GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  const ws=new MiniSocket(sock);
  ws.on('message',d=>handleMessage(ws,d));ws.on('close',()=>leave(ws));ws.on('error',()=>{});send(ws,{t:'hello',version:'1.0.0'});
});

setInterval(()=>{
  const now=Date.now(); const dt=Math.min(.12,(now-lastTick)/1000); lastTick=now;
  for (const room of rooms.values()) updateRoom(room,dt,now);
  if (now-lastBroadcast>=BROADCAST_MS) { lastBroadcast=now; for (const room of rooms.values()) if(room.players.size) roomStateBroadcast(room); }
  for (const [code,room] of rooms) if(room.players.size===0 && room.emptyAt && now-room.emptyAt>15*60*1000) rooms.delete(code);
},TICK_MS);

server.listen(PORT,()=>console.log(`Mysterious Woods running at http://localhost:${PORT}`));
