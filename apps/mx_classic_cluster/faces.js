'use strict';
/**
 * faces.js - the classic cluster's artwork, drawn once in pure JavaScript (kit canvas.js):
 * the speedometer and tachometer faces, their fuel and oil-temperature sub-dials, the
 * orange needles and their hub caps, the warm-up segments and the two LCD windows.
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
const R_BEZEL = 328, R_CHROME = 312, R_FACE = 310;
const R_TICK = 292;             // outer end of the main ticks
const A0 = -125, A1 = 125;      // main sweep
const SUB = { cy: C + 228, r: 78, a0: -52, a1: 52 };   // sub-dial (fuel / oil), its pivot below the centre
const LCD = { w: 200, h: 54, y: C + 52 };              // LCD window, centred horizontally, top at y

/* the illumination: classic night orange, or the white of a daytime face */
const ILLUM = {
    orange: { mark: '#ff8a1f', num: '#ff9a2e', dim: '#b8601a', red: '#ff2414', lcd: '#ff9124', ghost: [255, 145, 36, 22] },
    white: { mark: '#eeeeee', num: '#f6f6f6', dim: '#9a9a9a', red: '#ff3a2c', lcd: '#ff9124', ghost: [255, 145, 36, 22] },
};
const NEEDLE = { core: '#ff5a1c', edge: '#d0300a', hi: '#ffb27a', glow: [255, 80, 20, 40] };

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

/** Black face with the chrome bezel ring and a soft vignette. */
function blank(cv) {
    cv.clear([0, 0, 0, 0]);
    cv.arc(C, C, R_CHROME, R_BEZEL, 0, 360, '#2b2b2d');
    // chrome: bright at the top, darker at the bottom, as the classic rings catch the light
    for (let a = 0; a < 360; a += 3) {
        const t = (Math.cos(a * RAD) + 1) / 2;
        const v = Math.round(lerp(70, 205, t));
        cv.arc(C, C, R_CHROME + 2, R_BEZEL - 3, a, a + 3.4, [v, v, v + 4, 255]);
    }
    cv.arc(C, C, R_BEZEL - 3, R_BEZEL, 0, 360, '#111113');
    cv.arc(C, C, 0, R_FACE + 2, 0, 360, '#0a0a0b');
    // a faint lift towards the centre
    for (let r = R_FACE; r > 40; r -= 6) {
        const t = 1 - r / R_FACE;
        cv.arc(C, C, 0, r, 0, 360, [24, 24, 26, Math.round(16 * t)]);
    }
    cv.arc(C, C, R_FACE - 2, R_FACE + 2, 0, 360, '#000000');
}

/** A sub-dial: ticks, end labels, a red zone from redFrom (fraction) and a small icon below. */
function subDial(cv, il, labels, redFrom, redTo, icon) {
    const cx = C, cy = SUB.cy;
    for (let i = 0; i <= 8; i++) {
        const t = i / 8, a = subAngleOf(t);
        const red = t >= redFrom - 1e-6 && t <= redTo + 1e-6;
        const major = i % 4 === 0;
        tick(cv, cx, cy, a, SUB.r - (major ? 16 : 9), SUB.r, major ? 4 : 2.5, red ? il.red : il.mark);
    }
    labels.forEach(([t, s]) => {
        const [x, y] = pol(cx, cy, SUB.r + 20, subAngleOf(t));
        cv.text(s, x, y + 8, 22, il.num, { font: 'bold', align: 'center', literal: true });
    });
    if (icon) icon(cv, cx, cy + 22, il);
}

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

/**
 * The speedometer face.
 * opts: { units: 'mph' | 'kmh', illum: 'orange' | 'white' }
 * In mph the outer scale is 0-160 mph with a small inner km/h scale (as US-market classics had);
 * in km/h the outer scale is 0-260 km/h with a small inner mph scale.
 */
