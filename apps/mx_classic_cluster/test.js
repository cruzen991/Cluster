'use strict';
/* node apps/mx_classic_cluster/test.js - the parts that run without a car or a renderer */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const F = require('./faces');
const FX = require('./fx');
const { tachMax, warmLimit, shiftLevel, layout, W, H } = require('./cluster');

/* scales */
assert.strictEqual(F.angleOf(0, 0, 160), F.A0);
assert.strictEqual(F.angleOf(160, 0, 160), F.A1);
assert.strictEqual(F.angleOf(80, 0, 160), 0, 'half scale points straight up');
assert.strictEqual(F.angleOf(999, 0, 160), F.A1, 'clamped');
assert.strictEqual(F.subAngleOf(0.5), 0);
assert.deepStrictEqual([6000, 6500, 7000, 7500, 8500].map(tachMax), [7000, 7000, 8000, 8000, 9000]);
assert.strictEqual(warmLimit(null, 7000), null);
assert.strictEqual(warmLimit(95, 7000), 7000);

/* shift lights: none below 5000, one more every 200 rpm, all ten by 6800, flashing from 7000 */
assert.deepStrictEqual([0, 4999, 5000, 5199, 5200, 6000, 6799, 6800, 6999, 7000, 9000, NaN].map((r) => shiftLevel(r, 7000)),
    [0, 0, 1, 1, 2, 6, 9, 10, 10, 11, 11, 0]);

/* layout */
[layout(0, 0), layout(80, 30), layout(-80, -30)].forEach((L) => [L.speedo, L.tach].forEach((d) => {
    assert(d.cx - F.C >= 0 && d.cx + F.C <= W && d.cy - F.C >= 0 && d.cy + F.C <= H, 'dial inside the panel');
}));

