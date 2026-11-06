'use strict';
/**
 * game.js - Road Hopper's rules, with no drawing and no head unit: a hopper crosses a road and a
 * river to reach the five homes at the top. Pure and stepped by time, so test.js can play it.
 *
 * Grid: COLS x ROWS cells, row 0 at the bottom (the start), row ROWS-1 at the top (the homes).
 *   row 0         start verge
 *   rows 1-5      road: cars and trucks; touching one ends the life
 *   row 6         middle verge (safe)
 *   rows 7-11     river: logs and turtle rafts carry the hopper; water ends the life, and so does
 *                 being carried off the edge; diving rafts sink for a while
 *   row 12        the bank with five homes; a hop into an empty home fills it, anywhere else ends the life
 *
 * Positions are in cells (floats for things that move). A lane's things all move at the lane's
 * speed (cells a second, + = right) and wrap round a band wider than the screen.
 *
 * Events (for sounds and effects): game.events gets { type, t } pushed: hop, squash, splash, edge,
 * timeout, home, level, extra, over, start.
 */

const COLS = 15, ROWS = 13;
const ROAD = [1, 2, 3, 4, 5], RIVER = [7, 8, 9, 10, 11], TOP = 12;
const HOMES = [1, 4, 7, 10, 13];             // home columns on the top row
const LIFE_MS = 40000;                       // time for one crossing
const DEATH_MS = 1100;                       // the life-lost moment before the next life
const LEVEL_MS = 1600;                       // the "level clear" moment
const HOP_MS = 110;                          // a hop's animation (drawing only; the rules move at once)
const WRAP = 6;                              // things wrap round [-WRAP, COLS + WRAP)
const START_LIVES = 3, EXTRA_LIFE_AT = 10000;
const RIVER_GIVE = 0.15;                     // cells of give at a log's ends

/* the lanes of level 1: speed in cells/s; things: [start x, length] */
const LANES = {
    1: { kind: 'car', speed: -1.6, things: [[0, 1], [5, 1], [10, 1], [16, 1]], look: 0 },
    2: { kind: 'car', speed: 1.3, things: [[2, 1], [8, 1], [14, 1]], look: 1 },
    3: { kind: 'car', speed: -2.4, things: [[1, 1], [9, 1], [17, 1]], look: 2 },
    4: { kind: 'car', speed: 3.4, things: [[3, 1], [13, 1]], look: 3 },
    5: { kind: 'truck', speed: -1.2, things: [[0, 2], [7, 2], [15, 2]], look: 4 },
    7: { kind: 'raft', speed: -1.3, things: [[0, 3], [6, 3], [12, 2], [18, 3]], dive: 1 },
    8: { kind: 'log', speed: 1.0, things: [[1, 3], [8, 3], [15, 3]] },
    9: { kind: 'log', speed: 2.2, things: [[0, 5], [11, 5]] },
    10: { kind: 'raft', speed: -1.7, things: [[2, 2], [7, 2], [12, 2], [17, 2]], dive: 2 },
    11: { kind: 'log', speed: 1.4, things: [[0, 4], [7, 4], [14, 4]] },
};
const DIVE = { period: 6000, under: 1500, warn: 900 };      // a diving raft: under for `under` ms every `period`

class Game {
    /** opts: { rnd() (0..1), now(), best (high score), speed (difficulty factor, 1 = normal) } */
    constructor(opts) {
        this.o = opts || {};
        this.rnd = this.o.rnd || Math.random;
        this.best = this.o.best || 0;
        this.diff = this.o.speed || 1;
        this.events = [];
        this.state = 'ready';                // ready (press to start), play, dead, level, over
        this.reset(0);
    }

    /** A new game (t: now). */
    newGame(t) {
        this.score = 0; this.lives = START_LIVES; this.level = 1; this.extraGiven = false;
        this.homes = HOMES.map(() => false);
        this.buildLanes();
        this.spawn(t);
        this.state = 'play';
        this.emit('start', t);
    }

    reset(t) {
        this.score = 0; this.lives = START_LIVES; this.level = 1;
        this.homes = HOMES.map(() => false);
        this.buildLanes();
        this.x = Math.floor(COLS / 2); this.y = 0; this.dir = 'up';
        this.lifeT = t; this.hopT = -1e9; this.from = null; this.furthest = 0; this.stateT = t;
    }

    /** The lanes for the current level: faster each level (by 12 %, capped), with the difficulty. */
    buildLanes() {
        const k = this.diff * Math.min(2.2, 1 + 0.12 * (this.level - 1));
        this.lanes = {};
        Object.keys(LANES).forEach((r) => {
            const L = LANES[r];
            this.lanes[r] = { kind: L.kind, speed: L.speed * k, look: L.look || 0, dive: L.dive || 0,
                things: L.things.map(([x, len], i) => ({ x, len, i })) };
        });
    }

    spawn(t) {
        this.x = Math.floor(COLS / 2); this.y = 0; this.dir = 'up';
        this.lifeT = t; this.from = null; this.hopT = -1e9; this.furthest = 0;
    }

    emit(type, t, extra) { this.events.push(Object.assign({ type, t }, extra || {})); if (this.events.length > 40) this.events.shift(); }

