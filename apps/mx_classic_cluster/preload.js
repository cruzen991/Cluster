'use strict';
/**
 * preload.js - the Arc style "pre-loaded" (needles setting "preload", the default from 0.13.0).
 *
 * Every picture is sent to cluster-render once, at the start; while driving the app sends no
 * pixels for the dial or the readouts at all, only small messages the renderer acts on by itself:
 *
 *   the needle      a still sprite the renderer turns (an animation, from one rpm to the next)
 *   the lit arc     PIECES lit pieces of the arc, each under a "cover" turned with the needle (the same
 *                   animation's path, clamped to the piece): the cover is the unlit track, so turning it
 *                   uncovers the lit arc up to the needle. The covers' far ends swing past the next
 *                   pieces (drawn above them) and, for the last, past the arc's end, under a MASK (a
 *                   still copy of the face there)
 *   numerals        each a still sprite at its largest size, scaled by the renderer (an animation too)
 *   shift lights    each lit light a still sprite, shown and hidden; the redline flash one more
 *   readouts        boost, torque, oil, coolant, speed, gear: effect layers that draw their figures from
 *                   a glyph atlas (an asset, uploaded once); a new value is a uniform (the glyphs'
 *                   numbers and places), never pixels
 *
 * That is the advice of the author of waze-on-cluster: stream pixels only for video; pre-load
 * everything else and let the cluster's GPU draw it at its own frame rate.
 *
 * Needs cluster-render 0.4.2 or later (64 layers a client, assets). On an older one the cluster
 * falls back to the rotating mode by itself (cluster.js).
 */
const F = require('./faces');
const A = require('./arc');
const { Canvas } = F;
const RAD = Math.PI / 180;
const { DW, DH, DCX, DCY } = A;

const cl = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const SNAP = 25;                         // sub-layer rectangles start and end on multiples of 25 dial pixels:
                                         // 25 x 1.04 (the notch scale) is a whole 26, so they sit exactly on the dial
const snapDown = (v) => Math.floor(v / SNAP) * SNAP, snapUp = (v) => Math.ceil(v / SNAP) * SNAP;

/** A rectangle (dial pixels) round the points, padded, snapped, inside the dial. */
function boxOf(pts, pad) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.max(0, snapDown(Math.min(...xs) - pad)), y0 = Math.max(0, snapDown(Math.min(...ys) - pad));
    const x1 = Math.min(DW, snapUp(Math.max(...xs) + pad)), y1 = Math.min(DH, snapUp(Math.max(...ys) + pad));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
/** Points along a sector (for its box). */
function sectorPts(r0, r1, a0, a1) {
    const pts = [];
    for (let a = a0; a <= a1 + 1e-9; a += Math.max(0.5, (a1 - a0) / 64)) for (const r of [r0, r1]) pts.push(F.pol(DCX, DCY, r, a));
    pts.push(F.pol(DCX, DCY, r0, a1), F.pol(DCX, DCY, r1, a1));
    return pts;
}

/* ---------- the lit arc: pieces and covers ---------- */

const REACH = 9.5;       // degrees past A1 a cover may ever reach: the face's backdrop goes 10 past it (the mask covers it)
const EPS = 0.35;        // a cover reaches this far (about a pixel) past both ends of its piece, so the soft
                         // edge the renderer's turning gives it never lets the lit arc peek out
const OVER = 1;
const CAP = 60;          // no piece longer than this: a long piece's rectangle is mostly empty, and cluster-render
                         // counts every picture's pixels twice against its 16 MB          // a cover turns this far past its piece's end, so its edge rests inside the next
                         // piece (under that piece's lit arc), not on the seam
const TAIL = REACH;
/**
 * The arc A0..A1 cut so that every cover, turned all the way (its piece, plus OVER, plus its EPS),
 * ends no further than REACH past A1: a piece is at most REACH - EPS - OVER plus all the pieces
 * after it. Returns [{ s, e }] in degrees.
 */
