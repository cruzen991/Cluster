'use strict';
/**
 * cluster.js - puts the dials on the instrument cluster through cluster-render
 * (robertnisipeanu/idrive-apps, native/cluster-render): its `panel` target, the whole
 * 1920x720 cluster over the stock gauges.
 *
 * cluster-render gives one app at most 8 layers (CompositorLimits.per_client) and 32 for all
 * apps together; a layer over the limit is refused ("too many layers"). Versions up to 0.6 asked
 * for about 15, and the needles, made last, were the ones refused. Now (at most 7):
 *
 *   back       a black panel over the whole stock cluster (a 16x16 image stretched by the
 *              renderer), with "Stock cluster: hidden"; BMW's warning lights stay above it
 *   centre     drive mode, speed, range and odometer, one image; a speed change sends only
 *              the speed's rectangle
 *   faces x2   the speedometer and the tachometer, still images
 *   fx x2      everything on a dial that moves (fx.js): needle, hub, small needle and hub, and
 *              in the tech style the lit ring and the shift lights. Either an effect layer
 *              drawn by a shader (needles "Shader"), state in one uniform; or nothing, with the
 *              same picture composited into the face image itself, sending only the changed
 *              rectangles (needles "Redrawn images", no shaders at all)
 *   gear       the gear window on the tach
 *   speed      the speed window on the speedometer, only when there is no centre panel
 *
 * The arc style (arc.js) has its own set: back, the tach, its fx (shader only), the gear and speed
 * inside it, the two readout panels and the bottom strip; at most 7.
 */
const F = require('./faces');
const FX = require('./fx');
const A = require('./arc');
const { ClusterRender } = require('./cluster_render_client');

const TARGET = 'panel';
const W = 1920, H = 720;
const FPS = 30;
const MIN_STEP_DEG = 0.1;
const LCD_MIN_MS = 200;            // an LCD's text is redrawn at most 5 times a second
const REDRAW_FPS = 5;              // redrawn mode: dial updates a second at most (each costs CPU)
const ROTATE_FPS = 15;             // rotating mode (arc): the lit arc / lights / numerals redrawn up to this often; tiny rectangles
const ROTATE_MIN_DEG = 0.1;        // and the needle layer turned for a move of at least this
const REDRAW_MIN_DEG = 0.5;        // and none for a smaller move
const MAX_LAYERS = 8;              // cluster-render's per-client limit
/* arc style: how often each slow value shown is refreshed (ms); a value that was missing shows at once */
const SLOW_MS = { oilC: 3000, coolC: 3000, iatC: 2000, outsideC: 120000 };
const PANEL_MS = 250;
const PEAK_MAX_PSI = 35;           // arc style: a boost above this is a bad sample, never a peak
const PEAK_RESET_MS = 60000;       // and the peak is forgotten after the engine has been off this long              // arc style: readouts redrawn at most 4 times a second (big figures cost upload)

/* where the two dials sit on the panel; dx moves both outwards (+) or inwards (-) */
function layout(dx, dy) {
    const cy = H / 2 + (dy || 0);
    return { speedo: { cx: 430 - (dx || 0), cy }, tach: { cx: W - 430 + (dx || 0), cy } };
}

const buf = (cv) => Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.length);

/** A smoothed needle: value -> angle, eased towards its target. */
class Needle {
    constructor(tauMs) { this.tau = tauMs; this.v = 0; this.t = 0; this.sent = null; }
    step(dt) {
        if (!isFinite(this.v)) this.v = this.t;          // one bad sample must not freeze the needle
        const k = 1 - Math.exp(-dt / this.tau);
        this.v += (this.t - this.v) * k;
        if (Math.abs(this.t - this.v) < 1e-3) this.v = this.t;
    }
}

