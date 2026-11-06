'use strict';
/**
 * faces.js - the Tech style's artwork, drawn once in pure JavaScript (kit canvas.js): the
 * speedometer and tachometer faces with their fuel, oil-temperature and boost sub-dials, the gear
 * window and the centre panel. (The Arc style's is in arc.js. The Sport and Classic styles were
 * removed in 0.11.0; they are in the repository's history up to 0.10.3.)
 *
 * Everything here is pixels in, pixels out: no head unit, no renderer. cluster.js puts the
 * results on the instrument cluster; the needles are turned there by the renderer (a layer
 * rotation), so a needle never costs a texture upload after it is drawn.
 *
 * Angles: degrees clockwise from 12 o'clock (canvas.js and the renderer's convention).
 */
let Canvas;
try { ({ Canvas } = require('./kit/canvas')); } catch (e) { ({ Canvas } = require('../../kit/runtime/canvas')); }

const RAD = Math.PI / 180;

/* ---------- geometry (pixels of one dial image) ---------- */
const D = 660;                  // dial image size
const C = D / 2;                // its centre
const A0 = -125, A1 = 125;      // main sweep
const SUB = { cx: C, cy: C + 228, r: 78, a0: -52, a1: 52 };   // the speedometer's fuel gauge, its pivot below the centre
/* the tachometer's two small gauges, side by side below the gear window, in the gap the main needle never sweeps */
const TSUB = { boost: { cx: C - 100, cy: C + 214, r: 60 }, oil: { cx: C + 100, cy: C + 214, r: 60 } };
const BOOST_MAX = 21;           // psi, full scale of the boost gauge
const LCD = { w: 200, h: 54, y: C + 52 };              // LCD window, centred horizontally, top at y

const STYLES = {};
STYLES.tech = {
    needle: { core: '#ff2424', edge: '#ff2424', hi: '#ff9a9a', glow: [255, 50, 50, 40] },
    rgb: { core: [255, 36, 36], edge: [255, 36, 36], hi: [255, 154, 154], glow: [255, 50, 50], fill: [30, 4, 4] },
    il: { mark: '#ffffff', num: '#ffffff', dim: '#787e86', red: '#ff2828', lcd: '#ffffff', ghost: [255, 255, 255, 18] },
};
const style = () => STYLES.tech;
const T = { RD: 300, ring: 284, ringW: 8, tickEnd: 272, num: 189, lights: 316, lightsW: 12 };

const lerp = (a, b, t) => a + (b - a) * t;
const pol = (cx, cy, r, a) => [cx + Math.sin(a * RAD) * r, cy - Math.cos(a * RAD) * r];

/** The main sweep's angle for a value in [lo, hi] (clamped). */
function angleOf(v, lo, hi) {
    const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
    return lerp(A0, A1, t);
}
/** A sub-dial's angle for a fraction 0..1 (clamped). */
function subAngleOf(t) { return lerp(SUB.a0, SUB.a1, Math.max(0, Math.min(1, t))); }

/** A radial tick: from radius r0 to r1 at angle a, width w. */
function tick(cv, cx, cy, a, r0, r1, w, c) {
    const [xa, ya] = pol(cx, cy, r0, a), [xb, yb] = pol(cx, cy, r1, a);
    const nx = Math.cos(a * RAD) * w / 2, ny = Math.sin(a * RAD) * w / 2;
    cv.convex([[xa - nx, ya - ny], [xb - nx, yb - ny], [xb + nx, yb + ny], [xa + nx, ya + ny]], c);
}

/**
 * A small gauge. g: { cx, cy, r }; o: { labels: [[fraction, text]], red: [from, to] fractions or null,
 * icon(cv, x, y, il), font, div (ticks, default 8), every (a major tick every, default 4) }
 */
function subDial(cv, il, g, o) {
    const div = o.div || 8, every = o.every || 4, k = g.r / 78;
    for (let i = 0; i <= div; i++) {
        const t = i / div, a = subAngleOf(t);
        const red = o.red && t >= o.red[0] - 1e-6 && t <= o.red[1] + 1e-6;
        const major = i % every === 0;
        tick(cv, g.cx, g.cy, a, g.r - (major ? 16 : 9) * k, g.r, (major ? 4 : 2.5) * Math.max(0.8, k), red ? il.red : il.mark);
    }
    const size = o.font ? Math.round(18 * Math.max(0.85, k)) : Math.round(22 * Math.max(0.8, k));
    o.labels.forEach(([t, txt]) => {
        const [x, y] = pol(g.cx, g.cy, g.r + 18 * Math.max(0.85, k), subAngleOf(t));
        cv.text(txt, x, y + size * 0.36, size, il.num, { font: o.font || 'bold', align: 'center', literal: true });
    });
    if (o.icon) o.icon(cv, g.cx, g.cy + (g.r >= 70 ? 22 : 26), il, o.font);
}