function ringPieces() {
    const sizes = [];
    let rest = F.A1 - F.A0, after = 0;
    while (rest > 1e-9) { const p = Math.min(rest, after + REACH - EPS - OVER, CAP); sizes.unshift(p); rest -= p; after += p; }
    const out = [];
    let a = F.A0;
    sizes.forEach((p) => { out.push({ s: a, e: a + p }); a += p; });
    return out;
}
const PIECES = ringPieces();
const RING_IN = A.R_PROG - A.W_PROG / 2 - 1.5, RING_OUT = A.R_PROG + A.W_PROG / 2 + 1.5;   // the covers' reach (one pixel past the lit arc's)

/** Lit piece k: the lit arc between its ends, cut hard (pieces meet without a seam). */
function litPiece(k) {
    const P = PIECES[k], q = boxOf(sectorPts(RING_IN, RING_OUT, P.s - 1, P.e + 1), 3);
    const cv = new Canvas(q.w, q.h).clear([0, 0, 0, 0]), c = A.NEEDLE_RED.concat([255]);
    for (let y = 0; y < q.h; y++) for (let x = 0; x < q.w; x++) {
        const px = x + q.x + 0.5 - DCX, py = y + q.y + 0.5 - DCY, rr = Math.sqrt(px * px + py * py);
        const band = cl(A.W_PROG / 2 + 0.5 - Math.abs(rr - A.R_PROG));
        if (band <= 0) continue;
        const th = Math.atan2(px, -py) / RAD;
        // hard where pieces meet; soft at the arc's start, as the old drawing (cover 0 reaches EPS before it)
        const a = th < P.e ? band * (k === 0 ? cl((th - F.A0) * RAD * A.R_PROG + 0.5) : th >= P.s ? 1 : 0) : 0;
        if (a > 0) cv._blend(x, y, c, a);
    }
    return { cv, q };
}

/**
 * The face as it is under the lit arc, the same at every angle: the backdrop and the track drawn
 * all the way round, as arcFace draws them.
 */
function trackFace() {
    const cv = new Canvas(DW, DH).clear([0, 0, 0, 0]);
    cv.arc(DCX, DCY, 0, A.R + 18, 0, 360, '#0c0e11');
    cv.arc(DCX, DCY, A.R_PROG - A.W_PROG / 2, A.R_PROG + A.W_PROG / 2, 0, 360, '#1c1e22');
    return cv;
}
/** Cover k: the unlit track over piece k (and EPS past both its ends), opaque, hard-edged. */
function coverPiece(k, track) {
    const P = PIECES[k], q = boxOf(sectorPts(RING_IN, RING_OUT, P.s - 1, P.e + 1), 3);
    const cv = new Canvas(q.w, q.h).clear([0, 0, 0, 0]);
    for (let y = 0; y < q.h; y++) for (let x = 0; x < q.w; x++) {
        const px = x + q.x + 0.5 - DCX, py = y + q.y + 0.5 - DCY, rr = Math.sqrt(px * px + py * py);
        if (rr < RING_IN || rr > RING_OUT) continue;
        const th = Math.atan2(px, -py) / RAD;
        if (th < P.s - EPS || th >= P.e + EPS) continue;
        const i = (y * q.w + x) * 4, j = ((y + q.y) * DW + x + q.x) * 4;
        cv.d[i] = track.d[j]; cv.d[i + 1] = track.d[j + 1]; cv.d[i + 2] = track.d[j + 2]; cv.d[i + 3] = 255;
    }
    return { cv, q };
}
/** The mask: the face itself just past the arc's end, over where the covers' far ends can reach. */
function ringMask(face) {
    const a0 = F.A1, a1 = F.A1 + REACH + 0.3, q = boxOf(sectorPts(RING_IN - 1, RING_OUT + 1, a0, a1), 2);
    const cv = new Canvas(q.w, q.h).clear([0, 0, 0, 0]);
    for (let y = 0; y < q.h; y++) for (let x = 0; x < q.w; x++) {
        const px = x + q.x + 0.5 - DCX, py = y + q.y + 0.5 - DCY, rr = Math.sqrt(px * px + py * py);
        if (rr < RING_IN - 1 || rr > RING_OUT + 1) continue;
        const th = Math.atan2(px, -py) / RAD;
        if (th < a0 || th > a1) continue;
        const i = (y * q.w + x) * 4, j = ((y + q.y) * DW + x + q.x) * 4;
        cv.d[i] = face.d[j]; cv.d[i + 1] = face.d[j + 1]; cv.d[i + 2] = face.d[j + 2]; cv.d[i + 3] = face.d[j + 3];
    }
    return { cv, q };
}

