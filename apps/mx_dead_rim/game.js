'use strict';
/**
 * game.js - Dead Rim's rules, with no drawing and no head unit. You hold the rim of a pit; the dead
 * climb up its lanes from the bottom. Turn round the rim and shoot down your lane before they get
 * over the top. Pure and stepped by time, so test.js can play it.
 *
 * The pit: LANES lanes round a shape (a ring, a square, a star ...; one shape a level, see SHAPES).
 * Closed shapes wrap (lane N-1 is next to lane 0); open ones (a trench) have two ends.
 * Depth d: 0 at the bottom of the pit (where the dead come from), 1 at the rim (where you are).
 *
 * The dead (KINDS):
 *   walker   climbs slowly; at the rim it shuffles along towards you
 *   runner   climbs fast
 *   crawler  changes lanes as it climbs
 *   bloater  takes three hits; bursts into two crawlers in the lanes beside it
 *   spitter  stops part-way and spits up its lane; a spit reaching you on the rim ends the life
 * One of them at the rim in your lane grabs you after GRAB_MS unless you shoot it first.
 *
 * A grenade (one a level, up to MAX_GRENADES kept) clears everything in the pit.
 *
 * Events (for sounds and effects): game.events gets { type, t } pushed: start, fire, hit, kill,
 * burst, spit, bomb, grab, spat, level, extra, over.
 */

const START_LIVES = 3, EXTRA_LIFE_EVERY = 20000, MAX_GRENADES = 3;
const GRAB_MS = 300;                     // at the rim in your lane: this long to shoot it
const DEATH_MS = 1500, LEVEL_MS = 2200, OVER_LOCK_MS = 1200, START_SAFE_MS = 600;
const BULLET_SPEED = 2.6;                // depth a second (rim to bottom in 0.4 s)
const MAX_BULLETS = 6;
const FIRE_GAP = { auto: 160, manual: 90 };   // ms between shots
const GOB_SPEED = 0.42;
const HIT_REACH = 0.035;                 // depth slack for a bullet meeting a zombie

const KINDS = {
    walker: { speed: 0.15, hp: 1, rimMs: 700, score: 100 },
    runner: { speed: 0.32, hp: 1, rimMs: 450, score: 150 },
    crawler: { speed: 0.12, hp: 1, rimMs: 520, score: 200, laneMs: 950 },
    bloater: { speed: 0.075, hp: 3, rimMs: 1100, score: 300 },
    spitter: { speed: 0.13, hp: 2, rimMs: 650, score: 250, spitMs: 2300, spits: 3 },
};
/** The kinds a level can send (each new one joins at its level). */
const JOINS = [['walker', 1], ['runner', 2], ['crawler', 3], ['bloater', 4], ['spitter', 5]];

/* ---------- the pit's shapes: rim points in -1..1, clockwise from 12 o'clock on the screen ---------- */
function sampleClosed(verts, n) {
    const segs = verts.map((a, i) => { const b = verts[(i + 1) % verts.length]; return [a, b, Math.hypot(b[0] - a[0], b[1] - a[1])]; });
    const per = segs.reduce((s, x) => s + x[2], 0), out = [];
    for (let k = 0; k < n; k++) {
        let s = (k / n) * per;
        for (const [a, b, l] of segs) {
            if (s <= l + 1e-9) { const f = l ? s / l : 0; out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]); break; }
            s -= l;
        }
    }
    return out;
}
function sampleOpen(verts, n) {
    // n lanes: n + 1 edges from the first vertex to the last
    const segs = verts.slice(1).map((b, i) => { const a = verts[i]; return [a, b, Math.hypot(b[0] - a[0], b[1] - a[1])]; });
    const per = segs.reduce((s, x) => s + x[2], 0), out = [];
    for (let k = 0; k <= n; k++) {
        let s = (k / n) * per;
        for (let i = 0; i < segs.length; i++) {
            const [a, b, l] = segs[i];
            if (s <= l + 1e-9 || i === segs.length - 1) { const f = l ? Math.min(1, s / l) : 0; out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]); break; }
            s -= l;
        }
    }
    return out;
}
const polar = (n, r) => Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; const k = r(i); return [Math.sin(a) * k, -Math.cos(a) * k]; });

