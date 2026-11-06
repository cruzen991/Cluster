'use strict';
/**
 * arc.js - the "Arc" style: one tachometer in the middle of the cluster with the gear and the
 * speed inside it, and large digital readouts either side (oil and coolant left, boost and torque
 * right), a fuel bar with the range, the odometer, and a strip along the bottom with the outside
 * temperature, the drive mode and the intake air temperature.
 *
 * The tach's numerals grow as the needle comes up to them: each numeral is drawn ahead of time at
 * NL sizes (sprites), and a size change re-pastes that numeral's box into the face picture.
 *
 * Layers (cluster.js makes them; at most 7 of the 8 one app may have):
 *   back      the black panel over the stock cluster (cluster.js)
 *   dial      the tach face (numerals included), DW x DH
 *   dialFx    its moving parts as a shader (needles "Shader" only; else composited into dial)
 *   centre    gear and speed inside the tach
 *   left      oil, coolant, fuel bar, range
 *   right     boost, torque, odometer
 *   strip     outside temperature, drive mode, intake temperature
 *
 * Pixels only here: no head unit, no renderer.
 */
const F = require('./faces');
const { Canvas, A0, A1, pol } = F;
let fonts, rgba;
try { fonts = require('./kit/fonts'); ({ rgba } = require('./kit/canvas')); } catch (e) { fonts = require('../../kit/runtime/fonts'); ({ rgba } = require('../../kit/runtime/canvas')); }

const RAD = Math.PI / 180;
const DW = 720, DH = 720;                 // the dial image
const DCX = 360, DCY = 372;               // its pivot
const R = 300;                            // outer end of the ticks
const R_NUM = 226;                        // numerals
const R_INNER = 168;                      // the dark disc the gear sits on
const R_PROG = 182, W_PROG = 6;           // the lit rpm arc
const R_LIGHTS = 334, W_LIGHTS = 12;      // shift lights
const NEEDLE_IN = 176;                    // the needle starts here, outside the gear disc
const NL = 7;                             // numeral sizes
const NUM_SIZE = 44, NUM_GROW = 0.5;      // base size, and how much bigger at the needle
const NUM_BOX = 86;                       // each numeral's box (fits the largest size)
const NUM_REACH = 0.85;                   // the growth starts this many thousand rpm away

const NEEDLE_RED = [255, 38, 38];        // the needle and the lit rpm arc
const ORANGE = [255, 122, 26], WHITE = '#f5f6f8', DIM = '#7a8088', FAINT = '#34383e', RED = '#ee3c32';

/* where the layers sit on the 1920 x 720 panel */
function arcLayout(dy) {
    const y = dy || 0;
    return {
        dial: { x: 960 - DCX, y: y + 0, w: DW, h: DH },
        centre: { x: 960 - 150, y: y + DCY - 150, w: 300, h: 300 },
        left: { x: 50, y: y + 96, w: 540, h: 500 },
        right: { x: 1920 - 50 - 540, y: y + 96, w: 540, h: 500 },
        strip: { x: 560, y: y + 640, w: 800, h: 76 },
    };
}

const angleOf = (v, max) => F.angleOf(v, 0, max);
const tint = (c, k, add) => c.map((v) => Math.round(v * k + add)).concat([255]);

