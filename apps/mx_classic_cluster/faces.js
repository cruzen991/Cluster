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

/*
 * Gauge styles (setting "Gauge style"):
 *   classic  the first design: black faces in chrome rings, orange markings, orange-red needles
 *   sport    an original modern look: rimless faces, white markings, red needles, a white digital
 *            speed, a dark hub with a red centre
 */
const STYLES = {
    classic: { needle: NEEDLE, rgb: { core: [255, 90, 28], edge: [208, 48, 10], hi: [255, 178, 122], glow: [255, 80, 20] } },
    sport: {
        needle: { core: '#ff2b2b', edge: '#c40f14', hi: '#ff9a9a', glow: [255, 30, 30, 40] },
        rgb: { core: [255, 43, 43], edge: [196, 15, 20], hi: [255, 154, 154], glow: [255, 30, 30] },
        il: { mark: '#ffffff', num: '#ffffff', dim: '#8d939a', red: '#ff2a2a', lcd: '#ffffff', ghost: [255, 255, 255, 18] },
    },
};
STYLES.tech = {
    needle: { core: '#ff2424', edge: '#ff2424', hi: '#ff9a9a', glow: [255, 50, 50, 40] },
    rgb: { core: [255, 36, 36], edge: [255, 36, 36], hi: [255, 154, 154], glow: [255, 50, 50], fill: [30, 4, 4] },
    il: { mark: '#ffffff', num: '#ffffff', dim: '#787e86', red: '#ff2828', lcd: '#ffffff', ghost: [255, 255, 255, 18] },
};
const style = (name) => STYLES[name] || STYLES.classic;
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
function subDial(cv, il, labels, redFrom, redTo, icon, font) {
    const cx = C, cy = SUB.cy;
    for (let i = 0; i <= 8; i++) {
        const t = i / 8, a = subAngleOf(t);
        const red = t >= redFrom - 1e-6 && t <= redTo + 1e-6;
        const major = i % 4 === 0;
        tick(cv, cx, cy, a, SUB.r - (major ? 16 : 9), SUB.r, major ? 4 : 2.5, red ? il.red : il.mark);
    }
    labels.forEach(([t, s]) => {
        const [x, y] = pol(cx, cy, SUB.r + 20, subAngleOf(t));
        cv.text(s, x, y + 8, font ? 18 : 22, il.num, { font: font || 'bold', align: 'center', literal: true });
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
    if (opts.style === 'sport') return speedoFaceSport(opts);
    if (opts.style === 'tech') return techFace('speed', opts);
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
    if (opts.well !== false) lcdWell(cv);
    subDial(cv, il, [[0, '0'], [0.5, '1/2'], [1, '1/1']], 0, 0.125, pumpIcon);
    return cv;
}

/**
 * The tachometer face.
 * opts: { illum, redline (rpm), max (rpm, a multiple of 1000), tempUnit: 'c' | 'f' }
 */
function tachFace(opts) {
    if (opts.style === 'sport') return tachFaceSport(opts);
    if (opts.style === 'tech') return techFace('rpm', opts);
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
 * An LCD's content: text right-aligned in the window, with ghost segments behind and an
 * optional small unit. Returns a Canvas of LCD.w x LCD.h.
 */
function lcd(text, unit, opts) {
    const centre = opts && opts.center;
    const tech = opts && opts.style === 'tech';
    const sport = (opts && opts.style === 'sport') || tech;
    const il = tech ? STYLES.tech.il : sport ? STYLES.sport.il : ILLUM[(opts && opts.illum) || 'orange'] || ILLUM.orange;
    const cv = new Canvas(LCD.w, LCD.h);
    if (sport) {
        // no window: large white figures straight on the face
        cv.clear(tech ? '#060608' : '#050506');
        const right = centre ? LCD.w / 2 : unit ? LCD.w - 62 : LCD.w - 14;
        cv.text(text, right, tech ? 46 : 48, tech ? 40 : 52, il.lcd, { font: tech ? 'orb' : 'bold', align: centre ? 'center' : 'right', literal: true });
        if (unit) cv.text(unit, LCD.w - 10, 46, 20, il.dim, { font: tech ? 'orbm' : 'bold', align: 'right', literal: true });
        return cv;
    }
    cv.clear('#0d0b08');
    cv.roundRect(0, 0, LCD.w, LCD.h, 6, '#120e09');
    const right = centre ? LCD.w / 2 : unit ? LCD.w - 58 : LCD.w - 14;
    if (opts && opts.ghost) cv.text(opts.ghost, right, 45, 40, il.ghost, { font: 'num', align: 'right', literal: true });
    cv.text(text, right, 45, 40, il.lcd, { font: 'num', align: centre ? 'center' : 'right', literal: true });
    if (unit) cv.text(unit, LCD.w - 10, 44, 18, il.lcd, { font: 'bold', align: 'right', literal: true });
    return cv;
}

/**
 * The centre panel shown when the stock cluster is hidden: the drive mode, the range and the odometer,
 * in a classic orange-on-black window. Returns a Canvas of CENTER.w x CENTER.h.
 */
const CENTER = { w: 360, h: 240 };
/** opts: { illum, style, mode (the drive mode as text, or '') } */
function centerInfo(range, odo, opts) {
    const o = opts || {};
    const tech = o.style === 'tech', sport = o.style === 'sport' || tech;
    const il = tech ? STYLES.tech.il : sport ? STYLES.sport.il : ILLUM[o.illum || 'orange'] || ILLUM.orange;
    const F1 = tech ? 'orb' : 'bold', F2 = tech ? 'orbm' : 'bold';
    const rule = sport ? [255, 255, 255, 40] : [255, 145, 36, 60];
    const cv = new Canvas(CENTER.w, CENTER.h);
    if (sport) cv.clear(tech ? '#060608' : '#050506');
    else {
        cv.roundRect(0, 0, CENTER.w, CENTER.h, 12, '#2a2a2c');
        cv.roundRect(3, 3, CENTER.w - 6, CENTER.h - 6, 10, '#0d0b08');
    }
    const mode = o.mode || '';
    cv.text(mode ? mode.toUpperCase() : 'DRIVE MODE ---', CENTER.w / 2, 42, tech ? 24 : 28, mode ? il.lcd : il.dim,
        { font: F1, align: 'center', literal: true, spacing: 3 });
    cv.fillRect(24, 58, CENTER.w - 48, 2, rule);
    // the speed: CSPEED is the rectangle a speed change redraws
    const sp = o.speed == null ? '' : String(o.speed);
    cv.text(sp, CENTER.w / 2 + 14, 134, tech ? 72 : 64, il.lcd, { font: tech ? 'orb' : sport ? 'bold' : 'num', align: 'right', literal: true });
    cv.text(o.unit || '', CENTER.w / 2 + 26, 132, tech ? 18 : 24, il.dim, { font: F2, literal: true });
    cv.fillRect(24, 154, CENTER.w - 48, 2, rule);
    cv.text('RANGE', 30, 192, tech ? 18 : 22, il.dim, { font: F2, literal: true });
    cv.text(range, CENTER.w - 30, 192, tech ? 24 : 32, il.lcd, { font: F1, align: 'right', literal: true });
    cv.text('ODO', 30, 226, tech ? 18 : 22, il.dim, { font: F2, literal: true });
    cv.text(odo, CENTER.w - 30, 226, tech ? 24 : 32, il.lcd, { font: F1, align: 'right', literal: true });
    return cv;
}
/** The part of the centre panel a speed change redraws. */
const CSPEED = { x: 20, y: 62, w: CENTER.w - 40, h: 90 };

/* ---------- the sport style's faces: an original modern design ---------- */

/** Rimless face: a near-black disc, a thin outer ring and a dark track along the sweep. */
function blankSport(cv) {
    cv.clear([0, 0, 0, 0]);
    cv.arc(C, C, 0, 318, 0, 360, '#050506');
    cv.arc(C, C, 312, 316, 0, 360, '#26292e');
    cv.arc(C, C, 298, 306, A0, A1, '#121418');
    cv.arc(C, C, 196, 198, A0 + 8, A1 - 8, '#17191d');
}

/** A sport sweep: ticks every `minor`, longer every `mid`, longest every `major`; red from `red`. */
function sportTicks(cv, max, minor, mid, major, red, il) {
    for (let v = 0; v <= max + 1e-6; v += minor) {
        const a = angleOf(v, 0, max), r = red !== null && v >= red;
        const k = Math.abs(v % major) < 1e-6 ? 0 : Math.abs(v % mid) < 1e-6 ? 1 : 2;
        const len = [32, 18, 9][k], w = [3.5, 2.2, 1.6][k];
        tick(cv, C, C, a, 300 - len, 300, w, r ? il.red : k === 2 ? il.dim : il.mark);
    }
    if (red !== null) cv.arc(C, C, 298, 306, angleOf(red, 0, max), A1, il.red);
}

/** The sport speedometer: 0-160 mph (or 0-260 km/h). */
function speedoFaceSport(opts) {
    const il = STYLES.sport.il, cv = new Canvas(D, D);
    blankSport(cv);
    const mph = opts.units !== 'kmh', max = mph ? 160 : 260, step = 20;
    sportTicks(cv, max, mph ? 5 : 10, mph ? 10 : 20, step, null, il);
    for (let v = 0; v <= max; v += step) {
        const [x, y] = pol(C, C, 232, angleOf(v, 0, max));
        cv.text(String(v), x, y + 16, mph ? 44 : 34, il.num, { font: 'bold', align: 'center', literal: true });
    }
    cv.text(mph ? 'mph' : 'km/h', C, C - 96, 24, il.dim, { font: 'bold', align: 'center', literal: true, spacing: 2 });
    subDial(cv, il, [[0, '0'], [0.5, '1/2'], [1, '1/1']], 0, 0.125, pumpIcon);
    return cv;
}

/** The sport tachometer: large light numerals, red from the redline. */
function tachFaceSport(opts) {
    const il = STYLES.sport.il, cv = new Canvas(D, D);
    blankSport(cv);
    const max = opts.max || 8000, red = opts.redline || 7000;
    sportTicks(cv, max, 250, 500, 1000, red, il);
    for (let v = 0; v <= max; v += 1000) {
        const [x, y] = pol(C, C, 206, angleOf(v, 0, max));
        cv.text(String(v / 1000), x, y + 23, 64, v >= red ? il.red : il.num, { font: 'bold', align: 'center', literal: true });
    }
    cv.text('rpm x 1000', C, C - 96, 22, il.dim, { font: 'bold', align: 'center', literal: true, spacing: 2 });
    const f = opts.tempUnit === 'f';
    subDial(cv, il, f ? [[0, '120'], [0.5, '210'], [1, '300']] : [[0, '50'], [0.5, '100'], [1, '150']],
        f ? (280 - 120) / 180 : 0.9, 1, oilIcon);
    return cv;
}

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
    if (speed) subDial(cv, il, [[0, 'E'], [0.5, '1/2'], [1, 'F']], 0, 0.125, pumpIcon, 'orbm');
    else {
        const f = opts.tempUnit === 'f';
        subDial(cv, il, f ? [[0, '120'], [0.5, '210'], [1, '300']] : [[0, '50'], [0.5, '100'], [1, '150']], f ? (280 - 120) / 180 : 0.9, 1, oilIcon, 'orbm');
    }
    return cv;
}

/**
 * The moving parts of a dial, for fx.js: needles, hubs, and for the tech style the lit ring and
 * the shift lights. In face pixels.
 */
function dialFx(styleName, kind, opts) {
    const st = style(styleName), rgb = st.rgb;
    const tech = styleName === 'tech';
    const speed = kind === 'speed';
    const max = speed ? (opts.units === 'kmh' ? 260 : 160) : (opts.max || 8000);
    const red = speed ? null : (opts.redline || 7000);
    const spec = { id: styleName + '-' + kind, w: D, h: D, cx: C, cy: C };
    spec.main = tech
        ? { shape: 'hollow', len: 258, tail: 36, wid: 27, ow: 3.5, glowR: 6, glowA: 0.55, fillA: 0.9, col: { edge: rgb.edge, fill: rgb.fill, glow: rgb.glow, core: rgb.core, hi: rgb.hi } }
        : { shape: 'taper', len: 270, tail: 62, wid: 15, col: rgb };
    spec.sub = { cx: C, cy: SUB.cy, len: 66, tail: 16, wid: 8 };
    const hubs = {
        classic: { r: 36, fill: [26, 26, 27], ring: [60, 60, 62], rw: 2, r1: 6.5, c1: [12, 12, 12] },
        sport: { r: 36, fill: [11, 12, 14], ring: [46, 50, 55], rw: 2.5, r1: 11.5, c1: rgb.core, r2: 5, c2: [11, 12, 14] },
        tech: { r: 36, fill: [12, 12, 14], ring: [60, 64, 70], rw: 3, r1: 9, c1: rgb.core },
    };
    spec.hub = hubs[styleName] || hubs.classic;
    spec.subHub = { r: 11, fill: spec.hub.fill, ring: spec.hub.ring, rw: 1.5, r1: 3, c1: tech || styleName === 'sport' ? rgb.core : [12, 12, 12] };
    if (tech) {
        spec.ring = { r: T.ring, w: T.ringW, a0: A0, a1: A1, aRed: red ? angleOf(red, 0, max) : A1 + 1, lit: [255, 255, 255], red: [255, 40, 40] };
        if (red) spec.lights = { r: T.lights, w: T.lightsW, n: 10, a0: angleOf(red - 2000, 0, max), a1: angleOf(red, 0, max), gap: 0.8,
            green: 4, yellow: 7, cGreen: [40, 220, 90], cYellow: [255, 200, 30], cRed: [255, 40, 40], cDim: [60, 16, 16] };
    }
    spec.max = max; spec.redline = red;
    return spec;
}

module.exports = {
    CSPEED, techFace, dialFx,
    STYLES, style, CENTER, centerInfo,
    Canvas, D, C, R_FACE, R_TICK, A0, A1, SUB, LCD, ILLUM, NEEDLE, T,
    angleOf, subAngleOf, pol, speedoFace, tachFace, lcd,
};