const SHAPES = [
    { name: 'RING', closed: true, edges: polar(16, () => 1) },
    { name: 'SQUARE', closed: true, edges: sampleClosed([[0, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]], 16) },
    { name: 'TRENCH', closed: false, edges: sampleOpen([[-1, -0.85], [0, 0.95], [1, -0.85]], 14) },
    { name: 'STAR', closed: true, edges: polar(16, (i) => (i % 2 ? 0.62 : 1)) },
    { name: 'TRIANGLE', closed: true, edges: sampleClosed([[0, -1], [1, 0.95], [-1, 0.95]], 15) },
    { name: 'WALL', closed: false, edges: sampleOpen([[-1, 0.8], [1, 0.8]], 14) },
];
SHAPES.forEach((s) => { s.lanes = s.closed ? s.edges.length : s.edges.length - 1; });

class Game {
    /** opts: { rnd() (0..1), best, speed (difficulty, 1 = normal), fire: 'auto' | 'manual' } */
    constructor(opts) {
        this.o = opts || {};
        this.rnd = this.o.rnd || Math.random;
        this.best = this.o.best || 0;
        this.diff = this.o.speed || 1;
        this.fireMode = this.o.fire || 'auto';
        this.events = [];
        this.fx = [];                        // short-lived effects for the picture: { type, lane, d, t, kind }
        this.state = 'ready';                // ready, play, dead, level, over
        this.score = 0; this.lives = START_LIVES; this.level = 1; this.grenades = 1;
        this.setLevel(1, 0);
        this.stateT = 0;
    }

    emit(type, t, extra) { this.events.push(Object.assign({ type, t }, extra || {})); if (this.events.length > 60) this.events.shift(); }
    addFx(type, lane, d, t, kind) { this.fx.push({ type, lane, d, t, kind }); if (this.fx.length > 40) this.fx.shift(); }

    get shape() { return SHAPES[(this.level - 1) % SHAPES.length]; }
    get lanes() { return this.shape.lanes; }

    /** The lane next to `lane` in direction dir (+1 / -1), or null past an open shape's end. */
    next(lane, dir) {
        const n = this.lanes, l = lane + dir;
        if (this.shape.closed) return (l + n) % n;
        return l < 0 || l >= n ? null : l;
    }
    /** The way (+1 / -1 / 0) from lane a towards lane b, the short way round. */
    toward(a, b) {
        if (a === b) return 0;
        const n = this.lanes;
        if (!this.shape.closed) return b > a ? 1 : -1;
        const fwd = (b - a + n) % n;
        return fwd <= n / 2 ? 1 : -1;
    }

    newGame(t) {
        this.score = 0; this.lives = START_LIVES; this.extraAt = EXTRA_LIFE_EVERY; this.grenades = 1;
        this.setLevel(1, t);
        this.state = 'play'; this.stateT = t; this.startT = t;
        this.emit('start', t);
    }

    /** The level's speed factor: 10 % faster a level, capped at 2.2 times, with the difficulty. */
    pace() { return this.diff * Math.min(2.2, 1 + 0.1 * (this.level - 1)); }

    setLevel(level, t) {
        this.level = level;
        const n = this.lanes;
        // start at the lane nearest the bottom of the screen (nearest you), the middle one on a flat rim
        let bestLane = 0, bestY = -9;
        for (let l = 0; l < n; l++) { const r = this.laneRim(l), y = r[1] - 0.05 * Math.abs(r[0]); if (y > bestY + 1e-6) { bestY = y; bestLane = l; } }
        this.lane = bestLane;
        this.zombies = []; this.bullets = []; this.gobs = [];
        this.wave = this.makeWave(level);
        this.waveSize = this.wave.length;
        this.nextSpawn = t + 1200;
        this.fireT = -1e9; this.bombT = -1e9; this.moveT = -1e9;
        this.id = this.id || 0;
    }

    /** The middle of a lane's rim in shape units (for picking the start lane). */
    laneRim(l) {
        const e = this.shape.edges, a = e[l], b = e[(l + 1) % e.length];
        return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    }

    makeWave(level) {
        const count = Math.min(40, 8 + 3 * level);
        const kinds = JOINS.filter(([, at]) => level >= at).map(([k]) => k);
        const w = [];
        for (let i = 0; i < count; i++) {
            // the newest kind comes a bit more often on its first level; walkers stay the backbone
            const r = this.rnd();
            let k;
            if (r < 0.4 || kinds.length === 1) k = 'walker';
            else k = kinds[1 + Math.floor(this.rnd() * (kinds.length - 1))];
            w.push(k);
        }
        return w;
    }
    spawnGap() { return Math.max(380, 1500 - 85 * this.level) / this.diff; }
    maxAlive() { return Math.min(16, 6 + this.level); }