class ClassicCluster {
    /**
     * opts: { log, settings: () => current settings object, socket (optional path), app (name),
     *         onTarget(state, holder, reason), onDisconnected(), onError(e) }
     *
     * On and off are a connection: on connects to cluster-render and makes the layers; off closes
     * the connection, and cluster-render drops every layer of a client whose connection goes
     * (PROTOCOL.md), so the panel is released and the stock cluster comes back whatever state
     * this app was in.
     */
    constructor(opts) {
        this.opts = opts;
        this.log = opts.log;
        this.getSettings = opts.settings;
        this.cr = null;
        this.refs = {};
        this.state = { target: 'off', reason: '', layers: {}, budget: '' };
        this.values = { speed: 0, rpm: 0, fuel: null, oil: null, gearText: '', live: false };
        this.needles = { speed: new Needle(70), rpm: new Needle(45), fuel: new Needle(1500), oil: new Needle(1500), boost: new Needle(60) };
        this.lcdText = { speed: null, gear: null };
        this.lcdAt = { speed: 0, gear: 0 };
        this.sweep = null;
        this.timer = null;
        this.enabled = false;
        this.faceKey = '';
        this.sweptOnce = false;
    }

    /** Starts the needle loop; the cluster itself waits for enable(true). */
    start() {
        let last = Date.now();
        this.timer = setInterval(() => {
            const now = Date.now();
            try { this.tick(now - last, now); } catch (e) { if (this.opts.onError) this.opts.onError(e); }
            last = now;
        }, 1000 / FPS);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.enable(false);
    }

    /** On: connect and make the layers. Off: close the connection (everything goes with it). */
    enable(on) {
        on = !!on;
        if (on === this.enabled) return;
        this.enabled = on;
        if (on) this._connect(); else this._disconnect();
        this.log.info(on ? 'cluster on' : 'cluster off');
    }

    _connect() {
        const cr = this.cr = new ClusterRender(this.opts.app || 'mx_classic_cluster', this.opts.socket);
        this.state = { target: 'connecting', reason: '', layers: {}, why: {}, budget: '' };
        this.refs = {}; this.faceKey = ''; this.dials = null;
        this.lcdText = { speed: null, gear: null };
        Object.keys(this.needles).forEach((k) => { this.needles[k].sent = null; });
        cr.on('ready', () => this.log.info('cluster-render: backend ' + cr.backend + ', targets ' + cr.targets));
        cr.on('disconnected', () => {
            if (this.cr !== cr) return;
            this.state.target = 'disconnected'; this.state.reason = 'cluster renderer not reachable';
            if (this.opts.onDisconnected) this.opts.onDisconnected();
        });
        cr.on('target', (name, state, holder, reason) => {
            if (name !== TARGET || this.cr !== cr) return;
            const was = this.state.target;
            this.state.target = state; this.state.reason = reason || (holder && holder !== 'none' ? 'held by ' + holder : '');
            if (state !== was) this.log.info('panel ' + state + (this.state.reason ? ': ' + this.state.reason : ''));
            if (state === 'shown' && was !== 'shown' && !this.sweptOnce) { this.sweptOnce = true; this.startSweep(true); }
            if (this.opts.onTarget) this.opts.onTarget(state, holder, reason);
        });
        cr.on('layer', (ref, state, reason) => {
            this.state.layers[ref] = state;
            this.state.why[ref] = reason || '';
            if (state === 'error') this.log.warn('layer ' + ref + ' refused: ' + (reason || ''));
        });
        cr.on('budget', (cap, max) => { this.state.budget = cap + '/' + max + ' KB/s'; });
        cr.on('refused', (op, ref, reason) => {
            this.state.refused = (this.state.refused || 0) + 1;
            this.state.lastRefused = op + ' ' + ((this.groups && this.groups[ref]) || ref) + ': ' + (reason || '');
            this.log.warn('refused ' + op + ' ' + ref + ': ' + (reason || ''));
        });
        this.build();
        cr.connect();
    }

    _disconnect() {
        if (this.cr) this.cr.close();
        this.cr = null;
        this.refs = {}; this.faceKey = ''; this.dials = null;
        this.sweep = null;
        this.state = { target: 'off', reason: '', layers: {}, budget: '' };
    }

