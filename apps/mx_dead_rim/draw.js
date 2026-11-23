'use strict';
/**
 * draw.js - Dead Rim's picture: the pit in the middle, seen from above its rim, its far end small
 * and a little up the screen; the score left, lives, grenades and the dead still to come right.
 * Only the methods canvas.js and record.js share (fillRect, roundRect, arc, line, polyline, quad,
 * text), so the same code feeds the GPU renderer or a PNG. On a canvas.js Canvas (the PNG path)
 * the pit's lines are drawn once a shape into a cached layer and copied each frame.
 * All original artwork.
 */
const G = require('./game');

const W = 1600, H = 520;
const CX = 800, CY = 258, RX = 405, RY = 226;     // the rim
const ICX = 800, ICY = 206, IS = 0.13;            // the far end: centre and size
const persp = (d) => 0.42 * d + 0.58 * d * d;     // depth -> 0..1 of the way from the far end to the rim

const C = {
    bg: '#050706', lane: '#173d22', ring: '#0f2617', rim: '#3fc060', rimGlow: [63, 192, 96, 60], far: '#24603a',
    you: '#ffb020', youDim: [255, 176, 32, 40], youFill: [255, 176, 32, 20], danger: '#ff3a2a',
    text: '#eef2ee', dim: '#86918a', title: '#e8402e', bullet: '#ffe27a', bulletGlow: [255, 200, 80, 90],
    blood: '#8c1610', blood2: '#c42a1e', goo: '#78d848', gooDark: '#1f4a10', eye: '#ff3a1e', mouth: '#1a0a08', outline: '#0b0f0a',
};
const LOOK = {
    walker: { skin: '#7e9c5a', shirt: '#46587a' },
    runner: { skin: '#9cae70', shirt: '#8a2c22' },
    crawler: { skin: '#5f7f44', shirt: '#3a4a2a' },
    bloater: { skin: '#a3ac4c', shirt: '#7e8a34', spot: '#dcd66a' },
    spitter: { skin: '#77976a', shirt: '#5a3a7c' },
};

/* ---------- geometry ---------- */
const geoCache = new Map();
function geo(shape) {
    let g = geoCache.get(shape.name);
    if (g) return g;
    const outer = shape.edges.map(([x, y]) => [CX + x * RX, CY + y * RY]);
    const inner = shape.edges.map(([x, y]) => [ICX + x * RX * IS, ICY + y * RY * IS]);
    g = { outer, inner, n: shape.lanes, closed: shape.closed };
    geoCache.set(shape.name, g);
    return g;
}
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
function edgeAt(g, i, t) { return lerp(g.inner[i], g.outer[i], t); }
function laneEdges(g, l) { return [l, g.closed ? (l + 1) % g.outer.length : l + 1]; }
/** A lane at depth d: its middle, scale (1 at the rim), outward unit (towards you), along-rim unit. */
function at(g, l, d) {
    const [i, j] = laneEdges(g, l), t = persp(Math.max(0, Math.min(1.08, d)));
    const a = edgeAt(g, i, t), b = edgeAt(g, j, t);
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const mi = lerp(g.inner[i], g.inner[j], 0.5), mo = lerp(g.outer[i], g.outer[j], 0.5);
    let ox = mo[0] - mi[0], oy = mo[1] - mi[1]; const ol = Math.hypot(ox, oy) || 1; ox /= ol; oy /= ol;
    let px = b[0] - a[0], py = b[1] - a[1]; const pl = Math.hypot(px, py) || 1; px /= pl; py /= pl;
    return { x: m[0], y: m[1], s: IS + (1 - IS) * t, out: [ox, oy], perp: [px, py], a, b, width: pl };
}

/* ---------- the pit ---------- */
function pit(cv, g) {
    cv.fillRect(0, 0, W, H, C.bg);
    // rings part-way down, then the lane edges
    for (const d of [0.3, 0.55, 0.8]) {
        const t = persp(d), pts = g.outer.map((_, i) => edgeAt(g, i, t));
        if (g.closed) pts.push(pts[0]);
        cv.polyline(pts, 1, C.ring);
    }
    for (let i = 0; i < g.outer.length; i++) cv.line(g.inner[i][0], g.inner[i][1], g.outer[i][0], g.outer[i][1], 1.5, C.lane);
    const far = g.inner.slice(), rim = g.outer.slice();
    if (g.closed) { far.push(far[0]); rim.push(rim[0]); }
    cv.polyline(far, 1.5, C.far);
    cv.polyline(rim, 7, C.rimGlow);
    cv.polyline(rim, 2.5, C.rim);
}

