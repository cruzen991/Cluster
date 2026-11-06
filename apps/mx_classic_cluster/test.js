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