    /**
     * The player's input: 'up', 'down', 'left', 'right' (a hop), or 'press' (start / restart).
     * Returns true when it did something.
     */
    input(what, t) {
        if (this.state === 'ready' || this.state === 'over') {
            this.newGame(t);
            return true;
        }
        if (this.state !== 'play') return false;
        if (what === 'press') what = 'up';
        const d = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0] }[what];
        if (!d) return false;
        const nx = Math.round(this.x) + d[0], ny = this.y + d[1];
        if (ny < 0 || ny > TOP || nx < 0 || nx > COLS - 1) return false;      // the edges don't move you
        this.from = { x: this.x, y: this.y };
        this.x = nx; this.y = ny; this.dir = what; this.hopT = t;
        this.emit('hop', t);
        if (ny > this.furthest) { this.furthest = ny; this.addScore(10, t); }
        if (ny === TOP) this.landTop(t);
        return true;
    }

    addScore(n, t) {
        this.score += n;
        if (!this.extraGiven && this.score >= EXTRA_LIFE_AT) { this.extraGiven = true; this.lives++; this.emit('extra', t); }
        if (this.score > this.best) this.best = this.score;
    }

    landTop(t) {
        const i = HOMES.indexOf(Math.round(this.x));
        if (i < 0 || this.homes[i]) return this.die('splash', t);
        this.homes[i] = true;
        const left = Math.max(0, LIFE_MS - (t - this.lifeT));
        this.addScore(50 + Math.floor(left / 1000) * 10, t);
        this.emit('home', t, { home: i });
        if (this.homes.every(Boolean)) {
            this.addScore(1000, t);
            this.state = 'level'; this.stateT = t;
            this.emit('level', t);
        } else this.spawn(t);
    }

    die(why, t) {
        if (this.state !== 'play') return;
        this.lives--;
        this.state = 'dead'; this.stateT = t; this.deathWhy = why;
        this.emit(why, t);
        if (this.lives <= 0) this.emit('over', t);
    }

    /** A raft's things are under water at time t (and the moment before, `warn`, they flash). */
    diving(lane, thing, t) {
        if (!lane.dive || thing.i % 2 === 0 && lane.dive === 1) return 0;     // in lane 7 every other raft dives
        const ph = ((t + thing.i * 1700 + lane.dive * 900) % DIVE.period + DIVE.period) % DIVE.period;
        if (ph < DIVE.under) return 2;                                          // under
        if (ph > DIVE.period - DIVE.warn) return 1;                             // about to go
        return 0;
    }

    /** Advance the world by dt ms to time t. */
    step(dt, t) {
        dt = Math.max(0, Math.min(dt, 100));               // a stall doesn't teleport anything
        const span = COLS + 2 * WRAP;
        Object.keys(this.lanes).forEach((r) => {
            const L = this.lanes[r];
            L.things.forEach((th) => { th.x = ((th.x + L.speed * dt / 1000 + WRAP) % span + span) % span - WRAP; });
        });
        if (this.state === 'dead') {
            if (t - this.stateT >= DEATH_MS) {
                if (this.lives <= 0) { this.state = 'over'; this.stateT = t; }
                else { this.state = 'play'; this.spawn(t); }
            }
            return;
        }
        if (this.state === 'level') {
            if (t - this.stateT >= LEVEL_MS) {
                this.level++; this.homes = HOMES.map(() => false);
                this.buildLanes(); this.state = 'play'; this.spawn(t);
            }
            return;
        }
        if (this.state !== 'play') return;
        if (t - this.lifeT >= LIFE_MS) return this.die('timeout', t);
        const L = this.lanes[this.y];
        if (!L) return;
        if (L.kind === 'car' || L.kind === 'truck') {
            if (this.hit(L, this.x, 0.38, t)) this.die('squash', t);
            return;
        }
        // river: on something that floats? then it carries you (with a little give at the ends: a
        // hop that lands a hair past a log's end counts as on it, as it looks)
        const on = this.hit(L, this.x, -RIVER_GIVE, t);
        if (!on) return this.die('splash', t);
        this.x += L.speed * dt / 1000;
        if (this.x < -0.45 || this.x > COLS - 0.55) this.die('edge', t);
    }

    /**
     * The thing in lane L under a hopper at x, or null. pad > 0: a car's reach - touching when the
     * hopper's centre +- pad overlaps it; pad <= 0: standing on it - the centre within it, or within
     * -pad of its ends. Sunk rafts don't count.
     */
    hit(L, x, pad, t) {
        for (const th of L.things) {
            if (L.dive && this.diving(L, th, t) === 2) continue;
            const a = th.x, b = th.x + th.len, c = x + 0.5;
            if (pad > 0 ? (c + pad > a && c - pad < b) : (c >= a + pad && c <= b - pad)) return th;
        }
        return null;
    }

    /** After a pause of `ms`: the clocks of this life and of the moment shown move on by it, so no time is lost. */
    shift(ms) { if (ms > 0) { this.lifeT += ms; this.stateT += ms; this.hopT += ms; } }

    /** Time left on this life, 0..1. */
    timeLeft(t) { return this.state === 'play' ? Math.max(0, 1 - (t - this.lifeT) / LIFE_MS) : 0; }
}

module.exports = { Game, COLS, ROWS, ROAD, RIVER, TOP, HOMES, LIFE_MS, DEATH_MS, LEVEL_MS, HOP_MS, DIVE, LANES, START_LIVES };