const layers = new Map();
function pitLayer(cv, g, key) {
    if (typeof cv.copyRows !== 'function') { pit(cv, g); return; }        // GPU recorder: just draw it
    let L = layers.get(key);
    if (!L) { L = new cv.constructor(W, H); pit(L, g); layers.set(key, L); }
    cv.copyRows(L, 0, 0);
}

function laneHighlight(cv, g, l, fill, edge, rimCol, rimW) {
    const [i, j] = laneEdges(g, l);
    if (fill) cv.quad([g.inner[i], g.inner[j], g.outer[j], g.outer[i]], fill);
    if (edge) { cv.line(g.inner[i][0], g.inner[i][1], g.outer[i][0], g.outer[i][1], 2, edge); cv.line(g.inner[j][0], g.inner[j][1], g.outer[j][0], g.outer[j][1], 2, edge); }
    if (rimCol) cv.line(g.outer[i][0], g.outer[i][1], g.outer[j][0], g.outer[j][1], rimW || 4, rimCol);
}

/* ---------- the dead ---------- */
const P = (o, ax, k, bx, kb) => [o[0] + ax[0] * k + (bx ? bx[0] * kb : 0), o[1] + ax[1] * k + (bx ? bx[1] * kb : 0)];
function limb(cv, a, b, w, col) {
    cv.line(a[0], a[1], b[0], b[1], w + 3, C.outline);
    cv.line(a[0], a[1], b[0], b[1], w, col);
}
function disc(cv, p, r, col, outline) {
    if (outline) cv.arc(p[0], p[1], 0, r + 1.8, 0, 360, C.outline);
    cv.arc(p[0], p[1], 0, r, 0, 360, col);
}

/**
 * One of the dead at A (from at()), seen from above as it climbs towards you: arms reaching up the
 * lane, a head, red eyes. f: { flash (just hit), grab (about to grab you), spit (about to spit), t }
 */