    /**
     * (Re)draw everything a setting changes. Never in one block: the two faces are drawn in turns of
     * the event loop (or come from the cache), so the app keeps answering the HMI meanwhile; a newer
     * build, or the cluster going off, abandons an older one.
     */
    build() {
        const s = this.getSettings();
        const key = JSON.stringify([s.shift, s.style, s.arcBg, s.units, s.redline, s.tempUnit, s.dx, s.dy, s.backdrop, s.needles, s.retake]);
        if (!this.cr || key === this.faceKey) return;
        this.faceKey = key;
        const gen = this.buildGen = (this.buildGen || 0) + 1, cr = this.cr;
        const live = () => this.buildGen === gen && this.cr === cr;
        if (s.style === 'arc') {
            const o = { redline: s.redline, max: tachMax(s.redline) }, t0 = Date.now();
            later(() => {
                if (!live()) return;
                const art = this.arcArt(o);
                later(() => {
                    if (!live()) return;
                    const bk = s.arcBg === 'graphite' ? 'graphite' : 'grid';
                    if (!art.bg || art.bgKind !== bk) { art.bg = A.background(bk); art.bgKind = bk; }
                    later(() => { if (live()) this._arcLayers(s, o, art, t0); });
                });
            });
            return;
        }
        const centre = s.backdrop === 'full';
        const faceOpts = { style: s.style, units: s.units, redline: s.redline, max: tachMax(s.redline), tempUnit: s.tempUnit };
        const t0 = Date.now();
        later(() => {
            if (!live()) return;
            const speedo = this.face('speedo', faceOpts);
            later(() => {
                if (!live()) return;
                const tach = this.face('tach', faceOpts);
                later(() => { if (live()) this._layers(s, faceOpts, speedo, tach, t0); });
            });
        });
    }

    /** A face from the cache (the last few drawn), or drawn now. */
    face(kind, o) {
        const key = kind + JSON.stringify(o);
        this.faces = this.faces || new Map();
        let cv = this.faces.get(key);
        if (!cv) {
            cv = kind === 'speedo' ? F.speedoFace(o) : F.tachFace(o);
            this.faces.set(key, cv);
            while (this.faces.size > 4) this.faces.delete(this.faces.keys().next().value);
        }
        return cv;
    }

    /** The arc style's still artwork (face without numerals, the numeral sprites), cached. */
    arcArt(o) {
        const key = 'arc' + JSON.stringify(o);
        this.faces = this.faces || new Map();
        let a = this.faces.get(key);
        if (!a) {
            a = { base: A.arcFace(o), nums: A.numerals(o), bg: null };      // bg: drawn on a turn of its own (build)
            this.faces.set(key, a);
            while (this.faces.size > 4) this.faces.delete(this.faces.keys().next().value);
        }
        return a;
    }

    /** The arc style's layers (see arc.js). */
    _arcLayers(s, o, art, t0) {
        const cr = this.cr, L = A.arcLayout(s.dy);
        Object.keys(this.refs).forEach((k) => cr.drop(this.refs[k]));
        const R = this.refs = {};
        const base = { target: TARGET, visible: true, contend: s.retake ? 1 : 0 };
        const img = (q) => cr.image(Object.assign({}, base, q));
        this.arc = true;
        // the stock cluster is always hidden in this style: the readouts cover the whole panel. The
        // background is the horizon grid, drawn at half size and stretched (bilinear) by the renderer
        R.back = img({ klass: 'ambient', x: 0, y: 0, w: W, h: H, iw: A.BG_W, ih: A.BG_H, sampling: 'bilinear' });
        cr.pixels(R.back, null, buf(art.bg));

        this.mode = s.needles === 'shader' ? 'shader' : s.needles === 'rotate' ? 'rotate' : 'redraw';
        const spec = A.arcFx(o);
        if (!s.shift) spec.lights = null;
        // rotating mode: the needle is a layer of its own the renderer turns about the pivot; the dial
        // image keeps the lit arc, the shift lights and the numerals
        if (this.mode === 'rotate') spec.main = null;
        const levels = art.nums.map(() => 0);
        const face = A.faceWith(art.base, art.nums, levels);
        const d = { ref: img(Object.assign({ z: 0 }, L.dial)), spec, face, base: art.base, nums: art.nums, levels, st: null, at: 0, numAt: 0 };
        R.dial = d.ref;
        if (this.mode === 'shader') {
            cr.pixels(d.ref, null, buf(face));
            d.fx = cr.effect(Object.assign({}, base, { z: 2, fs: FX.shader(spec) }, L.dial));
            cr.uniform(d.fx, 'u_v', [F.A0, F.SUB.a0, 0, F.SUB.a0]);
            R.dialFx = d.fx;
        } else {
            if (this.mode === 'rotate') {
                const n = A.needleSprite(o);
                d.needle = img({ z: 2, x: L.dial.x + A.DCX - n.px, y: L.dial.y + A.DCY - n.py, w: n.w, h: n.h, px: n.px, py: n.py,
                    rotate: F.A0, sampling: 'bilinear' });
                cr.pixels(d.needle, null, buf(n.cv));
                d.needleAt = F.A0;
                R.needle = d.needle;
            }
            d.live = new F.Canvas(A.DW, A.DH);
            d.pending = true;
            const cur = this.cr;
            later(() => {
                if (this.cr !== cur || !this.dials || this.dials.tach !== d) return;
                this.redrawDial(d, { a: F.A0, b: F.SUB.a0, c: F.SUB.a0, lv: 0 }, Date.now(), true);
                d.pending = false;
            });
        }
        this.dials = { tach: d };

        this.panels = {};
        for (const k of ['centre', 'left', 'right', 'strip']) {
            R[k] = img(Object.assign({ z: k === 'centre' ? 3 : 1 }, L[k]));
            this.panels[k] = { ref: R[k], p: new A.Panel(L[k].w, L[k].h) };
        }
        this.panelAt = 0; this.slow = null;

        const count = Object.keys(R).length;
        if (count > MAX_LAYERS) this.log.warn(count + ' layers asked for, more than cluster-render allows one app (' + MAX_LAYERS + ')');
        this.groups = {};
        const g = (name, refs) => refs.forEach((ref) => { if (ref) this.groups[ref] = name; });
        g('background', [R.back]); g('dials', [R.dial]); g('moving', [R.dialFx, R.needle]); g('readouts', [R.centre, R.left, R.right, R.strip]);
        this.state.layers = {}; this.state.why = {};
        this.sends = 0;
        this.layerCount = count;
        Object.keys(this.needles).forEach((k) => { this.needles[k].sent = null; });
        this.log.info(count + ' layers (arc), drawn in ' + (Date.now() - t0) + ' ms');
    }