/** The tachometer's oil-temperature and boost gauges. */
function tachSubs(cv, il, opts, font) {
    const f = opts.tempUnit === 'f';
    subDial(cv, il, TSUB.oil, { labels: f ? [[0, '120'], [0.5, '210'], [1, '300']] : [[0, '50'], [0.5, '100'], [1, '150']],
        red: [f ? (280 - 120) / 180 : 0.9, 1], icon: oilIcon, font });
    subDial(cv, il, TSUB.boost, { labels: [[0, '0'], [1 / 3, '7'], [2 / 3, '14'], [1, '21']], div: 6, every: 2, icon: psiLabel, font });
}
function psiLabel(cv, x, y, il, font) { cv.text('PSI', x, y + 4, font ? 16 : 18, il.dim, { font: font || 'bold', align: 'center', literal: true }); }

/** The fuel pump glyph. */
function pumpIcon(cv, x, y, il) {
    cv.roundRect(x - 9, y - 11, 14, 22, 2, il.dim);
    cv.fillRect(x - 6, y - 8, 8, 6, '#0a0a0b');
    cv.line(x + 5, y - 6, x + 10, y - 2, 2.5, il.dim);
    cv.line(x + 10, y - 2, x + 10, y + 8, 2.5, il.dim);
}

/** The oil-can glyph. */
function oilIcon(cv, x, y, il) {
    cv.roundRect(x - 12, y - 4, 18, 11, 2, il.dim);
    cv.line(x + 5, y - 2, x + 15, y - 7, 3, il.dim);
    cv.line(x - 6, y - 4, x - 6, y - 9, 3, il.dim);
    cv.circle && cv.circle(x + 16, y + 3, 2.2, il.dim);
}

/** The speedometer face. opts: { units: 'mph' | 'kmh' } */
function speedoFace(opts) { return techFace('speed', opts); }

/** The tachometer face. opts: { redline (rpm), max (rpm, a multiple of 1000), tempUnit: 'c' | 'f' } */
function tachFace(opts) { return techFace('rpm', opts); }

/**
 * An LCD's content: text right-aligned in the window, with ghost segments behind and an
 * optional small unit. Returns a Canvas of LCD.w x LCD.h.
 */
function lcd(text, unit, opts) {
    const centre = opts && opts.center, il = STYLES.tech.il;
    const cv = new Canvas(LCD.w, LCD.h);
    // no window: large white figures straight on the face; transparent, so the needle passes under it
    const right = centre ? LCD.w / 2 : unit ? LCD.w - 62 : LCD.w - 14;
    cv.text(text, right, 46, 40, il.lcd, { font: 'orb', align: centre ? 'center' : 'right', literal: true });
    if (unit) cv.text(unit, LCD.w - 10, 46, 20, il.dim, { font: 'orbm', align: 'right', literal: true });
    return cv;
}

/**
 * The centre panel shown when the stock cluster is hidden: the drive mode, the speed, the range and
 * the odometer. Returns a Canvas of CENTER.w x CENTER.h.
 */
const CENTER = { w: 360, h: 240 };
/** opts: { mode (the drive mode as text, or ''), speed, unit } */
function centerInfo(range, odo, opts) {
    const o = opts || {}, il = STYLES.tech.il;
    const cv = new Canvas(CENTER.w, CENTER.h);
    cv.clear('#060608');
    const rule = [255, 255, 255, 40], mode = o.mode || '';
    cv.text(mode ? mode.toUpperCase() : 'DRIVE MODE ---', CENTER.w / 2, 42, 24, mode ? il.lcd : il.dim,
        { font: 'orb', align: 'center', literal: true, spacing: 3 });
    cv.fillRect(24, 58, CENTER.w - 48, 2, rule);
    // the speed: CSPEED is the rectangle a speed change redraws
    const sp = o.speed == null ? '' : String(o.speed);
    cv.text(sp, CENTER.w / 2 + 14, 134, 72, il.lcd, { font: 'orb', align: 'right', literal: true });
    cv.text(o.unit || '', CENTER.w / 2 + 26, 132, 18, il.dim, { font: 'orbm', literal: true });
    cv.fillRect(24, 154, CENTER.w - 48, 2, rule);
    cv.text('RANGE', 30, 192, 18, il.dim, { font: 'orbm', literal: true });
    cv.text(range, CENTER.w - 30, 192, 24, il.lcd, { font: 'orb', align: 'right', literal: true });
    cv.text('ODO', 30, 226, 18, il.dim, { font: 'orbm', literal: true });
    cv.text(odo, CENTER.w - 30, 226, 24, il.lcd, { font: 'orb', align: 'right', literal: true });
    return cv;
}
/** The part of the centre panel a speed change redraws. */
const CSPEED = { x: 20, y: 62, w: CENTER.w - 40, h: 90 };

/* ---------- the tech style: Orbitron numerals, a lit ring, shift lights ---------- */