/** Cover k's turn (degrees clockwise) with the needle at angle th: its leading edge (EPS before the
 * piece) follows the needle, up to OVER past the piece's end. */
function coverTurn(k, th) { const P = PIECES[k]; return Math.max(P.s, Math.min(P.e + OVER, th)) - P.s; }

/**
 * The keys of cover k's animation as the needle goes from angle `from` to `to` in `ms`: its turn at
 * the start, where the needle crosses the piece's ends, and at the end (piecewise straight, so the
 * cover's edge stays under the needle). Returns [[t, turn], ...] (at least 2).
 */
function coverKeys(k, from, to, ms) {
    const P = PIECES[k], keys = [[0, coverTurn(k, from)]];
    const at = (a) => (to === from ? 0 : (a - from) / (to - from));
    [P.s, P.e + OVER].map((a) => at(a)).filter((t) => t > 0 && t < 1).sort((x, y) => x - y)
        .forEach((t) => keys.push([Math.round(t * ms), coverTurn(k, from + (to - from) * t)]));
    keys.push([ms, coverTurn(k, to)]);
    return keys.filter((kk, i) => i === 0 || kk[0] > keys[i - 1][0] || i === keys.length - 1);
}

/* ---------- shift lights ---------- */

/** Light i lit (or every light red: i = 'flash'), as compose() in fx.js draws them. */
function lightSprite(spec, i) {
    const L = spec.lights, step = (L.a1 - L.a0) / L.n;
    const a0 = i === 'flash' ? L.a0 : L.a0 + i * step, a1 = i === 'flash' ? L.a1 : L.a0 + (i + 1) * step;
    const q = boxOf(sectorPts(L.r - L.w / 2 - 1, L.r + L.w / 2 + 1, a0, a1), 2);
    const cv = new Canvas(q.w, q.h).clear([0, 0, 0, 0]);
    for (let y = 0; y < q.h; y++) for (let x = 0; x < q.w; x++) {
        const px = x + q.x + 0.5 - DCX, py = y + q.y + 0.5 - DCY, rr = Math.sqrt(px * px + py * py);
        const th = Math.atan2(px, -py) / RAD;
        if (!(th > a0 && th < a1) || Math.abs(rr - L.r) > L.w / 2 + 1) continue;
        const u = (th - L.a0) / step, k = Math.floor(u);
        if (i !== 'flash' && k !== i) continue;
        const e = Math.min(u - k, k + 1 - u) * step * RAD * L.r - L.gap * RAD * L.r;
        const a = cl(L.w / 2 + 0.5 - Math.abs(rr - L.r)) * cl(e + 0.5);
        const c = i === 'flash' ? L.cRed : k < L.green ? L.cGreen : k < L.yellow ? L.cYellow : L.cRed;
        if (a > 0) cv._blend(x, y, c.concat([255]), a);
    }
    return { cv, q };
}

/* ---------- numerals ---------- */

/** A numeral's scale (of its largest sprite) with the needle at `rpm`: as numeralLevels, but smooth. */
function numeralScale(rpm, n) {
    const v = (rpm > 0 ? rpm : 0) / 1000;
    let t = 1 - Math.abs(v - n) / A.NUM_REACH;
    t = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
    return (1 + A.NUM_GROW * t) / (1 + A.NUM_GROW);
}

/* ---------- readouts: glyph atlases and the shader that draws from them ---------- */

const FIGS = '0123456789-';
const GEAR_GLYPHS = 'PRND0123456789-';
const SLOTS = 4;

