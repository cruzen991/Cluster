'use strict';
/**
 * art.js - the Shift HUD's pictures, pure pixels (kit canvas.js): no head unit, no renderer.
 *
 * The HUD target is 800 x 480 (cluster-render's `hud`, slot 0x323, the area above BMW's own speed
 * bar). On the HUD, black is see-through: only what is lit shows, floating on the glass. The design
 * ("Arc"):
 *
 *   - a curved band of N shift lights across the top, green, then yellow, then red, each lit one
 *     with a soft glow; the unlit ones faint grey; at the redline all of them flash red;
 *   - the gear, large, under the middle of the band;
 *   - boost in whole psi under the gear, with a small "PSI BOOST" label.
 *
 * Coordinates are the HUD's (0..800, 0..480); each layer is a rectangle of it (BAND, GEAR, BOOST),
 * drawn in its own canvas with the rectangle's top left at 0, 0.
 */
let Canvas, fonts, rgba;
try { ({ Canvas, rgba } = require('./kit/canvas')); fonts = require('./kit/fonts'); } catch (e) { ({ Canvas, rgba } = require('../../kit/runtime/canvas')); fonts = require('../../kit/runtime/fonts'); }

const HW = 800, HH = 480;
const RAD = Math.PI / 180;
const N = 12;                                   // shift lights
/* the band: an arc about (cx, cy), radius r to the middle of the lights, w wide, from a0 to a1
 * (degrees clockwise from 12 o'clock), gap degrees between lights, corners rounded by `round` px */
const ARC = { cx: 400, cy: 330, r: 250, w: 26, a0: -62, a1: 62, gap: 2.4, round: 5 };
const GLOW = { r: 7, a: 0.5, reach: 16 };       // a lit light's glow: falloff, strength, how far it reaches
const STEP = (ARC.a1 - ARC.a0) / N;

const GREEN = [60, 235, 110], YELLOW = [255, 205, 40], RED = [255, 50, 40];
const UNLIT = [78, 84, 94], UNLIT_A = 0.45;
const WHITE = [240, 245, 250], DIM = [120, 130, 140];

/** Light i's colour when lit (the first half green, then yellow, the last quarter red). */
function colourOf(i) { return i < Math.round(N * 0.5) ? GREEN : i < Math.round(N * 0.75) ? YELLOW : RED; }

/* the band layer's rectangle: every light and its glow */
const BAND = (() => {
    const ro = ARC.r + ARC.w / 2 + GLOW.reach, ri = ARC.r - ARC.w / 2 - GLOW.reach, a = (ARC.a1 + 3) * RAD;
    const x0 = Math.floor(ARC.cx - Math.sin(a) * ro) - 2, y0 = Math.floor(ARC.cy - ro) - 2;
    const y1 = Math.ceil(ARC.cy - Math.cos(a) * ri) + 2;
    return { x: x0, y: y0, w: 2 * (ARC.cx - x0), h: y1 - y0 };
})();
const GEAR = { x: 320, y: 156, w: 160, h: 140 };
const BOOST = { x: 300, y: 292, w: 200, h: 96 };
const BOOST_CELL = { x: 20, y: 0, w: 160, h: 62 };      // the figures, in BOOST's coordinates; the label stays

/** Light i's rectangle in the band layer (with its glow), clipped to the layer. */
function lightRect(i) {
    const lo = ARC.a0 + i * STEP - 3, hi = ARC.a0 + (i + 1) * STEP + 3;
    const ro = ARC.r + ARC.w / 2 + GLOW.reach, ri = ARC.r - ARC.w / 2 - GLOW.reach;
    const xs = [], ys = [];
    for (let a = lo; a <= hi + 1e-9; a += (hi - lo) / 8) for (const r of [ri, ro]) {
        xs.push(ARC.cx + Math.sin(a * RAD) * r - BAND.x); ys.push(ARC.cy - Math.cos(a * RAD) * r - BAND.y);
    }
    const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 1), y0 = Math.max(0, Math.floor(Math.min(...ys)) - 1);
    const x1 = Math.min(BAND.w, Math.ceil(Math.max(...xs)) + 1), y1 = Math.min(BAND.h, Math.ceil(Math.max(...ys)) + 1);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
const LIGHT_RECTS = Array.from({ length: N }, (_, i) => lightRect(i));