function zombie(cv, A, kind, f) {
    const u = Math.max(4, Math.min(46 * A.s, A.width * 0.42));    // fits its lane
    const o = A.out, q = A.perp, c = [A.x, A.y];
    const L = LOOK[kind] || LOOK.walker;
    const skin = f.flash ? '#ffffff' : L.skin, shirt = f.flash ? '#e0e0e0' : L.shirt;
    const sway = Math.sin(f.t / 180 + A.x * 0.05) * 0.12;           // a shamble
    const reach = f.grab ? 1.35 : 0.95;
    if (kind === 'crawler') {
        const h = P(c, o, 0.1 * u);
        for (const sd of [-1, 1]) for (const fb of [0.55, -0.45]) {
            const knee = P(h, q, sd * 0.7 * u, o, fb * u * 0.6), foot = P(h, q, sd * 1.0 * u, o, (fb + (fb > 0 ? 0.35 : -0.2) + sway * sd) * u);
            limb(cv, h, knee, 0.16 * u, skin); limb(cv, knee, foot, 0.14 * u, skin);
        }
        disc(cv, P(c, o, -0.35 * u), 0.38 * u, shirt, true);
        disc(cv, h, 0.36 * u, skin, true);
        for (const sd of [-1, 1]) disc(cv, P(h, o, 0.12 * u, q, sd * 0.14 * u), Math.max(1.2, 0.08 * u), C.eye);
        return;
    }
    if (kind === 'bloater') {
        const b = P(c, o, -0.15 * u);
        disc(cv, b, 0.95 * u, shirt, true);
        disc(cv, P(b, q, 0.35 * u, o, 0.1 * u), 0.2 * u, L.spot); disc(cv, P(b, q, -0.4 * u, o, -0.25 * u), 0.26 * u, L.spot); disc(cv, P(b, q, 0.05 * u, o, -0.5 * u), 0.15 * u, L.spot);
        for (const sd of [-1, 1]) limb(cv, P(b, q, sd * 0.75 * u, o, 0.2 * u), P(b, q, sd * (0.85 + sway) * u, o, (0.95 + (f.grab ? 0.4 : 0)) * u), 0.24 * u, skin);
        const h = P(b, o, 0.75 * u);
        disc(cv, h, 0.32 * u, skin, true);
        for (const sd of [-1, 1]) disc(cv, P(h, o, 0.06 * u, q, sd * 0.12 * u), Math.max(1.2, 0.07 * u), C.eye);
        return;
    }
    // walker, runner, spitter: shoulders, arms, head
    const body = P(c, o, -0.3 * u);
    const wide = kind === 'runner' ? 0.42 : 0.5;
    for (const sd of [-1, 1]) {
        const sh = P(body, q, sd * wide * u, o, 0.1 * u);
        const hand = kind === 'runner'
            ? P(body, q, sd * (0.75 + sway * sd) * u, o, (-0.35 + (f.grab ? 1.4 : 0)) * u)   // arms pumping, until it grabs
            : P(body, q, sd * (0.32 + sway * sd) * u, o, reach * u + 0.2 * u);
        limb(cv, sh, hand, 0.2 * u, skin);
        disc(cv, hand, 0.13 * u, skin);
    }
    disc(cv, body, wide * u, shirt, true);
    const h = P(body, o, 0.32 * u);
    disc(cv, h, 0.38 * u, skin, true);
    for (const sd of [-1, 1]) {
        const e = P(h, o, 0.1 * u, q, sd * 0.15 * u);
        if (u > 9) disc(cv, e, 0.14 * u, [255, 60, 30, 70]);
        disc(cv, e, Math.max(1.2, 0.075 * u), C.eye);
    }
    if (kind === 'spitter') disc(cv, P(h, o, 0.24 * u), (f.spit ? 0.16 : 0.09) * u, f.spit ? C.goo : C.mouth);
    else if (u > 8) disc(cv, P(h, o, 0.24 * u), 0.07 * u, C.mouth);
    if (kind === 'runner' && !f.grab) for (const k of [0.6, 0.95]) cv.line(body[0] - o[0] * k * u * 1.3 + q[0] * 0.3 * u, body[1] - o[1] * k * u * 1.3 + q[1] * 0.3 * u, body[0] - o[0] * (k + 0.25) * u * 1.3 + q[0] * 0.3 * u, body[1] - o[1] * (k + 0.25) * u * 1.3 + q[1] * 0.3 * u, 2, [200, 210, 190, 90]);
}

/* ---------- you ---------- */
function survivor(cv, g, l, t, game) {
    const A = at(g, l, 1), o = A.out, m = [A.x, A.y];
    const [i, j] = laneEdges(g, l), tin = persp(0.9), tn = persp(0.955);
    // the claw: it sits across the lane's rim, two prongs down the lane edges, a notch between them
    const ai = edgeAt(g, i, 1), bj = edgeAt(g, j, 1);
    const aOut = P(ai, o, 9), bOut = P(bj, o, 9), aIn = edgeAt(g, i, tin), bIn = edgeAt(g, j, tin);
    const notch = lerp(edgeAt(g, i, tn), edgeAt(g, j, tn), 0.5), back = P(m, o, 16);
    const shape = [aOut, aIn, notch, bIn, bOut, back, aOut];
    if (t - game.fireT < 70) { const f = lerp(aIn, bIn, 0.5); cv.arc(f[0], f[1], 0, 14, 0, 360, [255, 220, 120, 140]); cv.arc(f[0], f[1], 0, 6, 0, 360, '#fff6d0'); }
    cv.polyline(shape, 9, C.outline);
    cv.polyline(shape, 4.5, C.you);
    disc(cv, P(m, o, 6), 5, '#fff0c8');
}

function splat(cv, A, k, kind) {
    const u = Math.min(46 * A.s, A.width * 0.42), goo = kind === 'bloater' || kind === 'spitter';
    const col = goo ? C.goo : C.blood2, col2 = goo ? C.gooDark : C.blood;
    for (let i = 0; i < 7; i++) {
        const ang = i * 0.9 + A.x * 0.01, r = u * (0.3 + 1.1 * k);
        const p = [A.x + Math.cos(ang) * r, A.y + Math.sin(ang) * r * 0.8];
        disc(cv, p, Math.max(1, u * 0.2 * (1 - k)), i % 2 ? col : col2);
    }
    disc(cv, [A.x, A.y], Math.max(1, u * 0.35 * (1 - k)), col2);
}

