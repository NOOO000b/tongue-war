// 舌戰：多人連線伺服器
// 移動由玩家自己的電腦計算（盪鞦韆手感才不會有延遲），
// 抓人、拉扯、繞柱斷線、吃人、計分、各模式規則由伺服器判定，大家看到的結果才會一致。
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

// ===== 共用規則參數 =====
const RANGE = 50, HUNTER_RANGE = 70;   // 舌頭射程（獵人比較遠）
const PULL_BASE = 5;        // 抓到人之後，舌頭自己收回的速度
const CLICK_BOOST = 2;      // 每點一下，拉的速度增加多少
const MAX_BOOST = 8;        // 連點加速上限
const BOOST_DECAY = 4;      // 加速消退速度
const EAT_DIST = 2.0;       // 拉到嘴巴前多近算吃掉
const DIGEST = 4;           // 嚼多久（會重生的模式，幾秒後重生）
// 被抓時的逃法（和遊戲裡一樣）
const ANCHOR_MAX = 3;       // 勾牆抵抗：最多撐幾秒
const ANCHOR_DRAIN = 0.15;  // 對方每點一下，少撐幾秒
const JERK_GAIN = 0.2;      // 甩動掙脫：每甩一下鬆開多少（到 1 就斷）
const JERK_DECAY = 0.15;    // 每秒自己恢復多少
const CLICK_TIGHTEN = 0.04; // 對方每點一下拉緊多少
// 角色技能（冷卻秒數；和遊戲裡的角色表一樣）
const SKILL_CD = { frog: 25, fire: 40, water: 40, cloud: 45, ice: 40, earth: 40, poison: 40, light: 45 };
const DASH_GRAB_ADD = 10;    // 青蛙被抓時衝刺：舌頭變長幾公尺（拿蛋時減半）
const FIRE_TIME = 6000, WEAK_TIME = 6000, WEAK_PULL = 1.5;   // 火蛙：燃燒 6 秒，燒完 6 秒內被拉得快 50%
const SMOKE_R = 7, SMOKE_TIME = 6000;                         // 雲蛙：雲霧半徑、維持多久
const WALL_W = 7, WALL_H = 4.5, WALL_T = 1.2, WALL_TIME = 5000, WALL_HITS = 3;   // 土蛙：土牆大小、維持多久、被打中幾次會碎
const FREEZE_TIME = 1000, POISON_TIME = 4000, IMMUNE_TIME = 5000, FLASH_R = 20;  // 冰凍、中毒的時間；控制結束後免疫多久；閃光範圍
// 控制效果（凍住、中毒、失明）：結束後 5 秒內不會再被控制
function applyCC(p, key, ms) {
  const now = Date.now(); if ((p.immuneUntil || 0) > now) return false;
  p[key] = now + ms; p.immuneUntil = now + ms + IMMUNE_TIME; return true;
}
// 土牆：把世界座標換成土牆自己的座標（x 沿著牆、z 是牆的厚度方向）
function wallLocal(w, x, y, z) { const dx = x - w.x, dz = z - w.z, c = Math.cos(w.yaw), s = Math.sin(w.yaw); return [dx * c - dz * s, y - w.y - WALL_H / 2, dx * s + dz * c]; }
function segHitsWall(a, b, w) {
  const A = wallLocal(w, ...a), B = wallLocal(w, ...b), H = [WALL_W / 2, WALL_H / 2, WALL_T / 2]; let t0 = 0, t1 = 1;
  for (let k = 0; k < 3; k++) {
    const d = B[k] - A[k];
    if (Math.abs(d) < 1e-9) { if (Math.abs(A[k]) > H[k]) return false; continue; }
    let ta = (-H[k] - A[k]) / d, tb = (H[k] - A[k]) / d; if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); if (t0 > t1) return false;
  }
  return true;
}
const RESULT_TIME = 10;     // 結算畫面幾秒
const ROUND_BREAK = 5;      // 回合之間休息幾秒
const MAX_PLAYERS = 10;
const TICK = 1 / 30, SEND_EVERY = 2;   // 每秒算 30 次、送 15 次狀態
const T = (sec) => (+process.env.MATCH_TIME || sec);   // 測試時可以用環境變數把時間縮短

// ===== 模式 =====
const MODES = {
  team:    { name: '團隊吞噬戰', teams: true,  time: 360, desc: '吃掉對手得分，6 分鐘內得分多的隊伍獲勝' },
  elim:    { name: '全滅戰',     teams: true,  time: 180, rounds: 3, desc: '被吃就出局；隊友吃掉吃你的人就能救你出來。全隊出局就輸掉這回合，三戰兩勝' },
  egg:     { name: '搶蛋模式',   teams: true,  time: 480, desc: '把中間的蛋搬回自己的基地得分。拿著蛋會變慢、不能抓人' },
  hunt:    { name: '獵人與獵物', teams: false, time: 240, rounds: 3, desc: '獵人要吃光所有獵物；獵物撐到時間結束就贏，打中正在拉人的獵人可以救同伴' },
  race:    { name: '競速模式',   teams: false, time: 300, desc: '依序穿過空中的圈圈跑兩圈，先到終點的贏。舌頭可以把對手往回拉' },
  hill:    { name: '王者之山',   teams: true,  time: 360, desc: '只有你們隊站在發光區域裡時，每秒得 1 分。區域每 90 秒換位置' },
  glutton: { name: '大胃王',     teams: false, time: 420, desc: '個人大亂鬥：吃人得 1 分，吃掉頭戴皇冠的第一名得 2 分' },
};

// ===== 地圖：六張地圖的資料都在 public/maps.js（遊戲和伺服器共用同一份）=====
const TW_MAPS = require('./public/maps.js');
const ZONE_MOVE = 90, LAPS = 2;
// 每個房間用自己的地圖。伺服器一次只處理一件事，所以處理某個房間之前，
// 先用 useMap() 把下面這些「目前地圖」的變數換成那個房間的地圖就好。
let MAP, trunks, rocks, terrainRaw, terrainH, MAP_R, BASE_Z, EGG_HOME, BASES, BASE_R, ZONES, ZONE_R, RINGS, RING_R, RACE_CPS;
let CUR_ROOM = null;               // 目前正在處理的房間（土牆會擋舌頭）
function useMap(id, room) {
  CUR_ROOM = room || null;
  MAP = TW_MAPS.load(id);
  trunks = MAP.layout.trunks; rocks = MAP.layout.rocks;
  terrainRaw = MAP.terrainH;                                              // 沒有地面的地方（雲海）會回傳 null
  terrainH = (x, z) => { const h = terrainRaw(x, z); return h === null ? -1e4 : h; };
  MAP_R = MAP.R; BASE_Z = MAP.baseZ;
  const A = MAP.anchors;
  EGG_HOME = A.eggHome; BASES = A.bases; BASE_R = A.baseR; ZONES = A.zones; ZONE_R = A.zoneR;
  RINGS = A.rings; RING_R = A.ringR; RACE_CPS = RINGS.length * LAPS;
}
useMap('forest');
const clearOf = (x, z, pad) => trunks.every(([tx, tz, r]) => Math.hypot(x - tx, z - tz) > r + pad);

