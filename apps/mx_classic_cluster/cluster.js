'use strict';
/**
 * cluster.js - puts the classic dials on the instrument cluster through cluster-render
 * (robertnisipeanu/idrive-apps, native/cluster-render): its `panel` target, the whole
 * 1920x720 cluster over the stock gauges.
 *
 * Layers (all image layers; nothing here uses a shader, a mesh or an animation):
 *   faces      the speedometer and tachometer, drawn once (and again only when a setting
 *              that changes them does)
 *   lcds       two small windows: digital speed and gear, redrawn only when their text changes
 *   segments   the warm-up segments in the tach, each its own tiny layer, shown while lit
 *   needles    two main and two small needles, drawn once and turned by the renderer
 *              (the layer's `rotate`), so moving a needle sends a few bytes of JSON
 *   hubs       the caps over the needles' pivots
 *   backdrop   a black panel over the whole stock cluster (a 16x16 image stretched by the renderer,
 *              so it costs 1 KB, not 5.5 MB) and a centre panel with the clock, range and odometer;
 *              BMW's warning and indicator lights are drawn above the panel by the cluster itself
 *
 * Values come in through update(values); a 30 Hz loop smooths the needles and sends a
 * rotation only when one moved by more than 0.1 degree.
 */
const F = require('./faces');
const { ClusterRender } = require('./cluster_render_client');

