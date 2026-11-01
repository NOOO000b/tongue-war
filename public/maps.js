// maps.js：六張地圖的資料（遊戲和伺服器共用這一份程式，算出來一模一樣）
// 每張地圖提供：地形高度 terrainH、水面高度 waterH、地圖上的東西（樹、石頭、平台、樹枝、彈跳蘑菇）、
// 各模式需要的位置（基地、蛋、區域、競速圈圈）、出生區域，以及畫面的主題顏色。
// 南北（z 的正負）兩半一律鏡像對稱：紅隊在 +z、藍隊在 -z，兩隊的地形完全一樣。
(function (root) {
  const smooth = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
  const rng = (seed) => { let s = seed; const r = () => (s = (s * 16807) % 2147483647) / 2147483647; return { r, rr: (a, b) => a + r() * (b - a) }; };
  // 一階一階的梯田／石階：把連續的高度切成一層一層（riser：每階的斜坡佔多少）
  const terrace = (h, step, riser) => { const k = Math.floor(h / step), f = h / step - k; return step * (k + (f > 1 - riser ? smooth((f - (1 - riser)) / riser) : 0)); };
  const mirrorZ = (list, zi) => { const out = []; for (const t of list) { out.push(t); const m = t.slice(); m[zi] = -m[zi]; if (Math.abs(t[zi]) > 0.01) out.push(m); } return out; };
  const mirrorSeg = (list) => { const out = []; for (const s of list) { out.push(s); if (Math.abs(s[2]) > 0.01 || Math.abs(s[5]) > 0.01) { const m = s.slice(); m[2] = -m[2]; m[5] = -m[5]; out.push(m); } } return out; };
  // 繞地圖一圈的 8 個空中圈圈（避開樹幹）
  function ringsAround(trunks, rad, yOf) {
    const out = [];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8; let r = rad, x = 0, z = 0;
      for (let tries = 0; tries < 30; tries++) {
        x = Math.cos(a) * r; z = Math.sin(a) * r;
        if (trunks.every(([tx, tz, tr]) => Math.hypot(x - tx, z - tz) > tr + 6)) break;
        r += tries % 2 ? -tries * 1.5 : tries * 1.5;
      }
      out.push([x, yOf(x, z, k), z]);
    }
    return out;
  }
  const MAPS = {};

  // ================= 1. 呱呱森林 =================
  MAPS.forest = () => {
    const MAP_SCALE = 1.45;                      // 地圖大小（1 = 原本的大小；改這裡就能放大縮小）
    const MAP_R = Math.round(86 * MAP_SCALE);    // 可以走動的圓形範圍半徑（外面是一圈岩壁）
    const BASE_Z = Math.round(72 * MAP_SCALE);   // 兩隊基地的位置（z = ±BASE_Z）
    function segDist2(ax, az, bx, bz, cx, cz) {
      const vx = bx - ax, vz = bz - az, t = Math.max(0, Math.min(1, ((cx - ax) * vx + (cz - az) * vz) / (vx * vx + vz * vz || 1)));
      return Math.hypot(ax + vx * t - cx, az + vz * t - cz);
    }
    // ===== 地形：地面的高低起伏（伺服器和遊戲用同一份，青蛙、樹、舌頭判定都跟著它走）=====
    // 平頂台地：中間平的，邊緣是平滑的斜坡
    function plateau(x, z, cx, cz, h, r, edge) {
      const d = Math.hypot(x - cx, z - cz);
      if (d <= r) return h;
      if (d >= r + edge) return 0;
      const t = (d - r) / edge;
      return h * (1 - t * t * (3 - 2 * t));
    }
    // 圓圓的小山丘（h 是負的就是凹地）
    const hump = (x, z, cx, cz, h, r) => h * Math.exp(-(((x - cx) ** 2 + (z - cz) ** 2) / (r * r)) * 2.2);
    const HILLS = (() => {
      let s = 4242; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647, rr = (a, b) => a + rnd() * (b - a);
      const out = [];
      for (let k = 0, tries = 0; k < 7 && tries < 300; tries++) {
        const x = rr(-100, 100) * MAP_SCALE / 1.45, z = rr(22, 92) * MAP_SCALE / 1.45, h = rr(-4, 11), r = rr(16, 26);
        if (Math.hypot(x, z - BASE_Z) < 30 || Math.hypot(x, z) < 34 || Math.hypot(x, z) > MAP_R - 22) continue;   // 不要擋到基地和中央大樹
        if (out.some((q) => Math.hypot(q[0] - x, q[1] - z) < 26)) continue;
        out.push([x, z, h, r], [x, -z, h, r]); k++;                    // 南北對稱
      }
      return out;
    })();
    function terrainH(x, z) {
      let y = plateau(x, z, 0, 0, 7, 10, 24);                            // 中央大樹的小山丘
      y += plateau(x, z, 0, BASE_Z, 6, 13, 14) + plateau(x, z, 0, -BASE_Z, 6, 13, 14);   // 兩隊基地的高台
      for (const [cx, cz, h, r] of HILLS) y += hump(x, z, cx, cz, h, r);
      const d = Math.hypot(x, z), e = MAP_R - 18;                         // 地圖邊緣往上翹，像一個碗
      if (d > e) y += ((d - e) / 18) ** 2 * 10;
      return y;
    }
    function makeLayout() {
      const S = MAP_SCALE, N = (n) => Math.round(n * S * S);   // 地圖放大幾倍，樹的數量就按面積比例增加，密度不變
      let s = 20261024;
      const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
      const rr = (a, b) => a + rnd() * (b - a);
      const trunks = [], rocks = [], branches = [], plats = [], half = [];
      // 新的樹要離其他樹夠遠，也要留出基地和中央大樹周圍的空地
      const free = (x, z, r, pad) => Math.hypot(x, z) < MAP_R - 6 - r
        && half.every(([tx, tz, tr]) => Math.hypot(x - tx, z - tz) > tr + r + pad)
        && Math.hypot(x, z - BASE_Z) > 13 && Math.hypot(x, z) > 12;
      function place(n, xr, zr, r, h, pad) {
        for (let k = 0, tries = 0; k < n && tries < 400; tries++) {
          const x = rr(xr[0], xr[1]), z = rr(zr[0], zr[1]), tr = rr(r[0], r[1]), th = rr(h[0], h[1]);
          if (!free(x, z, tr, pad)) continue;
          half.push([x, z, tr, th]); k++;
        }
      }
      // 中央大樹（地標）：三層可以站、也可以勾的平台
      const cb = terrainH(0, 0);                                          // 中央大樹長在小山丘上
      trunks.push([0, 0, 5, cb + 46]);
      plats.push([0, cb + 14, 0, 9.5], [0, cb + 26, 0, 8], [0, cb + 36, 0, 6.5]);
      place(N(14), [-80 * S, -26 * S], [7, 76 * S], [1.6, 2.4], [18, 32], 5);     // 西邊密林：又細又密
      place(N(4), [30 * S, 78 * S], [9, 66 * S], [2.6, 3.4], [34, 44], 16);       // 東邊草原：只有幾棵很高的大樹
      place(N(5), [-30 * S, 30 * S], [48 * S, 82 * S], [1.8, 2.6], [16, 26], 6);      // 基地周圍的小樹林
      place(N(4), [-24 * S, 24 * S], [16, 40 * S], [2.0, 2.8], [22, 34], 8);      // 中間地帶
      // 第四個數字是樹頂的高度（地面高度＋樹的長度）
      for (const t of half) { const top = terrainH(t[0], t[1]) + t[3]; trunks.push([t[0], t[1], t[2], top], [t[0], -t[1], t[2], top]); }
      // 東邊草原上方的浮石（空曠的地方也有東西可以勾）
      const hr = [];
      for (let k = 0, tries = 0; k < N(4) && tries < 400; tries++) {
        const x = rr(24 * S, 74 * S), z = rr(10, 68 * S), y = rr(24, 38), r = rr(2.6, 4);
        if (Math.hypot(x, z) > MAP_R - 10 || hr.some((q) => Math.hypot(q[0] - x, q[2] - z) < 16)) continue;
        hr.push([x, y + terrainH(x, z), z, r]); k++;
      }
      for (const q of hr) rocks.push(q, [q[0], q[1], -q[2], q[3]]);
      // 密林裡的橫向樹枝：連接距離剛好的兩棵樹，形成可以一路盪過去的空中路線
      const west = half.filter((t) => t[0] < -20), hb = [];
      for (const a of west) {
        if (hb.length >= N(9)) break;
        const near = west.filter((b) => b !== a).map((b) => [b, Math.hypot(a[0] - b[0], a[1] - b[1])])
          .filter(([, d]) => d > 7 && d < 17).sort((p, q) => p[1] - q[1]);
        for (const [b] of near) {
          if (hb.some((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a))) continue;
          if (half.some((t) => t !== a && t !== b && segDist2(a[0], a[1], b[0], b[1], t[0], t[1]) < t[2] + 1.5)) continue;
          const base = Math.max(terrainH(a[0], a[1]), terrainH(b[0], b[1]));
          hb.push({ a, b, y: base + Math.min(a[3], b[3]) * rr(0.55, 0.75), dy: rr(-1.5, 1.5) }); break;
        }
      }
      for (const { a, b, y, dy } of hb) {
        const dx = b[0] - a[0], dz = b[1] - a[1], d = Math.hypot(dx, dz), ux = dx / d, uz = dz / d;
        // [x1, y1, z1, x2, y2, z2, 粗細]：從一棵樹幹接到另一棵樹幹
        const seg = [a[0] + ux * a[2] * 0.8, y, a[1] + uz * a[2] * 0.8, b[0] - ux * b[2] * 0.8, y + dy, b[1] - uz * b[2] * 0.8, 0.55];
        branches.push(seg, [seg[0], seg[1], -seg[2], seg[3], seg[4], -seg[5], seg[6]]);
      }
      return { trunks, rocks, branches, plats };
    }
    const L = makeLayout();
    const ZONE_X = Math.round(50 * MAP_SCALE);
    return {
      id: 'forest', name: '呱呱森林', desc: '大樹、密林和草原，什麼都有一點的標準圖',
      R: MAP_R, baseZ: BASE_Z, terrainH, waterH: () => null, extraBlock: () => false,
      layout: { ...L, pads: [], water: [] },
      anchors: { bases: { red: [0, BASE_Z], blue: [0, -BASE_Z] }, baseR: 7, eggHome: [11.5, terrainH(11.5, 0) + 0.8, 0],
        zones: [[0, 0], [ZONE_X, 0], [-ZONE_X, 0]], zoneR: 11, ringR: 4.5,
        rings: ringsAround(L.trunks, 52 * MAP_SCALE, (x, z, k) => terrainH(x, z) + 12 + (k % 2) * 6 + (x < 0 ? 3 : 0)) },
      theme: { sky: '#bfe6ff', fog: [80, 270], light: 1, ground: ['#8fd06c', '#79c25c', '#a8dd84', '#5fa94a'], paths: true,
        grass: '#5aad45', wall: 'cliff', cliff: null, leaves: ['#6cbf4f', '#5aad45', '#7acb5a', '#4e9e3e'], clouds: true },
    };
  };

  // ================= 2. 井底之呱 =================
  // 森林中間有一口巨人的古井。先照參考圖做出一口水井（以石圈外徑 = 1 為單位的比例），再整個等比例放大 S 倍。
  // 井口的石圈很高，要用勾爪翻過去；井裡是很深的井道，可以沿著井壁的螺旋石台爬回來。
  MAPS.well = () => {
    const R = 120, S = 50, SURF = 24, { rr } = rng(5151);
    // ---- 參考圖量出來的比例（石圈外徑 = 1）----
    const P = { ringO: 0.5, ringI: 0.31, ringH: 0.42, baseR: 0.97, baseT: 0.07, postX: 0.6, postR: 0.085, postH: 1.32,
      beamZ: 0.17, beamW: 0.13, beamL: 2.0, braceY: 0.6, braceX: 0.25 };
    const Ro = P.ringO * S, Ri = P.ringI * S, Rb = P.baseR * S;
    const BASE_TOP = SURF + 1.8;                              // 石板地基露出地面 1.8 公尺（跳得上去；其餘埋在地下）
    const RING_TOP = BASE_TOP + P.ringH * S;                  // 石圈頂端
    const BEAM_Y = BASE_TOP + P.postH * S;                    // 橫樑高度
    const FLOOR = 0;                                          // 井底
    const BZ = 95;
    const surface = (x, z) => { const d = Math.hypot(x, z);
      return SURF + 1.2 * Math.sin(x * 0.11) * Math.cos(z * 0.09) * smooth((d - Rb - 2) / 10) + (d > R - 16 ? ((d - (R - 16)) / 16) ** 2 * 9 : 0); };
    // 物理用的地形：井道、石圈（頂端可以站）、石板地基、森林
    const terrainH = (x, z) => { const d = Math.hypot(x, z); return d < Ri ? FLOOR : d <= Ro ? RING_TOP : d <= Rb ? BASE_TOP : surface(x, z); };
    // 畫地面用的高度：井道以外都畫成森林地面（石圈和石板另外畫，會蓋住）
    const meshH = (x, z) => (Math.hypot(x, z) < Ri + 1.2 ? FLOOR : surface(x, z));
    const waterH = (x, z) => (Math.hypot(x, z) < Ri * 0.55 ? FLOOR + 0.45 : null);
    const trunks = [], rocks = [], branches = [], plats = [];
    // 外圍森林
    const half = [];
    for (let k = 0, t = 0; k < 26 && t < 4000; t++) {
      const a = rr(0.05, Math.PI - 0.05), d = rr(Rb + 6, R - 8), x = Math.cos(a) * d, z = Math.sin(a) * d, r = rr(1.8, 2.8);
      if (Math.hypot(x, z - BZ) < 12 || Math.abs(x) < 9 || half.some((q) => Math.hypot(q[0] - x, q[1] - z) < q[2] + r + 6)) continue;
      half.push([x, z, r, surface(x, z) + rr(16, 26), 'tree']); k++;
    }
    trunks.push(...mirrorZ(half, 1));
    // 水井的木架：兩根木柱、兩根平行的橫樑、斜撐
    const PX = P.postX * S, PR = P.postR * S, BZW = P.beamZ * S, BW = P.beamW * S, BL = P.beamL * S;
    trunks.push([PX, 0, PR, BEAM_Y, 'wellpost'], [-PX, 0, PR, BEAM_Y, 'wellpost']);
    for (const z of [BZW, -BZW]) branches.push([-BL / 2, BEAM_Y + BW / 2, z, BL / 2, BEAM_Y + BW / 2, z, BW / 2, 'beam']);
    for (const sx of [1, -1]) branches.push([sx * (PX - PR * 0.8), BASE_TOP + P.braceY * S, 0, sx * P.braceX * S, BEAM_Y, 0, BW * 0.32, 'beam']);
    // 井道裡的螺旋石台：從井底沿著井壁一圈圈往上，可以一路跳回石圈頂端
    const LR = 3.6, LD = Ri - 4, N = Math.ceil((RING_TOP - 1.8 - FLOOR) / 2.3);           // 石台夠大才站得穩
    for (let k = 0; k < N; k++) { const a = 0.5 + k * ((LR * 2 + 1.0) / LD); plats.push([Math.cos(a) * LD, Math.min(FLOOR + 2.3 * (k + 1), RING_TOP - 1.6), Math.sin(a) * LD, LR, 'stone']); }
    // 井口上方的浮石：盪鞦韆用
    for (let k = 0; k < 2; k++) { const a = 0.8 + k * 1.55, d = rr(36, 50); rocks.push([Math.cos(a) * d, RING_TOP + rr(4, 14), Math.sin(a) * d, rr(3, 4), 'float']); }   // 放在斜角方向，不擋住水井
    const allT = trunks;
    return {
      id: 'well', name: '井底之呱', desc: '森林中間有一口巨人的古井，石圈要用勾爪翻過去，井道很深',
      R, baseZ: BZ, terrainH, meshH, waterH, extraBlock: () => false,
      // 石圈：在井道裡、或在石圈外，只要比石圈頂端低就穿不過去
      well: { r: Ri, t: Ro - Ri, top: RING_TOP, surf: BASE_TOP, floor: FLOOR, model: { ...P, S, Ro, Ri, Rb, BASE_TOP, RING_TOP, BEAM_Y, PX, PR, BZW, BW, BL } },
      spawnRing: [Rb + 5, R - 8],
      layout: { trunks: allT, rocks: mirrorZ(rocks, 2), plats, branches, pads: [], water: [{ type: 'disc', x: 0, z: 0, r: Ri * 0.55, y: FLOOR + 0.45 }] },
      anchors: { bases: { red: [0, BZ], blue: [0, -BZ] }, baseR: 7, eggHome: [0, FLOOR + 0.8, Ri * 0.5],
        zones: [[0, 0], [80, 0], [-80, 0]], zoneR: Math.min(10, Ri - 3), ringR: 4.5,
        rings: [[0, RING_TOP + 10, 0], ...ringsAround(allT, 78, (x, z, k) => surface(x, z) + 10 + (k % 2) * 6).slice(1)] },
      theme: { sky: '#bfe6ff', fog: [80, 290], light: 1, ground: ['#8fd06c', '#79c25c', '#a8dd84', '#5fa94a'], wellGround: ['#5e5a50', '#55514a', '#66625a', '#3f3c36'],
        paths: false, grass: '#5aad45', wall: 'cliff', leaves: ['#6cbf4f', '#5aad45', '#7acb5a', '#4e9e3e'], clouds: true },
    };
  };

  // ================= 3. 蓮花池塘 =================
  // 一整片淺水池塘，邊緣是長草的岸，水面上有荷葉、蓮花、蘆葦和浮木，中間有幾座小土丘島
  MAPS.pond = () => {
    const R = 110, BZ = 96, { r, rr } = rng(777);
    const plateau = (x, z, cx, cz, h, rad, edge) => { const d = Math.hypot(x - cx, z - cz); return d <= rad ? h : d >= rad + edge ? 0 : h * (1 - smooth((d - rad) / edge)); };
    const ISLANDS = [[0, 0, 4.2, 9, 8], [46, 34, 3.8, 6, 6], [-46, 34, 3.8, 6, 6], [0, 56, 3.4, 4, 5]];
    const terrainH = (x, z) => {
      const d = Math.hypot(x, z);
      let y = -1.1 + smooth((d - 62) / 28) * 1.1 + smooth((d - 88) / 20) * 4;     // 中間低（水淹到腰）、岸邊高
      y += plateau(x, z, 0, BZ, 5, 12, 8) + plateau(x, z, 0, -BZ, 5, 12, 8);      // 岸邊的基地
      for (const [cx, cz, h, rad, e] of ISLANDS) y += plateau(x, Math.abs(z), cx, cz, h, rad, e);
      return y;
    };
    const waterH = () => 0;
    const plats = [], trunks = [], branches = [], rocks = [];
    for (let k = 0, t = 0; k < 34 && t < 2000; t++) {                                   // 荷葉
      const x = rr(-95, 95), z = rr(6, 95), R0 = rr(2.4, 5.8);
      if (Math.hypot(x, z) > 86 || terrainH(x, z) > -0.6 || plats.some((p) => Math.hypot(p[0] - x, p[2] - z) < p[3] + R0 + 1.5)) continue;
      plats.push([x, 0.12, z, R0, 'lily']); k++;
    }
    for (let k = 0, t = 0; k < 10 && t < 2000; t++) {                                   // 蓮花
      const x = rr(-80, 80), z = rr(8, 80);
      if (terrainH(x, z) > -0.6 || plats.some((p) => Math.hypot(p[0] - x, p[2] - z) < p[3] + 1) || trunks.some((q) => Math.hypot(q[0] - x, q[1] - z) < 14)) continue;
      trunks.push([x, z, 0.5, rr(8, 14), 'lotus']); k++;
    }
    for (let c = 0; c < 8; c++) {                                                      // 岸邊的蘆葦叢
      const a = rr(0.15, Math.PI - 0.15), d = rr(70, 84), cx = Math.cos(a) * d, cz = Math.sin(a) * d;
      for (let j = 0; j < 6; j++) { const x = cx + rr(-3, 3), z = cz + rr(-3, 3); if (z > 3) trunks.push([x, z, 0.28, terrainH(x, z) + rr(4, 6.5), 'reed']); }
    }
    for (const [x, z] of [[46, 34], [-46, 34]]) trunks.push([x, z, 2.2, terrainH(x, z) + 24, 'tree']);   // 島上的樹
    for (let k = 0; k < 4; k++) {                                                      // 浮木
      const x = rr(-70, 70), z = rr(14, 70), a = rr(0, Math.PI), L = rr(7, 10);
      if (terrainH(x, z) > -0.6) continue;
      branches.push([x - Math.cos(a) * L / 2, 0.3, z - Math.sin(a) * L / 2, x + Math.cos(a) * L / 2, 0.3, z + Math.sin(a) * L / 2, 0.7, 'log']);
    }
    for (let k = 0; k < 4; k++) { const x = rr(-70, 70), z = rr(18, 75); rocks.push([x, rr(18, 26), z, rr(2.4, 3.4), 'float']); }   // 空中可以勾的浮石
    const allT = [[0, 0, 3, terrainH(0, 0) + 28, 'tree'], ...mirrorZ(trunks, 1)];
    return {
      id: 'pond', name: '蓮花池塘', desc: '掉進水裡會變慢，要在荷葉之間跳、勾著蓮花盪過去',
      R, baseZ: BZ, terrainH, waterH, extraBlock: () => false,
      layout: { trunks: allT, rocks: mirrorZ(rocks, 2), plats: mirrorZ(plats, 2), branches: mirrorSeg(branches), pads: [], water: [{ type: 'disc', x: 0, z: 0, r: R + 6, y: 0 }] },
      anchors: { bases: { red: [0, BZ], blue: [0, -BZ] }, baseR: 7, eggHome: [0, terrainH(0, 0) + 0.8, 5],
        zones: [[0, 0], [46, 0], [-46, 0]], zoneR: 10, ringR: 4.5, rings: ringsAround(allT, 62, (x, z, k) => 8 + (k % 2) * 5) },
      theme: { sky: '#cdeeff', fog: [90, 300], light: 1, ground: ['#7ec46a', '#6db35a', '#94d07c', '#5a9a4a'], mud: '#7d8f5a', paths: false,
        grass: '#5fae4a', wall: 'bank', water: '#5fb8a8', leaves: ['#6cbf4f', '#5aad45', '#7acb5a', '#4e9e3e'], clouds: true },
    };
  };

  // ================= 4. 蘑菇夜森林 =================
  // 夜晚的森林：起伏很大的山坡、會發光的巨大蘑菇，山溝裡有彈跳蘑菇
  MAPS.mushroom = () => {
    const R = 115, BZ = 100, { r, rr } = rng(9090);
    const plateau = (x, z, cx, cz, h, rad, edge) => { const d = Math.hypot(x - cx, z - cz); return d <= rad ? h : d >= rad + edge ? 0 : h * (1 - smooth((d - rad) / edge)); };
    const HILLS = [];
    for (let k = 0, t = 0; k < 10 && t < 500; t++) {
      const x = rr(-95, 95), z = rr(18, 90), h = rr(-6, 11), rad = rr(16, 28);
      if (Math.hypot(x, z - BZ) < 28 || Math.hypot(x, z) < 26 || Math.hypot(x, z) > R - 20 || HILLS.some((q) => Math.hypot(q[0] - x, q[1] - z) < 22)) continue;
      HILLS.push([x, z, h, rad]); k++;
    }
    const terrainH = (x, z) => {
      let y = plateau(x, z, 0, 0, 5, 9, 16) + plateau(x, z, 0, BZ, 6, 12, 14) + plateau(x, z, 0, -BZ, 6, 12, 14);
      for (const [cx, cz, h, rad] of HILLS) y += h * Math.exp(-(((x - cx) ** 2 + (Math.abs(z) - cz) ** 2) / (rad * rad)) * 2.2);
      const d = Math.hypot(x, z), e = R - 18; if (d > e) y += ((d - e) / 18) ** 2 * 10;
      return y;
    };
    const trunks = [], plats = [], pads = [], rocks = [];
    for (let k = 0, t = 0; k < 13 && t < 3000; t++) {                                  // 巨大蘑菇（菇柄＋可以站的菇傘）
      const x = rr(-95, 95), z = rr(10, 92), rad = rr(1.6, 3.2);
      if (Math.hypot(x, z) > R - 16 || Math.hypot(x, z - BZ) < 16 || Math.hypot(x, z) < 14 || trunks.some((q) => Math.hypot(q[0] - x, q[1] - z) < 16)) continue;
      const top = terrainH(x, z) + rr(14, 30), cap = rad * 2.6 + 2;
      trunks.push([x, z, rad, top, 'mushroom']); plats.push([x, top, z, cap, 'cap' + (k % 3)]); k++;
    }
    for (let k = 0, t = 0; k < 7 && t < 3000; t++) {                                   // 彈跳蘑菇：放在低處（山溝）
      const x = rr(-95, 95), z = rr(10, 92), y = terrainH(x, z);
      if (Math.hypot(x, z) > R - 20 || y > 0.5 || trunks.some((q) => Math.hypot(q[0] - x, q[1] - z) < q[2] + 4) || pads.some((q) => Math.hypot(q[0] - x, q[2] - z) < 18)) continue;
      pads.push([x, y, z, 2.2, 34]); k++;
    }
    pads.push([18, terrainH(18, 0), 0, 2.2, 34], [-18, terrainH(-18, 0), 0, 2.2, 34]);
    for (let k = 0; k < 5; k++) { const x = rr(-80, 80), z = rr(15, 80); rocks.push([x, terrainH(x, z) + rr(24, 34), z, rr(2.2, 3.4), 'crystal']); }
    const allT = [[0, 0, 4, terrainH(0, 0) + 34, 'mushroom'], ...mirrorZ(trunks, 1)];
    return {
      id: 'mushroom', name: '蘑菇夜森林', desc: '夜晚的森林，踩上彈跳蘑菇可以一下子彈到高空',
      R, baseZ: BZ, terrainH, waterH: () => null, extraBlock: () => false,
      layout: { trunks: allT, rocks: mirrorZ(rocks, 2), plats: [[0, terrainH(0, 0) + 34, 0, 13, 'cap1'], ...mirrorZ(plats, 2)], branches: [], pads: mirrorZ(pads, 2), water: [] },
      anchors: { bases: { red: [0, BZ], blue: [0, -BZ] }, baseR: 7, eggHome: [12, terrainH(12, 0) + 0.8, 0],
        zones: [[0, 0], [55, 0], [-55, 0]], zoneR: 11, ringR: 4.5, rings: ringsAround(allT, 62, (x, z, k) => terrainH(x, z) + 13 + (k % 2) * 6) },
      theme: { sky: '#1b2140', fog: [45, 210], fogColor: '#1b2140', light: 0.5, night: true, ground: ['#2f6a5e', '#285c52', '#3a7a6a', '#1f4a40'], paths: false,
        grass: '#3f8a70', wall: 'cliff', cliff: '#5a5a8a', leaves: ['#5ac0a0', '#4aa890', '#6ad0b0', '#3a9080'], clouds: false },
    };
  };

  // ================= 5. 梯田稻田 =================
  // 一座長滿梯田的山：田埂上跑得快、田裡有水會變慢，稻子會擋住舌頭；山頂有農舍和稻草人，電線桿之間的電線可以勾
  MAPS.rice = () => {
    const R = 115, BZ = 100, STEP = 3, RISER = 0.18, PEAK = 24;
    const raw = (d) => PEAK * (1 - smooth(d / 96));
    const level = (x, z) => { const h = raw(Math.hypot(x, z)), k = Math.floor(h / STEP), f = h / STEP - k; return { k, f }; };
    const terrainH = (x, z) => {
      const d = Math.hypot(x, z), { k, f } = level(x, z);
      let y = terrace(raw(d), STEP, RISER);
      if (k >= 1 && f < 0.07) y += 0.45;                                               // 田埂：每一階外緣高起來的土路
      const e = R - 16; if (d > e) y += ((d - e) / 16) ** 2 * 9;
      return y;
    };
    const inPaddy = (x, z) => { const { k, f } = level(x, z); return k >= 1 && k < PEAK / STEP && f >= 0.07 && f <= 1 - RISER && Math.abs(x) > 2.5 && Math.abs(z) > 2.5; };
    const waterH = (x, z) => (inPaddy(x, z) ? level(x, z).k * STEP + 0.3 : null);
    const extraBlock = (x, y, z) => { const w = waterH(x, z); return w !== null && y < w + 1.3; };   // 稻子擋住舌頭
    // 每一階田的範圍（拿來畫水面）
    const dOf = (h) => { let lo = 0, hi = 96; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (raw(m) > h) lo = m; else hi = m; } return (lo + hi) / 2; };
    const water = [];
    for (let k = 1; k < PEAK / STEP; k++) water.push({ type: 'ring', inner: dOf(STEP * (k + 1 - RISER)), outer: dOf(STEP * (k + 0.07)), y: k * STEP + 0.3 });
    const top = terrainH(0, 0);
    const trunks = [[4.5, 4.5, 0.45, top + 6, 'post'], [-4.5, 4.5, 0.45, top + 6, 'post'], [11, 0, 0.3, top + 5, 'post']];   // 農舍的柱子、稻草人
    const branches = [[11, top + 3.8, -1.8, 11, top + 3.8, 1.8, 0.2, 'beam']];
    const poles = [];                                                                   // 南北兩條路上的電線桿
    for (const zz of [22, 42, 62, 82]) for (const xx of [-6, 6]) poles.push([xx, zz]);
    for (const [x, z] of poles) trunks.push([x, z, 0.4, terrainH(x, z) + 14, 'pole']);
    for (const xx of [-6, 6]) for (let i = 0; i < 3; i++) {
      const z1 = [22, 42, 62][i], z2 = [42, 62, 82][i];
      branches.push([xx, terrainH(xx, z1) + 13.4, z1, xx, terrainH(xx, z2) + 13.4, z2, 0.15, 'wire']);
    }
    const { rr } = rng(3131);
    for (let k = 0; k < 6; k++) { const a = rr(0.3, Math.PI - 0.3), d = rr(84, 98), x = Math.cos(a) * d, z = Math.sin(a) * d; if (Math.hypot(x, z - BZ) > 16) trunks.push([x, z, rr(1.8, 2.5), terrainH(x, z) + rr(18, 26), 'tree']); }
    return {
      id: 'rice', name: '梯田稻田', desc: '田埂上跑得快、田裡會變慢，稻子會擋住舌頭；電線可以勾',
      R, baseZ: BZ, terrainH, waterH, extraBlock,
      layout: { trunks: mirrorZ(trunks, 1), rocks: [[11, top + 5.6, 0, 0.6, 'scare']], plats: [[0, top + 6.3, 0, 7.5, 'roof']], branches: mirrorSeg(branches), pads: [], water },
      anchors: { bases: { red: [0, BZ], blue: [0, -BZ] }, baseR: 7, eggHome: [0, top + 0.8, 8.5],
        zones: [[0, 0], [60, 0], [-60, 0]], zoneR: 10, ringR: 4.5, rings: ringsAround(mirrorZ(trunks, 1), 56, (x, z, k) => terrainH(x, z) + 9 + (k % 2) * 5) },
      theme: { sky: '#ffe2b8', fog: [80, 290], fogColor: '#ffe2b8', light: 1, ground: ['#a6c95e', '#93b850', '#b9d672', '#7d9e44'], mud: '#8a7a4a', paths: true,
        grass: '#8ab84a', wall: 'cliff', cliff: '#8f9a6a', water: '#8fc0b0', rice: '#b8c84a', leaves: ['#6cbf4f', '#5aad45', '#7acb5a', '#4e9e3e'], clouds: true },
    };
  };

  // ================= 6. 雲端浮島 =================
  // 一座座浮在天空中的小島，中間是雲海；掉下去就算死一次
  MAPS.sky = () => {
    const R = 135, BZ = 100;
    const ISLANDS = mirrorZ([[0, 0, 20, 30, 5], [0, BZ, 15, 26, 2], [48, 48, 12, 31, 4], [-48, 48, 12, 31, 4], [80, 0, 10, 28, 3], [-80, 0, 10, 28, 3],
      [22, 74, 7, 29, 1.5], [-22, 74, 7, 29, 1.5]], 1);
    const terrainH = (x, z) => {
      let best = null;
      for (const [cx, cz, rad, top, hill] of ISLANDS) {
        const d = Math.hypot(x - cx, z - cz); if (d > rad) continue;
        const y = top + hill * (1 - (d / rad) ** 2) - (d > rad - 2.5 ? (d - (rad - 2.5)) * 0.6 : 0);
        if (best === null || y > best) best = y;
      }
      return best;                                                                       // null：這裡沒有地面（雲海）
    };
    const trunks = [[6, 7, 2.6, terrainH(6, 7) + 24, 'tree'], [-7, -6, 2.6, terrainH(-7, -6) + 24, 'tree']];
    for (const [x, z] of [[48, 48], [-48, 48], [-9, BZ + 5], [9, BZ + 5]]) trunks.push([x, z, 2, terrainH(x, z) + 18, 'tree']);
    const rocks = [[24, 46, 22, 3, 'float'], [-24, 46, 22, 3, 'float'], [64, 44, 24, 2.8, 'float'], [-64, 44, 24, 2.8, 'float'], [0, 48, 62, 3, 'float'], [64, 42, 80, 2.6, 'float'], [-64, 42, 80, 2.6, 'float'], [30, 48, 92, 2.6, 'float'], [-30, 48, 92, 2.6, 'float']];
    const branches = [[0, 0, 0, 0, 0, 0, 0, 'none']].slice(1);
    // 吊橋：讓不太會勾爪的人也有路可走，但掉下去就完了
    const bridge = (a, b) => { const ya = terrainH(a[0], a[1]) + 0.2, yb = terrainH(b[0], b[1]) + 0.2; branches.push([a[0], ya, a[1], b[0], yb, b[1], 0.45, 'rope']); };
    bridge([0, BZ - 13], [16, 78]); bridge([-16, 78], [0, BZ - 13]); bridge([18, 14], [70, 2]); bridge([-18, 14], [-70, 2]);
    const isl = ISLANDS.map((i) => ({ x: i[0], z: i[1], r: i[2], top: i[3] }));
    return {
      id: 'sky', name: '雲端浮島', desc: '島和島之間要用勾爪盪過去，掉下去就算死一次',
      R, baseZ: BZ, terrainH, waterH: () => null, extraBlock: () => false, killY: 8, noGround: true,
      layout: { trunks: mirrorZ(trunks, 1), rocks: mirrorZ(rocks, 2), plats: [], branches: mirrorSeg(branches), pads: [], water: [], islands: isl },
      anchors: { bases: { red: [0, BZ], blue: [0, -BZ] }, baseR: 6, eggHome: [0, terrainH(0, 0) + 0.8, 10],
        zones: [[0, 0], [80, 0], [-80, 0]], zoneR: 8, ringR: 4.5,
        rings: [[30, 40, 26], [60, 40, 26], [80, 38, -10], [55, 42, -45], [0, 44, -38], [-55, 42, -45], [-80, 38, -10], [-45, 40, 30]] },
      spawnIslands: isl,
      theme: { sky: '#a8d8ff', fog: [110, 360], light: 1.05, ground: ['#8fd06c', '#79c25c', '#a8dd84', '#5fa94a'], paths: false,
        grass: '#5aad45', wall: 'none', leaves: ['#6cbf4f', '#5aad45', '#7acb5a', '#4e9e3e'], clouds: true, cloudSea: true },
    };
  };

  const LIST = ['forest', 'well', 'pond', 'mushroom', 'rice', 'sky'];
  const cache = {};
  const api = {
    LIST,
    info: () => LIST.map((id) => { const m = api.load(id); return { id, name: m.name, desc: m.desc }; }),
    load(id) { if (!MAPS[id]) id = 'forest'; return cache[id] || (cache[id] = MAPS[id]()); },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TW_MAPS = api;
})(typeof window !== 'undefined' ? window : globalThis);