/* ---------- the panels ---------- */
function icons(cv, x, y, n, draw) { for (let i = 0; i < Math.min(n, 6); i++) draw(x + i * 40, y); }
function lifeIcon(cv, x, y) { cv.polyline([[x - 14, y + 6], [x, y - 8], [x + 14, y + 6]], 5, C.you); }
function nadeIcon(cv, x, y) { disc(cv, [x, y], 10, '#5a6a3a', true); cv.fillRect(x - 3, y - 15, 6, 5, '#9aa0a4'); cv.line(x + 3, y - 13, x + 9, y - 17, 2, '#c8ccd0'); }

function hud(cv, g, t, info) {
    const L = 40, R = 1250;
    cv.text('DEAD RIM', L, 58, 32, C.title, { font: 'bold', literal: true });
    cv.text('SCORE', L, 118, 18, C.dim, { font: 'bold', literal: true });
    cv.text(String(g.score), L, 160, 40, C.text, { font: 'bold', literal: true });
    cv.text('BEST', L, 214, 18, C.dim, { font: 'bold', literal: true });
    cv.text(String(g.best), L, 250, 30, C.text, { font: 'bold', literal: true });
    cv.text('LEVEL', L, 304, 18, C.dim, { font: 'bold', literal: true });
    cv.text(String(g.level) + '  ' + g.shape.name, L, 340, 30, C.text, { font: 'bold', literal: true });
    const playing = g.state !== 'ready' && g.state !== 'over';
    cv.text('LIVES', R, 76, 18, C.dim, { font: 'bold', literal: true });
    icons(cv, R + 16, 104, playing ? g.lives : 0, (x, y) => lifeIcon(cv, x, y));
    cv.text('GRENADES', R, 154, 18, C.dim, { font: 'bold', literal: true });
    icons(cv, R + 12, 186, playing ? g.grenades : 0, (x, y) => nadeIcon(cv, x, y));
    cv.text('THE DEAD', R, 232, 18, C.dim, { font: 'bold', literal: true });
    const bw = 280, left = playing ? g.left() : 0, frac = g.waveSize ? Math.min(1, left / g.waveSize) : 0;
    cv.roundRect(R, 246, bw, 14, 7, '#1a1f1c');
    if (frac > 0) cv.roundRect(R, 246, Math.max(14, bw * frac), 14, 7, C.blood2);
    cv.text(String(left) + ' left', R, 288, 18, C.dim, { font: 'label', literal: true });
    const auto = info.fire !== 'manual';
    const help = !info.live
        ? ['TURN  pick Left / Fire', '   Grenade / Right', 'PRESS  use it']
        : auto ? ['TURN  round the rim', 'FIRE  is automatic', 'PRESS  grenade'] : ['TURN  round the rim', 'PRESS  fire', 'HOLD  grenade'];
    help.forEach((h, i) => cv.text(h, R, 360 + i * 30, 18, C.dim, { font: 'label', literal: true }));
}

function banner(cv, title, lines, col) {
    const w = 640, h = 64 + lines.length * 34, x = (W - w) / 2, y = (H - h) / 2;
    cv.roundRect(x, y, w, h, 16, [6, 8, 7, 228]);
    if (cv.strokeRoundRect) cv.strokeRoundRect(x, y, w, h, 16, 2, col);
    cv.text(title, W / 2, y + 48, 34, col, { font: 'bold', align: 'center', literal: true });
    lines.forEach((l, i) => cv.text(l, W / 2, y + 88 + i * 34, 22, C.text, { font: 'label', align: 'center', literal: true }));
}

/**
 * The whole frame. info: { live (controller data), paused: why the game waits ('' if it runs), fire: 'auto' | 'manual' }
 */