/** The tach face without its numerals. opts: { redline, max } */
function arcFace(opts) {
    const max = opts.max || 8000, red = opts.redline || 7000;
    const cv = new Canvas(DW, DH);
    cv.clear([0, 0, 0, 0]);
    // the backdrop follows the sweep: open at the bottom, clear of the strip below
    cv.arc(DCX, DCY, 0, R + 18, A0 - 10, A1 + 10, '#0c0e11');
    cv.arc(DCX, DCY, R + 13, R + 15, A0 - 6, A1 + 6, FAINT);
    // shift lights, unlit: 10 segments over the 2000 rpm below the redline, each a dark tint of its colour
    const l0 = angleOf(red - 2000, max), l1 = angleOf(red, max), st = (l1 - l0) / 10;
    for (let i = 0; i < 10; i++) {
        const c = i < 4 ? [40, 220, 90] : i < 7 ? [255, 200, 30] : [255, 40, 40];
        cv.arc(DCX, DCY, R_LIGHTS - W_LIGHTS / 2, R_LIGHTS + W_LIGHTS / 2, l0 + i * st + 0.8, l0 + (i + 1) * st - 0.8, tint(c, 0.16, 14));
    }
    // ticks every 100 rpm, longer every 500 and 1000; red from the redline
    for (let v = 0; v <= max; v += 100) {
        const a = angleOf(v, max), major = v % 1000 === 0, half = v % 500 === 0;
        const c = v >= red ? RED : major ? WHITE : DIM;
        tick(cv, a, R - (major ? 34 : half ? 22 : 12), R, major ? 5 : half ? 3 : 2, c);
    }
    cv.arc(DCX, DCY, R - 8, R, angleOf(red, max), A1, '#c8281f');
    // the track the lit arc runs in, and the disc under the gear
    cv.arc(DCX, DCY, R_PROG - W_PROG / 2, R_PROG + W_PROG / 2, A0, A1, '#1c1e22');
    cv.arc(DCX, DCY, 0, R_INNER, 0, 360, '#090a0c');
    cv.text('x1000 RPM', DCX + 150, DCY + 222, 18, DIM, { font: 'orbm', align: 'center', literal: true });
    return cv;
}

function tick(cv, a, r0, r1, w, c) {
    const [xa, ya] = pol(DCX, DCY, r0, a), [xb, yb] = pol(DCX, DCY, r1, a);
    const nx = Math.cos(a * RAD) * w / 2, ny = Math.sin(a * RAD) * w / 2;
    cv.convex([[xa - nx, ya - ny], [xb - nx, yb - ny], [xb + nx, yb + ny], [xa + nx, ya + ny]], c);
}

/**
 * The numerals: [{ n, box: {x, y, w, h} in dial pixels, sprites: [Canvas x NL] }], sprite k drawn
 * at NUM_SIZE * (1 + NUM_GROW * k / (NL - 1)), centred in the box.
 */
function numerals(opts) {
    const max = opts.max || 8000, red = opts.redline || 7000, out = [];
    for (let n = 0; n * 1000 <= max; n++) {
        const [x, y] = pol(DCX, DCY, R_NUM, angleOf(n * 1000, max));
        const box = { x: Math.round(x - NUM_BOX / 2), y: Math.round(y - NUM_BOX / 2), w: NUM_BOX, h: NUM_BOX };
        const sprites = [];
        for (let k = 0; k < NL; k++) {
            const size = NUM_SIZE * (1 + NUM_GROW * k / (NL - 1));
            const cv = new Canvas(NUM_BOX, NUM_BOX);
            cv.clear([0, 0, 0, 0]);
            cv.text(String(n), NUM_BOX / 2, NUM_BOX / 2 + size * 0.36, size, n * 1000 >= red ? RED : WHITE, { font: 'orb', align: 'center', literal: true });
            sprites.push(cv);
        }
        out.push({ n, box, sprites });
    }
    return out;
}

/** Each numeral's size (0 .. NL-1) with the needle at `rpm`: largest at the needle, eased. */
function numeralLevels(rpm, count) {
    const v = (rpm > 0 ? rpm : 0) / 1000, out = [];
    for (let n = 0; n < count; n++) {
        let t = 1 - Math.abs(v - n) / NUM_REACH;
        t = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
        out.push(Math.round(t * (NL - 1)));
    }
    return out;
}

/** Paste numeral `num` at size `k` into `face` (its box restored from `base` first). */
function pasteNumeral(face, base, num, k) {
    const q = num.box;
    for (let y = q.y; y < q.y + q.h; y++) {
        if (y < 0 || y >= face.h) continue;
        const x0 = Math.max(0, q.x), x1 = Math.min(face.w, q.x + q.w), i = (y * face.w + x0) * 4;
        face.d.set(base.d.subarray(i, i + (x1 - x0) * 4), i);
    }
    face.blit(num.sprites[k], q.x, q.y);
}