/** The union of rectangles (null for none). */
function union(rects) {
    if (!rects.length) return null;
    const x0 = Math.min(...rects.map((q) => q.x)), y0 = Math.min(...rects.map((q) => q.y));
    const x1 = Math.max(...rects.map((q) => q.x + q.w)), y1 = Math.max(...rects.map((q) => q.y + q.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
const cl = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Draw light i into the band canvas, only inside `clip` (band coordinates). look: 'unlit', 'lit'
 * (its own colour, with glow) or 'red' (red, with glow).
 */
function drawLight(cv, i, look, clip) {
    const q = clip ? intersect(LIGHT_RECTS[i], clip) : LIGHT_RECTS[i];
    if (!q) return;
    const mid = ARC.a0 + (i + 0.5) * STEP, half = (STEP - ARC.gap) / 2, hw = ARC.w / 2, rd = ARC.round;
    const col = look === 'red' ? RED : look === 'lit' ? colourOf(i) : UNLIT;
    const c = col.concat([255]), glow = look !== 'unlit';
    for (let y = q.y; y < q.y + q.h; y++) {
        const hy = y + 0.5 + BAND.y - ARC.cy;
        for (let x = q.x; x < q.x + q.w; x++) {
            const hx = x + 0.5 + BAND.x - ARC.cx, rr = Math.sqrt(hx * hx + hy * hy);
            const th = Math.atan2(hx, -hy) / RAD;
            // a rounded rectangle in (along the arc, across it), measured in pixels at this radius
            const u = Math.abs(th - mid) * RAD * rr - (half * RAD * rr - rd), v = Math.abs(rr - ARC.r) - (hw - rd);
            const d = Math.sqrt(Math.max(u, 0) ** 2 + Math.max(v, 0) ** 2) + Math.min(Math.max(u, v), 0) - rd;
            if (d > GLOW.reach) continue;
            if (glow && Math.abs(th - mid) <= STEP / 2) {
                const g = GLOW.a * Math.exp(-Math.max(d, 0) / GLOW.r) * (1 - cl((d - GLOW.reach + 6) / 6));
                if (g > 0.004) cv._blend(x, y, c, g);
            }
            const a = cl(0.5 - d) * (glow ? 1 : UNLIT_A);
            if (a > 0) cv._blend(x, y, c, a);
        }
    }
}
function intersect(a, b) {
    const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
function clearRect(cv, q) {
    for (let y = q.y; y < q.y + q.h; y++) cv.d.fill(0, (y * cv.w + q.x) * 4, (y * cv.w + q.x + q.w) * 4);
}

/** The band with every light unlit (the bottom layer). */
function darkBand() {
    const cv = new Canvas(BAND.w, BAND.h).clear([0, 0, 0, 0]);
    for (let i = 0; i < N; i++) drawLight(cv, i, 'unlit');
    return cv;
}
/** The band with every light red (the flash at the redline). */
function redBand() {
    const cv = new Canvas(BAND.w, BAND.h).clear([0, 0, 0, 0]);
    for (let i = 0; i < N; i++) drawLight(cv, i, 'red');
    return cv;
}
/** The band with every light lit in its own colour (under the cover). */
function litBand() {
    const cv = new Canvas(BAND.w, BAND.h).clear([0, 0, 0, 0]);
    for (let i = 0; i < N; i++) drawLight(cv, i, 'lit');
    return cv;
}

/**
 * The cover: the band's ring, opaque black (on the HUD black is no light: see-through), with every
 * light drawn unlit on it, from the slot edge before light 0 round to past the last light. Turned
 * clockwise about the band's centre by lv * STEP (coverAngle), it hides lights lv..N-1 of the lit
 * band under it and shows them unlit: the lights move with one small message and no pixels. Its
 * leading edge fades over 2 * EDGE px before the slot edge, so the last lit light's glow does not
 * end in a hard line. Turned, the cover's far end (lit lights' worth of unlit lights) swings past
 * the band's end: the mask hides it.
 */
const EDGE = 3;
function coverBand() {
    const cv = new Canvas(BAND.w, BAND.h).clear([0, 0, 0, 0]);
    const ri = ARC.r - ARC.w / 2 - GLOW.reach - 2, ro = ARC.r + ARC.w / 2 + GLOW.reach + 2, end = ARC.a1 + STEP;
    for (let y = 0; y < BAND.h; y++) {
        const hy = y + 0.5 + BAND.y - ARC.cy;
        for (let x = 0; x < BAND.w; x++) {
            const hx = x + 0.5 + BAND.x - ARC.cx, rr = Math.sqrt(hx * hx + hy * hy);
            if (rr < ri || rr > ro) continue;
            const th = Math.atan2(hx, -hy) / RAD;
            if (th > end) continue;
            const a = cl(((th - ARC.a0) * RAD * rr + 2 * EDGE) / (2 * EDGE));      // opaque from the slot edge on
            if (a > 0) { const i = (y * BAND.w + x) * 4; cv.d[i] = cv.d[i + 1] = cv.d[i + 2] = 0; cv.d[i + 3] = Math.round(a * 255); }
        }
    }
    for (let i = 0; i < N; i++) drawLight(cv, i, 'unlit');
    return cv;
}
/* the mask: the ring from the band's end round to past the bottom of the HUD, opaque black, so the
 * cover's far end never shows there; fading in over 2 * EDGE px after the last slot's edge */
const MASK = (() => {
    const ri = ARC.r - ARC.w / 2 - GLOW.reach - 3, ro = ARC.r + ARC.w / 2 + GLOW.reach + 3;
    let x0 = HW, y0 = HH, x1 = 0;
    for (let a = ARC.a1; a <= 200; a += 0.5) for (let r = ri; r <= ro; r += 2) {
        const x = ARC.cx + Math.sin(a * RAD) * r, y = ARC.cy - Math.cos(a * RAD) * r;
        if (y >= HH || x >= HW) continue;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y);
    }
    x0 = Math.max(0, Math.floor(x0) - 2); y0 = Math.max(0, Math.floor(y0) - 2);
    return { x: x0, y: y0, w: Math.min(HW, Math.ceil(x1) + 2) - x0, h: HH - y0 };
})();
function maskArt() {
    const cv = new Canvas(MASK.w, MASK.h).clear([0, 0, 0, 0]);
    const ri = ARC.r - ARC.w / 2 - GLOW.reach - 3, ro = ARC.r + ARC.w / 2 + GLOW.reach + 3;
    for (let y = 0; y < MASK.h; y++) {
        const hy = y + 0.5 + MASK.y - ARC.cy;
        for (let x = 0; x < MASK.w; x++) {
            const hx = x + 0.5 + MASK.x - ARC.cx, rr = Math.sqrt(hx * hx + hy * hy);
            if (rr < ri || rr > ro) continue;
            let th = Math.atan2(hx, -hy) / RAD;
            if (th < 0) th += 360;
            const a = cl(((th - ARC.a1) * RAD * rr) / (2 * EDGE));
            if (a > 0) cv.d[(y * MASK.w + x) * 4 + 3] = Math.round(a * 255);
        }
    }
    return cv;
}

/**
 * Light i lit (with its glow), alone: { cv, q } - q its rectangle in the band layer. The sprites
 * design (cluster-render 0.4.2+): one layer per light, shown and hidden; no black anywhere.
 */
function lightSprite(i) {
    const full = new Canvas(BAND.w, BAND.h).clear([0, 0, 0, 0]);
    drawLight(full, i, 'lit');
    const q = LIGHT_RECTS[i], cv = new Canvas(q.w, q.h).clear([0, 0, 0, 0]);
    for (let y = 0; y < q.h; y++) cv.d.set(full.d.subarray(((q.y + y) * BAND.w + q.x) * 4, ((q.y + y) * BAND.w + q.x + q.w) * 4), y * q.w * 4);
    return { cv, q };
}

/** The cover's turn (degrees, clockwise) that leaves lv lights lit. */
const coverAngle = (lv) => Math.max(0, Math.min(N, lv)) * STEP;
/** The band's centre in the band layer: the cover turns about it. */
const PIVOT = { x: ARC.cx - BAND.x, y: ARC.cy - BAND.y };

/** The rectangle of q in which a canvas has any ink (alpha), or null. */
function inkRect(cv, q) {
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) {
        if (cv.d[(y * cv.w + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/* ---------- text ---------- */

/** Box-blur a canvas's alpha (3 passes of radius r: close to a Gaussian), into a new alpha array. */
function blurAlpha(cv, r) {
    const w = cv.w, h = cv.h;
    let a = new Float32Array(w * h), b = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) a[i] = cv.d[i * 4 + 3] / 255;
    const pass = (src, dst, horiz) => {
        const n = horiz ? w : h, m = horiz ? h : w, k = 1 / (2 * r + 1);
        for (let j = 0; j < m; j++) {
            let s = 0;
            const at = (i) => (horiz ? j * w + i : i * w + j);
            for (let i = -r; i <= r; i++) s += i >= 0 && i < n ? src[at(i)] : 0;
            for (let i = 0; i < n; i++) {
                dst[at(i)] = s * k;
                const out = i - r, inn = i + r + 1;
                if (out >= 0) s -= src[at(out)];
                if (inn < n) s += src[at(inn)];
            }
        }
    };
    for (let p = 0; p < 3; p++) { pass(a, b, true); pass(b, a, false); }
    return a;
}

/**
 * Large Orbitron text centred on x, baseline y. The kit's largest Orbitron atlas (110 px) holds only
 * figures, so each letter comes from the 72 px atlas scaled up, each figure from the 110 px one.
 */
function bigText(cv, str, x, y, size, col) {
    const c = rgba(col), parts = [];
    let w = 0;
    for (const ch of String(str)) {
        const fig = /[0-9.:-]/.test(ch);
        const f = fonts.get('orb', fig ? size : Math.min(size, 72), ch), g = f && f.glyphs[ch.codePointAt(0)];
        if (!g) continue;
        const k = size / f.size;
        parts.push({ f, g, k, x: w });
        w += g[6] * k;
    }
    const x0 = x - w / 2;
    for (const p of parts) {
        const [gx, gy, gw, gh, ox, oy] = p.g;
        if (gw && gh) cv._blit(p.f, gx, gy, gw, gh, x0 + p.x + ox * p.k, y + oy * p.k, p.k, c);
    }
    return w;
}

/** The gear: big and white with a soft white glow. g: '1'..'9', 'N', 'R', 'P', 'D' or '-'. */
function gearArt(g) {
    const txt = new Canvas(GEAR.w, GEAR.h).clear([0, 0, 0, 0]);
    bigText(txt, String(g || '-'), GEAR.w / 2, 116, 120, WHITE);
    const halo = blurAlpha(txt, 6);
    const cv = new Canvas(GEAR.w, GEAR.h).clear([0, 0, 0, 0]), c = WHITE.concat([255]);
    for (let y = 0; y < GEAR.h; y++) for (let x = 0; x < GEAR.w; x++) {
        const k = halo[y * GEAR.w + x] * 0.45;
        if (k > 0.004) cv._blend(x, y, c, k);
    }
    // the letters themselves over the halo
    for (let i = 0; i < txt.d.length; i += 4) {
        const a = txt.d[i + 3] / 255;
        if (a > 0) cv._blend((i / 4) % GEAR.w, Math.floor(i / 4 / GEAR.w), [txt.d[i], txt.d[i + 1], txt.d[i + 2], 255], a);
    }
    return cv;
}

/** The boost layer whole: the figures and the label. */
function boostArt(text) {
    const cv = new Canvas(BOOST.w, BOOST.h).clear([0, 0, 0, 0]);
    cv.text('PSI BOOST', BOOST.w / 2, 86, 16, DIM.concat([255]), { font: 'orbm', align: 'center', literal: true, spacing: 3 });
    boostFigures(cv, text);
    return cv;
}
/** Redraw only the figures; returns their rectangle (BOOST coordinates). */
function boostFigures(cv, text) {
    const was = inkRect(cv, BOOST_CELL);
    clearRect(cv, BOOST_CELL);
    cv.text(String(text), BOOST.w / 2, 54, 46, WHITE.concat([255]), { font: 'orb', align: 'center', literal: true });
    const now = inkRect(cv, BOOST_CELL);
    return union([was, now].filter(Boolean)) || { x: BOOST_CELL.x, y: BOOST_CELL.y, w: 1, h: 1 };
}

/** Boost as the HUD shows it: whole psi, '--' without a value. */
function boostText(psi) { return psi == null || !isFinite(psi) ? '--' : String(Math.round(Math.max(0, Math.min(99, psi)))); }

/** The gear as the HUD shows it: the number alone in D (or M), else the letter. */
function hudGear(gearText) {
    const s = String(gearText || '-');
    const m = /^[DMS]?(\d+)$/.exec(s);
    return m ? m[1] : s.slice(0, 1) || '-';
}

/**
 * Shift lights for an rpm. s: { redline, span (rpm over which the lights come on), flash (bool) }.
 * Light i comes on at redline - span + i * span / N; from the redline all flash (when s.flash).
 * prev: the last result, so a light goes out only HYST rpm under its point (no flicker on the edge).
 * Returns { lv: lights lit 0..N, flash: bool }.
 */
const HYST = 60;
function shiftState(rpm, s, prev) {
    const start = s.redline - s.span, plv = prev ? prev.lv : 0, pfl = prev ? prev.flash : false;
    if (!(rpm > 0) || !isFinite(rpm)) return { lv: 0, flash: false };
    const count = (r) => Math.max(0, Math.min(N, Math.floor((r - start) / (s.span / N)) + 1));
    let lv = count(rpm);
    if (lv < plv) lv = Math.max(lv, Math.min(plv, count(rpm + HYST)));     // falling: hold until HYST under
    const flash = !!s.flash && (rpm >= s.redline || (pfl && rpm >= s.redline - HYST));
    return { lv, flash };
}

module.exports = {
    HW, HH, N, ARC, BAND, GEAR, BOOST, BOOST_CELL, LIGHT_RECTS, GREEN, YELLOW, RED,
    STEP, PIVOT, MASK, maskArt, lightSprite, colourOf, drawLight, darkBand, redBand, litBand, coverBand, coverAngle, inkRect, gearArt, boostArt, boostFigures, boostText, hudGear, shiftState, bigText, union,
};