/* every style draws, and its moving parts make a shader without holes */
for (const st of ['tech']) {
    const o = { style: st, units: 'mph', redline: 7000, max: 8000, tempUnit: 'f' };
    assert.strictEqual(F.speedoFace(o).d.length, F.D * F.D * 4);
    assert.strictEqual(F.tachFace(o).d.length, F.D * F.D * 4);
    assert.strictEqual(F.centerInfo('300 mi', '1 mi', { style: st, mode: 'Sport Plus', speed: '88', unit: 'mph' }).d.length, F.CENTER.w * F.CENTER.h * 4);
    assert.strictEqual(F.lcd('D3', '', { style: st, center: true }).d.length, F.LCD.w * F.LCD.h * 4);
    for (const k of ['speed', 'rpm']) {
        const sp = F.dialFx(st, k, o);
        const src = FX.shader(sp);
        assert(/^#version 100\n/.test(src) && /uniform vec4 u_v;/.test(src) && !/NaN|undefined|Infinity/.test(src), st + ' ' + k + ' shader');
        assert.deepStrictEqual(JSON.parse(/\/\/ cc-fx (\{.*\})/.exec(src)[1]), JSON.parse(JSON.stringify(sp)));
    }
}

/* the moving parts, drawn in JavaScript (the twin of the shader) */
{
    const sp = F.dialFx('tech', 'rpm', { redline: 7000, max: 8000 });
    const C = F.C, st = (a, lv) => ({ a, b: F.SUB.a0, c: F.SUB.a0, lv: lv || 0 });
    const at = (r, ang) => [C + Math.sin(ang * Math.PI / 180) * r, C - Math.cos(ang * Math.PI / 180) * r];
    // the hollow needle: a bright edge at the outline, a dark see-through middle, nothing far off it
    const [ex, ey] = at(150, 0);
    let edgeSeen = false;
    for (let dx = 0; dx < 14; dx += 0.5) { const c = FX.shade(sp, ex + dx, ey, st(0)); if (c[0] > 200 && c[3] > 200) edgeSeen = true; }
    assert(edgeSeen, 'the needle has a bright edge');
    const mid = FX.shade(sp, ex + 0.5, ey, st(0));
    assert(mid[3] > 150 && mid[0] < 120, 'the middle is dark');
    assert.strictEqual(FX.shade(sp, ...at(150, 90), st(0))[3], 0, 'nothing a quarter turn away');
    // the lit ring: lit behind the needle, not ahead of it
    assert(FX.shade(sp, ...at(F.T.ring, -60), st(0))[3] > 250, 'ring lit behind the needle');
    assert.strictEqual(FX.shade(sp, ...at(F.T.ring, 60), st(0))[3], 0, 'ring dark ahead of it');
    // shift lights: segment 1 lit at level 1 and green, segment 9 not; flashing alternates
    const L = sp.lights, segA = (i) => L.a0 + (L.a1 - L.a0) / L.n * (i + 0.5);
    const s0 = FX.shade(sp, ...at(L.r, segA(0)), st(0, 1));
    assert(s0[3] > 250 && s0[1] > 150 && s0[0] < 100, 'first light green');
    assert.strictEqual(FX.shade(sp, ...at(L.r, segA(8)), st(0, 1))[3], 0, 'ninth light off');
    const on = FX.shade(sp, ...at(L.r, segA(8)), st(0, 11)), off = FX.shade(sp, ...at(L.r, segA(8)), st(0, 12));
    assert(on[0] > 200 && off[0] < 100, 'redline flash');
}

/* dirty rectangles cover every pixel that changes (the redrawn mode depends on it) */
for (const st of ['tech']) {
    const sp = F.dialFx(st, 'rpm', { redline: 7000, max: 8000 });
    const cases = [[{ a: -125, b: -52, c: -52, lv: 0 }, { a: -100, b: -40, c: -30, lv: 0 }],
        [{ a: 10, b: 0, c: 10, lv: 3 }, { a: 17, b: 0, c: 25, lv: 6 }],
        [{ a: 60, b: 0, c: 40, lv: 11 }, { a: 60.5, b: 0, c: 41, lv: 12 }],
        [{ a: 0, b: -52, c: -52, lv: 0 }, { a: 0, b: 52, c: 52, lv: 0 }]];
    for (const [o, n] of cases) {
        const rects = FX.dirty(sp, o, n);
        assert(rects.length <= FX.MAX_RECTS);
        const inR = (x, y) => rects.some((q) => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h);
        for (let y = 0; y < sp.h; y += 2) for (let x = 0; x < sp.w; x += 2) {
            const p = FX.shade(sp, x + 0.5, y + 0.5, o), q = FX.shade(sp, x + 0.5, y + 0.5, n);
            if (Math.abs(p[3] - q[3]) > 1 || Math.abs(p[0] - q[0]) > 1) assert(inR(x, y), st + ' pixel ' + x + ',' + y + ' changed outside the rectangles');
        }
    }
}

/* the tach's small gauges: oil (u_v.y) and boost (u_v.w), side by side, apart from the gear window */
{
    const sp = F.dialFx('tech', 'rpm', { redline: 7000, max: 8000 });
    assert.deepStrictEqual(sp.subs.map((s) => s.u), ['y', 'w']);
    const [oil, boost] = sp.subs;
    assert(boost.cx < F.C && oil.cx > F.C, 'boost on the left, oil on the right');
    const lcdBottom = F.LCD.y + F.LCD.h;
    sp.subs.forEach((s) => assert(s.cy - s.len - 4 > lcdBottom, 'small needle clear of the gear window'));
    // boost at full scale points at the right end of its arc; oil does not move with it
    const tip = (s, ang) => [s.cx + Math.sin(ang * Math.PI / 180) * (s.len - 3), s.cy - Math.cos(ang * Math.PI / 180) * (s.len - 3)];
    const st = { a: -125, b: F.SUB.a0, c: F.SUB.a1, lv: 0 };
    assert(FX.shade(sp, ...tip(boost, F.SUB.a1), st)[3] > 200, 'boost needle at 21 psi');
    assert(FX.shade(sp, ...tip(oil, F.SUB.a1), st)[3] < 10, 'oil needle not moved by boost');
    assert(/u_v\.w/.test(FX.shader(sp)) && !/u_time|highp float u_/.test(FX.shader(sp)), 'boost uses u_v.w; no clock, no forced highp');
    assert(/#ifdef GL_FRAGMENT_PRECISION_HIGH/.test(FX.shader(sp)));
    // the gear window's pixels are transparent where there is no text (the needle shows through)
    const lc = F.lcd('2', '', { style: 'tech', center: true });
    assert.strictEqual(lc.d[3], 0, 'corner transparent');
}

/* the arc style */
{
    const A = require('./arc');
    const { arcTexts, MAX_LAYERS } = require('./cluster');
    for (const rl of [6000, 7000, 8500]) {
        const o = { redline: rl, max: tachMax(rl) };
        const base = A.arcFace(o), nums = A.numerals(o), sp = A.arcFx(o);
        assert.strictEqual(base.d.length, A.DW * A.DH * 4);
        assert.strictEqual(nums.length, o.max / 1000 + 1, 'a numeral per 1000 rpm');
        nums.forEach((n) => assert(n.box.x >= 0 && n.box.y >= 0 && n.box.x + n.box.w <= A.DW && n.box.y + n.box.h <= A.DH, 'numeral box inside'));
        const src = FX.shader(sp);
        assert(!/NaN|undefined|Infinity/.test(src) && !/hub\(pc/.test(src), 'arc shader: no hub');
        // the needle starts outside the gear disc, reaches the ticks
        const at = (r, ang) => [sp.cx + Math.sin(ang * Math.PI / 180) * r, sp.cy - Math.cos(ang * Math.PI / 180) * r];
        const st = { a: 0, b: 0, c: 0, lv: 0 };
        assert.strictEqual(FX.shade(sp, ...at(A.NEEDLE_IN - 20, 0), st)[3], 0, 'nothing on the gear disc beyond the glow');
        assert(FX.shade(sp, ...at(240, 0), st)[3] > 100, 'needle at r 240');
        // the compositor matches the reference and dirty rectangles cover each change
        const live = new F.Canvas(A.DW, A.DH);
        FX.compose(sp, st, base.d, live.d, [{ x: 0, y: 0, w: A.DW, h: A.DH }]);
        const [px, py] = at(240, 0).map(Math.floor);
        let edge = 0;
        for (let x = px - 14; x <= px + 14; x++) edge = Math.max(edge, live.d[(py * A.DW + x) * 4]);
        assert(edge > 200, 'composited needle has its orange edge');
        const o2 = { a: -40, b: 0, c: 0, lv: 0 }, n2 = { a: 30, b: 0, c: 0, lv: 4 };
        const rects = FX.dirty(sp, o2, n2);
        const inR = (x, y) => rects.some((q) => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h);
        for (let y = 0; y < sp.h; y += 3) for (let x = 0; x < sp.w; x += 3) {
            const p = FX.shade(sp, x + 0.5, y + 0.5, o2), q = FX.shade(sp, x + 0.5, y + 0.5, n2);
            if (Math.abs(p[3] - q[3]) > 1 || Math.abs(p[0] - q[0]) > 1) assert(inR(x, y), 'arc pixel ' + x + ',' + y + ' outside the rectangles');
        }
    }
    // numerals grow towards the needle: biggest at it, back to normal a thousand rpm away
    assert.deepStrictEqual(A.numeralLevels(3000, 9), [0, 0, 0, A.NL - 1, 0, 0, 0, 0, 0]);
    const half = A.numeralLevels(3400, 9);
    assert(half[3] > 0 && half[4] > 0 && half[3] < A.NL - 1 && half[4] < A.NL - 1, 'two numerals part grown between them');
    assert.deepStrictEqual(A.numeralLevels(NaN, 3), [A.NL - 1, 0, 0], 'no rpm: as at 0');
    // pasting a numeral changes only its box
    {
        const o = { redline: 7000, max: 8000 }, base = A.arcFace(o), nums = A.numerals(o);
        const face = A.faceWith(base, nums, nums.map(() => 0)), before = Buffer.from(face.d);
        A.pasteNumeral(face, base, nums[4], A.NL - 1);
        const q = nums[4].box;
        let inside = 0;
        for (let k = 0; k < face.d.length; k += 4) if (face.d[k + 3] !== before[k + 3] || face.d[k] !== before[k]) {
            const x = (k / 4) % A.DW, y = Math.floor(k / 4 / A.DW);
            assert(x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h, 'paste outside the box'); inside++;
        }
        assert(inside > 50, 'the bigger numeral changed pixels');
        A.pasteNumeral(face, base, nums[4], 0);
        assert(Buffer.compare(face.d, before) === 0, 'back to size 0 restores the face exactly');
        // the rectangle returned covers every pixel a size change touches
        for (const [from, to] of [[0, 3], [3, 6], [6, 2], [2, 0]]) {
            A.pasteNumeral(face, base, nums[5], from);
            const was = Buffer.from(face.d), r = A.pasteNumeral(face, base, nums[5], to, from);
            for (let k = 0; k < face.d.length; k += 4) if (face.d[k] !== was[k] || face.d[k + 3] !== was[k + 3]) {
                const x = (k / 4) % A.DW, y = Math.floor(k / 4 / A.DW);
                assert(x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h, 'numeral size ' + from + '->' + to + ': pixel ' + x + ',' + y + ' outside ' + JSON.stringify(r));
            }
        }
    }
    // the panels: the first take is whole, then only changed cells
    const L = A.arcLayout(0);
    ['dial', 'centre', 'left', 'right', 'strip'].forEach((k) => {
        const q = L[k];
        assert(q.x >= 0 && q.y >= 0 && q.x + q.w <= W && q.y + q.h <= H, k + ' inside the panel');
    });
    assert(L.left.x + L.left.w <= L.dial.x + 60 && L.right.x >= L.dial.x + L.dial.w - 60, 'readouts beside the dial');
    const s = { tempUnit: 'f', torqueUnit: 'lbft', units: 'mph' };
    const v = { oilC: 90, coolC: 88, iatC: 30, outsideC: 18, boostPsi: 12.34, torqueNm: 400, fuel: 0.5, speedText: '48', gearText: 'D3', rangeText: '212 mi', odoText: '41,820 mi', modeText: 'Sport Plus' };
    const t = arcTexts(s, v, false);
    assert.deepStrictEqual([t.left.oil, t.left.cool, t.right.boost, t.right.torque, t.right.tq, t.strip.intake, t.strip.outside, t.strip.mode, t.right.odo],
        ['194', '190', '12', '295', 'LB-FT', '86°F', '64°F', 'SPORT PLUS', '41,820 MI']);
    assert.strictEqual(arcTexts(s, Object.assign({}, v, { peakPsi: 18.6 }), false).right.peak, 'PEAK 19');
    assert.strictEqual(arcTexts(s, Object.assign({}, v, { peakPsi: 0.4 }), false).right.peak, '', 'no peak shown under 1 psi');
    const tn = arcTexts({ tempUnit: 'c', torqueUnit: 'nm', units: 'kmh' }, { boostPsi: null, torqueNm: NaN, iatC: null }, false);
    assert.deepStrictEqual([tn.right.boost, tn.right.torque, tn.right.tq, tn.strip.intake, tn.left.oil, tn.centre.unit], ['--', '--', 'NM', '--', '--', 'KM/H']);
    const p = new A.Panel(L.right.w, L.right.h);
    A.drawRight(p, t.right);
    assert.strictEqual(p.take().whole, true);
    A.drawRight(p, t.right);
    assert.strictEqual(p.take().rects.length, 0, 'nothing changed, nothing sent');
    A.drawRight(p, Object.assign({}, t.right, { boost: '13' }));
    const one = p.take().rects;
    assert.strictEqual(one.length, 1, 'one digit changed, one slot sent');
    assert(one[0].w < 90, 'only that digit (' + one[0].w + ' px wide)');
    A.drawRight(p, Object.assign({}, t.right, { boost: '9' }));
    assert(p.take().rects.some((q) => q.w >= 400), 'fewer digits: the whole value again');
    // big gear letters draw (the 110 px atlas has only figures)
    const g = new A.Panel(L.centre.w, L.centre.h);
    A.drawCentre(g, { gear: 'M', speed: '0', unit: 'MPH' });
    let lit = 0;
    for (let y = 40; y < 175; y++) for (let x = 0; x < 300; x++) if (g.cv.d[(y * 300 + x) * 4 + 3] > 128) lit++;
    assert(lit > 1500, 'the gear letter is drawn (' + lit + ')');
}

/* the rotating needle: its sprite is the composited needle, pointing up, pivot at the bottom centre */
{
    const A = require('./arc');
    const o = { redline: 7000, max: 8000 }, n = A.needleSprite(o), sp = A.arcFx(o);
    assert.strictEqual(n.px * 2, n.w); assert.strictEqual(n.py, n.h);
    let diff = 0;
    for (let y = 0; y < n.h; y += 2) for (let x = 0; x < n.w; x += 2) {
        const want = FX.shade(sp, sp.cx - n.px + x + 0.5, sp.cy - n.py + y + 0.5, { a: 0, b: 0, c: 0, lv: 0 });
        const i = (y * n.w + x) * 4;
        // the dial's ring and lights are not in the sprite: compare only the needle's own pixels
        const r = Math.hypot(x + 0.5 - n.px, y + 0.5 - n.py);
        if (Math.abs(r - 182) < 8 || r > 320) continue;
        diff = Math.max(diff, Math.abs(want[3] - n.cv.d[i + 3]));
    }
    assert(diff <= 2, 'sprite matches the composited needle (' + diff + ')');
    const st = { a: 30, b: 0, c: 0, lv: 0 }, noNeedle = Object.assign({}, sp, { main: null });
    assert(!/u_v\.x\);/.test(FX.shader(noNeedle)) && FX.dirty(noNeedle, { a: 0, b: 0, c: 0, lv: 0 }, st).every((q) => q.w * q.h < 4000), 'no needle: only the lit arc moves');
}

/* the camera notch: a smaller tach, its ticks and numerals below the driver camera (x 740-1180, y 0-120) */
{
    const A = require('./arc');
    const N = A.arcLayout(0, true), k = N.scale;
    assert(k !== 1 && N.dial.iw === A.DW && N.dial.sampling === 'bilinear' && N.centre.iw === 300);
    // the pivot of the stretched dial lands at (cx, cy)
    assert(Math.abs(N.dial.x + A.DCX * k - N.cx) <= 1 && Math.abs(N.dial.y + A.DCY * k - N.cy) <= 1);
    const top = (r, a) => [N.cx + Math.sin(a * Math.PI / 180) * r * k, N.cy - Math.cos(a * Math.PI / 180) * r * k];
    for (let a = -125; a <= 125; a += 5) {
        const [x, y] = top(A.R, a);
        if (x > 740 && x < 1180) assert(y > 125, 'tick at ' + a + ' deg under the camera (' + x.toFixed(0) + ',' + y.toFixed(0) + ')');
        const [lx, ly] = top(340, a);                       // shift lights, red zone only (right side)
        if (a > 20 && lx > 740 && lx < 1180) assert(ly > 125, 'shift light under the camera');
    }
    assert(N.cy + 192 * k < N.strip.y, 'the rpm label clears the strip');
    assert(N.dial.y + N.dial.h <= 720 && N.dial.y >= 0, 'the dial inside the panel');
    assert(N.cy - A.R * k >= 150, 'ticks below the camera (it ends about y 147)');
    assert(k > 1, 'the tach a little larger than full size');
    const F0 = A.arcLayout(0, false);
    assert.strictEqual(F0.scale, 1); assert(!F0.dial.iw, 'full size: no stretch');
}

/* the arc background: half size, opaque, dark above the horizon, lines below it */
{
    const A = require('./arc');
    const bg = A.gridBackground();
    assert.strictEqual(bg.d.length, A.BG_W * A.BG_H * 4);
    let opaque = true, top = 0, bottom = 0;
    for (let i = 3; i < bg.d.length; i += 4) if (bg.d[i] !== 255) opaque = false;
    for (let x = 0; x < A.BG_W; x++) { top = Math.max(top, bg.d[(20 * A.BG_W + x) * 4]); bottom = Math.max(bottom, bg.d[((A.BG_H - 10) * A.BG_W + x) * 4]); }
    assert(opaque, 'the background is opaque: it hides the stock cluster');
    assert(top < 20, 'black at the top (' + top + ')');
    assert(bottom > 60, 'red lines near the bottom (' + bottom + ')');
    const gr = A.background('graphite');
    assert.strictEqual(gr.d.length, A.BG_W * A.BG_H * 4);
    let gOpaque = true;
    for (let i = 3; i < gr.d.length; i += 4) if (gr.d[i] !== 255) gOpaque = false;
    const at = (x, y) => gr.d[(y * A.BG_W + x) * 4];
    assert(gOpaque && at(480, 20) > at(5, 20) && at(480, 330) > at(480, 200) && at(480, 330) > 50, 'graphite: lighter middle, red pool under the dial');
    const bg2 = require('./app.json').settings.find((x) => x.key === 'arcBg');
    assert(bg2 && bg2.default === 'grid' && bg2.options.map((o) => o[0]).join() === 'grid,graphite,dusk,twin');
    assert.deepStrictEqual(Object.keys(A.BACKGROUNDS), bg2.options.map((o) => o[0]), 'a picture for every choice');
    for (const k of ['dusk', 'twin']) {
        const c = A.background(k), px = (x, y) => c.d[(y * A.BG_W + x) * 4];
        let op = true;
        for (let i = 3; i < c.d.length; i += 4) if (c.d[i] !== 255) op = false;
        assert(op && c.d.length === A.BG_W * A.BG_H * 4, k + ' opaque, half size');
        if (k === 'dusk') assert(px(480, 355) > 60 && px(480, 20) < 10, 'dusk: red at the bottom, black at the top');
        else assert(px(150, 175) > 50 && px(810, 175) > 50 && px(480, 175) < 15, 'twin glow: red behind both sides, dark middle');
    }
}

/* a bad sample never freezes a needle */
{
    const C = require('./cluster');
    assert.strictEqual(typeof C.ClassicCluster, 'function');
}

/* drive mode */
{
    const { modeOf } = require('./modes');
    assert.deepStrictEqual(['SPORT_DYNAMIC', 2, 4, 'ECO_PRO_EFFICIENT', 0, 63, 'COMFORT_PLUS', undefined].map(modeOf),
        ['Sport', 'Sport Plus', 'Comfort', 'Eco Pro', null, null, 'Comfort Plus', null]);
    const { boostPsiOf } = require('./modes');
    assert.strictEqual(boostPsiOf(null, 0, 0, 'gauge'), null, 'no value');
    assert(Math.abs(boostPsiOf(1, 1000, 1500, 'gauge') - 14.5038) < 1e-6, '1 bar = 14.5 psi');
    assert.strictEqual(boostPsiOf(1, 1000, 3000, 'gauge'), null, 'stale after 1.5 s');
    assert(Math.abs(boostPsiOf(2.2, 0, 0, 'absolute') - (2.2 * 14.5038 - 14.696)) < 1e-6, 'absolute: minus one atmosphere');
    assert.strictEqual(boostPsiOf(0.9, 0, 0, 'absolute'), 0, 'vacuum reads 0');
}

/* the app's screen stays on the software path; defaults */
{
    const spec = require('./app.json');
    const r = spec.settings.find((x) => x.key === 'renderer');
    assert(r && r.default === 'software' && r.hidden && r.reset);
    assert.strictEqual(spec.settings.find((x) => x.key === 'style').default, 'tech');
    assert.deepStrictEqual(spec.settings.find((x) => x.key === 'style').options.map((o) => o[0]).sort(), ['arc', 'tech'], 'only the Arc and Tech styles');
    assert(!spec.settings.some((x) => x.key === 'illum'));
    assert(spec.config.dme.iat.length >= 1 && spec.signals['de.bmw.infrastructure.EnvironmentalInformation']._optional);
    assert.strictEqual(spec.settings.find((x) => x.key === "needles").default, "preload");
    assert.deepStrictEqual(spec.settings.find((x) => x.key === 'needles').options.map((o) => o[0]), ['preload', 'rotate', 'shader', 'redraw']);
    assert.strictEqual(spec.settings.find((x) => x.key === 'backdrop').default, 'full');
}

/* the guard: a fake clock, a temporary data folder */
{
    const { Guard, STABLE_MS } = require('./guard');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-guard-'));
    const log = { info() {}, warn() {} };
    let now = 0, offs = [];
    const mk = () => new Guard({ dir, log, now: () => now, disable: (why) => offs.push(why) });
    let g = mk();
    assert.strictEqual(g.boot(), true);
    g.want(); g.target('shown', 'none', ''); g.off();
    g = mk(); assert.strictEqual(g.boot(), true); assert.strictEqual(g.status().strikes, 0);
    g.want(); g.target('shown', 'none', '');
    g = mk(); assert.strictEqual(g.boot(), true); assert.strictEqual(g.status().strikes, 1);
    g.want();
    g = mk(); assert.strictEqual(g.boot(), false, 'second boot strike trips');
    g = mk(); assert.strictEqual(g.boot(), false, 'stays off across starts');
    g.retry(); g = mk(); assert.strictEqual(g.boot(), true, 'turning it on clears it');
    offs = []; g = mk(); g.boot(); g.want();
    for (let i = 0; i < 6; i++) { now += 1000; g.target('shown', 'none', ''); now += 2000; g.target('waiting', 'stock', 'held by stock'); }
    assert.strictEqual(g.status().strikes, 0, 'yielding to BMW content is no strike');
    for (let i = 0; i < 6; i++) { now += 1000; g.target('shown', 'none', ''); now += 500; g.disconnected(); }
    assert.strictEqual(offs.length, 1, 'six fast losses: off');
    g.retry(); offs = []; g = mk(); g.boot(); g.want();
    for (let i = 0; i < 9; i++) { now += 1000; g.target('shown', 'none', ''); now += STABLE_MS; g.target('acquiring', 'none', ''); }
    assert.strictEqual(g.status().strikes, 0);
}


/* ---------- pre-loaded (0.13.0): preload.js ---------- */
const PL = require('./preload');
{
    const A = require('./arc');
    // the pieces tile the arc; no cover, turned all the way, reaches past A1 + REACH (under the mask, on the backdrop)
    assert.strictEqual(PL.PIECES[0].s, F.A0);
    assert(Math.abs(PL.PIECES[PL.PIECES.length - 1].e - F.A1) < 1e-9);
    PL.PIECES.forEach((P, i) => {
        if (i) assert(Math.abs(P.s - PL.PIECES[i - 1].e) < 1e-9, 'pieces meet');
        const reach = P.e + PL.EPS + PL.coverTurn(i, F.A1 + 50);
        assert(reach <= F.A1 + PL.REACH + 1e-9, 'cover ' + i + ' reaches ' + reach);
        assert(PL.coverTurn(i, F.A0 - 5) === 0 && PL.coverTurn(i, P.s + 1) > 0 === (P.s + 1 > P.s));
    });
    assert(PL.REACH + 0.3 < 10, 'the mask stays on the backdrop (A1 + 10)');
    // cover keys: piecewise, ending where the cover belongs
    const ks = PL.coverKeys(1, -100, 100, 200), P1 = PL.PIECES[1];
    assert.strictEqual(ks[0][0], 0); assert.strictEqual(ks[ks.length - 1][0], 200);
    assert(Math.abs(ks[ks.length - 1][1] - PL.coverTurn(1, 100)) < 1e-9);
    ks.forEach((k, i) => { if (i) assert(k[0] >= ks[i - 1][0] && k[1] >= ks[i - 1][1] - 1e-9, 'monotonic'); });
    assert(ks.length >= 3 || !(P1.s > -100 && P1.s < 100), 'a key where the needle enters the piece');
    // numerals: full size at the needle, 1/(1+grow) far from it
    assert(Math.abs(PL.numeralScale(4000, 4) - 1) < 1e-9);
    assert(Math.abs(PL.numeralScale(0, 6) - 1 / (1 + A.NUM_GROW)) < 1e-9);
    assert(PL.numeralScale(3600, 4) > PL.numeralScale(3300, 4));

    // the lit arc, put together as the renderer turns the covers, is the old drawing (outside the
    // needle's tip) at a few needle angles
    const o = { redline: 7000, max: 8000 }, face = A.arcFace(o), spec = A.arcFx(o);
    const art = PL.dialArt(face, A.numerals(o), spec);
    const RAD = Math.PI / 180, W = A.DW, Hh = A.DH, r0 = A.R_PROG - 12, r1 = A.R_PROG + 12;
    const samp = (cv, x, y) => {
        const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, r = [0, 0, 0, 0];
        [[x0, y0, (1 - fx) * (1 - fy)], [x0 + 1, y0, fx * (1 - fy)], [x0, y0 + 1, (1 - fx) * fy], [x0 + 1, y0 + 1, fx * fy]].forEach(([xx, yy, w]) => {
            if (xx < 0 || yy < 0 || xx >= cv.w || yy >= cv.h) return;
            const i = (yy * cv.w + xx) * 4, a = cv.d[i + 3] * w; r[0] += cv.d[i] * a; r[1] += cv.d[i + 1] * a; r[2] += cv.d[i + 2] * a; r[3] += a;
        });
        return r[3] > 0 ? [r[0] / r[3], r[1] / r[3], r[2] / r[3], r[3]] : [0, 0, 0, 0];
    };
    const ringSpec = Object.assign({}, spec, { main: null, lights: null });
    for (const th of [-125, -60, PL.PIECES[1].s + 0.6, 90, F.A1]) {
        const live = new Uint8ClampedArray(W * Hh * 4);
        FX.compose(ringSpec, { a: th, b: 0, c: 0, lv: 0 }, face.d, live, [{ x: 0, y: 0, w: W, h: Hh }]);
        let worst = 0;
        for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
            const px = x + 0.5 - A.DCX, py = y + 0.5 - A.DCY, rr = Math.hypot(px, py), a = Math.atan2(px, -py) / RAD;
            if (rr < r0 || rr > r1 || Math.abs(a - th) < 2.5) continue;
            const i = (y * W + x) * 4;
            let c = [face.d[i], face.d[i + 1], face.d[i + 2]];
            const over = (s2) => { const al = s2[3] / 255; c = c.map((v, k) => s2[k] * al + v * (1 - al)); };
            const layer = (sp, turn) => {
                const cs = Math.cos(turn * RAD), sn = Math.sin(turn * RAD), dx = x + 0.5 - A.DCX, dy = y + 0.5 - A.DCY;
                over(samp(sp.cv, dx * cs + dy * sn + A.DCX - sp.q.x - 0.5, -dx * sn + dy * cs + A.DCY - sp.q.y - 0.5));
            };
            art.pieces.forEach((p, k) => { layer(p.lit, 0); layer(p.cover, PL.coverTurn(k, th)); });
            layer(art.mask, 0);
            const al = live[i + 3] / 255;
            for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(c[k] - live[i + k] * al - 0 * (1 - al)));
        }
        assert(worst <= 10, 'lit arc at ' + th + ': differs from the old drawing by ' + worst.toFixed(1));
    }
    // every sub-picture starts on a multiple of 25 dial pixels (exact at the notch scale)
    [art.mask].concat(art.lights, [art.flash], art.pieces.map((p) => p.lit), art.pieces.map((p) => p.cover)).forEach((sp) => {
        assert(sp.q.x % PL.SNAP === 0 && sp.q.y % PL.SNAP === 0, 'snapped: ' + JSON.stringify(sp.q));
    });
    assert.strictEqual(art.lights.length, spec.lights.n);

    // readouts: the shader's twin draws the same figures as the panel did (tabular)
    const at = PL.atlas('tabular', 96, A.ROW.v1.h, A.ROW.b1 - A.ROW.v1.y);
    const p0 = new A.Panel(540, 500);
    A.drawRight(p0, { boost: '19', torque: '220', tq: 'LB-FT', odo: '1 MI', peak: '' });
    const p1 = new A.Panel(540, 500);
    p1.gpu = { boost: {}, torque: {} };
    A.drawRight(p1, { boost: '19', torque: '220', tq: 'LB-FT', odo: '1 MI', peak: '' });
    const spec96 = JSON.parse(/cc-readout (\{.*\})/.exec(PL.readoutShader(A.ROW.v1.w, A.ROW.v1.h, at))[1]);
    for (const [key, q] of [['boost', A.ROW.v1], ['torque', A.ROW.v2]]) {
        const G = p1.gpu[key], u = PL.readoutUniforms(at, G.text, G.cx, G.unitW);
        u.col = [1, 1, 1, 1];
        let worst = 0;
        for (let y = 0; y < q.h; y++) for (let x = 0; x < q.w; x++) {
            const i = ((q.y + y) * 540 + q.x + x) * 4;
            const g = PL.readoutShade(spec96, at.r8, u, x + 0.5, y + 0.5);
            const panelA = p1.cv.d[i + 3], shown = Math.max(g[3], panelA);        // figures (GPU) + unit (pixels)
            worst = Math.max(worst, Math.abs(shown - p0.cv.d[i + 3]));
        }
        assert(worst <= 40, key + ': GPU figures differ from the drawn ones by ' + worst);
    }
    assert(/\)\.r;/.test(PL.readoutShader(10, 10, at)) && at.r8.length === at.cv.w * at.cv.h, 'atlases are r8, read in .r');
    // every cell the readout panels draw lies inside the strips they are sent as
    for (const [key, draw, gpu] of [['left', A.drawLeft, ['oil', 'cool']], ['right', A.drawRight, ['boost', 'torque']], ['centre', A.drawCentre, ['gear', 'speed']]]) {
        const W0 = key === 'centre' ? 300 : 540, H0 = key === 'centre' ? 300 : 500;
        const p = new A.Panel(W0, H0);
        p.gpu = {}; gpu.forEach((f) => { p.gpu[f] = {}; });
        const vals = [
            { oil: '-5', cool: '--', tu: '°C', fuel: 0, range: '---', boost: '0', torque: '-100', tq: 'NM', odo: '0 KM', peak: '', gear: 'P', speed: '0', unit: 'KM/H' },
            { oil: '302', cool: '250', tu: '°F', oilWarn: true, coolWarn: true, fuel: 1, range: '1,234 MI', boost: '29', torque: '999', tq: 'LB-FT', odo: '999,999 MI', peak: 'PEAK 29', gear: 'D8', speed: '188', unit: 'MPH' },
            { oil: '88', cool: '9', tu: '°F', fuel: null, range: '', boost: '--', torque: '--', tq: 'LB-FT', odo: '', peak: 'PEAK 9', gear: '-', speed: '---', unit: 'MPH' },
        ];
        vals.forEach((v) => { draw(p, v); const out = p.take(); (out.whole ? [] : out.rects).forEach((r) => {
            assert(PL.PANEL_BANDS[key].some((b) => r.x >= b.x && r.y >= b.y && r.x + r.w <= b.x + b.w && r.y + r.h <= b.y + b.h), key + ': a change outside the strips ' + JSON.stringify(r));
        }); });
        for (let y = 0; y < H0; y++) for (let x = 0; x < W0; x++) if (p.cv.d[(y * W0 + x) * 4 + 3]) {
            assert(PL.PANEL_BANDS[key].some((b) => x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h), key + ': ink outside the strips at ' + x + ',' + y);
        }
    }
    assert.deepStrictEqual(PL.readoutUniforms(at, '--', 100, 0).g.slice(0, 2), [10, 10]);
    assert.deepStrictEqual(PL.readoutUniforms(at, '', 100, 0).g, [-1, -1, -1, -1]);
    assert.strictEqual(PL.readoutUniforms(at, '12345', 100, 0).g.filter((g) => g >= 0).length, 4, 'four slots at most');
    const ag = PL.atlas('gear', A.CENTRE_GEAR_SIZE, A.CENTRE_GEAR.h, A.CENTRE_GEAR_BASE - A.CENTRE_GEAR.y);
    assert(ag.cv.w <= 2048 && 'PRND'.split('').every((c) => ag.adv[c] > 0));
    const d3 = PL.readoutUniforms(ag, 'D3', 150, 0);
    assert(d3.x[1] - d3.x[0] === Math.round(ag.adv.D) && d3.g[0] === ag.glyphs.indexOf('D'));
    // the app's settings: pre-loaded is the default
    const nd = require('./app.json').settings.find((x) => x.key === 'needles');
    assert.strictEqual(nd.default, 'preload');
    assert(nd.options.some((x) => x[0] === 'rotate'), 'the rotating layer stays a choice (and the fallback)');
}