    _layers(s, faceOpts, speedo, tach, t0) {
        this.arc = false; this.panels = null;
        const L = layout(s.dx, s.dy);
        const cr = this.cr, r = this.refs;
        const D = F.D, C = F.C;
        const centre = s.backdrop === 'full';

        Object.keys(r).forEach((k) => cr.drop(r[k]));
        this.refs = {};
        const R = this.refs;
        // contend 0 (the default): wait for the slot to be free and never retry against BMW's
        // own content; the panel never takes a slot from the stock HMI either way
        // (cluster-render's panel_take_over_stock is 0)
        const base = { target: TARGET, visible: true, contend: s.retake ? 1 : 0 };
        const img = (o) => cr.image(Object.assign({}, base, o));

        if (centre) {
            const black = new F.Canvas(16, 16).clear('#000000');
            R.back = img({ klass: 'ambient', x: 0, y: 0, w: W, h: H, iw: 16, ih: 16 });
            cr.pixels(R.back, null, buf(black));
            R.center = img({ z: 1, x: Math.round(W / 2 - F.CENTER.w / 2), y: Math.round(H / 2 - F.CENTER.h / 2), w: F.CENTER.w, h: F.CENTER.h });
            this.centerKey = null; this.centerSpeed = null; this.centerAt = 0;
        }

        this.mode = s.needles === 'shader' ? 'shader' : 'redraw';     // 'rotate' is the arc style's only: redrawn here
        this.dials = {};
        const dial = (key, face, kind, cx, cy) => {
            const ref = img({ z: 0, x: cx - C, y: cy - C, w: D, h: D });
            const spec = F.dialFx(s.style, kind, faceOpts);
            if (!s.shift) spec.lights = null;
            const d = { ref, spec, face, st: null, at: 0, flash: null };
            R[key] = ref;
            if (this.mode === 'shader') {
                cr.pixels(ref, null, buf(face));
                d.fx = cr.effect(Object.assign({}, base, { z: 2, x: cx - C, y: cy - C, w: D, h: D, fs: FX.shader(spec) }));
                cr.uniform(d.fx, 'u_v', [F.A0, F.SUB.a0, 0, F.SUB.a0]);
                R[key + 'Fx'] = d.fx;
            } else {
                // the first picture of each dial on a turn of its own
                d.live = new F.Canvas(D, D);
                d.pending = true;
                const cur = this.cr;
                later(() => {
                    if (this.cr !== cur || !this.dials || this.dials[key] !== d) return;
                    this.redrawDial(d, { a: F.A0, b: F.SUB.a0, c: F.SUB.a0, lv: 0 }, Date.now(), true);
                    d.pending = false;
                });
            }
            this.dials[key] = d;
        };
        dial('speedo', speedo, 'speed', L.speedo.cx, L.speedo.cy);
        dial('tach', tach, 'rpm', L.tach.cx, L.tach.cy);

        // LCDs: the gear on the tach; the speed on the speedometer only without the centre panel
        const lcdX = (cx) => cx - F.LCD.w / 2, lcdY = (cy) => cy - C + F.LCD.y;
        if (!centre) R.lcdSpeed = img({ z: 1, x: lcdX(L.speedo.cx), y: lcdY(L.speedo.cy), w: F.LCD.w, h: F.LCD.h });
        R.lcdGear = img({ z: 3, x: lcdX(L.tach.cx), y: lcdY(L.tach.cy), w: F.LCD.w, h: F.LCD.h });
        this.lcdText = { speed: null, gear: null };
        this.lcdAt = { speed: 0, gear: 0 };

        const count = Object.keys(R).length;
        if (count > MAX_LAYERS) this.log.warn(count + ' layers asked for, more than cluster-render allows one app (' + MAX_LAYERS + ')');

        // which group each layer is in, for the app's diagnostics
        this.groups = {};
        const g = (name, refs) => refs.forEach((ref) => { if (ref) this.groups[ref] = name; });
        g('background', [R.back]); g('centre', [R.center]); g('dials', [R.speedo, R.tach]);
        g('moving', [R.speedoFx, R.tachFx]); g('lcds', [R.lcdSpeed, R.lcdGear]);
        this.state.layers = {}; this.state.why = {};
        this.sends = 0;
        this.layerCount = count;

        Object.keys(this.needles).forEach((k) => { this.needles[k].sent = null; });
        this.log.info(count + ' layers, faces drawn in ' + (Date.now() - t0) + ' ms');
    }