/**
 * The strips of each readout panel that ever hold anything (panel pixels): the panel is drawn whole
 * here, but sent as these strips only (the GPU draws the figures between them). Every cell the
 * panels draw lies inside one (test.js).
 */
const PANEL_BANDS = {
    left: [{ x: 0, y: 0, w: 540, h: 60 }, { x: 0, y: 128, w: 540, h: 40 }, { x: 0, y: 196, w: 540, h: 40 }, { x: 0, y: 308, w: 540, h: 40 }, { x: 0, y: 396, w: 540, h: 96 }],
    centre: [{ x: 0, y: 160, w: 300, h: 40 }],
};
PANEL_BANDS.right = PANEL_BANDS.left;

/**
 * A glyph atlas: cells side by side, the glyphs' coverage. Drawn white in a canvas (cv), sent as one
 * byte a pixel (r8: r8, the coverage), which shaders read in .r - as cluster-render's own video
 * atlases are read on the car - and which it counts at a quarter of RGBA. kind 'tabular': figures of `size` in fixed slots dw wide, as tabular()
 * draws them, baseline `base` in a cell `h` tall; kind 'gear': the gear's letters and figures as
 * bigText() draws them (118 px), each from its cell's left edge, with its advance.
 * Returns { cv, cw, h, glyphs, adv: {ch: px} }.
 */
function atlas(kind, size, h, base) {
    const glyphs = kind === 'gear' ? GEAR_GLYPHS : FIGS;
    const probe = new Canvas(8, 8);
    let cw, adv = {};
    if (kind === 'gear') {
        const tmp = new Canvas(400, h);
        [...glyphs].forEach((ch) => { adv[ch] = A.bigText(tmp, ch, -1000, base, size, '#ffffff'); });
        cw = Math.ceil(Math.max(...Object.values(adv))) + 4;
    } else cw = A.figW(probe, size);
    // the width a multiple of 8: a GPU reads an r8 texture's rows on 4-byte (or 8) boundaries unless told
    // otherwise, so any other width shears every row (0.13.0-0.13.3: the figures garbled on the car)
    const cv = new Canvas(Math.ceil(cw * glyphs.length / 8) * 8, h).clear([0, 0, 0, 0]);
    [...glyphs].forEach((ch, i) => {
        if (kind === 'gear') A.bigText(cv, ch, i * cw + adv[ch] / 2, base, size, '#ffffff');
        else { cv.text(ch, i * cw + cw / 2, base, size, '#ffffff', { font: 'orb', align: 'center', literal: true }); adv[ch] = cw; }
    });
    const r8 = Buffer.alloc(cv.w * cv.h);
    for (let i = 0; i < r8.length; i++) r8[i] = cv.d[i * 4 + 3];
    return { cv, r8, cw, h, glyphs, adv, kind };
}

/**
 * The readout shader for a layer w x h (image pixels) drawing from an atlas (cells cw wide):
 * uniforms u_x (each slot's left edge, layer pixels; far left when unused), u_g (each slot's glyph,
 * -1: none), u_col (colour and alpha, 0..1); sampler u_font. The first line names it for the desk
 * stand-in renderer.
 */
function readoutShader(w, h, at) {
    const f = (v) => { const s = String(Math.round(v * 10000) / 10000); return /[.e]/.test(s) ? s : s + '.0'; };
    const spec = { w, h, cw: at.cw, aw: at.cv.w, ah: at.h };
    return [
        '#version 100',
        '// cc-readout ' + JSON.stringify(spec),
        '#ifdef GL_FRAGMENT_PRECISION_HIGH',
        'precision highp float;',
        '#else',
        'precision mediump float;',
        '#endif',
        'uniform sampler2D u_font;',
        'uniform vec4 u_x;',
        'uniform vec4 u_g;',
        'uniform vec4 u_col;',
        'varying vec2 v_uv;',
        'float glyph(float x0, float g, vec2 p) {',
        '  float lx = p.x - x0;',
        '  if (g < 0.0 || lx < 0.0 || lx >= ' + f(at.cw) + ') return 0.0;',
        '  return texture2D(u_font, vec2((g * ' + f(at.cw) + ' + lx) / ' + f(at.cv.w) + ', p.y / ' + f(at.h) + ')).r;',
        '}',
        'void main() {',
        '  vec2 p = v_uv * vec2(' + f(w) + ', ' + f(h) + ');',
        '  float a = max(max(glyph(u_x.x, u_g.x, p), glyph(u_x.y, u_g.y, p)), max(glyph(u_x.z, u_g.z, p), glyph(u_x.w, u_g.w, p)));',
        '  gl_FragColor = vec4(u_col.rgb, u_col.a * a);',
        '}',
    ].join('\n');
}

