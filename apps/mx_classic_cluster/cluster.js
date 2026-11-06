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
 */
const F = require('./faces');
const FX = require('./fx');
const { ClusterRender } = require('./cluster_render_client');

const TARGET = 'panel';
const W = 1920, H = 720;
const FPS = 30;
const MIN_STEP_DEG = 0.1;
const LCD_MIN_MS = 200;            // an LCD's text is redrawn at most 5 times a second
const REDRAW_FPS = 6;              // redrawn mode: dial updates a second at most (each costs CPU)
const MAX_LAYERS = 8;              // cluster-render's per-client limit

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
        this.needles = { speed: new Needle(70), rpm: new Needle(45), fuel: new Needle(1500), oil: new Needle(1500) };
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
        this.refs = {}; this.faceKey = '';
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
        this.refs = {}; this.faceKey = '';
        this.sweep = null;
        this.state = { target: 'off', reason: '', layers: {}, budget: '' };
    }

    /** (Re)draw everything a setting changes. Layers keep their refs where they can. */
    build() {
        const s = this.getSettings();
        const L = layout(s.dx, s.dy);
        const key = JSON.stringify([s.shift, s.style, s.units, s.illum, s.redline, s.tempUnit, s.dx, s.dy, s.backdrop, s.needles, s.retake]);
        if (!this.cr || key === this.faceKey) return;
        const first = !this.faceKey;
        this.faceKey = key;
        const t0 = Date.now();
        const cr = this.cr, r = this.refs;
        const D = F.D, C = F.C;

        const centre = s.backdrop === 'full';
        const max = tachMax(s.redline);
        const faceOpts = { style: s.style, units: s.units, illum: s.illum, redline: s.redline, max, tempUnit: s.tempUnit };
        const speedo = F.speedoFace(Object.assign({ well: !centre }, faceOpts));
        const tach = F.tachFace(faceOpts);

        if (!first) Object.keys(r).forEach((k) => cr.drop(r[k]));
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

        this.mode = s.needles === 'redraw' ? 'redraw' : 'shader';
        this.dials = {};
        const dial = (key, face, kind, cx, cy) => {
            const ref = img({ z: 0, x: cx - C, y: cy - C, w: D, h: D });
            const spec = F.dialFx(s.style, kind, faceOpts);
            if (!s.shift) spec.lights = null;
            const d = { ref, spec, face, st: null, at: 0, flash: null };
            R[key] = ref;
            if (this.mode === 'shader') {
                cr.pixels(ref, null, buf(face));
                d.fx = cr.effect(Object.assign({}, base, { z: 2, x: cx - C, y: cy - C, w: D, h: D, fs: FX.shader(spec), time: true }));
                cr.uniform(d.fx, 'u_v', [F.A0, F.SUB.a0, 0, 0]);
                R[key + 'Fx'] = d.fx;
            } else {
                d.live = new F.Canvas(D, D);
                d.live.d.set(face.d);
                this.redrawDial(d, { a: F.A0, b: F.SUB.a0, lv: 0, t: 0 }, Date.now(), true);
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
     *           oil (dial fraction 0..1 or null), oilC (deg C or null), speedText, gearText, live }
     */
    update(v) { Object.assign(this.values, v); }

    tick(dt, now) {
        if (!this.enabled || !this.cr || !this.dials || !this.dials.tach) return;
        const s = this.getSettings(), v = this.values, n = this.needles;
        const speedMax = s.units === 'kmh' ? 260 : 160, rpmMax = tachMax(s.redline);
        let fs = v.speed / speedMax, fr = v.rpm / rpmMax, ff = v.fuel, fo = v.oil, rpm = v.rpm;
        if (this.sweep) {
            const t = (now - this.sweep.t0) / 800;
            const p = t < 1 ? ease(t) : t < 2 ? 1 - ease(t - 1) : null;
            if (p === null) this.sweep = null;
            else { fs = fr = ff = fo = p; rpm = p * rpmMax; }
        }
        n.speed.t = clamp01(fs); n.rpm.t = clamp01(fr);
        n.fuel.t = ff == null ? 0 : clamp01(ff); n.oil.t = fo == null ? 0 : clamp01(fo);
        if (this.sweep) { Object.keys(n).forEach((k) => { n[k].v = n[k].t; }); }
        else Object.keys(n).forEach((k) => n[k].step(dt));

        const lv = shiftLevel(rpm, s.redline);
        this.dialState('speedo', { a: lerp(F.A0, F.A1, n.speed.v), b: F.subAngleOf(n.fuel.v), lv: 0 }, now);
        this.dialState('tach', { a: lerp(F.A0, F.A1, n.rpm.v), b: F.subAngleOf(n.oil.v), lv }, now);

        // LCDs
        const unit = s.units === 'kmh' ? 'km/h' : 'mph';
        if (this.refs.lcdSpeed) this.lcd('speed', this.refs.lcdSpeed, this.sweep ? '888' : v.speedText, unit, now, s, false);
        this.lcd('gear', this.refs.lcdGear, this.sweep ? '88' : v.gearText, '', now, s, true);
        if (this.refs.center) {
            const key = [v.rangeText, v.odoText, v.modeText, s.illum, s.style, unit].join('|');
            const sp = this.sweep ? '888' : (v.speedText == null ? '' : String(v.speedText));
            const all = key !== this.centerKey;
            if (all || (sp !== this.centerSpeed && now - this.centerAt >= LCD_MIN_MS)) {
                const cv = F.centerInfo(v.rangeText || '---', v.odoText || '---', { illum: s.illum, style: s.style, mode: v.modeText || '', speed: sp, unit });
                if (all) this.cr.pixels(this.refs.center, null, buf(cv));
                else this.cr.pixels(this.refs.center, [F.CSPEED], crop(cv, F.CSPEED));
                this.centerKey = key; this.centerSpeed = sp; this.centerAt = now;
            }
        }
    }

    /** A dial's moving parts to a new state: a uniform (shader), or changed rectangles (redrawn). */
    dialState(key, st, now) {
        const d = this.dials[key];
        if (!d) return;
        const o = d.st;
        const moved = !o || Math.abs(o.a - st.a) >= MIN_STEP_DEG || Math.abs(o.b - st.b) >= MIN_STEP_DEG || o.lv !== st.lv;
        if (this.mode === 'shader') {
            if (!moved) return;
            d.st = st; this.sends++;
            this.cr.uniform(d.fx, 'u_v', [round2(st.a), round2(st.b), st.lv, 0]);
            return;
        }
        st.t = now / 1000;
        const L = d.spec.lights;
        const phase = L && st.lv > L.n ? Math.floor(st.t * FX.FLASH_HZ * 2) : null;
        const flashChanged = phase !== d.flash;
        if (!moved && !flashChanged) return;
        if (now - d.at < 1000 / REDRAW_FPS) return;
        if (o && !flashChanged && o.lv === st.lv && Math.abs(o.a - st.a) < 0.3 && Math.abs(o.b - st.b) < 0.3) return;
        d.flash = phase;
        this.redrawDial(d, st, now, false, flashChanged);
    }

    /** Redrawn mode: recomposite face + moving parts in the changed rectangles and send those. */
    redrawDial(d, st, now, whole, flashChanged) {
        const rects = whole ? [{ x: 0, y: 0, w: d.spec.w, h: d.spec.h }] : FX.dirty(d.spec, d.st, st, flashChanged);
        const face = d.face.d, live = d.live.d, Wd = d.spec.w;
        for (const q of rects) {
            for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) {
                const i = (y * Wd + x) * 4;
                const fx = FX.shade(d.spec, x + 0.5, y + 0.5, st);
                const fa = fx[3] / 255, ba = face[i + 3] / 255, oa = fa + ba * (1 - fa);
                if (oa <= 0) { live[i] = live[i + 1] = live[i + 2] = live[i + 3] = 0; continue; }
                for (let c = 0; c < 3; c++) live[i + c] = Math.round((fx[c] * fa + face[i + c] * ba * (1 - fa)) / oa);
                live[i + 3] = Math.round(oa * 255);
            }
        }
        d.st = st; d.at = now; this.sends++;
        if (whole) this.cr.pixels(d.ref, null, buf(d.live));
        else if (rects.length) this.cr.pixels(d.ref, rects, cropMany(d.live, rects));
    }

    lcd(key, ref, text, unit, now, s, center) {
        text = text == null ? '' : String(text);
        if (text === this.lcdText[key] || now - (this.lcdAt[key] || 0) < LCD_MIN_MS) return;
        this.lcdText[key] = text; this.lcdAt[key] = now;
        this.cr.pixels(ref, null, buf(F.lcd(text, unit, { illum: s.illum, center, style: s.style })));
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
 * Shift lights lit for an rpm: none below redline - 2000, then one more every 200 rpm,
 * all ten at redline - 200, and 11 (all flashing) from the redline.
 */
function shiftLevel(rpm, redline) {
    if (!(rpm > 0)) return 0;
    if (rpm >= redline) return 11;
    return Math.max(0, Math.min(10, Math.floor((rpm - (redline - 2000)) / 200) + 1));
}

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

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

module.exports = { ClassicCluster, layout, tachMax, warmLimit, shiftLevel, TARGET, W, H, MAX_LAYERS };