/** The face with every numeral at its size. */
function faceWith(base, nums, levels) {
    const cv = new Canvas(DW, DH);
    cv.d.set(base.d);
    nums.forEach((num, i) => cv.blit(num.sprites[levels[i] || 0], num.box.x, num.box.y));
    return cv;
}

/** The moving parts for fx.js: the needle (starting outside the gear disc), the lit arc, the shift lights. */
function arcFx(opts) {
    const max = opts.max || 8000, red = opts.redline || 7000;
    return {
        id: 'arc-rpm', w: DW, h: DH, cx: DCX, cy: DCY, max, redline: red,
        // "red glass": a pale pink outline round a see-through red middle, a red glow
        main: { shape: 'hollow', len: R - 4, tail: -NEEDLE_IN, inner: NEEDLE_IN, wid: 20, ow: 2.5, glowR: 7, glowA: 0.7, fillA: 0.55,
            col: { edge: [255, 150, 140], fill: [200, 20, 20], glow: NEEDLE_RED, core: NEEDLE_RED, hi: [255, 170, 170] } },
        subs: [], hub: null, subHub: null,
        ring: { r: R_PROG, w: W_PROG, a0: A0, a1: A1, aRed: A1 + 1, lit: NEEDLE_RED, red: NEEDLE_RED },
        lights: { r: R_LIGHTS, w: W_LIGHTS, n: 10, a0: angleOf(red - 2000, max), a1: angleOf(red, max), gap: 0.8,
            green: 4, yellow: 7, cGreen: [40, 220, 90], cYellow: [255, 200, 30], cRed: [255, 40, 40], cDim: [60, 16, 16] },
    };
}

/* ---------- the background: a red perspective grid under the dials ---------- */
const BG_W = 960, BG_H = 360;             // drawn at half size; cluster-render stretches it (bilinear) to 1920 x 720

/**
 * The "horizon grid": a floor of red lines from a horizon just below the middle, fading out towards
 * the horizon, with a dim red glow along it. Drawn at half size (BG_W x BG_H, 1.4 MB instead of
 * 5.5 MB of cluster-render's shared 16 MB); the renderer's bilinear stretch softens the lines a little.
 * Each pixel works out its distance to the nearest line, so the lines are anti-aliased.
 */
function gridBackground() {
    const cv = new Canvas(BG_W, BG_H), d = cv.d;
    const cx = BG_W / 2, hz = 215, depth = 245, rows = 21;
    // the horizontal lines: their y and brightness (closer = lower and brighter)
    const hl = [];
    for (let k = 1; k <= rows; k++) hl.push({ y: hz + (BG_H - hz) * Math.pow(k / rows, 2.2), a: Math.pow(k / rows, 0.8) });
    for (let y = 0; y < BG_H; y++) {
        const py = y + 0.5;
        const fade = py <= hz ? 0 : Math.min(1, (py - hz) / 110);
        let hr = 0;
        for (const l of hl) { const c = 1.2 - Math.abs(py - l.y); if (c > 0) hr = Math.max(hr, Math.min(1, c) * l.a); }
        const spacing = 5 + 65 * (py - hz) / depth;            // the converging lines' spacing at this row
        for (let x = 0; x < BG_W; x++) {
            const px = x + 0.5, i = (y * BG_W + x) * 4;
            // glow along the horizon, wide and flat
            const gd = Math.hypot((px - cx) / 2.5, py - hz) / 250;
            let g = gd < 1 ? (1 - gd) * (1 - gd) * (3 - 2 * (1 - gd)) * 0.6 : 0;
            let r = 60 * g, gr = 6 * g, b = 6 * g;
            if (fade > 0) {
                const t = (px - cx) / spacing, dist = Math.abs(t - Math.round(t)) * spacing;
                const v = Math.max(0, Math.min(1, 1.1 - dist)) * 0.75;
                const h = hr;
                r += fade * Math.max(120 * h, 90 * v); gr += fade * Math.max(10 * h, 8 * v); b += fade * Math.max(12 * h, 10 * v);
            }
            d[i] = r > 255 ? 255 : r; d[i + 1] = gr; d[i + 2] = b; d[i + 3] = 255;
        }
    }
    return cv;
}