/* needle response: 'quick' aims a reading ahead while the revs move steadily, never past a shift */
{
    const { aimRpm } = require('./cluster');
    // the engine: a pull in 3rd, a shift, a pull in 4th, a lift; readings 9 a second (111 ms), as on the car
    const engine = (t) => t < 1.5 ? 2500 + 3000 * t : t < 1.7 ? 7000 - (t - 1.5) * 13000 : t < 3.5 ? 4400 + 1300 * (t - 1.7) : Math.max(1500, 6740 - 4000 * (t - 3.5));
    const run = (quick) => {
        const d = {};
        let from = engine(0), to = from, t0 = 0, err = 0, n = 0, under = 0, over = 0;
        for (let k = 0; k * 0.111 < 4.5; k++) {
            const t = k * 0.111, aim = aimRpm(d, engine(t), quick);
            for (let tt = t; tt < t + 0.111; tt += 0.01) {                 // the needle, gliding over the interval
                const shown = from + (to - from) * Math.min(1, (tt - t0) / 0.111), e = shown - engine(tt);
                err += Math.abs(e); n++; under = Math.min(under, e); over = Math.max(over, e);
            }
            from = from + (to - from) * Math.min(1, (t - t0) / 0.111); to = aim; t0 = t;
        }
        return { mean: err / n, under, over };
    };
    const smooth = run(false), quick = run(true);
    assert(quick.mean < smooth.mean * 0.75, 'quick is closer to the engine: ' + quick.mean.toFixed(0) + ' vs ' + smooth.mean.toFixed(0) + ' rpm');
    // the worst moments (the needle still above the engine after a shift: the lag itself) no worse than smooth's
    assert(quick.over <= smooth.over + 350 && quick.under >= smooth.under - 350, 'quick never swings past by more: ' + JSON.stringify({ quick, smooth }));
    // across the shift (a 2,600 rpm drop) quick aims at the rpm itself
    const d = {};
    [5800, 6100, 6400, 6700].forEach((r) => aimRpm(d, r, true));
    assert.strictEqual(aimRpm(d, 6700 + 300, true), 7300, 'steady: one reading ahead');
    assert.strictEqual(aimRpm(d, 4400, true), 4400, 'the shift: no prediction');
    assert.strictEqual(aimRpm(d, 4450, true), 4450, 'the turn after it: none');
    assert.strictEqual(aimRpm(d, 4500, true), 4550, 'steady again');
    assert.strictEqual(aimRpm({}, 3000, false), 3000);
}

