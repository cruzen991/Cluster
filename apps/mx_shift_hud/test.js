'use strict';
/* node apps/mx_shift_hud/test.js - the Shift HUD's rules, art and layer traffic, without a car or a renderer */
const assert = require('assert');
const A = require('./art');
const { ShiftHud, FLASH_MS } = require('./hud');

const S = { redline: 7000, span: 2500, flash: true, boost: true };
const RAD = Math.PI / 180;

/* shift lights: thresholds, hysteresis, flash */
{
    const st = (rpm, prev, s) => A.shiftState(rpm, s || S, prev);
    assert.deepStrictEqual(st(0), { lv: 0, flash: false });
    assert.deepStrictEqual(st(NaN), { lv: 0, flash: false });
    assert.strictEqual(st(4499).lv, 0, 'nothing below redline - span');
    assert.strictEqual(st(4500).lv, 1, 'the first light at redline - span');
    assert.strictEqual(st(4500 + 2500 / 12 * 5).lv, 6);
    assert.strictEqual(st(6999).lv, 12, 'all lit just under the redline');
    assert.strictEqual(st(6999).flash, false);
    assert.deepStrictEqual(st(7000), { lv: 12, flash: true }, 'flashing from the redline');
    assert.strictEqual(st(7000, null, Object.assign({}, S, { flash: false })).flash, false, 'no flash with the setting off');
    // hysteresis: a light goes out only 60 rpm under its point; the flash holds 60 rpm under the redline
    const at6 = 4500 + 2500 / 12 * 5;
    assert.strictEqual(st(at6 - 30, { lv: 6, flash: false }).lv, 6, 'held within the hysteresis');
    assert.strictEqual(st(at6 - 61, { lv: 6, flash: false }).lv, 5, 'out past it');
    assert.strictEqual(st(at6 - 30, { lv: 4, flash: false }).lv, 5, 'rising: no hold-back');
    assert.strictEqual(st(6950, { lv: 12, flash: true }).flash, true);
    assert.strictEqual(st(6930, { lv: 12, flash: true }).flash, false);
    assert.strictEqual(st(1200, { lv: 12, flash: true }).lv, 0, 'a big drop clears at once');
}

/* gear and boost texts */
{
    assert.strictEqual(A.hudGear('3'), '3'); assert.strictEqual(A.hudGear('D5'), '5'); assert.strictEqual(A.hudGear('M2'), '2');
    assert.strictEqual(A.hudGear('P'), 'P'); assert.strictEqual(A.hudGear('R'), 'R'); assert.strictEqual(A.hudGear(''), '-'); assert.strictEqual(A.hudGear(null), '-');
    assert.strictEqual(A.boostText(14.4), '14'); assert.strictEqual(A.boostText(14.6), '15'); assert.strictEqual(A.boostText(-3), '0');
    assert.strictEqual(A.boostText(null), '--'); assert.strictEqual(A.boostText(NaN), '--'); assert.strictEqual(A.boostText(400), '99');
}

/* every layer inside the HUD's 800 x 480 */
for (const [n, q] of Object.entries({ BAND: A.BAND, MASK: A.MASK, GEAR: A.GEAR, BOOST: A.BOOST })) {
    assert(q.x >= 0 && q.y >= 0 && q.x + q.w <= A.HW && q.y + q.h <= A.HH && q.w > 0 && q.h > 0, n + ' inside the HUD: ' + JSON.stringify(q));
}
assert(A.GEAR.y + A.GEAR.h <= A.BOOST.y + 4, 'the gear clear of boost');