/* ---------- the readout panels: cells redrawn one at a time, only their rectangles sent ---------- */

class Panel {
    constructor(w, h) { this.cv = new Canvas(w, h).clear([0, 0, 0, 0]); this.sig = {}; this.rects = []; this.whole = true; }
    /** Draw cell `key` (rectangle q) with draw(cv) when its signature changed. */
    cell(key, q, sig, draw) {
        if (this.sig[key] === sig) return;
        this.sig[key] = sig;
        clearRect(this.cv, q);
        draw(this.cv);
        if (!this.whole) this.rects.push(q);
    }
    /** What to send: { whole: true } the first time, else the changed rectangles (then forgotten). */
    take() {
        if (this.whole) { this.whole = false; this.rects = []; return { whole: true }; }
        const r = this.rects; this.rects = [];
        return { rects: r };
    }
}
function clearRect(cv, q) {
    for (let y = Math.max(0, q.y); y < Math.min(cv.h, q.y + q.h); y++) {
        const x0 = Math.max(0, q.x), x1 = Math.min(cv.w, q.x + q.w);
        cv.d.fill(0, (y * cv.w + x0) * 4, (y * cv.w + x1) * 4);
    }
}

const LBL = (cv, x, y, s) => cv.text(s, x, y, 18, DIM, { font: 'orbm', align: 'center', literal: true, spacing: 5 });
/** A big value with its unit to the right, the pair centred on x. */
function bigValue(cv, x, base, val, unit, col) {
    const vw = cv.textWidth(val, 96, { font: 'orb', literal: true }), uw = cv.textWidth(unit, 22, { font: 'orbm', literal: true });
    const left = x - (vw + 12 + uw) / 2;
    cv.text(val, left, base, 96, col, { font: 'orb', literal: true });
    cv.text(unit, left + vw + 12, base, 22, DIM, { font: 'orbm', literal: true });
}
/* rows of a side panel (panel pixels) */
// value cells: just the figures' box (96 px figures stand ~70 px above the baseline), so a change
// sends ~130 KB, not the whole row
const ROW = { l1: 46, v1: { x: 60, y: 80, w: 420, h: 84 }, b1: 156, l2: 226, v2: { x: 60, y: 260, w: 420, h: 84 }, b2: 336,
    bar: { x: 140, y: 410, w: 260 }, foot: { x: 0, y: 436, w: 540, h: 56 }, fb: 476 };

/** Oil / coolant / fuel / range. v: { oil, cool (strings), oilWarn, coolWarn, tu ('°F'), fuel (0..1|null), range } */
function drawLeft(p, v) {
    const X = 270;
    p.cell('lbl', { x: 0, y: 0, w: 540, h: 60 }, 'x', (cv) => LBL(cv, X, ROW.l1, 'OIL'));
    p.cell('oil', ROW.v1, v.oil + v.tu + v.oilWarn, (cv) => bigValue(cv, X, ROW.b1, v.oil, v.tu, v.oilWarn ? ORANGE : WHITE));
    p.cell('lbl2', { x: 0, y: 196, w: 540, h: 40 }, 'x', (cv) => LBL(cv, X, ROW.l2, 'COOLANT'));
    p.cell('cool', ROW.v2, v.cool + v.tu + v.coolWarn, (cv) => bigValue(cv, X, ROW.b2, v.cool, v.tu, v.coolWarn ? ORANGE : WHITE));
    const fb = v.fuel == null ? -1 : Math.round(Math.max(0, Math.min(1, v.fuel)) * 40);
    p.cell('bar', { x: 90, y: ROW.bar.y - 8, w: 360, h: 26 }, String(fb), (cv) => {
        const b = ROW.bar;
        cv.roundRect(b.x, b.y, b.w, 10, 5, '#1e2126');
        if (fb >= 0) cv.roundRect(b.x, b.y, Math.max(10, b.w * fb / 40), 10, 5, fb <= 5 ? ORANGE : WHITE);
        for (let k = 1; k < 4; k++) cv.fillRect(b.x + b.w * k / 4 - 1.5, b.y - 2, 3, 14, '#000000');
        cv.text('E', b.x - 16, b.y + 11, 18, DIM, { font: 'orbm', align: 'right', literal: true });
        cv.text('F', b.x + b.w + 16, b.y + 11, 18, DIM, { font: 'orbm', literal: true });
    });
    p.cell('range', ROW.foot, v.range, (cv) => cv.text(v.range, X, ROW.fb, 26, WHITE, { font: 'orb', align: 'center', literal: true }));
}