/** opts: { units, redline, max, tempUnit } */
function techFace(kind, opts) {
    const il = STYLES.tech.il, cv = new Canvas(D, D);
    const speed = kind === 'speed';
    const mph = opts.units !== 'kmh';
    const max = speed ? (mph ? 160 : 260) : (opts.max || 8000);
    const red = speed ? null : (opts.redline || 7000);
    cv.clear([0, 0, 0, 0]);
    cv.arc(C, C, 0, T.RD, 0, 360, '#060608');
    cv.arc(C, C, T.RD - 3, T.RD, 0, 360, '#282c32');
    // the ring's dark track (lit by the fx layer), red from the redline
    cv.arc(C, C, T.ring - T.ringW / 2, T.ring + T.ringW / 2, A0, A1, '#181a1e');
    if (red) cv.arc(C, C, T.ring - T.ringW / 2, T.ring + T.ringW / 2, angleOf(red, 0, max), A1, '#5a1010');
    // shift lights, unlit: 10 segments over the 2000 rpm below the redline
    if (red) {
        const l0 = angleOf(red - 2000, 0, max), l1 = angleOf(red, 0, max), st = (l1 - l0) / 10;
        for (let i = 0; i < 10; i++) cv.arc(C, C, T.lights - T.lightsW / 2, T.lights + T.lightsW / 2, l0 + i * st + 0.8, l0 + (i + 1) * st - 0.8, '#1c1e22');
    }
    // ticks
    const minor = speed ? (mph ? 5 : 10) : 250, major = speed ? 20 : 1000;
    for (let v = 0; v <= max + 1e-6; v += minor) {
        const a = angleOf(v, 0, max), isM = Math.abs(v % major) < 1e-6 || Math.abs(v % major - major) < 1e-6;
        const c = red !== null && v >= red ? il.red : isM ? il.mark : il.dim;
        tick(cv, C, C, a, T.tickEnd - (isM ? 33 : 15), T.tickEnd, isM ? 6 : 3, c);
    }
    // numerals
    for (let v = 0; v <= max + 1e-6; v += major) {
        const [x, y] = pol(C, C, T.num, angleOf(v, 0, max));
        const size = speed ? 44 : 66;
        cv.text(String(speed ? v : v / 1000), x, y + size * 0.36, size, red !== null && v >= red ? il.red : il.num, { font: 'orb', align: 'center', literal: true });
    }
    cv.text(speed ? (mph ? 'mph' : 'km/h') : 'rpm x1000', C, C - 104, 22, il.dim, { font: 'orbm', align: 'center', literal: true });
    if (speed) subDial(cv, il, SUB, { labels: [[0, 'E'], [0.5, '1/2'], [1, 'F']], red: [0, 0.125], icon: pumpIcon, font: 'orbm' });
    else tachSubs(cv, il, opts, 'orbm');
    return cv;
}

/**
 * The moving parts of a dial, for fx.js: needles, hubs, and for the tech style the lit ring and
 * the shift lights. In face pixels.
 */
function dialFx(styleName, kind, opts) {
    const rgb = STYLES.tech.rgb;
    const speed = kind === 'speed';
    const max = speed ? (opts.units === 'kmh' ? 260 : 160) : (opts.max || 8000);
    const red = speed ? null : (opts.redline || 7000);
    const spec = { id: 'tech-' + kind, w: D, h: D, cx: C, cy: C };
    spec.main = { shape: 'hollow', len: 258, tail: 36, wid: 27, ow: 3.5, glowR: 6, glowA: 0.55, fillA: 0.9, col: { edge: rgb.edge, fill: rgb.fill, glow: rgb.glow, core: rgb.core, hi: rgb.hi } };
    // small needles: the fuel gauge (u_v.y) on the speedometer; oil (u_v.y) and boost (u_v.w) on the tach
    const small = (g, u) => ({ cx: g.cx, cy: g.cy, len: Math.round(g.r * 0.85), tail: Math.round(g.r * 0.2), wid: g.r >= 70 ? 8 : 7, hr: g.r >= 70 ? 11 : 9, u });
    spec.subs = speed ? [small(SUB, 'y')] : [small(TSUB.oil, 'y'), small(TSUB.boost, 'w')];
    spec.hub = { r: 36, fill: [12, 12, 14], ring: [60, 64, 70], rw: 3, r1: 9, c1: rgb.core };
    spec.subHub = { r: 11, fill: spec.hub.fill, ring: spec.hub.ring, rw: 1.5, r1: 3, c1: rgb.core };
    spec.ring = { r: T.ring, w: T.ringW, a0: A0, a1: A1, aRed: red ? angleOf(red, 0, max) : A1 + 1, lit: [255, 255, 255], red: [255, 40, 40] };
    if (red) spec.lights = { r: T.lights, w: T.lightsW, n: 10, a0: angleOf(red - 2000, 0, max), a1: angleOf(red, 0, max), gap: 0.8,
        green: 4, yellow: 7, cGreen: [40, 220, 90], cYellow: [255, 200, 30], cRed: [255, 40, 40], cDim: [60, 16, 16] };
    spec.max = max; spec.redline = red;
    return spec;
}

module.exports = {
    CSPEED, techFace, dialFx, TSUB, BOOST_MAX,
    STYLES, style, CENTER, centerInfo,
    Canvas, D, C, A0, A1, SUB, LCD, T,
    angleOf, subAngleOf, pol, speedoFace, tachFace, lcd,
};