/* the cover, turned as the renderer turns it, leaves exactly lv lights lit, and the mask hides its far end */
const art = { lit: A.litBand(), cover: A.coverBand(), mask: A.maskArt(), red: A.redBand() };
function hudAt(lv) {
    // HUD pixel (x, y): lit band, the cover turned by coverAngle(lv) about the pivot (bilinear), then the mask
    const turn = A.coverAngle(lv) * RAD, c = Math.cos(turn), s = Math.sin(turn);
    const B = A.BAND, P = A.PIVOT, M = A.MASK;
    const get = (cv, x, y) => { x = Math.round(x - 0.5); y = Math.round(y - 0.5); if (x < 0 || y < 0 || x >= cv.w || y >= cv.h) return [0, 0, 0, 0]; const i = (y * cv.w + x) * 4; return [cv.d[i], cv.d[i + 1], cv.d[i + 2], cv.d[i + 3]]; };
    const over = (o, p) => { const a = p[3] / 255; return [0, 1, 2].map((k) => o[k] * (1 - a) + p[k] * a); };
    return (x, y) => {
        let o = [0, 0, 0];
        o = over(o, get(art.lit, x - B.x, y - B.y));
        const dx = x - (B.x + P.x), dy = y - (B.y + P.y);
        o = over(o, get(art.cover, dx * c + dy * s + P.x, -dx * s + dy * c + P.y));     // inverse of a clockwise turn
        o = over(o, get(art.mask, x - M.x, y - M.y));
        return o;
    };
}
const lightCentre = (i) => { const a = (A.ARC.a0 + (i + 0.5) * A.STEP) * RAD; return [A.ARC.cx + Math.sin(a) * A.ARC.r, A.ARC.cy - Math.cos(a) * A.ARC.r]; };
for (const lv of [0, 1, 5, 6, 11, 12]) {
    const px = hudAt(lv);
    for (let i = 0; i < A.N; i++) {
        const [x, y] = lightCentre(i), p = px(x, y), col = A.colourOf(i);
        const lit = Math.abs(p[0] - col[0]) < 12 && Math.abs(p[1] - col[1]) < 12 && Math.abs(p[2] - col[2]) < 12;
        assert.strictEqual(lit, i < lv, 'lv ' + lv + ': light ' + i + (i < lv ? ' lit' : ' unlit') + ' (got ' + p.map(Math.round) + ')');
        if (i >= lv) assert(Math.max(...p) < 60 && Math.max(...p) > 15, 'lv ' + lv + ': light ' + i + ' shows unlit grey, got ' + p.map(Math.round));
    }
    // nothing at all past the band's end: the cover's far end is under the mask
    for (let a = A.ARC.a1 + 4; a < 140; a += 2) for (let r = A.ARC.r - 30; r <= A.ARC.r + 30; r += 6) {
        const x = A.ARC.cx + Math.sin(a * RAD) * r, y = A.ARC.cy - Math.cos(a * RAD) * r;
        if (y >= A.HH - 1) continue;
        const p = px(x, y);
        assert(Math.max(...p) < 3, 'lv ' + lv + ': dark past the band at ' + a + ' deg r ' + r + ' (got ' + p.map(Math.round) + ')');
    }
}

/* boost figures: only the figures' rectangle is sent, the label stays */
{
    const cv = A.boostArt('14');
    const r = A.boostFigures(cv, '15');
    assert(r.w * r.h < A.BOOST_CELL.w * A.BOOST_CELL.h, 'figures only: ' + JSON.stringify(r));
    assert(r.y + r.h <= A.BOOST_CELL.y + A.BOOST_CELL.h, 'the label row untouched');
    assert(A.inkRect(cv, { x: 0, y: 66, w: A.BOOST.w, h: A.BOOST.h - 66 }), 'the label still there');
}