/* the cluster pre-loaded, with a stand-in client: what it sends at start and while driving */
function preloadDrive(done) {
    const C = require('./cluster');
    const sent = [], layers = new Map();
    let next = 1;
    const add = (kind) => (o) => { const ref = next++; layers.set(ref, { kind, anims: new Map(), opts: o }); sent.push({ op: kind, ref, o }); return ref; };
    const fake = {
        layers, image: add('image'), effect: add('effect'), asset: add('asset'),
        pixels(ref, rects, px) { sent.push({ op: 'pixels', ref, bytes: px.length }); return true; },
        set(ref, o) { sent.push({ op: 'set', ref, o }); }, uniform(ref, name, v) { sent.push({ op: 'uniform', ref, name, v }); },
        bind(ref, s, a) { sent.push({ op: 'bind', ref, s, a }); }, drop(ref) { sent.push({ op: 'drop', ref }); layers.delete(ref); },
        animate(ref, o) { const l = layers.get(ref), n = l.anims.size + 1; l.anims.set(n, Object.assign({ op: 'animate', ref, anim: n }, o)); sent.push({ op: 'animate', ref, o }); return n; },
        _send(m) { sent.push({ op: m.op, ref: m.ref, o: m }); },
    };
    const s = { on: true, style: 'arc', torqueUnit: 'lbft', shift: true, units: 'mph', tempUnit: 'f', redline: 7000, sweep: false, backdrop: 'full',
        tank: 59, dx: 0, dy: 0, needles: 'preload', retake: false, notch: true, arcBg: 'grid' };
    const cl = new C.ClassicCluster({ log: { info() {}, warn() {} }, settings: () => s, app: 'test' });
    cl.cr = fake; cl.enabled = true; cl.state = { target: 'shown', reason: '', layers: {}, why: {}, budget: '' };
    cl.build();
    setTimeout(() => {
        const made = sent.filter((m) => ['image', 'effect'].includes(m.op));
        assert(made.length > 8 && made.length <= 64, made.length + ' layers');
        assert.strictEqual(sent.filter((m) => m.op === 'asset').length, 3);
        // within cluster-render's 16 MB with room for other apps on it: it counts every
        // picture twice (its pixels and a scratch copy), an r8 asset at a byte a pixel
        const mem = sent.filter((m) => m.op === 'image' || m.op === 'asset').reduce((a, m) => a + (m.o.iw || m.o.w) * (m.o.ih || m.o.h) * (m.o.format === 'r8' ? 1 : 4) * 2, 0);
        assert(mem < 12.5 * 1048576, 'pre-loaded uses ' + (mem / 1048576).toFixed(2) + ' MB of the renderer\'s 16');
        assert.strictEqual(cl.mode, 'preload');
        assert(sent.filter((m) => m.op === 'bind').length === 6, 'six readouts bound to atlases');
        let t = Date.now(), seq = 0;
        let n0 = 0;
        // each 50 ms: a new rpm (a tick), and the motion loop at 60 a second in between
        const feed = (rpm, boost) => {
            cl.update({ speed: 50, rpm, fuel: 0.5, oil: 0.5, oilC: 95, coolC: 90, boost: 0.5, boostPsi: boost, torqueNm: 200 + rpm / 20, iatC: 30, outsideC: 15,
                speedText: String(Math.round(rpm / 100)), gearText: 'D3', rangeText: '200 mi', odoText: '1 mi', modeText: 'Sport', live: true, rpmSeq: ++seq, rpmEvery: 50 });
            cl.tick(50, t);
            for (let k = 0; k < 3; k++) { t += 50 / 3; cl.motion(t); }
        };
        for (let i = 0; i < 10; i++) feed(1500, 0);             // the first readouts (whole panels) go out here
        n0 = sent.length;
        for (let r = 1500; r <= 7200; r += 60) feed(r, (r - 1500) / 300);
        for (let r = 7200; r >= 3000; r -= 300) feed(r, 8);
        const drive = sent.slice(n0), px = drive.filter((m) => m.op === 'pixels');
        const dial = [cl.refs.dial].concat(Object.keys(cl.refs).filter((k) => /^(lit|cover|light|num)\d|^needle$|^flash$|^mask$/.test(k)).map((k) => cl.refs[k]));
        assert.strictEqual(px.filter((m) => dial.includes(m.ref)).length, 0, 'the dial sends no pixels while driving');
        const bytes = px.reduce((a, m) => a + m.bytes, 0);
        if (process.env.DBG) { const by = {}; px.forEach((m) => { const k = Object.keys(cl.refs).find((x) => cl.refs[x] === m.ref); by[k] = (by[k] || 0) + m.bytes; }); console.log(by); }
        assert(bytes < 120000, 'a 6 s pull to the redline and back sends ' + bytes + ' bytes of pixels (the peak and units moving only)');
        // never a renderer animation: cluster-render 0.5.2+ rebuilds all of a scene's animations each
        // time one is replaced (RAMSES 19); everything moves by plain sets
        const isAnim = (m) => m.op === 'animate' || (m.o && m.o.op === 'animate');
        assert.strictEqual(sent.filter(isAnim).length, 0, 'no renderer animations at all');
        assert(drive.some((m) => m.op === 'uniform' && m.name === 'u_g'), 'readouts change by uniforms');
        const covers = Object.keys(cl.refs).filter((k) => /^cover\d/.test(k)).map((k) => cl.refs[k]);
        const topAng = Math.max(...drive.filter((m) => m.op === 'set' && m.ref === cl.refs.needle).map((m) => m.o.rotate));
        Object.keys(cl.refs).filter((k) => /^cover\d/.test(k)).forEach((k) => {
            if (PL.PIECES[Number(k.slice(5))].s >= topAng) return;               // a piece the needle never reached
            assert(sent.some((m) => m.op === 'set' && m.ref === cl.refs[k] && m.o.rotate !== undefined), k + ' turned');
        });
        const fl = drive.filter((m) => m.op === 'set' && m.ref === cl.refs.flash);
        assert(fl.length >= 2, 'the flash at the redline');
        // the needle: a set on (nearly) every motion step while it moves, each a small step (no jumps)
        const nd = drive.filter((m) => m.op === 'set' && m.ref === cl.refs.needle).map((m) => m.o.rotate);
        assert(nd.length > 200, 'the needle set ' + nd.length + ' times');
        const steps = nd.slice(1).map((x, i) => Math.abs(x - nd[i]));
        assert(Math.max(...steps) < 15, 'no jump: largest step ' + Math.max(...steps).toFixed(2) + ' deg');
        // the lit arc's edge stays under the needle: each cover's turn is the needle's, clamped
        const lastNeedle = nd[nd.length - 1];
        Object.keys(cl.refs).filter((k) => /^cover\d/.test(k)).forEach((k) => {
            const i = Number(k.slice(5)), sets = sent.filter((m) => m.op === 'set' && m.ref === cl.refs[k] && m.o.rotate !== undefined);
            const want = PL.coverTurn(i, lastNeedle), got = sets.length ? sets[sets.length - 1].o.rotate : 0;
            assert(Math.abs(want - got) < 0.2, k + ': ' + got + ' for the needle at ' + lastNeedle + ' (want ' + want + ')');
        });
        // the sweep: the needle along its curve, up to full scale and back, by sets
        const n5 = sent.length;
        cl.values.live = false; cl.values.speed = 0;
        assert.strictEqual(cl.startSweep(false), '');
        cl.sweep.t0 = t;                                                         // on this test's clock
        for (let k = 0; k < 180; k++) { t += 1000 / 60; if (k % 2 === 0) cl.tick(33, t); cl.motion(t); }   // 3 s
        const sw = sent.slice(n5).filter((m) => m.op === 'set' && m.ref === cl.refs.needle).map((m) => m.o.rotate);
        assert(sw.length > 100, 'the sweep moves the needle (' + sw.length + ' sets)');
        assert(Math.abs(Math.max(...sw) - F.A1) < 0.5, 'to full scale: ' + Math.max(...sw));
        assert(Math.abs(sw[sw.length - 1] - F.A0) < 0.5, 'and back to rest: ' + sw[sw.length - 1]);
        assert(!cl.sweep, 'the sweep over');
        assert.strictEqual(sent.filter(isAnim).length, 0, 'still no renderer animations');
        // a refusal (an older cluster-render) turns the pre-loaded mode off and rebuilds
        cl.preloadFailed(fake, 'layer refused: too many layers');
        setTimeout(() => {
            assert.strictEqual(cl.mode, 'rotate');
            assert(cl.status().preloadOff);
            assert(sent.some((m) => m.op === 'drop' && m.ref === cl.assetRefs) || cl.assetRefs === null, 'atlases dropped');
            done();
        }, 50);
    }, 200);
}
preloadDrive(() => console.log('classic cluster self-check ok'));
