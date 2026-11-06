'use strict';
/**
 * draw.js - Road Hopper's picture: the playfield in the middle (15 x 13 cells of 64 x 40 px),
 * the score and lives either side. Draws with the methods canvas.js and record.js share (fillRect,
 * roundRect, arc, line, text), so the same code feeds the GPU renderer or a PNG.
 * All original artwork.
 */
const G = require('./game');

const W = 1600, H = 520;
const CW = 64, CH = 40;                              // a cell
const FW = G.COLS * CW, FH = G.ROWS * CH;            // the field: 960 x 520
const FX = Math.round((W - FW) / 2), FY = H - FH;    // its top-left

const C = {
    bg: '#07090c', verge: '#1d3a1f', vergeHi: '#2a5a2c', road: '#26282d', dash: '#5a5d63', water: '#0d2e57', waterHi: '#164476',
    bank: '#173a19', hedge: '#0f2a11', home: '#0a1a0b', homeLit: '#2a6a2e',
    log: '#7a4a24', logHi: '#9a6334', logEnd: '#c08a52', raft: '#2f8a5a', raftHi: '#48b07a', raftWarn: '#1f5c3c',
    hopper: '#5ad04a', hopperHi: '#9cf07a', eye: '#ffffff', pupil: '#101010',
    text: '#f2f4f6', dim: '#8a9099', accent: '#ffb020', red: '#ff4a3a',
    cars: ['#e8463a', '#f2c230', '#3aa0f0', '#e8e8ea', '#c05ad8'],
};

/** Screen x, y (top-left) of cell column x (float) and row y. */
const sx = (x) => FX + x * CW;
const sy = (row) => FY + (G.ROWS - 1 - row) * CH;

/** A rectangle clipped to the field's columns. */
function rect(cv, x, y, w, h, c, r) {
    const x0 = Math.max(FX, x), x1 = Math.min(FX + FW, x + w);
    if (x1 <= x0) return;
    if (r && x0 === x && x1 === x + w) cv.roundRect(x0, y, x1 - x0, h, r, c);
    else cv.fillRect(x0, y, x1 - x0, h, c);
}
/** A disc, only when it lies wholly inside the field (a disc can't be clipped by halves here). */
function dot(cv, x, y, r, c) { if (x - r >= FX && x + r <= FX + FW) cv.arc(x, y, 0, r, 0, 360, c); }

function field(cv, g, t) {
    // verges, road, river, bank
    for (let row = 0; row < G.ROWS; row++) {
        const y = sy(row);
        const col = row === 0 || row === 6 ? C.verge : row <= 5 ? C.road : row <= 11 ? C.water : C.bank;
        cv.fillRect(FX, y, FW, CH, col);
        if (row >= 1 && row <= 4) for (let x = 0; x < FW; x += 48) cv.fillRect(FX + x + 8, y + CH - 2, 24, 3, C.dash);
        if (row >= 7 && row <= 11) {
            // ripples drift slowly with the lane
            const off = ((t / 60) * (row % 2 ? 1 : -1)) % 96;
            for (let x = -96; x < FW; x += 96) rect(cv, FX + x + off + 20, y + 14 + (row % 2) * 10, 28, 2, C.waterHi);
        }
    }
    cv.fillRect(FX, sy(0), FW, 3, C.vergeHi);
    cv.fillRect(FX, sy(6), FW, 3, C.vergeHi);
    // homes along the bank
    const y = sy(G.TOP);
    cv.fillRect(FX, y, FW, CH, C.hedge);
    G.HOMES.forEach((col, i) => {
        cv.roundRect(sx(col) + 4, y + 4, CW - 8, CH - 6, 8, g.homes[i] ? C.homeLit : C.home);
        if (g.homes[i]) hopper(cv, sx(col) + CW / 2, y + CH / 2 + 1, 'down', 0.8);
    });
}

