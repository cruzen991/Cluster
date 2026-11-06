'use strict';
/* node apps/mx_road_hopper/test.js - Road Hopper's rules, controls and drawing, without a car */
const assert = require('assert');
const G = require('./game');
const { Controls, MAX_QUEUE } = require('./controls');
const D = require('./draw');
let Canvas, Recorder;
try { ({ Canvas } = require('./kit/canvas')); ({ Recorder } = require('./kit/record')); } catch (e) { ({ Canvas } = require('../../kit/runtime/canvas')); ({ Recorder } = require('../../kit/runtime/record')); }

const fresh = (t) => { const g = new G.Game({ best: 0 }); g.newGame(t || 0); return g; };
/** Empty a lane (or put one thing in it at x). */
const lane = (g, row, things) => { g.lanes[row].things = (things || []).map(([x, len], i) => ({ x, len, i })); };

/* hops and edges */
{
    const g = fresh();
    assert.strictEqual(g.state, 'play'); assert.strictEqual(g.y, 0); assert.strictEqual(g.x, 7);
    G.ROAD.concat(G.RIVER).forEach((r) => lane(g, r));
    assert(!g.input('down', 1), 'can\'t hop off the bottom');
    assert(g.input('left', 1) && g.x === 6);
    for (let i = 0; i < 10; i++) g.input('left', 2);
    assert.strictEqual(g.x, 0, 'stops at the left edge');
    assert(g.input('up', 3) && g.y === 1 && g.score === 10, '10 points for a new row');
    g.input('down', 4); g.input('up', 5);
    assert.strictEqual(g.score, 10, 'no points for the same row again');
}

/* a car ends the life; the next life comes after DEATH_MS; the last life ends the game */
{
    const g = fresh(0);
    lane(g, 1, [[7, 1]]); g.lanes[1].speed = 0;
    g.input('up', 0); g.step(16, 16);
    assert.strictEqual(g.state, 'dead'); assert.strictEqual(g.lives, G.START_LIVES - 1);
    assert(g.events.some((e) => e.type === 'squash'));
    g.step(16, G.DEATH_MS + 20);
    assert.strictEqual(g.state, 'play'); assert.strictEqual(g.y, 0, 'back at the start');
    g.lives = 1; g.input('up', 2000); g.step(16, 2016); g.step(16, 2016 + G.DEATH_MS + 10);
    assert.strictEqual(g.state, 'over'); assert(g.events.some((e) => e.type === 'over'));
    assert(g.input('press', 9000) && g.state === 'play' && g.lives === G.START_LIVES && g.score === 0, 'a press starts again');
}
/* a car just beside isn't a hit */
{
    const g = fresh(0); lane(g, 1, [[8.2, 1]]); g.lanes[1].speed = 0;
    g.input('up', 0); g.step(16, 16); assert.strictEqual(g.state, 'play');
}

/* river: a log carries you; water and the edge end the life */
{
    const g = fresh(0);
    G.ROAD.forEach((r) => lane(g, r));
    g.y = 6; g.x = 7;
    lane(g, 7, [[6, 3]]); g.lanes[7].speed = 2; g.lanes[7].dive = 0;
    g.input('up', 0);
    g.step(100, 100); g.step(100, 200);
    assert.strictEqual(g.state, 'play');
    assert(Math.abs(g.x - 7.4) < 1e-9, 'carried 0.4 cells in 0.2 s (' + g.x + ')');
    g.input('up', 300); g.step(16, 316);                  // row 8 has its logs elsewhere
    lane(g, 8); g.step(16, 332);
    assert.strictEqual(g.state, 'dead'); assert.strictEqual(g.deathWhy, 'splash');
    const h = fresh(0); h.y = 7; h.x = 13.8; lane(h, 7, [[12, 3]]); h.lanes[7].speed = 3; h.lanes[7].dive = 0;
    for (let t = 0; t < 1000 && h.state === 'play'; t += 50) h.step(50, t);
    assert.strictEqual(h.deathWhy, 'edge', 'carried off the side');
}

/* a diving raft: safe on top, a splash when it's under */
{
    const g = fresh(0); g.y = 7; g.x = 3;
    lane(g, 7, [[2, 3]]); g.lanes[7].speed = 0; g.lanes[7].dive = 2;
    const th = g.lanes[7].things[0];
    let up = null, under = null;
    for (let t = 0; t < G.DIVE.period; t += 50) { const s = g.diving(g.lanes[7], th, t); if (s === 0 && up === null) up = t; if (s === 2 && under === null) under = t; }
    assert(up !== null && under !== null, 'it surfaces and dives');
    g.step(16, up); assert.strictEqual(g.state, 'play');
    g.lifeT = under; g.step(16, under); assert.strictEqual(g.state, 'dead');
}

/* homes: an empty one scores and fills; a full one or the bank between ends the life; all five: next level */
{
    const g = fresh(0);
    const top = (col, t) => { g.state = 'play'; g.y = G.TOP - 1; g.x = col; lane(g, 11, [[col - 1, 3]]); return g.input('up', t); };
    top(G.HOMES[0], 1000);
    assert(g.homes[0] && g.state === 'play' && g.y === 0, 'home filled, back to the start');
    assert(g.score >= 50, 'home points + time');
    top(G.HOMES[0], 2000); assert.strictEqual(g.state, 'dead', 'a full home ends the life');
    g.state = 'play'; top(2, 3000); assert.strictEqual(g.state, 'dead', 'the bank between homes ends the life');
    const speed1 = Math.abs(g.lanes[3].speed);
    for (let i = 1; i < 5; i++) top(G.HOMES[i], 4000 + i);
    assert.strictEqual(g.state, 'level'); assert(g.events.some((e) => e.type === 'level'));
    g.step(16, 4010 + G.LEVEL_MS);
    assert.strictEqual(g.level, 2); assert(g.homes.every((h) => !h), 'homes empty again');
    assert(Math.abs(g.lanes[3].speed) > speed1 * 1.1, 'faster on level 2');
}