/** Boost / torque / odometer. v: { boost, torque (strings), tq ('LB-FT'), odo } */
function drawRight(p, v) {
    const X = 270;
    p.cell('lbl', { x: 0, y: 0, w: 540, h: 60 }, 'x', (cv) => LBL(cv, X, ROW.l1, 'BOOST'));
    p.cell('boost', ROW.v1, v.boost, (cv) => bigValue(cv, X, ROW.b1, v.boost, 'PSI', WHITE));
    p.cell('lbl2', { x: 0, y: 196, w: 540, h: 40 }, 'x', (cv) => LBL(cv, X, ROW.l2, 'TORQUE'));
    p.cell('torque', ROW.v2, v.torque + v.tq, (cv) => bigValue(cv, X, ROW.b2, v.torque, v.tq, WHITE));
    p.cell('odoL', { x: 0, y: 396, w: 540, h: 36 }, 'x', (cv) => LBL(cv, X, 420, 'ODOMETER'));
    p.cell('odo', ROW.foot, v.odo, (cv) => cv.text(v.odo, X, ROW.fb, 26, WHITE, { font: 'orb', align: 'center', literal: true }));
}

/** The bottom strip. v: { outside, mode, intake (strings) } */
function drawStrip(p, v) {
    p.cell('rule', { x: 0, y: 0, w: 800, h: 6 }, 'x', (cv) => cv.fillRect(0, 2, 800, 2, FAINT));
    p.cell('out', { x: 0, y: 8, w: 270, h: 66 }, v.outside, (cv) => cv.text(v.outside, 140, 52, 26, WHITE, { font: 'orb', align: 'center', literal: true }));
    p.cell('mode', { x: 270, y: 8, w: 260, h: 66 }, v.mode, (cv) => cv.text(v.mode, 400, 52, 26, ORANGE, { font: 'orb', align: 'center', literal: true, spacing: 6 }));
    p.cell('iat', { x: 530, y: 8, w: 270, h: 66 }, v.intake, (cv) => {
        cv.text('INTAKE', 640, 52, 16, DIM, { font: 'orbm', align: 'right', literal: true, spacing: 3 });
        cv.text(v.intake, 652, 52, 26, WHITE, { font: 'orb', literal: true });
    });
}

/** Gear and speed inside the tach. v: { gear, speed, unit } */
function drawCentre(p, v) {
    p.cell('gear', { x: 0, y: 30, w: 300, h: 150 }, v.gear, (cv) => bigText(cv, v.gear, 150, 160, 118, WHITE));
    p.cell('speed', { x: 30, y: 184, w: 240, h: 70 }, v.speed, (cv) => cv.text(v.speed, 150, 247, 64, WHITE, { font: 'orb', align: 'center', literal: true }));
    p.cell('unit', { x: 60, y: 258, w: 180, h: 30 }, v.unit, (cv) => cv.text(v.unit, 150, 280, 18, ORANGE, { font: 'orbm', align: 'center', literal: true, spacing: 4 }));
}

/**
 * Large Orbitron text centred on x, baseline y. The kit's largest Orbitron atlas (110 px) holds
 * only figures, so canvas.text() above 72 px draws no letters: here each letter comes from the
 * 72 px atlas scaled up, each figure from the 110 px one.
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

module.exports = {
    bigText, gridBackground, BG_W, BG_H,
    DW, DH, DCX, DCY, R, NL, NUM_BOX, NEEDLE_IN, arcLayout, arcFace, numerals, numeralLevels, pasteNumeral, faceWith, arcFx,
    Panel, drawLeft, drawRight, drawStrip, drawCentre,
};