function car(cv, x, y, len, look, dirRight) {
    const w = len * CW - 10, c = C.cars[look % C.cars.length];
    rect(cv, x + 5, y + 6, w, CH - 12, c, 7);
    // windscreen towards the way it drives, and wheels
    const wx = dirRight ? x + 5 + w - 22 : x + 9;
    rect(cv, wx, y + 10, 13, CH - 20, '#1a2230', 3);
    rect(cv, x + 12, y + 3, 12, 4, '#0a0a0a'); rect(cv, x + w - 14, y + 3, 12, 4, '#0a0a0a');
    rect(cv, x + 12, y + CH - 7, 12, 4, '#0a0a0a'); rect(cv, x + w - 14, y + CH - 7, 12, 4, '#0a0a0a');
    // headlights
    const hx = dirRight ? x + 5 + w - 4 : x + 5;
    rect(cv, hx, y + 9, 4, 5, '#fff4c0'); rect(cv, hx, y + CH - 14, 4, 5, '#fff4c0');
}

function truck(cv, x, y, len, dirRight) {
    const w = len * CW - 8;
    const cab = dirRight ? x + 4 + w - 30 : x + 4;
    rect(cv, x + 4, y + 5, w, CH - 10, '#d8d9dc', 4);
    rect(cv, cab, y + 5, 30, CH - 10, '#3a6ed8', 5);
    rect(cv, dirRight ? cab + 20 : cab + 4, y + 10, 6, CH - 20, '#1a2230');
}

function log(cv, x, y, len) {
    const w = len * CW - 6;
    rect(cv, x + 3, y + 6, w, CH - 12, C.log, 12);
    rect(cv, x + 10, y + 12, w - 20, 3, C.logHi);
    rect(cv, x + 16, y + 24, w - 34, 2, C.logHi);
    dot(cv, x + 3 + w - 8, y + CH / 2, 7, C.logEnd);
}

function raft(cv, x, y, len, state, t) {
    // a raft of round floats; state 1: about to sink (flicker), 2: under (only ripples)
    for (let k = 0; k < len; k++) {
        const cx = x + k * CW + CW / 2, cy = y + CH / 2;
        if (state === 2) { dot(cv, cx, cy, 6, C.waterHi); continue; }
        const warn = state === 1 && Math.floor(t / 150) % 2;
        dot(cv, cx, cy, 17, warn ? C.raftWarn : C.raft);
        dot(cv, cx, cy, 10, warn ? C.raft : C.raftHi);
    }
}

/** The hopper at screen centre (x, y), facing dir, size k (1 = a cell). */
function hopper(cv, x, y, dir, k) {
    k = k || 1;
    const r = 14 * k;
    // legs, body, eyes towards where it faces
    const lx = 13 * k, ly = 9 * k;
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => cv.arc(x + a * lx, y + b * ly, 0, 5 * k, 0, 360, C.hopper));
    cv.arc(x, y, 0, r, 0, 360, C.hopper);
    cv.arc(x, y, 0, r * 0.55, 0, 360, C.hopperHi);
    const f = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir] || [0, -1];
    const ex = f[0] * 8 * k, ey = f[1] * 8 * k, px = -f[1] * 6 * k, py = f[0] * 6 * k;
    for (const s of [-1, 1]) {
        cv.arc(x + ex + s * px, y + ey + s * py, 0, 4.5 * k, 0, 360, C.eye);
        cv.arc(x + ex * 1.15 + s * px, y + ey * 1.15 + s * py, 0, 2.2 * k, 0, 360, C.pupil);
    }
}

function movers(cv, g, t) {
    Object.keys(g.lanes).forEach((r) => {
        const L = g.lanes[r], y = sy(Number(r)), right = L.speed > 0;
        L.things.forEach((th) => {
            const x = sx(th.x);
            if (x > FX + FW || x + th.len * CW < FX) return;
            if (L.kind === 'car') car(cv, x, y, th.len, L.look, right);
            else if (L.kind === 'truck') truck(cv, x, y, th.len, right);
            else if (L.kind === 'log') log(cv, x, y, th.len);
            else raft(cv, x, y, th.len, g.diving(L, th, t), t);
        });
    });
}