    spawn(kind, lane, d, t) {
        const K = KINDS[kind];
        const z = { id: ++this.id, kind, lane, d, hp: K.hp, rim: false, moveT: t + (K.laneMs || 0), grabT: null, hitT: -1e9, spitT: null, spits: 0, stopD: null };
        if (kind === 'spitter') { z.stopD = 0.32 + this.rnd() * 0.22; z.spitT = null; }
        this.zombies.push(z);
        return z;
    }

    /** How many of the dead are left this level (still to come and in the pit). */
    left() { return this.wave.length + this.zombies.length; }

    /**
     * The player's input: 'left' / 'right' (one lane), 'fire', 'bomb', or 'press' (start). In the
     * ready and over screens any of fire / bomb / press starts a game.
     */
    input(what, t) {
        if (this.state === 'ready' || this.state === 'over') {
            if (what === 'left' || what === 'right') return false;
            if (this.state === 'over' && t - this.stateT < OVER_LOCK_MS) return false;
            this.newGame(t);
            return true;
        }
        if (this.state !== 'play') return false;
        if (what === 'left' || what === 'right') {
            const l = this.next(this.lane, what === 'right' ? 1 : -1);
            if (l === null) return false;
            this.lane = l; this.moveT = t;
            return true;
        }
        if (what === 'fire' || what === 'press') return this.fire(t);
        if (what === 'bomb') return this.bomb(t);
        return false;
    }

    fire(t) {
        if (this.state !== 'play') return false;
        if (t - this.fireT < FIRE_GAP[this.fireMode === 'manual' ? 'manual' : 'auto']) return false;
        if (this.bullets.length >= MAX_BULLETS) return false;
        this.bullets.push({ lane: this.lane, d: 1, prev: 1.02 });
        this.fireT = t;
        this.emit('fire', t);
        // anything already at the rim of this lane is hit at once (it's right in front of you)
        this.collide(t);
        return true;
    }

    bomb(t) {
        if (this.state !== 'play' || this.grenades <= 0 || t - this.startT < START_SAFE_MS) return false;
        this.grenades--;
        this.bombT = t;
        for (const z of this.zombies) { this.addScore(KINDS[z.kind].score, t); this.addFx('kill', z.lane, z.d, t, z.kind); }
        this.zombies = []; this.gobs = [];
        this.emit('bomb', t);
        return true;
    }

    addScore(n, t) {
        this.score += n;
        if (this.score > this.best) this.best = this.score;
        while (this.score >= this.extraAt) { this.extraAt += EXTRA_LIFE_EVERY; this.lives++; this.emit('extra', t); }
    }

    kill(z, t, how) {
        this.zombies.splice(this.zombies.indexOf(z), 1);
        this.addScore(KINDS[z.kind].score, t);
        this.addFx('kill', z.lane, z.d, t, z.kind);
        this.emit('kill', t, { kind: z.kind });
        if (z.kind === 'bloater' && how !== 'bomb') {
            this.emit('burst', t);
            for (const dir of [-1, 1]) {
                const l = this.next(z.lane, dir);
                if (l !== null) this.spawn('crawler', l, Math.min(z.d, 0.94), t);
            }
        }
    }

    /** Bullets against the dead and their spit. */
    collide(t) {
        for (let i = this.bullets.length - 1; i >= 0; i--) {
            const b = this.bullets[i], lo = b.d - HIT_REACH, hi = b.prev + HIT_REACH;
            let hit = null;
            // the nearest thing in the lane that the bullet passed (from the rim down)
            for (const z of this.zombies) if (z.lane === b.lane && z.d >= lo && z.d <= hi && (!hit || z.d > hit.d)) hit = z;
            let gob = null;
            for (const g of this.gobs) if (g.lane === b.lane && g.d >= lo && g.d <= hi && (!gob || g.d > gob.d)) gob = g;
            if (gob && (!hit || gob.d >= hit.d)) {
                this.gobs.splice(this.gobs.indexOf(gob), 1);
                this.bullets.splice(i, 1);
                this.addScore(25, t); this.addFx('pop', gob.lane, gob.d, t);
                continue;
            }
            if (!hit) continue;
            this.bullets.splice(i, 1);
            hit.hp--; hit.hitT = t;
            if (hit.hp <= 0) this.kill(hit, t, 'shot');
            else this.emit('hit', t);
        }
    }

    die(why, t) {
        this.state = 'dead'; this.stateT = t; this.deathWhy = why;
        this.lives--;
        this.emit(why, t);
        if (this.lives <= 0) this.emit('over', t);
    }