/* the layer traffic, with a stand-in client: moving lights cost no pixels, the flash toggles visibility */
{
    const sent = [];
    let next = 1;
    const fake = {
        image(o) { const ref = next++; sent.push({ op: 'layer', ref, o }); return ref; },
        pixels(ref, rects, px) { sent.push({ op: 'pixels', ref, rects, bytes: px.length }); return true; },
        set(ref, o) { sent.push({ op: 'set', ref, o }); },
    };
    const logs = [];
    const hud = new ShiftHud({ log: { info: (m) => logs.push(m), warn: (m) => logs.push('W ' + m) }, settings: () => S });
    hud.coverMode = true;                       // the cover design (an older cluster-render)
    hud.cr = fake; hud._layers();
    const L = hud.L;
    assert.strictEqual(sent.filter((m) => m.op === 'layer').length, 6, 'six layers');
    sent.filter((m) => m.op === 'layer').forEach((m) => { assert.strictEqual(m.o.target, 'hud'); assert.strictEqual(m.o.visible, false, 'made hidden'); });
    const coverMade = sent.find((m) => m.ref === L.cover && m.op === 'layer').o;
    assert.strictEqual(coverMade.px, A.PIVOT.x); assert.strictEqual(coverMade.py, A.PIVOT.y);
    const n0 = sent.length;
    let t = 1000;
    const run = (v, ms) => { hud.update(Object.assign({ show: true, gearText: '3', boostPsi: 10 }, v)); for (let k = 0; k < ms; k += 33) hud.tick(t += 33); };
    run({ rpm: 900 }, 200);
    assert(sent.slice(n0).some((m) => m.op === 'set' && m.ref === L.lit && m.o.visible === true), 'shown with data');
    assert(sent.slice(n0).some((m) => m.op === 'set' && m.ref === L.mask && m.o.visible === true), 'mask shown');
    const n1 = sent.length;
    for (let r = 3000; r <= 6990; r += 40) run({ rpm: r }, 33);
    const sweep = sent.slice(n1);
    assert.strictEqual(sweep.filter((m) => m.op === 'pixels' && m.ref !== L.boost).length, 0, 'a rev sweep sends no light pixels');
    const turns = sweep.filter((m) => m.op === 'set' && m.ref === L.cover).map((m) => m.o.rotate);
    assert.strictEqual(turns.length, 12, 'one turn per light: ' + turns);
    assert(Math.abs(turns[11] - A.coverAngle(12)) < 1e-9);
    const n2 = sent.length;
    run({ rpm: 7100 }, 1000);
    const fl = sent.slice(n2);
    assert(fl.some((m) => m.op === 'set' && m.ref === L.cover && m.o.rotate === 0), 'the cover back over every light while flashing');
    const flashes = fl.filter((m) => m.op === 'set' && m.ref === L.flash).map((m) => m.o.visible);
    assert(flashes.length >= Math.floor(1000 / FLASH_MS) - 2 && flashes[0] === true, 'flashing, starting on: ' + flashes.length);
    assert(flashes.every((v, i) => i === 0 || v !== flashes[i - 1]), 'on and off in turns');
    const n3 = sent.length;
    run({ rpm: 4800, gearText: '4', boostPsi: 12.2 }, 400);
    const shift = sent.slice(n3), bytes = shift.filter((m) => m.op === 'pixels').reduce((a, m) => a + m.bytes, 0);
    assert.strictEqual(L.vis[L.flash], false, 'flash off after the shift');
    assert.strictEqual(L.vis[L.lit], true);
    assert(shift.some((m) => m.op === 'set' && m.ref === L.cover && m.o.rotate === A.coverAngle(2)), 'two lights at 4,800');
    assert(bytes < 90000, 'an upshift sends the gear and boost rectangles only: ' + bytes + ' bytes');
    const n4 = sent.length;
    run({ rpm: 4800, show: false }, 200);
    const hid = sent.slice(n4).filter((m) => m.op === 'set' && m.o.visible === false).map((m) => m.ref);
    [L.lit, L.cover, L.mask, L.gear, L.boost].forEach((ref) => assert(hid.includes(ref), 'hidden without data: ' + ref));
    assert.strictEqual(sent.slice(n4).filter((m) => m.op === 'pixels').length, 0, 'hiding sends no pixels');
    run({ rpm: NaN, gearText: undefined, boostPsi: NaN }, 200);           // garbage: no throw, nothing lit
    assert.strictEqual(hud.status().lit, 0);
}