function player(cv, g, t) {
    if (g.state === 'ready' || g.state === 'over') return;
    let x = g.x, row = g.y, lift = 0;
    const a = (t - g.hopT) / G.HOP_MS;
    if (g.from && a < 1) {
        x = g.from.x + (g.x - g.from.x) * a; row = g.from.y + (g.y - g.from.y) * a;
        lift = Math.sin(a * Math.PI) * 0.18;
    }
    const cx = sx(x) + CW / 2, cy = FY + (G.ROWS - 1 - row) * CH + CH / 2;
    if (g.state === 'dead') {
        const k = Math.min(1, (t - g.stateT) / 500);
        if (g.deathWhy === 'squash') {
            cv.arc(cx, cy, 0, 16 + 6 * k, 0, 360, '#7a1a12');
            cv.arc(cx, cy, 0, 9, 0, 360, C.hopper);
        } else {
            for (let i = 0; i < 3; i++) cv.arc(cx, cy, 6 + i * 9 + k * 10, 8 + i * 9 + k * 10, 0, 360, C.waterHi);
        }
        return;
    }
    hopper(cv, cx, cy, g.dir, 1 + lift);
}

function lifeIcons(cv, x, y, n) {
    for (let i = 0; i < Math.min(n, 6); i++) hopper(cv, x + i * 44, y, 'up', 0.8);
}

function hud(cv, g, t, info) {
    const L = 40, R = FX + FW + 40;
    cv.text('ROAD HOPPER', L, 58, 30, C.accent, { font: 'bold', literal: true });
    cv.text('SCORE', L, 118, 18, C.dim, { font: 'bold', literal: true });
    cv.text(String(g.score), L, 160, 40, C.text, { font: 'bold', literal: true });
    cv.text('BEST', L, 214, 18, C.dim, { font: 'bold', literal: true });
    cv.text(String(g.best), L, 250, 30, C.text, { font: 'bold', literal: true });
    cv.text('LEVEL', L, 304, 18, C.dim, { font: 'bold', literal: true });
    cv.text(String(g.level), L, 340, 30, C.text, { font: 'bold', literal: true });
    cv.text('LIVES', R, 118, 18, C.dim, { font: 'bold', literal: true });
    lifeIcons(cv, R + 14, 148, g.state === 'ready' || g.state === 'over' ? 0 : g.lives);
    cv.text('TIME', R, 214, 18, C.dim, { font: 'bold', literal: true });
    const tl = g.timeLeft(t), bw = 220;
    cv.roundRect(R, 230, bw, 14, 7, '#1c1f24');
    if (tl > 0) cv.roundRect(R, 230, Math.max(14, bw * tl), 14, 7, tl < 0.25 ? C.red : '#5ad04a');
    // how to play, small
    const help = info.live ? ['TURN  left / right', 'PRESS  hop forward', 'HOLD  hop back'] : ['TURN  pick a direction', 'PRESS  hop'];
    help.forEach((h, i) => cv.text(h, R, 330 + i * 30, 18, C.dim, { font: 'label', literal: true }));
}

function banner(cv, title, lines, col) {
    const w = 640, h = 64 + lines.length * 34, x = (W - w) / 2, y = (H - h) / 2;
    cv.roundRect(x, y, w, h, 16, [8, 10, 14, 225]);
    cv.strokeRoundRect && cv.strokeRoundRect(x, y, w, h, 16, 2, col);
    cv.text(title, W / 2, y + 48, 34, col, { font: 'bold', align: 'center', literal: true });
    lines.forEach((l, i) => cv.text(l, W / 2, y + 88 + i * 34, 22, C.text, { font: 'label', align: 'center', literal: true }));
}

/**
 * The whole frame. info: { live (controller data), paused: why the game waits ('' if it runs), flash: event }
 */
function frame(cv, g, t, info) {
    cv.fillRect(0, 0, W, H, C.bg);
    field(cv, g, t);
    movers(cv, g, t);
    player(cv, g, t);
    hud(cv, g, t, info);
    const start = info.live ? 'Press the controller to start' : 'Press Hop to start';
    if (info.paused) banner(cv, 'PAUSED', [info.paused], C.accent);
    else if (g.state === 'ready') banner(cv, 'ROAD HOPPER', ['Cross the road and the river', 'Fill all five homes', start], C.accent);
    else if (g.state === 'over') banner(cv, 'GAME OVER', ['Score ' + g.score + (g.score >= g.best && g.score > 0 ? '  -  new best!' : ''), start.replace('start', 'play again')], C.red);
    else if (g.state === 'level') banner(cv, 'LEVEL ' + g.level + ' CLEAR', ['Faster traffic ahead'], '#5ad04a');
    return cv;
}

module.exports = { frame, W, H, CW, CH, FX, FY, FW, FH, C };