    /**
     * The needle sweep: to full scale and back, about 1.6 s. auto: the one at start, which the
     * "Needle sweep at start" setting controls; the button's sweep runs whatever that setting.
     * Returns why it did not run, or ''.
     */
    startSweep(auto) {
        if (auto && !this.getSettings().sweep) return 'off in the settings';
        if (!this.enabled || !this.cr) return 'the cluster is off';
        if (this.values.live && this.values.speed > 1) return 'not while moving';     // never while moving
        this.sweep = { t0: Date.now() };
        this.log.info('needle sweep');
        return '';
    }

    /**
     * values: { speed (mph or km/h, already in the dial's units), rpm, fuel (0..1 or null),
     *           oil (dial fraction 0..1 or null), oilC (deg C or null), boost (dial fraction 0..1 or null),
     *           speedText, gearText, live }
     */
    update(v) { Object.assign(this.values, v); }

    tick(dt, now) {
        if (!this.enabled || !this.cr || !this.dials || !this.dials.tach) return;
        const s = this.getSettings(), v = this.values, n = this.needles;
        const speedMax = s.units === 'kmh' ? 260 : 160, rpmMax = tachMax(s.redline);
        let fs = v.speed / speedMax, fr = v.rpm / rpmMax, ff = v.fuel, fo = v.oil, fb = v.boost, rpm = v.rpm;
        if (this.sweep) {
            const t = (now - this.sweep.t0) / 800;
            const p = t < 1 ? ease(t) : t < 2 ? 1 - ease(t - 1) : null;
            if (p === null) this.sweep = null;
            else { fs = fr = ff = fo = fb = p; rpm = p * rpmMax; }
        }
        n.speed.t = clamp01(fs); n.rpm.t = clamp01(fr);
        n.fuel.t = ff == null ? 0 : clamp01(ff); n.oil.t = fo == null ? 0 : clamp01(fo); n.boost.t = fb == null ? 0 : clamp01(fb);
        if (this.sweep) { Object.keys(n).forEach((k) => { n[k].v = n[k].t; }); }
        else Object.keys(n).forEach((k) => n[k].step(dt));

        // shift lights; at the redline the app flashes them (11 on, 12 off) FLASH_HZ times a second
        let lv = shiftLevel(rpm, s.redline);
        if (lv === 11 && Math.floor(now / 1000 * FX.FLASH_HZ * 2) % 2) lv = 12;
        const sub0 = F.SUB.a0;
        if (this.arc) { this._arcTick(s, v, lerp(F.A0, F.A1, n.rpm.v), n.rpm.v * rpmMax, lv, now); return; }
        this.dialState('speedo', { a: lerp(F.A0, F.A1, n.speed.v), b: F.subAngleOf(n.fuel.v), c: sub0, lv: 0 }, now);
        this.dialState('tach', { a: lerp(F.A0, F.A1, n.rpm.v), b: F.subAngleOf(n.oil.v), c: F.subAngleOf(n.boost.v), lv }, now);

        // LCDs
        const unit = s.units === 'kmh' ? 'km/h' : 'mph';
        if (this.refs.lcdSpeed) this.lcd('speed', this.refs.lcdSpeed, this.sweep ? '888' : v.speedText, unit, now, s, false);
        this.lcd('gear', this.refs.lcdGear, this.sweep ? '88' : v.gearText, '', now, s, true);
        if (this.refs.center) {
            const key = [v.rangeText, v.odoText, v.modeText, unit].join('|');
            const sp = this.sweep ? '888' : (v.speedText == null ? '' : String(v.speedText));
            const all = key !== this.centerKey;
            if (all || (sp !== this.centerSpeed && now - this.centerAt >= LCD_MIN_MS)) {
                const cv = F.centerInfo(v.rangeText || '---', v.odoText || '---', { mode: v.modeText || '', speed: sp, unit });
                if (all) this.cr.pixels(this.refs.center, null, buf(cv));
                else this.cr.pixels(this.refs.center, [F.CSPEED], crop(cv, F.CSPEED));
                this.centerKey = key; this.centerSpeed = sp; this.centerAt = now;
            }
        }
    }