    /** Move the game on by dt ms; t is now. */
    step(dt, t) {
        dt = Math.min(dt, 100);                    // a stall doesn't teleport everything
        const s = dt / 1000;
        this.fx = this.fx.filter((f) => t - f.t < 600);

        if (this.state === 'dead') {
            if (t - this.stateT >= DEATH_MS) {
                if (this.lives <= 0) { this.state = 'over'; this.stateT = t; return; }
                // the dead in the pit drop back to the bottom: they come again
                for (const z of this.zombies) this.wave.unshift(z.kind);
                this.zombies = []; this.bullets = []; this.gobs = [];
                this.state = 'play'; this.stateT = t; this.startT = t; this.nextSpawn = t + 900;
            }
            return;
        }
        if (this.state === 'level') {
            if (t - this.stateT >= LEVEL_MS) {
                this.setLevel(this.level + 1, t);
                this.grenades = Math.min(MAX_GRENADES, this.grenades + 1);
                this.state = 'play'; this.stateT = t; this.startT = t;
            }
            return;
        }
        if (this.state !== 'play') return;

        const k = this.pace();
        if (this.fireMode !== 'manual') this.fire(t);

        // bullets down, spit up
        for (const b of this.bullets) { b.prev = b.d; b.d -= BULLET_SPEED * s; }
        for (const g of this.gobs) g.d += GOB_SPEED * k * s;
        this.collide(t);
        this.bullets = this.bullets.filter((b) => b.d > -0.02);

        // the spawn
        if (this.wave.length && t >= this.nextSpawn && this.zombies.length < this.maxAlive()) {
            this.spawn(this.wave.shift(), Math.floor(this.rnd() * this.lanes), 0, t);
            this.nextSpawn = t + this.spawnGap() * (0.7 + this.rnd() * 0.6);
        }

        // the dead
        for (const z of this.zombies.slice()) {
            const K = KINDS[z.kind];
            if (!z.rim) {
                if (z.kind === 'spitter' && z.spits < K.spits && z.d >= z.stopD) {
                    if (z.spitT === null) z.spitT = t + 600;
                    if (t >= z.spitT) {
                        this.gobs.push({ lane: z.lane, d: z.d + 0.02 });
                        z.spits++; z.spitT = t + K.spitMs / k;
                        this.emit('spit', t);
                    }
                } else z.d += K.speed * k * s;
                if (z.kind === 'crawler' && t >= z.moveT && z.d < 0.97) {
                    const dir = this.rnd() < 0.6 ? this.toward(z.lane, this.lane) || 1 : (this.rnd() < 0.5 ? -1 : 1);
                    const l = this.next(z.lane, dir);
                    if (l !== null) z.lane = l;
                    z.moveT = t + K.laneMs / k;
                }
                if (z.d >= 1) { z.d = 1; z.rim = true; z.moveT = t + K.rimMs / k; }
            } else if (z.lane !== this.lane && t >= z.moveT) {
                // along the rim towards you
                const l = this.next(z.lane, this.toward(z.lane, this.lane));
                if (l !== null) z.lane = l;
                z.moveT = t + K.rimMs / k;
            }
            if (z.rim && z.lane === this.lane) {
                if (z.grabT === null) z.grabT = t + GRAB_MS;
                else if (t >= z.grabT) { this.die('grab', t); return; }
            } else z.grabT = null;
        }
        // spit at the rim
        for (const g of this.gobs.slice()) {
            if (g.d < 1) continue;
            this.gobs.splice(this.gobs.indexOf(g), 1);
            if (g.lane === this.lane) { this.die('spat', t); return; }
        }

        if (!this.wave.length && !this.zombies.length) {
            const bonus = 500 * this.level;
            this.addScore(bonus, t);
            this.state = 'level'; this.stateT = t; this.bonus = bonus;
            this.emit('level', t);
        }
    }

    /** Time spent away (the game screen hidden): push every clock on by ms. */
    shift(ms) {
        if (!(ms > 0)) return;
        this.stateT += ms; this.nextSpawn += ms; this.fireT += ms; this.bombT += ms; this.moveT += ms;
        if (this.startT != null) this.startT += ms;
        for (const z of this.zombies) { z.moveT += ms; if (z.grabT !== null) z.grabT += ms; if (z.spitT !== null) z.spitT += ms; z.hitT += ms; }
        for (const f of this.fx) f.t += ms;
    }
}

module.exports = { Game, SHAPES, KINDS, JOINS, START_LIVES, GRAB_MS, DEATH_MS, LEVEL_MS, OVER_LOCK_MS, MAX_BULLETS, MAX_GRENADES, EXTRA_LIFE_EVERY, BULLET_SPEED };