/* the clock: running out ends the life; a pause (shift) doesn't use it up */
{
    const g = fresh(0); G.ROAD.forEach((r) => lane(g, r));
    g.step(16, G.LIFE_MS - 100); assert.strictEqual(g.state, 'play');
    g.shift(5000); g.step(16, G.LIFE_MS + 100); assert.strictEqual(g.state, 'play', 'paused 5 s: still time');
    g.step(16, G.LIFE_MS + 5000); assert.strictEqual(g.deathWhy, 'timeout');
}

/* an extra life at 10000; the best score follows */
{
    const g = fresh(0); g.addScore(9990, 1); assert.strictEqual(g.lives, 3); g.addScore(20, 2); assert.strictEqual(g.lives, 4);
    assert.strictEqual(g.best, 10010);
}

/* controls */
{
    const c = new Controls({ log: { info() {} } }); c.enable(true);
    const msg = (pos, push, defl) => c.raw({ frontRotaryEncoderOperation: pos, frontRotaryEncoderPushButton: push || 'KEINE_BETAETIGUNG', frontRotaryEncoderDeflection: defl || 'MITTELSTELLUNG' });
    msg(100); assert.deepStrictEqual(c.take(), [], 'the first counter is a reference');
    msg(101); assert.deepStrictEqual(c.take(), ['right']);
    msg(99); assert.deepStrictEqual(c.take(), ['left', 'left']);
    msg(65535); msg(1); assert.deepStrictEqual(c.take(), ['right', 'right'], 'the counter wraps');
    msg(30000); assert.deepStrictEqual(c.take(), [], 'a jump is not a spin');
    msg(30010); assert.strictEqual(c.take().length, MAX_QUEUE, 'a fast spin queues at most ' + MAX_QUEUE);
    // short press: forward on release; long press: back, nothing on release
    msg(30010, 'DREHGEBER_KURZ_GEDRUECKT'); assert.deepStrictEqual(c.take(), []);
    msg(30010); assert.deepStrictEqual(c.take(), ['up']);
    msg(30010, 'DREHGEBER_KURZ_GEDRUECKT'); msg(30010, 'DREHGEBER_LANG_GEDRUECKT'); msg(30010, 'DREHGEBER_LANG_GEDRUECKT'); msg(30010);
    assert.deepStrictEqual(c.take(), ['down'], 'a long press hops back once, never forward');
    // pushes: once each
    msg(30010, 0, 'OST_KURZ_GEDRUECKT'); msg(30010, 0, 'OST_LANG_GEDRUECKT'); msg(30010);
    assert.deepStrictEqual(c.take(), ['right']);
    // reversed knob
    const r = new Controls({ log: { info() {} }, reversed: () => true }); r.enable(true);
    r.raw({ frontRotaryEncoderOperation: 5, frontRotaryEncoderPushButton: 0, frontRotaryEncoderDeflection: 0 });
    r.raw({ frontRotaryEncoderOperation: 6, frontRotaryEncoderPushButton: 0, frontRotaryEncoderDeflection: 0 });
    assert.deepStrictEqual(r.take(), ['left']);
    // no controller behind it: ignored; the hidden buttons then work
    const b = new Controls({ log: { info() {} } }); b.enable(true);
    b.raw({ frontRotaryEncoderOperation: 65535, frontRotaryEncoderPushButton: 'SIGNAL_UNGUELTIG', frontRotaryEncoderDeflection: 'SIGNAL_UNGUELTIG' });
    assert(!b.live);
    b.barClick('BTN_LEFT'); b.barClick('BTN_HOP'); assert.deepStrictEqual(b.take(), ['left', 'up']);
    c.barClick('BTN_HOP'); assert.deepStrictEqual(c.take(), [], 'with the controller live a click is the same press again: ignored');
    c.enable(false); msg(30011); assert.deepStrictEqual(c.take(), [], 'nothing while the game is away');
}

/* drawing: every state, on a canvas.js Canvas (PNG path) and on a Recorder (GPU path) */
{
    const g = new G.Game({ best: 120 });
    const states = [['ready'], ['play'], ['dead', 'squash'], ['dead', 'splash'], ['level'], ['over']];
    for (const [st, why] of states) {
        g.state = st; g.deathWhy = why; g.stateT = 0; g.hopT = 50; g.from = { x: 6, y: 0 }; g.x = 7; g.y = 1;
        for (const make of [() => new Canvas(D.W, D.H), () => new Recorder(D.W, D.H)]) {
            const cv = make();
            D.frame(cv, g, 100, { live: st !== 'ready', paused: st === 'level' ? 'Parked only' : '' });
        }
    }
    // the field fits the screen
    assert(D.FX >= 0 && D.FX + D.FW <= D.W && D.FY >= 0 && D.FY + D.FH <= D.H);
}

/* the manifest */
{
    const spec = require('./app.json');
    assert.strictEqual(spec.settings.find((s) => s.key === 'parkedOnly').default, true, 'parked only by default');
    assert(spec.signals['de.bmw.infotainment.vehicle.Vehicle2'].statusCarSpeed2, 'needs the speed for parked only');
    assert.deepStrictEqual(spec.screens.find((s) => s.name === 'GAME').buttons.map((b) => b[0]), ['BTN_LEFT', 'BTN_HOP', 'BTN_BACK', 'BTN_RIGHT']);
}

console.log('road hopper self-check ok');
