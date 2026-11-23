'use strict';
/* node apps/mx_dead_rim/test.js - Dead Rim's rules, controls and drawing, without a car */
const assert = require('assert');
const G = require('./game');
const { Controls, action, MAX_QUEUE } = require('./controls');
const D = require('./draw');
let Canvas, Recorder;
try { ({ Canvas } = require('./kit/canvas')); ({ Recorder } = require('./kit/record')); } catch (e) { ({ Canvas } = require('../../kit/runtime/canvas')); ({ Recorder } = require('../../kit/runtime/record')); }

/** A seeded random, so failures repeat. */
function seeded(n) { let s = n >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const fresh = (opts) => { const g = new G.Game(Object.assign({ rnd: seeded(7) }, opts)); g.newGame(0); g.wave = ['walker']; g.nextSpawn = 1e12; return g; };   // one held back: no level clear mid-test
const run = (g, from, to, dt) => { for (let t = from; t < to; t += dt || 16) g.step(dt || 16, t); return to; };

/* the shapes: lane counts, closed shapes wrap, open ones stop */
{
    for (const s of G.SHAPES) {
        assert(s.lanes >= 14 && s.lanes <= 16, s.name + ' lanes ' + s.lanes);
        s.edges.forEach(([x, y]) => assert(Math.abs(x) <= 1.0001 && Math.abs(y) <= 1.0001, s.name + ' in bounds'));
    }
    const g = fresh();
    assert.strictEqual(g.shape.name, 'RING');
    assert.strictEqual(g.next(0, -1), g.lanes - 1, 'a ring wraps');
    assert(g.laneRim(g.lane)[1] > 0.9, 'start at the lane nearest you');
    g.level = 3; assert.strictEqual(g.shape.closed, false);
    assert.strictEqual(g.next(0, -1), null, 'a trench has ends');
    assert.strictEqual(g.toward(2, 10), 1);
    g.level = 1; assert.strictEqual(g.toward(1, 15), -1, 'the short way round');
}

/* moving round the rim */
{
    const g = fresh({ fire: 'manual' });
    const l0 = g.lane;
    assert(g.input('right', 1) && g.lane === (l0 + 1) % 16);
    assert(g.input('left', 2) && g.input('left', 3) && g.lane === (l0 + 15) % 16);
    g.setLevel(3, 10); g.lane = 0; g.state = 'play';
    assert(!g.input('left', 11) && g.lane === 0, 'stops at a trench end');
}

/* shooting: a bullet runs down the lane and kills a walker; the score; an empty lane misses */
{
    const g = fresh({ fire: 'manual' });
    const z = g.spawn('walker', g.lane, 0.5, 0);
    assert(g.input('fire', 100));
    assert(!g.input('fire', 120), 'a moment between shots');
    run(g, 100, 400);
    assert(!g.zombies.includes(z), 'killed');
    assert.strictEqual(g.score, G.KINDS.walker.score);
    assert(g.events.some((e) => e.type === 'kill'));
    const y = g.spawn('walker', (g.lane + 3) % 16, 0.5, 400);
    g.input('fire', 500); run(g, 500, 900);
    assert(g.zombies.includes(y), 'another lane: missed');
    assert.strictEqual(g.bullets.length, 0, 'bullets leave at the bottom');
}
/* at most MAX_BULLETS in the air */
{
    const g = fresh({ fire: 'manual' });
    for (let i = 0; i < 20; i++) g.input('fire', i * 100);
    assert(g.bullets.length <= G.MAX_BULLETS);
}
/* auto fire shoots by itself */
{
    const g = fresh({ fire: 'auto' });
    run(g, 0, 1000);
    assert(g.events.filter((e) => e.type === 'fire').length >= 5, 'about six a second');
}

/* a bloater takes three hits and bursts into two crawlers */
{
    const g = fresh({ fire: 'manual' });
    const b = g.spawn('bloater', g.lane, 0.4, 0);
    let t = 0;
    for (let i = 0; i < 3; i++) { g.input('fire', t); t = run(g, t, t + 400); }
    assert(!g.zombies.includes(b), 'three hits');
    const kids = g.zombies.filter((z) => z.kind === 'crawler');
    assert.strictEqual(kids.length, 2, 'two crawlers');
    assert.deepStrictEqual(kids.map((k) => k.lane).sort((a, c) => a - c), [(g.lane + 15) % 16, (g.lane + 1) % 16].sort((a, c) => a - c));
}

/* the rim: one there in your lane grabs you after GRAB_MS; shoot it in time and you live */
{
    const g = fresh({ fire: 'manual' });
    g.spawn('walker', g.lane, 0.995, 0);
    run(g, 0, 100);
    assert.strictEqual(g.state, 'play');
    run(g, 100, 100 + G.GRAB_MS + 50);
    assert.strictEqual(g.state, 'dead'); assert.strictEqual(g.deathWhy, 'grab');
    assert.strictEqual(g.lives, G.START_LIVES - 1);

    const h = fresh({ fire: 'manual' });
    h.spawn('walker', h.lane, 0.995, 0);
    run(h, 0, 100); h.input('fire', 120); run(h, 120, 600);
    assert.strictEqual(h.state, 'play', 'shot in time');
    assert.strictEqual(h.zombies.length, 0);
}
/* at the rim in another lane it shuffles towards you */
{
    const g = fresh({ fire: 'manual' });
    const z = g.spawn('walker', (g.lane + 4) % 16, 1, 0);
    z.rim = true; z.moveT = 0;
    run(g, 0, 1600);
    const dist = Math.min((z.lane - g.lane + 16) % 16, (g.lane - z.lane + 16) % 16);
    assert(dist < 4, 'came closer (' + dist + ')');
}
/* a spitter stops, spits; the spit reaching you ends the life; a bullet stops spit */
{
    const g = fresh({ fire: 'manual' });
    const s = g.spawn('spitter', g.lane, 0.5, 0); s.stopD = 0.5;
    let t = run(g, 0, 700);
    assert.strictEqual(g.gobs.length, 1, 'it spat');
    assert(Math.abs(s.d - 0.5) < 0.02, 'it stopped');
    t = run(g, t, t + 1300);
    assert.strictEqual(g.deathWhy, 'spat');

    const h = fresh({ fire: 'manual' });
    const s2 = h.spawn('spitter', (h.lane + 2) % 16, 0.5, 0); s2.stopD = 0.5;
    run(h, 0, 700); h.lane = (h.lane + 2) % 16;
    h.input('fire', 720); run(h, 720, 900);
    assert.strictEqual(h.gobs.length, 0, 'spit shot down');
    assert.strictEqual(h.state, 'play');
}

/* a grenade clears the pit, scores, and is used up */
{
    const g = fresh({ fire: 'manual' });
    for (let l = 0; l < 5; l++) g.spawn('walker', l, 0.3, 0);
    g.spawn('bloater', 6, 0.3, 0);
    assert(g.input('bomb', 1000));
    assert.strictEqual(g.zombies.length, 0, 'no bloater kids from a grenade');
    assert.strictEqual(g.grenades, 0);
    assert(!g.input('bomb', 1100), 'none left');
    assert.strictEqual(g.score, 5 * 100 + 300);
    const h = fresh({ fire: 'manual' }); assert(!h.input('bomb', 100), 'not in the first moment of a game (the start press)');
}

/* a lost life: the dead in the pit go back to the wave; the last life ends it; restart after a moment */
{
    const g = fresh({ fire: 'manual' });
    g.spawn('runner', (g.lane + 5) % 16, 0.2, 0);
    g.spawn('walker', g.lane, 0.999, 0);
    run(g, 0, 400);
    assert.strictEqual(g.state, 'dead');
    run(g, 400, 400 + G.DEATH_MS + 50);
    assert.strictEqual(g.state, 'play');
    assert.strictEqual(g.zombies.length, 0); assert.deepStrictEqual(g.wave.slice().sort(), ['runner', 'walker', 'walker']);
    g.lives = 1; g.wave = []; g.spawn('walker', g.lane, 0.999, 3000);
    run(g, 3000, 3400); run(g, 3400, 3400 + G.DEATH_MS + 50);
    assert.strictEqual(g.state, 'over');
    const t = 3400 + G.DEATH_MS + 50;
    assert(!g.input('fire', t + 10), 'game over holds a moment');
    assert(g.input('press', t + G.OVER_LOCK_MS + 10) && g.state === 'play' && g.score === 0 && g.lives === G.START_LIVES);
}

/* a cleared level: the bonus, the next shape, a grenade more (up to MAX_GRENADES) */
{
    const g = fresh({ fire: 'manual' }); g.wave = [];
    g.step(16, 100);
    assert.strictEqual(g.state, 'level'); assert.strictEqual(g.score, 500);
    run(g, 100, 100 + G.LEVEL_MS + 50);
    assert.strictEqual(g.level, 2); assert.strictEqual(g.shape.name, 'SQUARE'); assert.strictEqual(g.grenades, 2);
    assert(g.wave.length > 10, 'a bigger wave');
    assert(g.wave.some((k) => k === 'runner' || k === 'walker'));
    assert(!g.wave.includes('spitter'), 'spitters join at level 5');
}
/* an extra life every EXTRA_LIFE_EVERY */
{
    const g = fresh(); g.addScore(G.EXTRA_LIFE_EVERY - 10, 0); assert.strictEqual(g.lives, 3);
    g.addScore(20, 1); assert.strictEqual(g.lives, 4); assert.strictEqual(g.best, G.EXTRA_LIFE_EVERY + 10);
}
/* time away doesn't count */
{
    const g = fresh({ fire: 'manual' });
    g.spawn('walker', g.lane, 0.999, 0); run(g, 0, 50);
    g.shift(10000);
    run(g, 10050, 10100);
    assert.strictEqual(g.state, 'play', 'the grab clock was paused too');
}

/* a bot: aims at the nearest climber, grenades when crowded. It should clear levels on every speed */
function bot(speed, fire, seed) {
    const g = new G.Game({ rnd: seeded(seed), speed, fire });
    g.newGame(0);
    let t = 0;
    while (t < 240000 && g.state !== 'over') {
        t += 16;
        if (g.state === 'play') {
            const threat = g.zombies.slice().sort((a, b) => (b.d + (b.rim ? 1 : 0)) - (a.d + (a.rim ? 1 : 0)))[0];
            const gob = g.gobs.find((s) => s.lane === g.lane && s.d > 0.6);
            if (g.zombies.filter((z) => z.d > 0.8).length >= 3) g.input('bomb', t);
            if (threat && !gob && t - g.moveT > 70) { const w = g.toward(g.lane, threat.lane); if (w) g.input(w > 0 ? 'right' : 'left', t); }
            if (fire === 'manual') g.input('fire', t);
        }
        g.step(16, t);
    }
    return g;
}
for (const [sp, fire] of [[0.8, 'auto'], [1, 'auto'], [1.25, 'auto'], [1, 'manual']]) {
    const g = bot(sp, fire, 11);
    assert(g.level >= 3, 'bot on ' + sp + ' / ' + fire + ' reached level ' + g.level);
}

/* controls */
{
    const c = new Controls({ log: { info() {} } }); c.enable(true);
    const msg = (pos, push, defl) => c.raw({ frontRotaryEncoderOperation: pos, frontRotaryEncoderPushButton: push || 'KEINE_BETAETIGUNG', frontRotaryEncoderDeflection: defl || 'MITTELSTELLUNG' });
    msg(100); assert.deepStrictEqual(c.take(), []);
    msg(102); assert.deepStrictEqual(c.take(), ['right', 'right']);
    const w = new Controls({ log: { info() {} } }); w.enable(true);
    w.raw({ frontRotaryEncoderOperation: 65535, frontRotaryEncoderPushButton: 0, frontRotaryEncoderDeflection: 0 });
    w.raw({ frontRotaryEncoderOperation: 1, frontRotaryEncoderPushButton: 0, frontRotaryEncoderDeflection: 0 });
    assert.deepStrictEqual(w.take(), ['right', 'right'], 'the counter wraps');
    msg(30000); assert.deepStrictEqual(c.take(), [], 'a jump is not a spin');
    msg(30040); assert(c.take().length <= MAX_QUEUE);
    // the press: at once as it starts; hold once when long; nothing on release
    msg(30040, 'DREHGEBER_KURZ_GEDRUECKT'); assert.deepStrictEqual(c.take(), ['press']);
    msg(30040, 'DREHGEBER_LANG_GEDRUECKT'); msg(30040, 'DREHGEBER_LANG_GEDRUECKT'); assert.deepStrictEqual(c.take(), ['hold']);
    msg(30040); assert.deepStrictEqual(c.take(), []);
    // fire settings
    assert.strictEqual(action('press', 'auto'), 'bomb'); assert.strictEqual(action('hold', 'auto'), null);
    assert.strictEqual(action('press', 'manual'), 'fire'); assert.strictEqual(action('hold', 'manual'), 'bomb');
    assert.strictEqual(action('fire', 'auto'), 'fire', 'the hidden Fire button always fires');
    // reversed
    const r = new Controls({ log: { info() {} }, reversed: () => true }); r.enable(true);
    r.raw({ frontRotaryEncoderOperation: 5, frontRotaryEncoderPushButton: 0, frontRotaryEncoderDeflection: 0 });
    r.raw({ frontRotaryEncoderOperation: 6, frontRotaryEncoderPushButton: 0, frontRotaryEncoderDeflection: 0 });
    assert.deepStrictEqual(r.take(), ['left']);
    // no controller: the hidden buttons
    const b = new Controls({ log: { info() {} } }); b.enable(true);
    b.raw({ frontRotaryEncoderOperation: 65535, frontRotaryEncoderPushButton: 'SIGNAL_UNGUELTIG', frontRotaryEncoderDeflection: 'SIGNAL_UNGUELTIG' });
    assert(!b.live);
    b.barClick('BTN_LEFT'); b.barClick('BTN_FIRE'); b.barClick('BTN_BOMB'); assert.deepStrictEqual(b.take(), ['left', 'fire', 'bomb']);
    c.barClick('BTN_FIRE'); assert.deepStrictEqual(c.take(), [], 'with the controller live a click is the same press again');
    c.enable(false); msg(30041); assert.deepStrictEqual(c.take(), []);
}

/* drawing: every state and shape, on a canvas.js Canvas (PNG path) and a Recorder (GPU path) */
{
    const g = new G.Game({ rnd: seeded(3), best: 900 });
    g.newGame(0);
    let msCpu = 0, frames = 0;
    for (let lv = 1; lv <= G.SHAPES.length; lv++) {
        g.setLevel(lv, 0); g.state = 'play';
        Object.keys(G.KINDS).forEach((k, i) => { const z = g.spawn(k, (g.lane + i * 2) % g.lanes, 0.15 + i * 0.2, 0); if (i === 4) { z.rim = true; z.d = 1; z.lane = (g.lane + 1) % g.lanes; } });
        g.spawn('walker', g.lane, 1, 0).rim = true; g.zombies[g.zombies.length - 1].grabT = 50;
        g.bullets.push({ lane: g.lane, d: 0.6, prev: 0.65 }); g.gobs.push({ lane: g.lane, d: 0.7 });
        g.addFx('kill', g.lane, 0.5, 90, 'walker'); g.addFx('pop', g.lane, 0.4, 90);
        g.fireT = 80; g.bombT = 0;
        for (const st of ['ready', 'play', 'dead', 'level', 'over']) {
            g.state = st; g.stateT = 0; g.deathWhy = 'spat'; g.bonus = 500;
            const a = Date.now(); D.frame(new Canvas(D.W, D.H), g, 100, { live: true, paused: '', fire: 'auto' }); msCpu += Date.now() - a; frames++;
            D.frame(new Recorder(D.W, D.H), g, 100, { live: false, paused: st === 'level' ? 'Parked only' : '', fire: 'manual' });
        }
    }
    console.log('PNG-path frame: ' + Math.round(msCpu / frames) + ' ms on this PC');
}

/* the manifest */
{
    const spec = require('./app.json');
    assert.strictEqual(spec.settings.find((s) => s.key === 'parkedOnly').default, true, 'parked only by default');
    assert(spec.signals['de.bmw.infotainment.vehicle.Vehicle2'].statusCarSpeed2);
    assert.deepStrictEqual(spec.screens.find((s) => s.name === 'GAME').buttons.map((b) => b[0]), ['BTN_LEFT', 'BTN_FIRE', 'BTN_BOMB', 'BTN_RIGHT']);
}

console.log('dead rim self-check ok');