    /**
     * The arc style, each tick: the needle (as dialState), the numerals' sizes following the needle
     * (rpm = where the needle is now), and the readouts (at most 5 times a second, changed cells only).
     */
    _arcTick(s, v, a, rpm, lv, now) {
        const d = this.dials.tach;
        if (d && !d.pending) {
            const st = { a, b: F.SUB.a0, c: F.SUB.a0, lv };
            const lv2 = A.numeralLevels(rpm, d.nums.length);
            const changed = [];
            lv2.forEach((k, i) => { if (k !== d.levels[i]) changed.push(i); });
            // rotating mode: the needle layer turns every tick (30 a second), a message of a few bytes
            if (d.needle && Math.abs(a - d.needleAt) >= ROTATE_MIN_DEG) { this.cr.set(d.needle, { rotate: round2(a) }); d.needleAt = a; this.sends++; }
            if (this.mode === 'shader') {
                this.dialState('tach', st, now);
                if (changed.length && now - d.numAt >= 1000 / 10) {
                    const rects = changed.map((i) => { const from = d.levels[i]; d.levels[i] = lv2[i]; return A.pasteNumeral(d.face, d.base, d.nums[i], lv2[i], from); });
                    this.cr.pixels(d.ref, rects, cropMany(d.face, rects));
                    d.numAt = now; this.sends++;
                }
            } else if (now - d.at >= 1000 / (this.mode === 'rotate' ? ROTATE_FPS : REDRAW_FPS)) {
                const o = d.st;
                const moved = !o || o.lv !== st.lv || Math.abs(o.a - st.a) >= REDRAW_MIN_DEG;
                if (moved || changed.length) {
                    const boxes = changed.map((i) => { const from = d.levels[i]; d.levels[i] = lv2[i]; return A.pasteNumeral(d.face, d.base, d.nums[i], lv2[i], from); });
                    const rects = FX.fewer((moved ? FX.dirty(d.spec, o, st) : []).concat(boxes), FX.MAX_RECTS);
                    FX.compose(d.spec, st, d.face.d, d.live.d, rects);
                    d.st = st; d.at = now; this.sends++;
                    if (rects.length) this.cr.pixels(d.ref, rects, cropMany(d.live, rects));
                }
            }
        }
        if (!this.panels || now - this.panelAt < PANEL_MS) return;
        this.panelAt = now;
        // the temperatures are taken every SLOW_MS only: a value flickering between two degrees would
        // otherwise redraw and upload its big figures several times a second for nothing
        const sl = this.slow = this.slow || { at: {}, v: {} };
        for (const k of Object.keys(SLOW_MS)) {
            const missing = sl.v[k] == null && v[k] != null;
            if (!(k in sl.v) || missing || now - sl.at[k] >= SLOW_MS[k]) { sl.v[k] = v[k]; sl.at[k] = now; }
        }
        // the drive's peak boost: the highest seen (not in the sweep, nothing above PEAK_MAX_PSI, which
        // would be a bad sample), forgotten once the engine has been off PEAK_RESET_MS (a new drive)
        const b = v.boostPsi;
        if (!this.sweep && v.live !== false && b != null && isFinite(b) && b <= PEAK_MAX_PSI) this.peak = Math.max(this.peak || 0, b);
        if (v.rpm > 300) this.engineAt = now;
        else if (this.peak && now - (this.engineAt || now) > PEAK_RESET_MS) this.peak = 0;
        const t = arcTexts(s, Object.assign({}, v, sl.v, { peakPsi: this.peak }), this.sweep);
        A.drawCentre(this.panels.centre.p, t.centre);
        A.drawLeft(this.panels.left.p, t.left);
        A.drawRight(this.panels.right.p, t.right);
        A.drawStrip(this.panels.strip.p, t.strip);
        for (const k of ['centre', 'left', 'right', 'strip']) {
            const P = this.panels[k], out = P.p.take();
            if (out.whole) this.cr.pixels(P.ref, null, buf(P.p.cv));
            else if (out.rects.length) this.cr.pixels(P.ref, FX.fewer(out.rects, FX.MAX_RECTS), cropMany(P.p.cv, FX.fewer(out.rects, FX.MAX_RECTS)));
        }
    }