function frame(cv, game, t, info) {
    info = info || {};
    const g = geo(game.shape);
    pitLayer(cv, g, game.shape.name);
    const playing = game.state === 'play' || game.state === 'dead';

    // the lanes with one of the dead on the rim glow red; yours is lit
    if (playing) {
        const pulse = Math.floor(t / 140) % 2;
        for (const z of game.zombies) if (z.rim && z.lane !== game.lane) laneHighlight(cv, g, z.lane, null, null, pulse ? C.danger : '#8a1a12', 4);
        laneHighlight(cv, g, game.lane, C.youFill, C.youDim, null);
    }
    // the dead, the far ones first
    const zs = game.zombies.slice().sort((a, b) => a.d - b.d);
    for (const z of zs) {
        const A = at(g, z.lane, z.d);
        zombie(cv, A, z.kind, { flash: t - z.hitT < 90, grab: z.grabT !== null, spit: z.spitT !== null && z.spitT - t < 400 && z.spitT > t, t });
    }
    for (const s of game.gobs) {
        const A = at(g, s.lane, s.d), r = 4 + 10 * A.s;
        disc(cv, [A.x, A.y], r, C.goo, true); disc(cv, [A.x - r * 0.3, A.y - r * 0.3], r * 0.35, '#c8f8a0');
    }
    for (const b of game.bullets) {
        const A = at(g, b.lane, b.d), B = at(g, b.lane, Math.min(1, b.d + 0.07));
        cv.line(A.x, A.y, B.x, B.y, 4 + 6 * A.s, C.bulletGlow);
        cv.line(A.x, A.y, B.x, B.y, 1.5 + 2.5 * A.s, C.bullet);
    }
    for (const f of game.fx) {
        const k = Math.min(1, (t - f.t) / 500);
        const A = at(g, f.lane, f.d);
        if (f.type === 'kill') splat(cv, A, k, f.kind);
        else cv.arc(A.x, A.y, 4 + 14 * k * A.s, 6 + 14 * k * A.s, 0, 360, [120, 216, 72, Math.round(200 * (1 - k))]);
    }
    // you, or what's left of you
    if (game.state === 'play') survivor(cv, g, game.lane, t, game);
    else if (game.state === 'dead') {
        const A = at(g, game.lane, 1), k = Math.min(1, (t - game.stateT) / 700);
        const col = game.deathWhy === 'spat' ? C.goo : C.blood2;
        for (let i = 0; i < 3; i++) cv.arc(A.x, A.y, 6 + i * 14 + k * 30, 9 + i * 14 + k * 30, 0, 360, col);
        disc(cv, [A.x, A.y], 14 * (1 - k) + 4, C.blood, true);
    }
    // a grenade: the pit lights up
    const bk = (t - game.bombT) / 600;
    if (bk >= 0 && bk < 1) {
        const rim = g.outer.slice(); if (g.closed) rim.push(rim[0]);
        cv.fillRect(0, 0, W, H, [255, 190, 90, Math.round(110 * (1 - bk))]);
        cv.polyline(rim, 6 + 30 * (1 - bk), [255, 235, 180, Math.round(220 * (1 - bk))]);
    }

    hud(cv, game, t, info);
    const start = info.live ? 'Press the controller to start' : 'Press Fire to start';
    if (info.paused) banner(cv, 'PAUSED', [info.paused], C.you);
    else if (game.state === 'ready') banner(cv, 'DEAD RIM', ['Hold the rim. The dead climb the pit.', 'Turn the knob to move round it', start], C.title);
    else if (game.state === 'over') banner(cv, 'GAME OVER', ['Score ' + game.score + (game.score >= game.best && game.score > 0 ? '  -  new best!' : ''), 'Level ' + game.level, start.replace('start', 'play again')], C.title);
    else if (game.state === 'level') {
        const nxt = G.SHAPES[game.level % G.SHAPES.length].name;
        banner(cv, 'LEVEL ' + game.level + ' CLEAR', ['Bonus ' + game.bonus, 'Next pit: ' + nxt], C.rim);
    } else if (game.state === 'dead') {
        cv.text(game.deathWhy === 'spat' ? 'SPAT ON' : 'GRABBED', W / 2, 40, 30, C.danger, { font: 'bold', align: 'center', literal: true });
    }
    return cv;
}

module.exports = { frame, at, geo, W, H, C };