function speedoFace(opts) {
    const il = ILLUM[opts.illum] || ILLUM.orange;
    const cv = new Canvas(D, D);
    blank(cv);
    const mph = opts.units !== 'kmh';
    const max = mph ? 160 : 260, minor = mph ? 5 : 10, mid = mph ? 10 : 20, label = mph ? 20 : 20;
    for (let v = 0; v <= max + 1e-6; v += minor) {
        const a = angleOf(v, 0, max);
        if (v % label === 0) tick(cv, C, C, a, R_TICK - 34, R_TICK, 6, il.mark);
        else if (v % mid === 0) tick(cv, C, C, a, R_TICK - 22, R_TICK, 3.5, il.mark);
        else tick(cv, C, C, a, R_TICK - 13, R_TICK, 2.5, il.mark);
    }
    const size = mph ? 40 : 32;
    for (let v = 0; v <= max; v += label) {
        const [x, y] = pol(C, C, mph ? 212 : 220, angleOf(v, 0, max));
        cv.text(String(v), x, y + size * 0.36, size, il.num, { font: 'bold', align: 'center', literal: true });
    }
    // the inner second scale, small and dim
    const k = mph ? 1.609344 : 1 / 1.609344, imax = Math.floor(max * k / 20) * 20, istep = mph ? 20 : 10;
    for (let v = 0; v <= imax; v += istep) {
        const a = angleOf(v / k, 0, max);
        tick(cv, C, C, a, 166, 175, 2, il.dim);
        if (v % (istep * 2) === 0 && v > 0) {
            const [x, y] = pol(C, C, 150, a);
            cv.text(String(v), x, y + 7, 18, il.dim, { font: 'label', align: 'center', literal: true });
        }
    }
    cv.text(mph ? 'MPH' : 'km/h', C, C - 108, 32, il.num, { font: 'bold', align: 'center', literal: true });
    cv.text(mph ? 'km/h' : 'mph', C, C - 76, 18, il.dim, { font: 'label', align: 'center', literal: true });
    lcdWell(cv);
    subDial(cv, il, [[0, '0'], [0.5, '1/2'], [1, '1/1']], 0, 0.125, pumpIcon);
    return cv;
}

/**
 * The tachometer face.
 * opts: { illum, redline (rpm), max (rpm, a multiple of 1000), tempUnit: 'c' | 'f' }
 */
function tachFace(opts) {
    const il = ILLUM[opts.illum] || ILLUM.orange;
    const cv = new Canvas(D, D);
    blank(cv);
    const max = opts.max || 8000, red = opts.redline || 7000;
    for (let v = 0; v <= max; v += 250) {
        const a = angleOf(v, 0, max), c = v >= red ? il.red : il.mark;
        if (v % 1000 === 0) tick(cv, C, C, a, R_TICK - 36, R_TICK, 7, c);
        else if (v % 500 === 0) tick(cv, C, C, a, R_TICK - 22, R_TICK, 4, c);
        else tick(cv, C, C, a, R_TICK - 12, R_TICK, 2.5, c);
    }
    // the red band along the outer edge from the redline
    cv.arc(C, C, R_TICK + 3, R_TICK + 11, angleOf(red, 0, max), A1, il.red);
    for (let v = 0; v <= max; v += 1000) {
        const [x, y] = pol(C, C, 200, angleOf(v, 0, max));
        cv.text(String(v / 1000), x, y + 23, 64, v >= red ? il.red : il.num, { font: 'bold', align: 'center', literal: true });
    }
    cv.text('x1000 RPM', C, C - 100, 24, il.num, { font: 'bold', align: 'center', literal: true });
    lcdWell(cv);
    const f = opts.tempUnit === 'f';
    // oil temperature: 50-150 C or 120-300 F, red from 140 C / 280 F
    subDial(cv, il, f ? [[0, '120'], [0.5, '210'], [1, '300']] : [[0, '50'], [0.5, '100'], [1, '150']],
        f ? (280 - 120) / 180 : 0.9, 1, oilIcon);
    return cv;
}

/** The recessed LCD window drawn into a face (the LCD layer is drawn over it). */
function lcdWell(cv) {
    const x = C - LCD.w / 2 - 4, y = LCD.y - 4;
    cv.roundRect(x, y, LCD.w + 8, LCD.h + 8, 8, '#2a2a2c');
    cv.roundRect(x + 2, y + 2, LCD.w + 4, LCD.h + 4, 7, '#050505');
}

/**
 * A needle pointing up: { cv, w, h, px, py } with (px, py) its pivot in the image.
 * len: pivot to tip; tail: pivot to the back end; width: at the pivot.
 */
function needle(len, tail, width, glow) {
    const pad = glow ? 8 : 2;
    const w = Math.ceil(width + 2 * pad) | 0, h = Math.ceil(len + tail + 2 * pad) | 0;
    const cv = new Canvas(w + (w & 1), h + (h & 1));
    const px = cv.w / 2, py = pad + len;
    const tipW = Math.max(2.5, width * 0.28);
    const body = (grow) => [
        [px - tipW / 2 - grow, pad - grow * 0.5], [px + tipW / 2 + grow, pad - grow * 0.5],
        [px + width / 2 + grow, py], [px + width * 0.7 + grow, py + tail + grow * 0.5],
        [px - width * 0.7 - grow, py + tail + grow * 0.5], [px - width / 2 - grow, py],
    ];
    if (glow) for (let g = 6; g >= 2; g -= 2) convexPoly(cv, body(g), NEEDLE.glow);
    convexPoly(cv, body(0), NEEDLE.edge);
    convexPoly(cv, body(-1.2), NEEDLE.core);
    // a lighter spine along the front half
    cv.convex([[px - 0.9, pad + 4], [px + 0.9, pad + 4], [px + 1.4, py - len * 0.15], [px - 1.4, py - len * 0.15]], NEEDLE.hi);
    return { cv, w: cv.w, h: cv.h, px, py };
}

