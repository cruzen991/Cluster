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
for (const st of ['tech', 'sport', 'classic']) {
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
    const C = F.C, st = (a, lv, t) => ({ a, b: F.SUB.a0, lv: lv || 0, t: t || 0 });
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
    const on = FX.shade(sp, ...at(L.r, segA(8)), st(0, 11, 0.01)), off = FX.shade(sp, ...at(L.r, segA(8)), st(0, 11, 0.13));
    assert(on[0] > 200 && off[0] < 100, 'redline flash');
}

/* dirty rectangles cover every pixel that changes (the redrawn mode depends on it) */
for (const st of ['tech', 'classic']) {
    const sp = F.dialFx(st, 'rpm', { redline: 7000, max: 8000 });
    const cases = [[{ a: -125, b: -52, lv: 0, t: 0 }, { a: -100, b: -40, lv: 0, t: 0 }],
        [{ a: 10, b: 0, lv: 3, t: 0 }, { a: 17, b: 0, lv: 6, t: 0 }],
        [{ a: 60, b: 0, lv: 11, t: 0.01 }, { a: 60.5, b: 0, lv: 11, t: 0.13 }]];
    for (const [o, n] of cases) {
        const rects = FX.dirty(sp, o, n, true);
        const inR = (x, y) => rects.some((q) => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h);
        for (let y = 0; y < sp.h; y += 2) for (let x = 0; x < sp.w; x += 2) {
            const p = FX.shade(sp, x + 0.5, y + 0.5, o), q = FX.shade(sp, x + 0.5, y + 0.5, n);
            if (Math.abs(p[3] - q[3]) > 1 || Math.abs(p[0] - q[0]) > 1) assert(inR(x, y), st + ' pixel ' + x + ',' + y + ' changed outside the rectangles');
        }
    }
}

/* drive mode */
{
    const { modeOf } = require('./modes');
    assert.deepStrictEqual(['SPORT_DYNAMIC', 2, 4, 'ECO_PRO_EFFICIENT', 0, 63, 'COMFORT_PLUS', undefined].map(modeOf),
        ['Sport', 'Sport Plus', 'Comfort', 'Eco Pro', null, null, 'Comfort Plus', null]);
}

/* the app's screen stays on the software path; defaults */
{
    const spec = require('./app.json');
    const r = spec.settings.find((x) => x.key === 'renderer');
    assert(r && r.default === 'software' && r.hidden && r.reset);
    assert.strictEqual(spec.settings.find((x) => x.key === 'style').default, 'tech');
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

console.log('classic cluster self-check ok');