// ===== 小工具 =====
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const hdist = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
function segPoint(a, b, c) {
  const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(c, a), ab) / (dot(ab, ab) || 1)));
  return { d: dist([a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t], c), t };
}
function lineBlocked(a, b) {
  if (CUR_ROOM) for (const w of CUR_ROOM.walls) if (segHitsWall(a, b, w)) return true;   // 土牆擋住
  for (const [x, z, r, h] of trunks) {
    const { d, t } = segPoint([a[0], 0, a[2]], [b[0], 0, b[2]], [x, 0, z]);
    if (d < r * 0.92 && a[1] + (b[1] - a[1]) * t < h) return true;
  }
  for (const [x, y, z, r] of rocks) if (segPoint(a, b, [x, y, z]).d < r * 0.85) return true;
  // 山丘擋住（和遊戲裡一樣的判斷方式）
  const L = dist(a, b), n = Math.ceil(L / 1.5);
  for (let i = 1; i < n; i++) {
    const t = i / n; if (t * L < 1.5 || (1 - t) * L < 1.5) continue;
    const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, z = a[2] + (b[2] - a[2]) * t;
    if (y < terrainH(x, z) + 0.3 || MAP.extraBlock(x, y, z)) return true;
  }
  return false;
}
const mouthOf = (p) => [p.pos[0] - Math.sin(p.face) * 0.8, p.pos[1] + 0.4, p.pos[2] - Math.cos(p.face) * 0.8];
function randomSpot(others, cx, cz, spread) {
  for (let i = 0; i < 80; i++) {
    const x = cx + (Math.random() - 0.5) * spread, z = cz + (Math.random() - 0.5) * spread;
    if (Math.hypot(x, z) > MAP_R - 4 || terrainRaw(x, z) === null || !clearOf(x, z, 3)) continue;
    if (others.some((q) => Math.hypot(q[0] - x, q[2] - z) < 6)) continue;
    return [x, terrainH(x, z) + 1, z];
  }
  return [cx, terrainH(cx, cz) + 1, cz];
}
const PALETTE = {
  red: ['#e0892a', '#e8564a', '#f2b632', '#e86fa3', '#c9692e'],
  blue: ['#3f8fd1', '#2fb3b8', '#9b6bd6', '#5a6fe0', '#47a3e8'],
  ffa: ['#5f9a2a', '#e0892a', '#3f8fd1', '#9b6bd6', '#e8564a', '#2fb3b8', '#f2b632', '#e86fa3', '#8a6d4a', '#6fc24a'],
};
const cleanName = (s) => String(s || '').replace(/[<>&"'`]/g, '').trim().slice(0, 10) || '無名蛙';
const cleanRoom = (s) => String(s || '').replace(/[^\w\u4e00-\u9fff-]/g, '').slice(0, 16);
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const vec = (a, d) => (Array.isArray(a) && a.length === 3 && a.every(Number.isFinite) ? a : d);
const TEAM_NAME = { red: '紅隊', blue: '藍隊' };

// ===== 房間 =====
const rooms = new Map();
function makeRoom(code, mode, mapId) {
  if (!TW_MAPS.LIST.includes(mapId)) mapId = 'forest';
  useMap(mapId);
  const room = { code, mode, map: mapId, M: MODES[mode], players: new Map(), grabs: [], phase: 'play', tick: 0, round: 1, smokes: [], walls: [], fxSeq: 1,
    score: { red: 0, blue: 0 }, wins: { red: 0, blue: 0 }, endsAt: 0, egg: null, zone: null, race: null, hunters: [], huntOrder: 0 };
  rooms.set(code, room);
  resetRound(room, true);
  return room;
}
const alive = (room) => [...room.players.values()].filter((p) => !p.out && !p.eatenBy);
const members = (room, team) => [...room.players.values()].filter((p) => p.team === team);
function pickTeam(room) {
  if (!room.M.teams) return room.mode === 'hunt' ? 'prey' : null;
  const red = members(room, 'red').length, blue = members(room, 'blue').length;
  return red <= blue ? 'red' : 'blue';
}
function pickColor(room, team) {
  const used = new Set([...room.players.values()].map((p) => p.color));
  const pal = PALETTE[team === 'red' || team === 'blue' ? team : 'ffa'];
  return pal.find((c) => !used.has(c)) || pal[Math.floor(Math.random() * pal.length)];
}
function spawnFor(room, p) {
  const others = [...room.players.values()].filter((o) => o !== p).map((o) => o.pos);
  const S = MAP_R / 125;                       // 以呱呱森林的大小為基準，按地圖大小換算
  // 雲端浮島：只能出生在島上（自己那一側的島）
  if (MAP.spawnIslands) {
    let isl = MAP.spawnIslands.filter((i) => (p.team === 'red' ? i.z >= -1 : p.team === 'blue' ? i.z <= 1 : true));
    if (room.mode === 'hunt') isl = p.role === 'hunter' ? MAP.spawnIslands.filter((i) => i.x === 0 && i.z === 0) : MAP.spawnIslands.filter((i) => !(i.x === 0 && i.z === 0));
    for (let t = 0; t < 120; t++) {
      const i = isl[Math.floor(Math.random() * isl.length)], a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * (i.r - 3.5);
      const x = i.x + Math.cos(a) * d, z = i.z + Math.sin(a) * d;
      if (!clearOf(x, z, 2) || others.some((q) => Math.hypot(q[0] - x, q[2] - z) < 4)) continue;
      return [x, terrainH(x, z) + 1, z];
    }
    return [0, terrainH(0, 10) + 1, 10];
  }
  // 井底之呱：出生在外圍森林（隊伍模式在自己那一側；獵人模式的獵人在井底）
  if (MAP.spawnRing && room.mode !== 'race' && !(room.mode === 'hunt' && p.role === 'hunter')) {
    const [r0, r1] = MAP.spawnRing;
    for (let t = 0; t < 120; t++) {
      let a = Math.random() * Math.PI * 2;
      if (p.team === 'red') a = 0.25 + Math.random() * (Math.PI - 0.5); else if (p.team === 'blue') a = -0.25 - Math.random() * (Math.PI - 0.5);
      const d = r0 + Math.random() * (r1 - r0), x = Math.cos(a) * d, z = Math.sin(a) * d;
      if (!clearOf(x, z, 3) || others.some((q) => Math.hypot(q[0] - x, q[2] - z) < 6)) continue;
      return [x, terrainH(x, z) + 1, z];
    }
  }
  if (room.mode === 'egg') { const b = BASES[p.team]; return randomSpot(others, b[0], b[1], Math.max(16, 22 * S)); }
  if (room.mode === 'race') return randomSpot(others, RINGS[RINGS.length - 1][0] * 0.5, RINGS[RINGS.length - 1][2] * 0.5, 14);
  if (room.mode === 'hunt') return p.role === 'hunter' ? randomSpot(others, 0, 0, 16 * S + 4) : randomSpot(others, (Math.random() < 0.5 ? 1 : -1) * 60 * S, (Math.random() < 0.5 ? 1 : -1) * 60 * S, 30 * S + 6);
  if (p.team === 'red' || p.team === 'blue') return randomSpot(others, 0, (p.team === 'red' ? 1 : -1) * 50 * S, 110 * S);
  return randomSpot(others, 0, 0, 160 * S);
}
const emitRoom = (room, ev, data) => io.to(room.code).emit(ev, data);
const note = (room, text) => emitRoom(room, 'note', text);

function respawn(room, p) {
  if (p.away) { p.eatenBy = 'away'; p.out = false; p.heldBy = null; return; }   // 暫停中：先不要出現，回來再重生
  p.eatenBy = null; p.out = false; p.heldBy = null; p.slip = true; p.an = false;
  p.pos = spawnFor(room, p); p.vel = [0, 0, 0];
  io.to(p.id).emit('respawn', { pos: p.pos });
}
// 新的一回合（或新的一場）
function resetRound(room, fullMatch) {
  room.phase = 'play'; room.roundStart = Date.now();
  room.endsAt = Date.now() + T(room.M.time) * 1000;
  for (const g of [...room.grabs]) releaseGrab(room, g, null);
  if (fullMatch) { room.score = { red: 0, blue: 0 }; room.wins = { red: 0, blue: 0 }; room.round = 1; for (const p of room.players.values()) { p.k = 0; p.deaths = 0; p.esc = 0; p.res = 0; p.best = 0; } }
  if (room.mode === 'egg') room.egg = { pos: [...EGG_HOME], carrier: null, droppedAt: 0 };
  if (room.mode === 'hill') { room.zone = { i: 0, owner: null, movesAt: Date.now() + ZONE_MOVE * 1000, acc: 0 }; }
  if (room.mode === 'race') { room.race = { finished: [], firstAt: 0 }; for (const p of room.players.values()) { p.cp = 0; p.lastPos = null; } }
  if (room.mode === 'hunt') assignHunters(room);
  for (const p of room.players.values()) respawn(room, p);
}
function assignHunters(room) {
  const list = [...room.players.values()];
  const n = list.length >= 5 ? 2 : 1;
  for (const p of list) { p.role = 'prey'; p.team = 'prey'; }
  for (let i = 0; i < Math.min(n, list.length); i++) {
    const p = list[(room.huntOrder + i) % list.length];
    p.role = 'hunter'; p.team = 'hunter';
  }
  room.huntOrder += n;
  room.hunters = list.filter((p) => p.role === 'hunter').map((p) => p.id);
}

// ===== 抓人、拉扯、吃人 =====
function releaseGrab(room, g, reason) {
  room.grabs = room.grabs.filter((x) => x !== g);
  if (reason === 'snap' || reason === 'slip' || reason === 'jerk') { const v = room.players.get(g.vic); if (v) v.esc++; }   // 逃脫成功
  emitRoom(room, 'release', { att: g.att, vic: g.vic, reason });
}
function startGrab(room, att, vic) {
  const freed = room.grabs.filter((g) => g.att === vic.id);
  for (const g of freed) releaseGrab(room, g, 'rescued');
  if (freed.length) att.res++;                                      // 抓住正在拉人的對手：救了被抓的人
  att.best = Math.max(att.best, dist(mouthOf(att), vic.pos));      // 最遠一次抓到人
  const g = { att: att.id, vic: vic.id, L: dist(mouthOf(att), vic.pos), boost: 0, at: Date.now(), loose: 0, anchorUsed: 0 };
  room.grabs.push(g);
  emitRoom(room, 'grab', { att: att.id, vic: vic.id });
}
function dropEgg(room, p) {
  if (room.egg && room.egg.carrier === p.id && terrainRaw(p.pos[0], p.pos[2]) === null) { room.egg = { pos: [...EGG_HOME], carrier: null, droppedAt: 0 }; note(room, '蛋回到中間了'); return; }
  if (room.egg && room.egg.carrier === p.id) { room.egg.carrier = null; room.egg.pos = [p.pos[0], terrainH(p.pos[0], p.pos[2]) + 0.8, p.pos[2]]; room.egg.droppedAt = Date.now(); note(room, `${p.name} 的蛋掉了！`); }
}
function eat(room, g) {
  const att = room.players.get(g.att), vic = room.players.get(g.vic);
  room.grabs = room.grabs.filter((x) => x !== g);
  for (const o of room.grabs.filter((o) => o.att === vic.id || o.vic === vic.id)) releaseGrab(room, o, null);
  dropEgg(room, vic);
  vic.deaths++;
  const m = room.mode;
  if (m === 'elim' || m === 'hunt') {
    vic.eatenBy = att.id; vic.out = true; vic.heldBy = att.id; vic.respawnAt = Infinity;
  } else { vic.eatenBy = att.id; vic.respawnAt = Date.now() + DIGEST * 1000; }
  // 計分
  if (m === 'team') room.score[att.team]++;
  if (m === 'elim' || m === 'team' || m === 'egg' || m === 'hill') att.k += m === 'team' || m === 'elim' ? 1 : 0;
  if (m === 'hunt') att.k += 3;
  if (m === 'glutton') {
    const lead = leader(room);
    const bonus = lead && lead.id === vic.id && vic.k > 0 ? 2 : 1;
    att.k += bonus;
    if (bonus === 2) note(room, `${att.name} 吃掉了第一名 ${vic.name}！得 2 分`);
  }
  emitRoom(room, 'eat', { att: att.id, vic: vic.id, out: !!vic.out });
  // 全滅戰：吃人的人被吃掉 → 牠肚子裡的人全部被救出來
  for (const q of room.players.values()) {
    if (q.heldBy === vic.id && q.out) {
      q.out = false; q.eatenBy = null; q.heldBy = null; q.pos = [vic.pos[0] + (Math.random() - 0.5) * 4, 0, vic.pos[2] + (Math.random() - 0.5) * 4]; q.pos[1] = terrainH(q.pos[0], q.pos[2]) + 1; q.vel = [0, 0, 0];
      io.to(q.id).emit('respawn', { pos: q.pos });
      note(room, `${q.name} 從 ${vic.name} 的肚子裡被救出來了！`);
    }
  }
}
function leader(room) {
  let best = null;
  for (const p of room.players.values()) if (!best || p.k > best.k) best = p;
  return best && best.k > 0 ? best : null;
}
function canGrab(room, me, vic) {
  if (!vic || vic === me || vic.out || vic.eatenBy || me.out || me.eatenBy) return false;
  if (room.phase !== 'play') return false;
  if (room.M.teams && vic.team === me.team) return false;
  if (room.mode === 'hunt' && me.role === vic.role) return false;
  if (room.mode === 'egg' && room.egg.carrier === me.id) return false;           // 拿著蛋不能抓人
  if (room.grabs.some((g) => g.vic === vic.id || g.vic === me.id || g.att === me.id)) return false;
  const range = room.mode === 'hunt' && me.role === 'hunter' ? HUNTER_RANGE : RANGE;
  if (dist(me.pos, vic.pos) > range + 6 || lineBlocked(mouthOf(me), vic.pos)) return false;
  return true;
}

// ===== 每個模式的回合判定、計分、畫面上方顯示 =====
function hudOf(room) {
  const m = room.mode, segs = [];
  if (m === 'team' || m === 'egg' || m === 'hill') {
    segs.push({ t: `紅隊 ${room.score.red}`, c: 'red' }, { t: `${room.score.blue} 藍隊`, c: 'blue' });
  } else if (m === 'elim') {
    const ar = alive(room).filter((p) => p.team === 'red').length, ab = alive(room).filter((p) => p.team === 'blue').length;
    segs.push({ t: `紅 ${room.wins.red} 勝｜剩 ${ar}`, c: 'red' }, { t: `剩 ${ab}｜${room.wins.blue} 勝 藍`, c: 'blue' });
  } else if (m === 'hunt') {
    if (room.players.size < 2) segs.push({ t: '等待更多玩家加入…', c: '' });
    else segs.push({ t: `第 ${room.round}/${room.M.rounds} 回合`, c: '' }, { t: `獵物剩 ${alive(room).filter((p) => p.role === 'prey').length}`, c: '' });
  } else if (m === 'race') {
    segs.push({ t: `兩圈・${RINGS.length} 個圈圈`, c: '' });
  } else if (m === 'glutton') {
    const l = leader(room); segs.push({ t: l ? `第一名：${l.name} ${l.k} 分` : '還沒有人吃到', c: '' });
  }
  return segs;
}
function endRound(room, title, sub) {
  for (const g of [...room.grabs]) releaseGrab(room, g, null);
  const M = room.M;
  if (M.rounds && room.round < M.rounds && !(room.mode === 'elim' && Math.max(room.wins.red, room.wins.blue) >= 2)) {
    room.phase = 'break'; room.endsAt = Date.now() + ROUND_BREAK * 1000;
    emitRoom(room, 'match', { phase: 'break', title, sub, rows: [] });
  } else finishMatch(room, title, sub);
}
// 記錄一個玩家這場的成績（同一個帳號的紀錄一筆一筆依序處理，不會互相蓋掉）
const recordQueue = new Map();
function recordMatch(p, room, won) {
  const uid = p.userId, sid = p.id, eats = room.mode === 'race' ? 0 : p.k || 0;
  const m = { esc: p.esc || 0, res: p.res || 0, best: Math.round(p.best || 0), deaths: p.deaths || 0, char: p.char, map: room.map, mode: room.mode };
  const job = (recordQueue.get(uid) || Promise.resolve()).then(async () => {
    const prof = await loadProfile({ uid, name: p.name });
    const before = new Set(achReady(prof).map((x) => `${x.id}:${x.tier}`));
    const st = { ...(prof.stats || {}) };
    st.esc = (st.esc || 0) + m.esc; st.res = (st.res || 0) + m.res;
    st.maxEat = Math.max(st.maxEat || 0, eats); st.best = Math.max(st.best || 0, m.best);
    if (won) {
      st.maps = [...new Set([...(st.maps || []), m.map])]; st.modes = [...new Set([...(st.modes || []), m.mode])];
      st.charWins = { ...(st.charWins || {}), [m.char]: ((st.charWins || {})[m.char] || 0) + 1 };
      if (m.deaths === 0) st.flawless = 1;
    }
    const today = new Date().toISOString().slice(0, 10), daily = won && st.lastWinDay !== today;   // 每天第一次贏
    if (daily) st.lastWinDay = today;
    const coins = COIN_PLAY + COIN_EAT * Math.min(eats, COIN_EAT_MAX) + (won ? COIN_WIN : 0) + (daily ? COIN_DAILY : 0);
    await updateProfile(uid, { stats: st });
    await addMatchStatsNow(uid, 1, won ? 1 : 0, eats, coins);
    const after = { ...prof, stats: st, games: (prof.games || 0) + 1, wins: (prof.wins || 0) + (won ? 1 : 0), eats: (prof.eats || 0) + eats };
    const fresh = achReady(after).filter((x) => !before.has(`${x.id}:${x.tier}`))
      .map((x) => { const a = ACHIEVEMENTS.find((y) => y.id === x.id); return `${a.name}${a.tiers.length > 1 ? ['（銅）', '（銀）', '（金）'][x.tier] : ''}`; });
    io.to(sid).emit('reward', { coins, daily, ach: fresh });                   // 告訴那個玩家：這場拿到多少金幣、達成了哪些成就
  }).catch((e) => console.error('記錄比賽成績時出錯：', e.message));
  recordQueue.set(uid, job);
  job.finally(() => { if (recordQueue.get(uid) === job) recordQueue.delete(uid); });
}
function finishMatch(room, roundTitle, roundSub) {
  for (const g of [...room.grabs]) releaseGrab(room, g, null);
  room.phase = 'results'; room.endsAt = Date.now() + RESULT_TIME * 1000;
  const m = room.mode, ps = [...room.players.values()];
  let title = '', sub = '', rows = [];
  const teamWin = (a, b) => (a === b ? 'tie' : a > b ? 'red' : 'blue');
  if (m === 'team' || m === 'egg' || m === 'hill') {
    const w = teamWin(room.score.red, room.score.blue);
    title = w === 'tie' ? '平手！' : `${TEAM_NAME[w]}獲勝！`; sub = `${room.score.red} : ${room.score.blue}`;
  } else if (m === 'elim') {
    const w = teamWin(room.wins.red, room.wins.blue);
    title = w === 'tie' ? '平手！' : `${TEAM_NAME[w]}獲勝！`; sub = `回合 ${room.wins.red} : ${room.wins.blue}`;
  } else {
    title = roundTitle || '比賽結束'; sub = roundSub || '';
  }
  const label = { team: '吃掉', elim: '吃掉', egg: '搬蛋', hill: '佔領秒數', hunt: '分數', race: '圈圈', glutton: '分數' }[m];
  if (m === 'race') {
    const order = [...room.race.finished.map((id) => room.players.get(id)).filter(Boolean),
      ...ps.filter((p) => !room.race.finished.includes(p.id)).sort((a, b) => b.cp - a.cp)];
    rows = order.map((p, i) => ({ n: `${i + 1}. ${p.name}`, v: room.race.finished.includes(p.id) ? '完成' : `${p.cp}/${RACE_CPS}`, id: p.id }));
    if (room.race.finished.length) title = `${order[0].name} 第一名！`;
    else if (order[0] && order[0].cp > 0) { title = '時間到！'; sub = `${order[0].name} 跑得最遠`; }
    else title = '時間到！';
  } else {
    rows = ps.sort((a, b) => b.k - a.k).map((p) => ({ n: p.name, v: `${p.k}`, team: p.team, id: p.id }));
    // 個人賽：分數最高的人就是冠軍
    if (m === 'glutton' || m === 'hunt') {
      const top = ps[0];
      title = top && top.k > 0 ? (m === 'glutton' ? `${top.name} 是大胃王！` : `${top.name} 拿下最高分！`) : '比賽結束';
      sub = top && top.k > 0 ? `${top.k} 分` : '';
    }
  }
  // 結算畫面用：每個人的數據、名次順序、獲勝的隊伍
  const stats = [...room.players.values()].map((p) => ({ id: p.id, n: p.name, team: p.team, ch: p.char, k: p.k, d: p.deaths, esc: p.esc, res: p.res, best: Math.round(p.best) }));
  const order = rows.map((r) => r.id).filter(Boolean);
  let winner = null;
  if (m === 'team' || m === 'egg' || m === 'hill') winner = teamWin(room.score.red, room.score.blue);
  else if (m === 'elim') winner = teamWin(room.wins.red, room.wins.blue);
  if (winner === 'tie') winner = null;
  // 有登入的玩家：把這一場的戰績加進資料庫（勝場：隊伍模式看隊伍有沒有贏，個人模式看是不是第一名；金幣之後再做）
  // 隊伍模式看隊伍有沒有贏（平手就是沒贏）；個人模式看是不是第一名
  const teamMode = ['team', 'egg', 'hill', 'elim'].includes(m);
  if (ACCOUNTS) for (const p of room.players.values()) if (p.userId) {
    const won = teamMode ? !!winner && p.team === winner : order[0] === p.id;
    recordMatch(p, room, won);
  }
  emitRoom(room, 'match', { phase: 'results', title, sub, label, rows, stats, order, winner, next: RESULT_TIME });
}
function modeTick(room, now) {
  const m = room.mode;
  // 搶蛋
  if (m === 'egg' && room.phase === 'play') {
    const egg = room.egg;
    if (egg.carrier) {
      const c = room.players.get(egg.carrier);
      if (!c || c.out || c.eatenBy) { if (c) dropEgg(room, c); else { egg.carrier = null; egg.droppedAt = now; } }
      else {
        egg.pos = [c.pos[0], c.pos[1] + 2.2, c.pos[2]];
        if (hdist(c.pos, [BASES[c.team][0], 0, BASES[c.team][1]]) < BASE_R && c.pos[1] < terrainH(BASES[c.team][0], BASES[c.team][1]) + 6) {
          room.score[c.team]++; c.k++;
          note(room, `${c.name} 把蛋搬回${TEAM_NAME[c.team]}基地！`);
          room.egg = { pos: [...EGG_HOME], carrier: null, droppedAt: 0 };
        }
      }
    } else {
      for (const p of alive(room)) if (dist(p.pos, egg.pos) < 2.6) { egg.carrier = p.id; note(room, `${p.name} 撿到蛋了！`); break; }
      if (!egg.carrier && egg.droppedAt && now - egg.droppedAt > 15000) { room.egg = { pos: [...EGG_HOME], carrier: null, droppedAt: 0 }; note(room, '蛋回到中間了'); }
    }
  }
  // 王者之山
  if (m === 'hill' && room.phase === 'play') {
    const z = room.zone, c = ZONES[z.i];
    if (now >= z.movesAt) { z.i = (z.i + 1) % ZONES.length; z.movesAt = now + ZONE_MOVE * 1000; note(room, '發光區域換位置了！'); }
    const inside = alive(room).filter((p) => Math.hypot(p.pos[0] - c[0], p.pos[2] - c[1]) < ZONE_R && p.pos[1] < terrainH(p.pos[0], p.pos[2]) + 8);
    const teams = new Set(inside.map((p) => p.team));
    z.owner = teams.size === 1 ? [...teams][0] : teams.size > 1 ? 'contest' : null;
    z.acc += TICK;
    if (z.acc >= 1) {
      z.acc -= 1;
      if (z.owner === 'red' || z.owner === 'blue') { room.score[z.owner]++; for (const p of inside) p.k++; }
    }
    if (room.score.red >= 100 || room.score.blue >= 100) finishMatch(room);
  }
  // 全滅戰：一隊全部出局就輸掉這回合
  if (m === 'elim' && room.phase === 'play') {
    const ar = alive(room).filter((p) => p.team === 'red').length, ab = alive(room).filter((p) => p.team === 'blue').length;
    const both = members(room, 'red').length > 0 && members(room, 'blue').length > 0;
    let w = null;
    if (both && ar === 0) w = 'blue'; else if (both && ab === 0) w = 'red';
    else if (now >= room.endsAt) w = ar === ab ? 'tie' : ar > ab ? 'red' : 'blue';
    if (w) {
      if (w !== 'tie') room.wins[w]++;
      endRound(room, w === 'tie' ? '這回合平手' : `${TEAM_NAME[w]}贏下第 ${room.round} 回合`, `回合 ${room.wins.red} : ${room.wins.blue}`);
    }
  }
  // 獵人與獵物：至少要 2 個人；人數夠了但還沒有獵人，就開始新的一回合並分配獵人
  if (m === 'hunt' && room.phase === 'play' && room.players.size >= 2 && !members(room, 'hunter').length) {
    resetRound(room, false); emitRoom(room, 'match', { phase: 'play' }); note(room, '獵人與獵物開始！');
  }
  if (m === 'hunt' && room.phase === 'play' && room.players.size >= 2) {
    const prey = alive(room).filter((p) => p.role === 'prey');
    if (prey.length === 0) endRound(room, '獵人贏了！', '獵物全部被吃光');
    else if (now >= room.endsAt) { for (const p of prey) p.k += 5; endRound(room, '獵物贏了！', `撐到最後的獵物各得 5 分`); }
  }
  // 競速：第一名到終點後 20 秒結束
  if (m === 'race' && room.phase === 'play' && room.race.firstAt && now - room.race.firstAt > 20000) finishMatch(room);
  // 時間到
  if (room.phase === 'play' && now >= room.endsAt && !(m === 'elim' || m === 'hunt')) finishMatch(room);
  // 休息、結算結束
  if (room.phase === 'break' && now >= room.endsAt) { room.round++; resetRound(room, false); emitRoom(room, 'match', { phase: 'play' }); }
  if (room.phase === 'results' && now >= room.endsAt) { resetRound(room, true); emitRoom(room, 'match', { phase: 'play' }); }
}
// 競速：檢查有沒有穿過下一個圈圈（用上一筆到這一筆位置的線段判斷，速度快也不會漏掉）
function raceCheck(room, p) {
  if (room.mode !== 'race' || room.phase !== 'play' || p.cp >= RACE_CPS) { p.lastPos = p.pos; return; }
  const ring = RINGS[p.cp % RINGS.length], a = p.lastPos || p.pos;
  if (segPoint(a, p.pos, ring).d < RING_R) {
    p.cp++; p.k = p.cp;
    if (p.cp >= RACE_CPS) {
      room.race.finished.push(p.id);
      if (!room.race.firstAt) room.race.firstAt = Date.now();
      note(room, `${p.name} 第 ${room.race.finished.length} 個抵達終點！`);
      if (room.race.finished.length === room.players.size) finishMatch(room);
    }
  }
  p.lastPos = p.pos;
}

// ===== 帳號（Supabase）=====
// 登入（Google、Email＋密碼）由 Supabase 處理；玩家資料存在 Supabase 的資料庫。
// 金鑰放在 Render 的環境變數裡：SUPABASE_URL、SUPABASE_ANON_KEY、SUPABASE_SERVICE_KEY。
// 沒有設定的話，遊戲照樣可以玩，只是只有訪客模式。
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_ANON = process.env.SUPABASE_ANON_KEY || '', SB_SERVICE = process.env.SUPABASE_SERVICE_KEY || '';
const ACCOUNTS = !!(SB_URL && SB_ANON && SB_SERVICE);
const CHAR_IDS = Object.keys(SKILL_CD);
// 商店：角色的價格（青蛙免費）。遊戲畫面上的價格也是從這裡拿的
// 價格分等級：普通 1500、稀有 2500、傳說 4000（以後的新角色照等級排進去）
const CHAR_PRICES = { frog: 0, fire: 1500, water: 1500, cloud: 1500, ice: 2500, earth: 2500, poison: 4000, light: 4000 };
// 打完一場拿到的金幣：參加 +10、每吃掉一隻 +2（每場最多算 10 隻）、贏了再 +15；每天第一次贏再 +50
//（只有登入的玩家、只有多人連線）。大筆的金幣主要從成就拿
const COIN_PLAY = 10, COIN_EAT = 2, COIN_EAT_MAX = 10, COIN_WIN = 15, COIN_DAILY = 50;
const CHAR_NAMES = { frog: '青蛙', fire: '火蛙', water: '水蛙', cloud: '雲蛙', ice: '冰蛙', earth: '土蛙', poison: '毒蛙', light: '光蛙' };
// ===== 成就 =====
// 大部分分成銅、銀、金三階（獎勵 50／150／400）。key：要看的數字（從玩家資料算出來）
const T3 = (a, b, c) => [{ goal: a, reward: 50 }, { goal: b, reward: 150 }, { goal: c, reward: 400 }];
const ACHIEVEMENTS = [
  { id: 'eats', name: '大胃王', desc: '累積吃掉 {n} 隻', icon: 'eat', key: 'eats', tiers: T3(10, 100, 1000) },
  { id: 'escape', name: '逃脫大師', desc: '累積逃脫 {n} 次', icon: 'escape', key: 'esc', tiers: T3(10, 100, 500) },
  { id: 'rescue', name: '救援英雄', desc: '累積救援隊友 {n} 次', icon: 'rescue', key: 'res', tiers: T3(5, 50, 200) },
  { id: 'wins', name: '常勝軍', desc: '累積贏 {n} 場', icon: 'trophy', key: 'wins', tiers: T3(5, 50, 300) },
  { id: 'games', name: '老玩家', desc: '累積打 {n} 場', icon: 'timer', key: 'games', tiers: T3(10, 100, 1000) },
  { id: 'feast', name: '飽餐一頓', desc: '一場吃掉 {n} 隻', icon: 'meat', key: 'maxEat', tiers: T3(5, 8, 12) },
  { id: 'sniper', name: '神射手', desc: '一次抓到 {n} 公尺外的人', icon: 'target', key: 'best', tiers: T3(35, 45, 55) },
  { id: 'maps', name: '地圖探險家', desc: '在 {n} 張不同的地圖各贏過一場', icon: 'frog', key: 'maps', tiers: T3(2, 4, 6) },
  { id: 'modes', name: '全能選手', desc: '在 {n} 種不同的模式各贏過一場', icon: 'help', key: 'modes', tiers: T3(3, 5, 7) },
  { id: 'collector', name: '角色收藏家', desc: '解鎖 {n} 隻角色', icon: 'shop', key: 'owned', tiers: T3(3, 5, CHAR_IDS.length) },
  { id: 'flawless', name: '毫髮無傷', desc: '贏一場而且整場都沒被吃', icon: 'escape', key: 'flawless', tiers: [{ goal: 1, reward: 150 }] },
  // 每隻角色的精通成就：金牌附帶專屬稱號（以後加新角色會自動多一組）
  ...CHAR_IDS.map((c) => ({ id: `char_${c}`, name: `${CHAR_NAMES[c]}精通`, desc: `用${CHAR_NAMES[c]}贏 {n} 場`, icon: 'frog', char: c, key: `char:${c}`, tiers: T3(10, 50, 200), title: `${CHAR_NAMES[c]}大師` })),
];
// 從玩家資料算出成就要看的數字
function achValue(prof, key) {
  const st = prof.stats || {};
  if (key === 'eats' || key === 'wins' || key === 'games') return prof[key] || 0;
  if (key === 'owned') return Array.isArray(prof.owned) ? prof.owned.length : 1;
  if (key === 'maps' || key === 'modes') return Array.isArray(st[key]) ? st[key].length : 0;
  if (key === 'flawless') return st.flawless ? 1 : 0;
  if (key.startsWith('char:')) return (st.charWins || {})[key.slice(5)] || 0;
  return st[key] || 0;
}
// 已經達成（還沒領）的成就：[{ id, tier }]
function achReady(prof) {
  const claimed = new Set(prof.claimed || []), out = [];
  for (const a of ACHIEVEMENTS) { const v = achValue(prof, a.key); a.tiers.forEach((t, i) => { if (v >= t.goal && !claimed.has(`${a.id}:${i}`)) out.push({ id: a.id, tier: i }); }); }
  return out;
}
// 這個角色能不能用：沒設定帳號功能的伺服器全部開放；訪客只能用青蛙；登入的人用自己解鎖的
function canUseChar(char, profile) {
  if (!ACCOUNTS) return true;
  if (char === 'frog') return true;
  return !!(profile && Array.isArray(profile.owned) && profile.owned.includes(char));
}
const cleanNick = (s) => String(s || '').replace(/[<>&"'`\\\n\r\t]/g, '').trim().slice(0, 12) || '青蛙';
// 確認玩家給的登入通行證是真的（問 Supabase），結果記 5 分鐘，不用每次都問
const tokenCache = new Map();
async function verifyToken(token) {
  if (!ACCOUNTS || typeof token !== 'string' || token.length < 20 || token.length > 4096) return null;
  const c = tokenCache.get(token); if (c && c.until > Date.now()) return c;
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_ANON, Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const u = await r.json(); if (!u || !u.id) return null;
    const meta = u.user_metadata || {};
    const info = { uid: u.id, email: u.email || '', name: meta.full_name || meta.name || (u.email || '').split('@')[0], until: Date.now() + 5 * 60 * 1000 };
    if (tokenCache.size > 5000) tokenCache.clear();
    tokenCache.set(token, info); return info;
  } catch (e) { console.error('確認登入時出錯：', e.message); return null; }
}
// 讀寫資料庫用伺服器專用的金鑰（玩家的瀏覽器拿不到，所以金幣、戰績只有伺服器能改）
const sbHeaders = (extra = {}) => ({ apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, 'Content-Type': 'application/json', ...extra });
async function loadProfile(info) {
  const url = `${SB_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(info.uid)}&select=*`;
  let r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`讀取玩家資料失敗（${r.status}）`);
  let rows = await r.json(); if (rows[0]) return rows[0];
  // 第一次登入：建立玩家資料（暱稱先用 Google 名字或 Email 前面那段）
  r = await fetch(`${SB_URL}/rest/v1/profiles`, { method: 'POST', headers: sbHeaders({ Prefer: 'return=representation,resolution=ignore-duplicates' }), body: JSON.stringify({ id: info.uid, nickname: cleanNick(info.name), owned: ['frog'] }) });
  if (!r.ok) throw new Error(`建立玩家資料失敗（${r.status}）`);
  rows = await r.json(); if (rows[0]) return rows[0];
  rows = await (await fetch(url, { headers: sbHeaders() })).json(); return rows[0];
}
async function updateProfile(uid, patch) {
  const r = await fetch(`${SB_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}`, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) });
  if (!r.ok) throw new Error(`更新玩家資料失敗（${r.status}）`);
  return (await r.json())[0];
}
// 比賽結束：場數、勝場、吃掉幾隻、金幣一次加上去（在資料庫裡直接加，不會算錯）
async function addMatchStatsNow(uid, games, wins, eats, coins) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/add_match_stats`, { method: 'POST', headers: sbHeaders(), body: JSON.stringify({ uid, add_games: games, add_wins: wins, add_eats: eats, add_coins: coins }) });
  if (!r.ok) throw new Error(`更新戰績失敗（${r.status}）`);
}
function addMatchStats(uid, games, wins, eats, coins) {
  fetch(`${SB_URL}/rest/v1/rpc/add_match_stats`, { method: 'POST', headers: sbHeaders(), body: JSON.stringify({ uid, add_games: games, add_wins: wins, add_eats: eats, add_coins: coins }) })
    .then((r) => { if (!r.ok) console.error('更新戰績失敗：', r.status); }).catch((e) => console.error('更新戰績時出錯：', e.message));
}
const publicProfile = (p) => ({ nickname: p.nickname, coins: p.coins, owned: p.owned, equipped: p.equipped, games: p.games, wins: p.wins, eats: p.eats, stats: p.stats || {}, claimed: p.claimed || [] });
app.use(express.json({ limit: '8kb' }));
app.get('/config', (req, res) => res.json({ accounts: ACCOUNTS, url: ACCOUNTS ? SB_URL : '', anonKey: ACCOUNTS ? SB_ANON : '', prices: CHAR_PRICES,
  coins: { play: COIN_PLAY, eat: COIN_EAT, eatMax: COIN_EAT_MAX, win: COIN_WIN, daily: COIN_DAILY }, achievements: ACHIEVEMENTS }));
const authOf = (req) => { const h = req.headers.authorization || ''; return verifyToken(h.startsWith('Bearer ') ? h.slice(7) : ''); };
// 讀自己的資料
app.get('/api/me', async (req, res) => {
  const info = await authOf(req); if (!info) return res.status(401).json({ error: '請重新登入' });
  try { res.json({ ...publicProfile(await loadProfile(info)), email: info.email }); } catch (e) { console.error(e.message); res.status(500).json({ error: '讀取玩家資料失敗，請稍後再試' }); }
});
// 改暱稱、改目前選的角色（金幣、戰績不能從這裡改）
app.post('/api/me', async (req, res) => {
  const info = await authOf(req); if (!info) return res.status(401).json({ error: '請重新登入' });
  const b = req.body || {}, patch = {};
  if (typeof b.nickname === 'string') patch.nickname = cleanNick(b.nickname);
  if (!Object.keys(patch).length && !(typeof b.char === 'string')) return res.status(400).json({ error: '沒有要改的東西' });
  try {
    const prof = await loadProfile(info);
    if (typeof b.char === 'string' && CHAR_IDS.includes(b.char)) { if (!canUseChar(b.char, prof)) return res.status(403).json({ error: '這隻角色還沒解鎖' }); patch.equipped = { ...(prof.equipped || {}), char: b.char }; }
    if (!Object.keys(patch).length) return res.status(400).json({ error: '沒有要改的東西' }); res.json({ ...publicProfile(await updateProfile(info.uid, patch)), email: info.email }); } catch (e) { console.error(e.message); res.status(500).json({ error: '儲存失敗，請稍後再試' }); }
});
// 領成就的獎勵：伺服器確認真的達成了；「確認沒領過＋加金幣」在資料庫裡一次完成，不會重複領
app.post('/api/claim', async (req, res) => {
  const info = await authOf(req); if (!info) return res.status(401).json({ error: '請先登入' });
  const { id, tier } = req.body || {}, a = ACHIEVEMENTS.find((x) => x.id === id), t = a && a.tiers[tier];
  if (!t) return res.status(400).json({ error: '沒有這個成就' });
  try {
    const prof = await loadProfile(info);
    if (achValue(prof, a.key) < t.goal) return res.status(400).json({ error: '還沒達成' });
    const r = await fetch(`${SB_URL}/rest/v1/rpc/claim_achievement`, { method: 'POST', headers: sbHeaders(), body: JSON.stringify({ uid: info.uid, akey: `${id}:${tier}`, reward: t.reward }) });
    if (!r.ok) throw new Error(`領取失敗（${r.status}）`);
    const out = await r.json(); if (out && out.error) return res.status(400).json({ error: '已經領過了' });
    res.json({ ...publicProfile(await loadProfile(info)), email: info.email, got: t.reward });
  } catch (e) { console.error(e.message); res.status(500).json({ error: '領取失敗，請稍後再試' }); }
});
// 設定稱號：只能用自己拿到的（角色精通的金牌）
app.post('/api/title', async (req, res) => {
  const info = await authOf(req); if (!info) return res.status(401).json({ error: '請先登入' });
  const title = (req.body || {}).title;
  try {
    const prof = await loadProfile(info), claimed = new Set(prof.claimed || []);
    if (title && !ACHIEVEMENTS.some((a) => a.title === title && claimed.has(`${a.id}:${a.tiers.length - 1}`))) return res.status(400).json({ error: '還沒拿到這個稱號' });
    res.json({ ...publicProfile(await updateProfile(info.uid, { equipped: { ...(prof.equipped || {}), title: title || null } })), email: info.email });
  } catch (e) { console.error(e.message); res.status(500).json({ error: '設定失敗，請稍後再試' }); }
});
// 商店：買角色。扣錢和加進擁有清單在資料庫裡一次完成，不會重複購買、也不會扣錯錢
app.post('/api/buy', async (req, res) => {
  const info = await authOf(req); if (!info) return res.status(401).json({ error: '請先登入' });
  const item = (req.body || {}).item, price = CHAR_PRICES[item];
  if (!price) return res.status(400).json({ error: '沒有這個商品' });
  try {
    await loadProfile(info);
    const r = await fetch(`${SB_URL}/rest/v1/rpc/buy_item`, { method: 'POST', headers: sbHeaders(), body: JSON.stringify({ uid: info.uid, item, price }) });
    if (!r.ok) throw new Error(`購買失敗（${r.status}）`);
    const out = await r.json();
    if (out && out.error) return res.status(400).json({ error: { owned: '已經擁有了', coins: '金幣不夠', no_profile: '找不到玩家資料' }[out.error] || '購買失敗' });
    res.json({ ...publicProfile(await loadProfile(info)), email: info.email });
  } catch (e) { console.error(e.message); res.status(500).json({ error: '購買失敗，請稍後再試' }); }
});
process.on('unhandledRejection', (e) => console.error('沒處理到的錯誤：', e && e.message ? e.message : e));

io.on('connection', (socket) => {
  // 安全措施：每個訊息都先把空的內容（null）換成「沒有」，處理時出錯也只記下來，不會讓整台伺服器當掉
  const rawOn = socket.on.bind(socket);
  socket.on = (ev, fn) => rawOn(ev, (...args) => {
    try { const r = fn(...args.map((x) => (x === null || typeof x !== 'object' ? undefined : x))); if (r && r.catch) r.catch((e) => console.error(`處理「${ev}」時出錯：`, e && e.message)); }
    catch (e) { console.error(`處理「${ev}」時出錯：`, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e); }
  });
  let room = null, me = null;

  let joining = false;
  socket.on('join', async ({ name, room: code, mode, map, char, token } = {}) => {
    if (room || joining) return;
    joining = true;
    let userId = null, prof = null;
    if (token) {
      const info = await verifyToken(token);
      if (info) { userId = info.uid; try { prof = await loadProfile(info); if (prof) name = prof.nickname; } catch (e) { console.error(e.message); } }
    }
    if (!SKILL_CD[char] || !canUseChar(char, prof)) char = 'frog';   // 還沒解鎖的角色不能用（訪客只能用青蛙）
    joining = false;
    if (room || !socket.connected) return;
    if (!MODES[mode]) mode = 'team';
    if (!TW_MAPS.LIST.includes(map)) map = 'forest';
    let rc = cleanRoom(code);
    if (!rc) rc = `大廳-${MODES[mode].name}-${TW_MAPS.load(map).name}`;   // 不填代碼：每種模式、每張地圖各有一個公開大廳
    const r = rooms.get(rc) || makeRoom(rc, mode, map);
    useMap(r.map, r);
    if (r.players.size >= MAX_PLAYERS) return socket.emit('full');
    room = r; socket.join(room.code);
    const team = pickTeam(room);
    me = { id: socket.id, name: cleanName(name), team, role: room.mode === 'hunt' ? 'prey' : null, color: null, pos: [0, 1, 0], vel: [0, 0, 0],
      face: 0, tip: null, tp: null, aim: false, gnd: true, k: 0, deaths: 0, eatenBy: null, out: false, heldBy: null, respawnAt: 0, cp: 0, lastPos: null,
      slip: true, an: false, lastStruggle: 0, esc: 0, res: 0, best: 0,
      char: SKILL_CD[char] ? char : 'frog', skillAt: 0, fireUntil: 0, weakUntil: 0, userId };   // userId：有登入的帳號（訪客是 null）   // 角色、技能下次可以用的時間、燃燒狀態   // esc：逃脫次數、res：救援次數、best：最遠一次抓到人
    me.color = pickColor(room, team);
    room.players.set(me.id, me);
    // 中途加入淘汰制的模式：這回合先觀戰
    if ((room.mode === 'elim' || room.mode === 'hunt') && room.phase === 'play' && room.players.size > 2 && Date.now() > room.roundStart + 10000) {
      me.out = true; me.eatenBy = null;
    }
    me.pos = spawnFor(room, me);
    socket.emit('welcome', {
      id: me.id, name: me.name, account: !!userId, room: room.code, mapId: room.map, mapName: MAP.name, mode: room.mode, modeName: room.M.name, desc: room.M.desc, team, role: me.role, color: me.color, pos: me.pos,
      out: me.out, map: { eggHome: EGG_HOME, bases: BASES, baseR: BASE_R, zones: ZONES, zoneR: ZONE_R, rings: RINGS, ringR: RING_R, laps: LAPS },
    });
    note(room, `${me.name} 加入了${TEAM_NAME[team] || ''}`);
  });

  socket.on('st', (s = {}) => {
    if (room) useMap(room.map, room);
    if (!me || me.eatenBy || me.out) return;
    me.pos = vec(s.p, me.pos); me.vel = vec(s.v, me.vel);
    me.face = num(s.f, me.face); me.gnd = !!s.g; me.aim = !!s.a; me.an = !!s.an;
    me.tp = typeof s.tp === 'string' ? s.tp.slice(0, 6) : null;
    me.tip = s.tip ? vec(s.tip, null) : null;
    raceCheck(room, me);
  });

  socket.on('grab', ({ vic: vid, ice } = {}) => {
    if (room) useMap(room.map, room);
    if (!me) return;
    const vic = room.players.get(vid);
    // 獵物的舌頭打中正在拉人的獵人：救下同伴（獵物不能吃人）
    if (room.mode === 'hunt' && me.role === 'prey' && vic && vic.role === 'hunter' && !me.out && !me.eatenBy) {
      const held = room.grabs.filter((g) => g.att === vic.id);
      for (const g of held) releaseGrab(room, g, 'rescued');
      if (held.length) { me.k += 1; me.res++; note(room, `${me.name} 打中獵人，救了同伴！`); }
      return socket.emit('grabDenied', { vic: vid });
    }
    if (!canGrab(room, me, vic)) return socket.emit('grabDenied', { vic: vid });
    startGrab(room, me, vic);
    if (ice && me.iceArmed > Date.now()) { me.iceArmed = 0; applyCC(vic, 'frozenUntil', FREEZE_TIME); }   // 冰凍舌頭：凍住 1 秒
  });

  socket.on('click', () => {
    if (room) useMap(room.map, room);
    if (!me) return;
    const g = room.grabs.find((g) => g.att === me.id);
    if (!g || !me.aim) return;
    g.boost = Math.min(MAX_BOOST, g.boost + CLICK_BOOST);
    g.loose = Math.max(0, g.loose - CLICK_TIGHTEN);           // 把對方甩鬆的舌頭拉緊
    const vic = room.players.get(g.vic);
    if (vic && vic.an) g.anchorUsed += ANCHOR_DRAIN;          // 對方勾樹撐著：讓牠撐得更短
  });
  // 甩動掙脫：被抓的人每甩一下（最快每 0.2 秒算一次）
  socket.on('struggle', () => {
    if (room) useMap(room.map, room);
    if (!me || me.frozenUntil > Date.now()) return;              // 被凍住時不能甩
    const now = Date.now(); if (now - me.lastStruggle < 200) return; me.lastStruggle = now;
    const g = room.grabs.find((g) => g.vic === me.id); if (!g) return;
    g.loose += JERK_GAIN;
    if (g.loose >= 1) releaseGrab(room, g, 'jerk');
  });
  // 角色技能（遊戲那邊按 Q）：檢查角色和冷卻，再套用會影響拉扯的效果
  socket.on('skill', ({ k } = {}) => {
    if (room) useMap(room.map, room);
    if (!me || me.eatenBy || k !== me.char) return;
    const now = Date.now(); if (now < me.skillAt - 1000) return;            // 冷卻還沒好（留 1 秒誤差）
    if (me.frozenUntil > now) return;                                      // 被凍住時不能用技能
    const g = room.grabs.find((g) => g.vic === me.id), carry = !!(room.egg && room.egg.carrier === me.id);
    if (k === 'water' && !g) return;                                       // 滑溜：被抓住時才能用
    me.skillAt = now + SKILL_CD[k] * 1000;
    if (k === 'frog' && g) { g.dashUntil = now + (carry ? 330 : 600); g.dashMax = g.L + (carry ? DASH_GRAB_ADD / 2 : DASH_GRAB_ADD); }   // 小衝刺：被抓時把距離拉開
    if (k === 'fire') { me.fireUntil = now + FIRE_TIME; me.weakUntil = now + FIRE_TIME + WEAK_TIME; }
    if (k === 'water') releaseGrab(room, g, 'slip');                       // 滑溜：直接脫身
    if (k === 'cloud') room.smokes.push({ id: room.fxSeq++, x: me.pos[0], y: me.pos[1], z: me.pos[2], until: now + SMOKE_TIME });
    if (k === 'ice') me.iceArmed = now + 10000;                            // 下一發舌頭是冰的（10 秒內要射出去）
    if (k === 'poison') me.poisonShotAt = now;                             // 毒液在遊戲那邊飛，打中再告訴伺服器
    if (k === 'earth') {
      // 土牆：在面前升起；被抓住時升在自己和對方中間
      let dx = -Math.sin(me.face), dz = -Math.cos(me.face);
      const att = g && room.players.get(g.att);
      if (att) { dx = att.pos[0] - me.pos[0]; dz = att.pos[2] - me.pos[2]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; }
      const x = me.pos[0] + dx * 3, z = me.pos[2] + dz * 3, gy = terrainRaw(x, z);
      room.walls.push({ id: room.fxSeq++, x, y: gy === null ? me.pos[1] - 1 : Math.min(gy, me.pos[1] - 1), z, yaw: Math.atan2(dx, dz), until: now + WALL_TIME, hits: 0 });
    }
    if (k === 'light') {
      // 閃光彈：20 公尺內、看得到光蛙的人都會失明（隊友也會）；正對著看最久，背對最短
      const eye = (p) => [p.pos[0], p.pos[1] + 0.6, p.pos[2]];
      for (const p of room.players.values()) {
        if (p === me || p.eatenBy || p.out) continue;
        const dx = me.pos[0] - p.pos[0], dz = me.pos[2] - p.pos[2], d = Math.hypot(dx, dz, me.pos[1] - p.pos[1]);
        if (d > FLASH_R || lineBlocked(eye(p), eye(me))) continue;
        const facing = (-Math.sin(p.face) * dx - Math.cos(p.face) * dz) / (Math.hypot(dx, dz) || 1);
        applyCC(p, 'blindUntil', facing > 0.3 ? 2500 : facing > -0.2 ? 1500 : 600);
      }
      emitRoom(room, 'flash', { p: me.pos });
    }
  });
  // 毒液打中人了（毒液是在遊戲那邊飛的）：確認是剛射出去的毒液、距離合理
  socket.on('hit', ({ vic: vid } = {}) => {
    if (room) useMap(room.map, room);
    const now = Date.now(), vic = room && room.players.get(vid);
    if (!me || !vic || me.char !== 'poison' || !(now - (me.poisonShotAt || 0) < 3000)) return;
    if (dist(me.pos, vic.pos) > 45 || vic.eatenBy) return;
    me.poisonShotAt = 0; applyCC(vic, 'poisonUntil', POISON_TIME);
  });
  // 毒液飛出去的樣子：轉給房間裡其他人看
  socket.on('shot', ({ p, v } = {}) => {
    if (!room || !me || me.char !== 'poison' || Date.now() - (me.poisonShotAt || 0) > 1000) return;   // 只有剛吐毒液的毒蛙能送
    if (!Array.isArray(p) || !Array.isArray(v) || p.length !== 3 || v.length !== 3 || ![...p, ...v].every(Number.isFinite)) return;
    socket.to(room.code).emit('shot', { p, v });
  });
  // 舌頭打到土牆：打中 3 次會碎
  socket.on('wallhit', ({ id } = {}) => {
    const now = Date.now(); if (!room || !me || now - (me.lastWallHit || 0) < 250) return; me.lastWallHit = now;
    const w = room.walls.find((w) => w.id === id); if (!w) return;
    if (++w.hits >= WALL_HITS) room.walls = room.walls.filter((x) => x !== w);
  });

  // 暫停（或切到別的分頁）：青蛙先離開戰場，別人看不到、抓不到、也吃不到（不能拿暫停的人刷分）
  // 被抓住時暫停算被吃掉（不能用暫停逃跑）；回合制的模式，這一回合算出局（不能躲到回合結束）
  socket.on('away', ({ on } = {}) => {
    if (!room || !me) return;
    useMap(room.map, room);
    if (on) {
      if (me.away) return;
      me.away = true;
      if (room.phase !== 'play') return;
      const g = room.grabs.find((x) => x.vic === me.id);
      if (g) { eat(room, g); return; }
      if (me.eatenBy || me.out) return;
      for (const o of room.grabs.filter((x) => x.att === me.id)) releaseGrab(room, o, null);
      dropEgg(room, me);
      me.eatenBy = 'away';
      if (room.mode === 'elim' || room.mode === 'hunt') me.out = true;
    } else {
      if (!me.away) return;
      me.away = false;
      if (me.eatenBy && !me.out) me.respawnAt = Math.max(me.respawnAt || 0, Date.now() + 1500);   // 回來之後 1.5 秒在出生點重生
    }
  });

  // 掉下去了（雲端浮島）：會重生的模式 2 秒後重生，淘汰制的模式直接出局
  socket.on('fell', () => {
    if (room) useMap(room.map, room);
    if (!me || me.eatenBy || me.out || MAP.killY === undefined) return;
    for (const g of room.grabs.filter((g) => g.att === me.id || g.vic === me.id)) releaseGrab(room, g, null);
    if (room.egg && room.egg.carrier === me.id) { room.egg = { pos: [...EGG_HOME], carrier: null, droppedAt: 0 }; note(room, '蛋掉下雲海，回到中間了'); }
    me.deaths++;
    if (room.mode === 'elim' || room.mode === 'hunt') { me.out = true; me.eatenBy = 'fall'; me.heldBy = null; me.respawnAt = Infinity; }
    else { me.eatenBy = 'fall'; me.respawnAt = Date.now() + 2000; }
    emitRoom(room, 'fell', { id: me.id, out: !!me.out });
    note(room, `${me.name} 掉下雲海了！`);
  });

  socket.on('disconnect', () => {
    if (room) useMap(room.map, room);
    if (!room || !me) return;
    for (const g of room.grabs.filter((g) => g.att === me.id || g.vic === me.id)) releaseGrab(room, g, null);
    dropEgg(room, me);
    room.players.delete(me.id);
    note(room, `${me.name} 離開了`);
    if (room.players.size === 0) rooms.delete(room.code);
    else if (room.mode === 'hunt' && me.role === 'hunter' && !members(room, 'hunter').length && room.phase === 'play') endRound(room, '獵人離開了', '重新分配獵人');
  });
});

// ===== 遊戲主迴圈 =====
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    try {                                                  // 一個房間出錯，只記下來，不影響其他房間
    useMap(room.map, room);
    room.smokes = room.smokes.filter((x) => x.until > now); room.walls = room.walls.filter((x) => x.until > now);
    for (const g of [...room.grabs]) {
      const att = room.players.get(g.att), vic = room.players.get(g.vic);
      if (!att || !vic || att.eatenBy || vic.eatenBy || att.out || vic.out) { releaseGrab(room, g, null); continue; }
      const anchor = mouthOf(att);
      if (lineBlocked(anchor, vic.pos)) { releaseGrab(room, g, 'snap'); continue; }
      g.boost = Math.max(0, g.boost - BOOST_DECAY * TICK);
      g.loose = Math.max(0, g.loose - JERK_DECAY * TICK);
      // 勾牆抵抗：被抓的人勾住東西時舌頭收不動，但最多只能撐 ANCHOR_MAX 秒
      const held = vic.an && g.anchorUsed < ANCHOR_MAX && !(vic.frozenUntil > now);
      if (vic.an) g.anchorUsed += TICK;
      if (g.dashUntil > now) { g.L = Math.min(g.dashMax, Math.max(g.L, dist(anchor, vic.pos))); continue; }   // 被抓的人正在衝刺：舌頭跟著變長（最多 6 公尺），這段時間拉不動
      const weak = vic.weakUntil > now && vic.fireUntil <= now ? WEAK_PULL : 1;   // 火蛙燒完之後被拉得比較快
      g.L = Math.max(0, Math.min(g.L, dist(anchor, vic.pos) + 0.5) - (att.aim && !held ? (PULL_BASE + g.boost) * weak : 0) * TICK);
      if (room.mode === 'race') {
        // 競速：只會把對手往回拉一段，不會吃掉
        if (g.L <= EAT_DIST + 1 || now - g.at > 2500) releaseGrab(room, g, 'race');
      } else if (g.L <= EAT_DIST) eat(room, g);
    }
    for (const p of room.players.values()) if (p.eatenBy && !p.out && !p.away && now >= p.respawnAt) respawn(room, p);
    modeTick(room, now);
    if (++room.tick % SEND_EVERY) continue;
    const r1 = (n) => Math.round(n * 100) / 100;
    const lead = room.mode === 'glutton' ? leader(room) : null;
    emitRoom(room, 'snap', {
      t: now, left: Math.max(0, room.endsAt - now), phase: room.phase, hud: hudOf(room),
      players: [...room.players.values()].map((p) => ({
        id: p.id, n: p.name, team: p.team, role: p.role, c: p.color, p: p.pos.map(r1), v: p.vel.map(r1), f: r1(p.face),
        g: p.gnd, tp: p.tp, tip: p.tip && p.tip.map(r1), e: p.eatenBy, o: p.out, h: p.heldBy, k: p.k, d: p.deaths, cp: p.cp,
        ch: p.char, fx: p.fireUntil > now ? 1 : p.weakUntil > now ? 2 : 0,   // 角色和燃燒狀態（別人畫面上要看得到）
        cc: [Math.max(0, (p.frozenUntil || 0) - now), Math.max(0, (p.poisonUntil || 0) - now), Math.max(0, (p.blindUntil || 0) - now)],   // 凍住、中毒、失明還剩幾毫秒
      })),
      grabs: room.grabs.map((g) => { const v = room.players.get(g.vic); return { att: g.att, vic: g.vic, L: r1(g.L), b: r1(g.boost), lo: r1(g.loose), an: !!(v && v.an && g.anchorUsed < ANCHOR_MAX) }; }),
      egg: room.egg && { p: room.egg.pos.map(r1), c: room.egg.carrier },
      zone: room.zone && { i: room.zone.i, o: room.zone.owner, m: Math.max(0, room.zone.movesAt - now) },
      sm: room.smokes.map((x) => [x.id, r1(x.x), r1(x.y), r1(x.z), x.until - now]),
      wl: room.walls.map((x) => [x.id, r1(x.x), r1(x.y), r1(x.z), r1(x.yaw), x.until - now]),
      lead: lead && lead.id,
    });
    } catch (e) { console.error(`房間 ${room.code} 更新時出錯：`, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e); }
  }
}, TICK * 1000);

const PORT = process.env.PORT || 3000;
if (require.main === module) server.listen(PORT, () => console.log(`舌戰伺服器已啟動：http://localhost:${PORT}`));
module.exports = { trunks, rocks, RINGS, ZONES, BASES, server, terrainH };