    /** A dial's moving parts to a new state: a uniform (shader), or changed rectangles (redrawn). */
    dialState(key, st, now) {
        const d = this.dials[key];
        if (!d || d.pending) return;
        const o = d.st;
        const moved = !o || o.lv !== st.lv || ['a', 'b', 'c'].some((k) => Math.abs(o[k] - st[k]) >= MIN_STEP_DEG);
        if (!moved) return;
        if (this.mode === 'shader') {
            d.st = st; this.sends++;
            this.cr.uniform(d.fx, 'u_v', [round2(st.a), round2(st.b), st.lv, round2(st.c)]);
            return;
        }
        if (now - d.at < 1000 / REDRAW_FPS) return;
        if (o.lv === st.lv && ['a', 'b', 'c'].every((k) => Math.abs(o[k] - st[k]) < REDRAW_MIN_DEG)) return;
        this.redrawDial(d, st, now, false);
    }

    /** Redrawn mode: recomposite face + moving parts in the changed rectangles and send those. */
    redrawDial(d, st, now, whole) {
        let rects;
        if (whole) { d.live.d.set(d.face.d); rects = FX.allRects(d.spec, st); }
        else rects = FX.dirty(d.spec, d.st, st);
        FX.compose(d.spec, st, d.face.d, d.live.d, rects);
        d.st = st; d.at = now; this.sends++;
        if (whole) this.cr.pixels(d.ref, null, buf(d.live));
        else if (rects.length) this.cr.pixels(d.ref, rects, cropMany(d.live, rects));
    }

    lcd(key, ref, text, unit, now, s, center) {
        text = text == null ? '' : String(text);
        if (text === this.lcdText[key] || now - (this.lcdAt[key] || 0) < LCD_MIN_MS) return;
        this.lcdText[key] = text; this.lcdAt[key] = now;
        this.cr.pixels(ref, null, buf(F.lcd(text, unit, { center })));
    }

    /**
     * The cluster's state for the app's screen: the panel, and per group of layers how many are in
     * each state cluster-render reported (shown, waiting, stalled, hidden, error) with a reason.
     */
    status() {
        const st = this.state, groups = {};
        Object.keys(this.groups || {}).forEach((ref) => {
            const name = this.groups[ref], state = st.layers[ref] || 'no report';
            const g = groups[name] = groups[name] || { counts: {}, why: '' };
            g.counts[state] = (g.counts[state] || 0) + 1;
            if (state !== 'shown' && st.why && st.why[ref] && !g.why) g.why = st.why[ref];
        });
        const shown = Object.keys(st.layers).filter((k) => st.layers[k] === 'shown').length;
        return { target: st.target, reason: st.reason, shown, budget: st.budget, backend: this.cr ? this.cr.backend : '',
            groups, mode: this.mode, sends: this.sends || 0, sweeping: !!this.sweep, layers: this.layerCount || 0,
            refused: st.refused || 0, lastRefused: st.lastRefused || '' };
    }
}