/* the sprites design (cluster-render 0.4.2+, the default): no black, no pixels for the lights */
{
    const sent = [];
    let next = 1;
    const fake = {
        image(o) { const ref = next++; sent.push({ op: 'layer', ref, o }); return ref; },
        pixels(ref, rects, px) { sent.push({ op: 'pixels', ref, rects, bytes: px.length }); return true; },
        set(ref, o) { sent.push({ op: 'set', ref, o }); }, drop(ref) { sent.push({ op: 'drop', ref }); },
    };
    const hud = new ShiftHud({ log: { info() {}, warn() {} }, settings: () => S });
    hud.cr = fake; hud._layers();
    const L = hud.L;
    assert.strictEqual(L.mode, 'sprites');
    assert.strictEqual(sent.filter((m) => m.op === 'layer').length, A.N + 4, 'a layer per light, the unlit band, the flash, gear, boost');
    // no opaque black anywhere: every pixel sent is either see-through or has light in it
    const art = hud.art;
    [art.dark, art.red].concat(art.sprites.map((x) => x.cv)).forEach((cv) => {
        for (let i = 0; i < cv.d.length; i += 4) if (cv.d[i + 3] > 40) assert(cv.d[i] + cv.d[i + 1] + cv.d[i + 2] > 60, 'no dark opaque pixel');
    });
    // each sprite is exactly its light: put together, lv lit lights look like the band with lv lit
    const lit5 = A.darkBand();
    for (let i = 0; i < 5; i++) A.drawLight(lit5, i, 'lit');
    const comp = A.darkBand();
    art.sprites.slice(0, 5).forEach((sp) => { for (let y = 0; y < sp.q.h; y++) for (let x = 0; x < sp.q.w; x++) { const j = (y * sp.q.w + x) * 4, a = sp.cv.d[j + 3]; if (a) comp._blend(sp.q.x + x, sp.q.y + y, [sp.cv.d[j], sp.cv.d[j + 1], sp.cv.d[j + 2], 255], a / 255); } });
    let worst = 0;
    for (let i = 0; i < comp.d.length; i++) worst = Math.max(worst, Math.abs(comp.d[i] - lit5.d[i]));
    assert(worst <= 3, 'sprites over the unlit band = the lit band: ' + worst);
    let t = 1000;
    const run = (v, ms) => { hud.update(Object.assign({ show: true, gearText: '3', boostPsi: 10 }, v)); for (let k = 0; k < ms; k += 33) hud.tick(t += 33); };
    run({ rpm: 900 }, 200);
    const n1 = sent.length;
    for (let r = 3000; r <= 6990; r += 40) run({ rpm: r }, 33);
    const sweep = sent.slice(n1);
    assert.strictEqual(sweep.filter((m) => m.op === 'pixels' && m.ref !== L.boost).length, 0, 'a rev sweep sends no light pixels');
    assert.strictEqual(sweep.filter((m) => m.op === 'set' && L.sprites.includes(m.ref) && m.o.visible).length, A.N, 'each light shown once on the way up');
    run({ rpm: 7100 }, 600);
    assert(L.sprites.every((ref) => L.vis[ref] === false), 'flashing: the lights hidden, the red band flashes');
    run({ rpm: 4800 }, 300);
    assert.deepStrictEqual(L.sprites.map((ref) => L.vis[ref]), L.sprites.map((_, i) => i < 2), 'two lights at 4,800');
    // a refused layer (an older cluster-render) switches to the cover design
    const was = L.all.slice();
    hud.cr = Object.assign(fake, { on() {} });
    hud.coverMode = true; hud._rebuild();
    assert(was.every((ref) => sent.some((m) => m.op === 'drop' && m.ref === ref)), 'the sprite layers dropped');
    assert.strictEqual(hud.L.mode, 'cover'); assert.strictEqual(hud.L.all.length, 6);
}

console.log('shift hud: all checks passed');