/**
 * A needle drawn by a fragment shader on an unturned quad: the quad covers the needle's whole
 * sweep and the shader draws the needle at the angle in uniform u_a (degrees clockwise from up).
 * Nothing is turned, so this does not depend on the renderer turning layers.
 * spec: { w, h (the quad), px, py (the pivot in it), len, tail, wid }
 */
const NEEDLE_RGB = { core: [255, 90, 28], edge: [208, 48, 10], hi: [255, 178, 122], glow: [255, 80, 20] };
const glsl3 = (c) => 'vec3(' + c.map((v) => (v / 255).toFixed(4)).join(', ') + ')';
const f1 = (v) => (Number.isInteger(v) ? v + '.0' : String(v));
function needleShader(sp) {
    return `#version 100
// cc-needle ${JSON.stringify(sp)}
precision mediump float;
uniform float u_a;
varying vec2 v_uv;
void main() {
    vec2 p = v_uv * vec2(${f1(sp.w)}, ${f1(sp.h)}) - vec2(${f1(sp.px)}, ${f1(sp.py)});
    float a = radians(u_a);
    float c = cos(a), s = sin(a);
    vec2 q = vec2(c * p.x + s * p.y, c * p.y - s * p.x);
    float y = q.y;
    float hw = y <= 0.0 ? mix(${f1(sp.wid * 0.14)}, ${f1(sp.wid * 0.5)}, clamp((y + ${f1(sp.len)}) / ${f1(sp.len)}, 0.0, 1.0))
                        : mix(${f1(sp.wid * 0.5)}, ${f1(sp.wid * 0.7)}, clamp(y / ${f1(sp.tail)}, 0.0, 1.0));
    float d = max(abs(q.x) - hw, max(-${f1(sp.len)} - y, y - ${f1(sp.tail)}));
    float body = clamp(0.5 - d, 0.0, 1.0);
    float core = clamp(-0.7 - d, 0.0, 1.0);
    float glow = (1.0 - smoothstep(0.0, 7.0, d)) * 0.16;
    vec3 col = mix(${glsl3(NEEDLE_RGB.edge)}, ${glsl3(NEEDLE_RGB.core)}, core);
    float spine = (1.0 - smoothstep(0.6, 1.6, abs(q.x))) * step(-${f1(sp.len - 4)}, y) * step(y, -${f1(Math.round(sp.len * 0.15))});
    col = mix(col, ${glsl3(NEEDLE_RGB.hi)}, spine * core);
    float al = max(body, glow);
    gl_FragColor = vec4(body > 0.0 ? col : ${glsl3(NEEDLE_RGB.glow)}, al);
}`;
}
/** The shader's twin in JavaScript, for desk previews: straight RGBA at pixel (x, y) of the quad. */
function needleShade(sp, x, y, ang) {
    const sm = (e0, e1, v) => { const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
    const px = x - sp.px, py = y - sp.py, a = ang * RAD, c = Math.cos(a), s = Math.sin(a);
    const qx = c * px + s * py, qy = c * py - s * px;
    const hw = qy <= 0 ? lerp(sp.wid * 0.14, sp.wid * 0.5, Math.max(0, Math.min(1, (qy + sp.len) / sp.len)))
        : lerp(sp.wid * 0.5, sp.wid * 0.7, Math.max(0, Math.min(1, qy / sp.tail)));
    const d = Math.max(Math.abs(qx) - hw, Math.max(-sp.len - qy, qy - sp.tail));
    const body = Math.max(0, Math.min(1, 0.5 - d)), core = Math.max(0, Math.min(1, -0.7 - d));
    const glow = (1 - sm(0, 7, d)) * 0.16;
    let col = NEEDLE_RGB.edge.map((v, i) => lerp(v, NEEDLE_RGB.core[i], core));
    const spine = (1 - sm(0.6, 1.6, Math.abs(qx))) * (qy >= -(sp.len - 4) ? 1 : 0) * (qy <= -Math.round(sp.len * 0.15) ? 1 : 0);
    col = col.map((v, i) => lerp(v, NEEDLE_RGB.hi[i], spine * core));
    const al = Math.max(body, glow);
    return [...(body > 0 ? col : NEEDLE_RGB.glow), al * 255];
}

/** convex() takes convex polygons: the needle outline is split into two convex halves. */
function convexPoly(cv, p, c) {
    cv.convex([p[0], p[1], p[2], p[5]], c);
    cv.convex([p[5], p[2], p[3], p[4]], c);
}

/** A round hub cap of radius r: { cv, w, h }. */
function hub(r) {
    const s = Math.ceil(2 * r + 4) | 0;
    const cv = new Canvas(s + (s & 1), s + (s & 1));
    const c = cv.w / 2;
    cv.arc(c, c, 0, r, 0, 360, '#1a1a1b');
    for (let i = 0; i < 8; i++) cv.arc(c, c, 0, r * (1 - i / 9), 0, 360, [40 + i * 3, 40 + i * 3, 42 + i * 3, 30]);
    cv.arc(c, c, r - 2, r, 0, 360, '#3c3c3e');
    cv.arc(c, c, 0, r * 0.18, 0, 360, '#0c0c0c');
    return { cv, w: cv.w, h: cv.h };
}

/**
 * One warm-up segment, a pill already turned to angle a (degrees clockwise), in a small square
 * image: its layer is placed, never turned.
 */
function segment(a) {
    const n = SEG.box, cv = new Canvas(n, n), c = n / 2;
    const ux = Math.sin(a * RAD), uy = -Math.cos(a * RAD);       // along the radius
    const vx = Math.cos(a * RAD), vy = Math.sin(a * RAD);        // across it
    const hl = (SEG.h - 4) / 2, hw = (SEG.w - 4) / 2;
    const quad = (l, w) => [[c - ux * l - vx * w, c - uy * l - vy * w], [c + ux * l - vx * w, c + uy * l - vy * w],
        [c + ux * l + vx * w, c + uy * l + vy * w], [c - ux * l + vx * w, c - uy * l + vy * w]];
    cv.convex(quad(hl, hw), '#ffa020');
    cv.convex(quad(hl * 0.45, hw * 0.5).map(([x, y]) => [x + ux * hl * 0.35, y + uy * hl * 0.35]), [255, 225, 160, 110]);
    return cv;
}
const SEG = { r: 247, w: 12, h: 18, box: 24 };

/**
 * An LCD's content: text right-aligned in the window, with ghost segments behind and an
 * optional small unit. Returns a Canvas of LCD.w x LCD.h.
 */
function lcd(text, unit, opts) {
    const centre = opts && opts.center;
    const il = ILLUM[(opts && opts.illum) || 'orange'] || ILLUM.orange;
    const cv = new Canvas(LCD.w, LCD.h);
    cv.clear('#0d0b08');
    cv.roundRect(0, 0, LCD.w, LCD.h, 6, '#120e09');
    const right = centre ? LCD.w / 2 : unit ? LCD.w - 58 : LCD.w - 14;
    if (opts && opts.ghost) cv.text(opts.ghost, right, 45, 40, il.ghost, { font: 'num', align: 'right', literal: true });
    cv.text(text, right, 45, 40, il.lcd, { font: 'num', align: centre ? 'center' : 'right', literal: true });
    if (unit) cv.text(unit, LCD.w - 10, 44, 18, il.lcd, { font: 'bold', align: 'right', literal: true });
    return cv;
}

/**
 * The centre panel shown when the stock cluster is hidden: a clock, the range and the odometer,
 * in a classic orange-on-black window. Returns a Canvas of CENTER.w x CENTER.h.
 */
const CENTER = { w: 360, h: 190 };
function centerInfo(clock, range, odo, opts) {
    const il = ILLUM[(opts && opts.illum) || 'orange'] || ILLUM.orange;
    const cv = new Canvas(CENTER.w, CENTER.h);
    cv.roundRect(0, 0, CENTER.w, CENTER.h, 12, '#2a2a2c');
    cv.roundRect(3, 3, CENTER.w - 6, CENTER.h - 6, 10, '#0d0b08');
    cv.text(clock, CENTER.w / 2, 82, 64, il.lcd, { font: 'num', align: 'center', literal: true });
    cv.fillRect(24, 104, CENTER.w - 48, 2, [255, 145, 36, 60]);
    cv.text('RANGE', 30, 142, 22, il.dim, { font: 'bold', literal: true });
    cv.text(range, CENTER.w - 30, 142, 32, il.lcd, { font: 'bold', align: 'right', literal: true });
    cv.text('ODO', 30, 176, 22, il.dim, { font: 'bold', literal: true });
    cv.text(odo, CENTER.w - 30, 176, 32, il.lcd, { font: 'bold', align: 'right', literal: true });
    return cv;
}

module.exports = {
    CENTER, centerInfo, needleShader, needleShade, NEEDLE_RGB,
    Canvas, D, C, R_FACE, R_TICK, A0, A1, SUB, LCD, SEG, ILLUM, NEEDLE,
    angleOf, subAngleOf, pol, speedoFace, tachFace, needle, hub, segment, lcd,
};