/**
 * The arc style's texts from the values and settings: temperatures in the chosen unit, torque in
 * lb-ft or Nm, '--' for anything the car has not sent.
 * v: { oilC, coolC, iatC, outsideC (deg C or null), boostPsi, torqueNm (or null), fuel (0..1 or null),
 *      speedText, gearText, rangeText, odoText, modeText }
 */
function arcTexts(s, v, sweep) {
    const f = s.tempUnit !== 'c', tu = f ? '°F' : '°C';
    const T = (c) => (c == null || !isFinite(c) ? '--' : String(Math.round(f ? c * 9 / 5 + 32 : c)));
    const lb = s.torqueUnit !== 'nm';
    const tq = v.torqueNm == null || !isFinite(v.torqueNm) ? '--' : String(Math.round((lb ? v.torqueNm * 0.737562 : v.torqueNm) / 5) * 5);   // in fives: steadier, fewer uploads
    const boost = v.boostPsi == null || !isFinite(v.boostPsi) ? '--' : String(Math.round(Math.max(0, v.boostPsi)));   // whole psi
    const up = (x) => String(x == null ? '' : x).toUpperCase();
    return {
        centre: { gear: sweep ? '88' : (v.gearText || '-'), speed: sweep ? '888' : (v.speedText == null ? '---' : String(v.speedText)), unit: s.units === 'kmh' ? 'KM/H' : 'MPH' },
        left: { oil: T(v.oilC), cool: T(v.coolC), tu, oilWarn: v.oilC >= 130, coolWarn: v.coolC >= 112, fuel: v.fuel, range: up(v.rangeText || '---') },
        right: { boost, torque: tq, tq: lb ? 'LB-FT' : 'NM', odo: up(v.odoText || '---'), peak: v.peakPsi >= 1 ? 'PEAK ' + Math.round(v.peakPsi) : '' },
        strip: { outside: T(v.outsideC) === '--' ? '--' : T(v.outsideC) + tu, mode: up(v.modeText) || 'DRIVE', intake: T(v.iatC) === '--' ? '--' : T(v.iatC) + tu },
    };
}

/**
 * Shift lights lit for an rpm: none below redline - 2000, then one more every 200 rpm,
 * all ten at redline - 200, and 11 (all flashing) from the redline.
 */
function shiftLevel(rpm, redline) {
    if (!(rpm > 0)) return 0;
    if (rpm >= redline) return 11;
    return Math.max(0, Math.min(10, Math.floor((rpm - (redline - 2000)) / 200) + 1));
}

/** Run fn on a later turn of the event loop, so the HMI's events get in between. */
const later = (fn) => setTimeout(fn, 0);

/** The pixels of rectangle q of a canvas, row by row. */
function crop(cv, q) { return cropMany(cv, [q]); }
function cropMany(cv, rects) {
    const out = Buffer.alloc(rects.reduce((t, q) => t + q.w * q.h * 4, 0));
    let off = 0;
    for (const q of rects) for (let y = q.y; y < q.y + q.h; y++) {
        Buffer.from(cv.d.buffer, cv.d.byteOffset + (y * cv.w + q.x) * 4, q.w * 4).copy(out, off);
        off += q.w * 4;
    }
    return out;
}
const round2 = (x) => Math.round(x * 100) / 100;

/** The tach's full scale: the redline plus at least 500 rpm, rounded up to 1000. */
function tachMax(redline) { return Math.max(6000, Math.ceil((redline + 500) / 1000) * 1000); }

/**
 * The rpm the engine may use at an oil temperature: 2500 below the redline when cold
 * (40 C or less), the full redline once warm (80 C), linear between; null without a value.
 */
function warmLimit(oilC, redline) {
    if (oilC == null || !isFinite(oilC)) return null;
    const t = clamp01((oilC - 40) / 40);
    return redline - 2500 * (1 - t);
}

const clamp01 = (x) => (!(x > 0) ? 0 : x > 1 ? 1 : x);     // NaN and -Infinity: 0
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

module.exports = { ClassicCluster, arcTexts, layout, tachMax, warmLimit, shiftLevel, TARGET, W, H, MAX_LAYERS };
