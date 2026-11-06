'use strict';
/* node apps/mx_classic_cluster/test.js - the pure parts: scales, warm-up limit, gear text, artwork sizes */
const assert = require('assert');
const F = require('./faces');
const { tachMax, warmLimit, layout, W, H } = require('./cluster');

assert.strictEqual(F.angleOf(0, 0, 160), F.A0);
assert.strictEqual(F.angleOf(160, 0, 160), F.A1);
assert.strictEqual(F.angleOf(80, 0, 160), 0, 'half scale points straight up');
assert.strictEqual(F.angleOf(999, 0, 160), F.A1, 'clamped');
assert.strictEqual(F.subAngleOf(0.5), 0);
assert.deepStrictEqual([6000, 6500, 7000, 7500, 8500].map(tachMax), [7000, 7000, 8000, 8000, 9000]);
assert.strictEqual(warmLimit(null, 7000), null);
assert.strictEqual(warmLimit(20, 7000), 4500);
assert.strictEqual(warmLimit(60, 7000), 5750);
assert.strictEqual(warmLimit(95, 7000), 7000);
const L = layout(0, 0);
[L.speedo, L.tach].forEach((d) => {
    assert(d.cx - F.C >= 0 && d.cx + F.C <= W && d.cy - F.C >= 0 && d.cy + F.C <= H, 'dial inside the panel');
});
const L2 = layout(80, 30);
[L2.speedo, L2.tach].forEach((d) => assert(d.cx - F.C >= 0 && d.cx + F.C <= W && d.cy + F.C <= H, 'extreme offsets stay inside'));
const n = F.needle(270, 62, 15, true);
assert(n.w % 2 === 0 && n.h % 2 === 0 && n.py > 270 && n.py < n.h);
assert.strictEqual(F.lcd('42', 'mph').d.length, F.LCD.w * F.LCD.h * 4);
console.log('classic cluster self-check ok');

/* the guard: a fake clock, a temporary data folder */
{
    const fs = require('fs'), os = require('os'), path = require('path');
    const { Guard, STABLE_MS } = require('./guard');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-guard-'));
    const log = { info() {}, warn() {} };
    let now = 0, offs = [];
    const mk = () => new Guard({ dir, log, now: () => now, disable: (why) => offs.push(why) });

    // a clean session: shown steadily, turned off by the driver, restarted: no strike
    let g = mk();
    assert.strictEqual(g.boot(), true);
    g.want(); g.target('shown', 'none', ''); g.off();
    g = mk(); assert.strictEqual(g.boot(), true); assert.strictEqual(g.status().strikes, 0);

    // two restarts while the dials were new: off, and it stays off at the next start
    g.want(); g.target('shown', 'none', '');
    g = mk(); assert.strictEqual(g.boot(), true); assert.strictEqual(g.status().strikes, 1);
    g.want();
    g = mk(); assert.strictEqual(g.boot(), false, 'second boot strike trips');
    assert.strictEqual(offs.length, 1);
    g = mk(); assert.strictEqual(g.boot(), false, 'stays off across starts');
    g.retry(); g = mk(); assert.strictEqual(g.boot(), true, 'the driver turning it on clears it');

    // losses: BMW's own content taking the slot never counts; a fast loss three times is a strike
    offs = []; g = mk(); g.boot(); g.want();
    for (let i = 0; i < 6; i++) { now += 1000; g.target('shown', 'none', ''); now += 2000; g.target('waiting', 'stock', 'held by stock'); }
    for (let i = 0; i < 6; i++) { now += 1000; g.target('shown', 'none', ''); now += 2000; g.target('parked', 'none', 'parked'); }
    assert.strictEqual(g.status().strikes, 0, 'yielding to BMW content is no strike');
    for (let i = 0; i < 3; i++) { now += 1000; g.target('shown', 'none', ''); now += 2000; g.target('acquiring', 'none', 'scene removed'); }
    assert.strictEqual(g.status().strikes, 1);
    for (let i = 0; i < 3; i++) { now += 1000; g.target('shown', 'none', ''); now += 500; g.disconnected(); }
    assert.strictEqual(offs.length, 1, 'six fast losses: off');

    // a loss after a long showing is no strike
    g.retry(); offs = []; g = mk(); g.boot(); g.want();
    for (let i = 0; i < 9; i++) { now += 1000; g.target('shown', 'none', ''); now += STABLE_MS; g.target('acquiring', 'none', ''); }
    assert.strictEqual(g.status().strikes, 0);

    // errors in the drawing loop
    for (let i = 0; i < 10; i++) { now += 100; g.error(new Error('x')); }
    assert.strictEqual(offs.length, 1, 'ten errors in a second: off');
    console.log('guard self-check ok');
}