/** The shader's twin (tests, the desk stand-in): RGBA 0..255 at image pixel (x, y) (centres at +0.5);
 * atlasPx: the r8 atlas (one byte a pixel). */
function readoutShade(spec, atlasPx, u, x, y) {
    const p = [x, y];
    let a = 0;
    for (let s = 0; s < SLOTS; s++) {
        const g = u.g[s], lx = p[0] - u.x[s];
        if (g < 0 || lx < 0 || lx >= spec.cw) continue;
        // bilinear, as the asset is sampled
        const tx = g * spec.cw + lx - 0.5, ty = p[1] * spec.ah / spec.h - 0.5;
        const x0 = Math.floor(tx), y0 = Math.floor(ty), fx = tx - x0, fy = ty - y0;
        const at = (xx, yy) => { xx = Math.max(0, Math.min(spec.aw - 1, xx)); yy = Math.max(0, Math.min(spec.ah - 1, yy)); return atlasPx[yy * spec.aw + xx]; };
        const v = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
        a = Math.max(a, v / 255);
    }
    return [u.col[0] * 255, u.col[1] * 255, u.col[2] * 255, u.col[3] * a * 255];
}

/**
 * A readout's uniforms for a text: { x: [4], g: [4] } - slot k's left edge and glyph. tabular:
 * centred on `cx` (cell pixels) with the unit's width beside it as tabular() lays it out; gear:
 * centred on cx by the glyphs' advances. Characters not in the atlas draw nothing; more than 4
 * are cut.
 */
function readoutUniforms(at, str, cx, unitW) {
    const chars = [...String(str == null ? '' : str)].slice(0, SLOTS);
    const widths = chars.map((c) => (at.adv[c] != null ? at.adv[c] : at.cw));
    const total = widths.reduce((t, w) => t + w, 0) + (unitW ? 12 + unitW : 0);
    let xx = Math.round(cx - total / 2);
    const x = [-10000, -10000, -10000, -10000], g = [-1, -1, -1, -1];
    chars.forEach((c, i) => { const k = at.glyphs.indexOf(c); x[i] = xx; g[i] = k; xx += Math.round(widths[i]); });
    return { x, g };
}

/**
 * All the pre-loaded dial art for a redline (cached by cluster.js): { pieces: [{lit, cover}], mask,
 * lights: [..], flash, nums: [{cv, box}] }. face: the face without numerals (arc.js arcFace).
 */
function dialArt(face, nums, spec) {
    const track = trackFace();
    const pieces = PIECES.map((P, k) => ({ P, lit: litPiece(k), cover: coverPiece(k, track) }));
    const mask = ringMask(face);
    const lights = spec.lights ? Array.from({ length: spec.lights.n }, (_, i) => lightSprite(spec, i)) : [];
    const flash = spec.lights ? lightSprite(spec, 'flash') : null;
    const numerals = nums.map((n) => ({ cv: n.sprites[n.sprites.length - 1], box: n.box, n: n.n }));
    return { pieces, mask, lights, flash, numerals };
}

module.exports = {
    PIECES, TAIL, REACH, EPS, OVER, SNAP, ringPieces, litPiece, coverPiece, trackFace, ringMask, coverTurn, coverKeys, lightSprite,
    numeralScale, atlas, readoutShader, readoutShade, readoutUniforms, dialArt, FIGS, GEAR_GLYPHS, SLOTS, PANEL_BANDS, CAP,
};