const TARGET = 'panel';
const W = 1920, H = 720;
const FPS = 30;
const MIN_STEP_DEG = 0.1;
const LCD_MIN_MS = 200;            // an LCD's text is redrawn at most 5 times a second

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
        this.segLit = [];
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
        this.state = { target: 'connecting', reason: '', layers: {}, budget: '' };
        this.refs = {}; this.faceKey = '';
        this.lcdText = { speed: null, gear: null };
        this.segLit = [];
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
            if (state === 'shown' && was !== 'shown' && !this.sweptOnce) { this.sweptOnce = true; this.startSweep(); }
            if (this.opts.onTarget) this.opts.onTarget(state, holder, reason);
        });
        cr.on('layer', (ref, state, reason) => {
            this.state.layers[ref] = state;
            if (state === 'error') this.log.warn('layer ' + ref + ' refused: ' + (reason || ''));
        });
        cr.on('budget', (cap, max) => { this.state.budget = cap + '/' + max + ' KB/s'; });
        cr.on('refused', (op, ref, reason) => this.log.warn('refused ' + op + ' ' + ref + ': ' + (reason || '')));
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
        const key = JSON.stringify([s.units, s.illum, s.redline, s.tempUnit, s.dx, s.dy, s.backdrop]);
        if (!this.cr || key === this.faceKey) return;
        const first = !this.faceKey;
        this.faceKey = key;
        const t0 = Date.now();
        const cr = this.cr, r = this.refs;
        const D = F.D, C = F.C;

        const speedo = F.speedoFace({ units: s.units, illum: s.illum });
        const tach = F.tachFace({ illum: s.illum, redline: s.redline, max: tachMax(s.redline), tempUnit: s.tempUnit });

        if (!first) Object.keys(r).forEach((k) => { if (Array.isArray(r[k])) r[k].forEach((x) => cr.drop(x)); else cr.drop(r[k]); });
        this.refs = {};
        const R = this.refs;
        // contend 0 (the default): wait for the slot to be free and never retry against BMW's
        // own content; the panel never takes a slot from the stock HMI either way
        // (cluster-render's panel_take_over_stock is 0)
        const img = (o) => cr.image(Object.assign({ target: TARGET, visible: true, contend: s.retake ? 1 : 0 }, o));

        if (s.backdrop === 'full') {
            const black = new F.Canvas(16, 16).clear('#000000');
            R.back = img({ klass: 'ambient', x: 0, y: 0, w: W, h: H, iw: 16, ih: 16 });
            cr.pixels(R.back, null, buf(black));
            R.center = img({ z: 1, x: Math.round(W / 2 - F.CENTER.w / 2), y: Math.round(H / 2 - F.CENTER.h / 2), w: F.CENTER.w, h: F.CENTER.h });
            this.centerText = null;
        }

        R.speedo = img({ z: 0, x: L.speedo.cx - C, y: L.speedo.cy - C, w: D, h: D });
        cr.pixels(R.speedo, null, buf(speedo));
        R.tach = img({ z: 0, x: L.tach.cx - C, y: L.tach.cy - C, w: D, h: D });
        cr.pixels(R.tach, null, buf(tach));

        // LCDs
        const lcdX = (cx) => cx - F.LCD.w / 2, lcdY = (cy) => cy - C + F.LCD.y;
        R.lcdSpeed = img({ z: 1, x: lcdX(L.speedo.cx), y: lcdY(L.speedo.cy), w: F.LCD.w, h: F.LCD.h });
        R.lcdGear = img({ z: 1, x: lcdX(L.tach.cx), y: lcdY(L.tach.cy), w: F.LCD.w, h: F.LCD.h });
        this.lcdText = { speed: null, gear: null };

        // warm-up segments: one per 250 rpm over the 2500 rpm below the redline
        R.segs = [];
        this.segRpm = [];
        const seg = F.segment(true);
        const max = tachMax(s.redline);
        for (let v = s.redline - 2500; v < s.redline; v += 250) {
            const a = F.angleOf(v + 125, 0, max);
            const [x, y] = F.pol(L.tach.cx, L.tach.cy, F.SEG.r, a);
            const ref = img({ z: 1, x: Math.round(x - F.SEG.w / 2), y: Math.round(y - F.SEG.h / 2), w: F.SEG.w, h: F.SEG.h,
                rotate: a, sampling: 'bilinear', visible: false });
            cr.pixels(ref, null, buf(seg));
            R.segs.push(ref);
            this.segRpm.push(v);
        }
        this.segLit = R.segs.map(() => false);

        // needles: main 270 px tip, 62 px tail; small ones 66 / 16
        const big = F.needle(270, 62, 15, true), small = F.needle(66, 16, 8, true);
        const hubBig = F.hub(36), hubSmall = F.hub(11);
        const place = (n, cx, cy, z) => {
            const ref = img({ z, x: Math.round(cx - n.px), y: Math.round(cy - n.py), w: n.w, h: n.h,
                px: n.px, py: n.py, rotate: F.A0, sampling: 'bilinear' });
            cr.pixels(ref, null, buf(n.cv));
            return ref;
        };
        const cap = (h, cx, cy, z) => {
            const ref = img({ z, x: Math.round(cx - h.w / 2), y: Math.round(cy - h.h / 2), w: h.w, h: h.h });
            cr.pixels(ref, null, buf(h.cv));
            return ref;
        };
        const subY = (cy) => cy - C + F.SUB.cy;
        R.fuel = place(small, L.speedo.cx, subY(L.speedo.cy), 2);
        R.oil = place(small, L.tach.cx, subY(L.tach.cy), 2);
        R.fuelHub = cap(hubSmall, L.speedo.cx, subY(L.speedo.cy), 3);
        R.oilHub = cap(hubSmall, L.tach.cx, subY(L.tach.cy), 3);
        R.speed = place(big, L.speedo.cx, L.speedo.cy, 4);
        R.rpm = place(big, L.tach.cx, L.tach.cy, 4);
        R.speedHub = cap(hubBig, L.speedo.cx, L.speedo.cy, 5);
        R.rpmHub = cap(hubBig, L.tach.cx, L.tach.cy, 5);

        Object.keys(this.needles).forEach((k) => { this.needles[k].sent = null; });
        this.log.info('faces drawn in ' + (Date.now() - t0) + ' ms');
    }

    /** The needle sweep: to full scale and back, about 1.6 s. */
    startSweep() {
        if (!this.getSettings().sweep) return;
        if (!this.enabled || (this.values.live && this.values.speed > 1)) return;     // never while moving
        this.sweep = { t0: Date.now() };
    }

    /**
     * values: { speed (mph or km/h, already in the dial's units), rpm, fuel (0..1 or null),
     *           oil (dial fraction 0..1 or null), oilC (deg C or null), speedText, gearText, live }
     */
    update(v) { Object.assign(this.values, v); }

    tick(dt, now) {
        if (!this.enabled || !this.cr || !this.refs.segs) return;
        const s = this.getSettings(), v = this.values, n = this.needles;
        const speedMax = s.units === 'kmh' ? 260 : 160, rpmMax = tachMax(s.redline);
        let fs = v.speed / speedMax, fr = v.rpm / rpmMax, ff = v.fuel, fo = v.oil;
        if (this.sweep) {
            const t = (now - this.sweep.t0) / 800;
            const p = t < 1 ? ease(t) : t < 2 ? 1 - ease(t - 1) : null;
            if (p === null) this.sweep = null;
            else { fs = fr = ff = fo = p; }
        }
        n.speed.t = clamp01(fs); n.rpm.t = clamp01(fr);
        n.fuel.t = ff == null ? 0 : clamp01(ff); n.oil.t = fo == null ? 0 : clamp01(fo);
        if (this.sweep) { Object.keys(n).forEach((k) => { n[k].v = n[k].t; }); }
        else Object.keys(n).forEach((k) => n[k].step(dt));

        const send = (k, ang) => {
            if (n[k].sent !== null && Math.abs(n[k].sent - ang) < MIN_STEP_DEG) return;
            n[k].sent = ang;
            this.cr.set(this.refs[k], { rotate: Math.round(ang * 100) / 100 });
        };
        send('speed', lerp(F.A0, F.A1, n.speed.v));
        send('rpm', lerp(F.A0, F.A1, n.rpm.v));
        send('fuel', F.subAngleOf(n.fuel.v));
        send('oil', F.subAngleOf(n.oil.v));

        // warm-up segments: lit from the rpm the engine may use now up to the redline
        const allowed = warmLimit(v.oilC, s.redline);
        this.refs.segs.forEach((ref, i) => {
            const lit = !this.sweep && allowed !== null && this.segRpm[i] + 250 > allowed;
            if (lit !== this.segLit[i]) { this.segLit[i] = lit; this.cr.set(ref, { visible: lit }); }
        });

        // LCDs
        const unit = s.units === 'kmh' ? 'km/h' : 'mph';
        this.lcd('speed', this.refs.lcdSpeed, this.sweep ? '888' : v.speedText, unit, now, s, false);
        this.lcd('gear', this.refs.lcdGear, this.sweep ? '88' : v.gearText, '', now, s, true);
        if (this.refs.center) {
            const d = new Date(), clock = (d.getHours() % 12 || 12) + ':' + ('0' + d.getMinutes()).slice(-2);
            const key = [clock, v.rangeText, v.odoText, s.illum].join('|');
            if (key !== this.centerText) {
                this.centerText = key;
                this.cr.pixels(this.refs.center, null, buf(F.centerInfo(clock, v.rangeText || '---', v.odoText || '---', { illum: s.illum })));
            }
        }
    }

    lcd(key, ref, text, unit, now, s, center) {
        text = text == null ? '' : String(text);
        if (text === this.lcdText[key] || now - this.lcdAt[key] < LCD_MIN_MS) return;
        this.lcdText[key] = text; this.lcdAt[key] = now;
        this.cr.pixels(ref, null, buf(F.lcd(text, unit, { illum: s.illum, center })));
    }

    status() {
        const shown = Object.keys(this.state.layers).filter((k) => this.state.layers[k] === 'shown').length;
        return { target: this.state.target, reason: this.state.reason, shown, budget: this.state.budget, backend: this.cr ? this.cr.backend : '' };
    }
}

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

module.exports = { ClassicCluster, layout, tachMax, warmLimit, TARGET, W, H };