/* the centre panel, and the app forcing the software screen (the GPU overlay was the blank-screen bug) */
{
    assert.strictEqual(F.centerInfo('10:42', '312 mi', '23817 mi').d.length, F.CENTER.w * F.CENTER.h * 4);
    const spec = require('./app.json');
    const r = spec.settings.find((x) => x.key === 'renderer');
    assert(r && r.default === 'software' && r.hidden && r.reset, 'the screen stays on the software path');
    assert.strictEqual(spec.settings.find((x) => x.key === 'backdrop').default, 'full');
    console.log('screen and backdrop self-check ok');
}

/* the shader needle and its JavaScript twin agree on where the needle is */
{
    const sp = { w: 560, h: 560, px: 280, py: 280, len: 270, tail: 62, wid: 15 };
    const fs = F.needleShader(sp);
    assert(/^#version 100\n/.test(fs) && /uniform float u_a;/.test(fs) && !/\$\{|NaN|undefined/.test(fs));
    assert(F.needleShade(sp, 280.5, 100, 0)[3] > 250, 'pointing up at 0 degrees');
    assert(F.needleShade(sp, 280.5 + 180, 280.5, 90)[3] > 250, 'pointing right at 90 degrees (clockwise)');
    assert(F.needleShade(sp, 280.5 - 180, 280.5, 90)[3] < 1, 'nothing on the other side');
    assert.strictEqual(F.segment(30).w, F.SEG.box);
    console.log('needle self-check ok');
}

/* redrawn needles: the pieces sent cover every pixel the needle drew, at any angle */
{
    for (const ang of [-125, -90, -37, 0, 12.5, 45, 90, 125]) {
        const cv = new F.Canvas(580, 580);
        const rects = F.drawNeedleAt(cv, 290, 290, ang, 270, 62, 15, 8);
        for (let y = 0; y < cv.h; y++) for (let x = 0; x < cv.w; x++) {
            if (!cv.d[(y * cv.w + x) * 4 + 3]) continue;
            assert(rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h), 'pixel ' + x + ',' + y + ' at ' + ang + ' outside the pieces');
        }
    }
    console.log('redraw self-check ok');
}

/* drive mode text, and both gauge styles draw */
{
    const { modeOf } = require('./modes');
    assert.deepStrictEqual(['SPORT_DYNAMIC', 2, 4, 'ECO_PRO_EFFICIENT', 0, 63, 'COMFORT_PLUS', undefined].map(modeOf),
        ['Sport', 'Sport Plus', 'Comfort', 'Eco Pro', null, null, 'Comfort Plus', null]);
    ['sport', 'classic'].forEach((st) => {
        assert.strictEqual(F.speedoFace({ style: st, units: 'mph' }).d.length, F.D * F.D * 4);
        assert.strictEqual(F.tachFace({ style: st, redline: 7000, max: 8000, tempUnit: 'f' }).d.length, F.D * F.D * 4);
        assert.strictEqual(F.centerInfo('9:41', '300 mi', '1 mi', { style: st, mode: 'Sport Plus' }).d.length, F.CENTER.w * F.CENTER.h * 4);
        assert.strictEqual(F.lcd('88', 'mph', { style: st }).d.length, F.LCD.w * F.LCD.h * 4);
        const fs = F.needleShader({ w: 100, h: 100, px: 50, py: 50, len: 40, tail: 10, wid: 6, col: F.style(st).rgb });
        assert(!/NaN|undefined/.test(fs));
    });
    console.log('styles and drive mode self-check ok');
}
