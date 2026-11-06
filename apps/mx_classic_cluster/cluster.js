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
const LCD_MIN_MS = 200;
const REDRAW_FPS = 8;             // redraw mode: needle updates a second at most
const REDRAW_PIECES = 8;           // and pieces per needle (old and new: at most 16 rectangles)            // an LCD's text is redrawn at most 5 times a second

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
        this.state = { target: 'connecting', reason: '', layers: {}, why: {}, budget: '' };
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
        const key = JSON.stringify([s.units, s.illum, s.redline, s.tempUnit, s.dx, s.dy, s.backdrop, s.needles, s.retake]);
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
        // (each drawn already turned, so no layer here is turned by the renderer)
        R.segs = [];
        this.segRpm = [];
        const max = tachMax(s.redline);
        for (let v = s.redline - 2500; v < s.redline; v += 250) {
            const a = F.angleOf(v + 125, 0, max);
            const [x, y] = F.pol(L.tach.cx, L.tach.cy, F.SEG.r, a);
            const ref = img({ z: 1, x: Math.round(x - F.SEG.box / 2), y: Math.round(y - F.SEG.box / 2), w: F.SEG.box, h: F.SEG.box,
                visible: false });
            cr.pixels(ref, null, buf(F.segment(a)));
            R.segs.push(ref);
            this.segRpm.push(v);
        }
        this.segLit = R.segs.map(() => false);

        // needles: main 270 px tip, 62 px tail; small ones 66 / 16
        const big = Object.assign(F.needle(270, 62, 15, true), { len: 270, tail: 62, wid: 15 });
        const small = Object.assign(F.needle(66, 16, 8, true), { len: 66, tail: 16, wid: 8 });
        const hubBig = F.hub(36), hubSmall = F.hub(11);
        // Two ways to draw a needle (setting "Needles"):
        //   shader  an unturned quad over the needle's sweep; a fragment shader draws the needle at
        //           the angle in the uniform u_a. Moving it sends a uniform.
        //   image   a needle image turned by the renderer about its pivot (the layer's rotate).
        this.mode = ['image', 'sharp', 'redraw'].indexOf(s.needles) >= 0 ? s.needles : 'shader';
        this.redraw = {};
        const place = (n, cx, cy, z) => {
            if (this.mode === 'shader') {
                const reach = Math.ceil(Math.max(n.len, n.tail) + 10);
                const box = Math.min(2 * reach, D);
                const x = Math.max(0, Math.round(cx - box / 2)), y = Math.max(0, Math.round(cy - box / 2));
                const w = Math.min(box, W - x), h = Math.min(box, H - y);
                const sp = { w, h, px: cx - x, py: cy - y, len: n.len, tail: n.tail, wid: n.wid };
                const ref = cr.effect({ target: TARGET, z, x, y, w, h, fs: F.needleShader(sp), contend: s.retake ? 1 : 0 });
                cr.uniform(ref, 'u_a', [F.A0]);
                return ref;
            }
            if (this.mode === 'redraw') {
                // an unturned image over the needle's sweep, the needle drawn into it here and only the
                // pieces that changed sent (the kind of layer the dials themselves are)
                const reach = Math.ceil(Math.max(n.len, n.tail) + 14);
                const box = Math.min(2 * reach, D);
                const x = Math.max(0, Math.round(cx - box / 2)), y = Math.max(0, Math.round(cy - box / 2));
                const w = Math.min(box, W - x), h = Math.min(box, H - y);
                const cv = new F.Canvas(w, h);
                const r = { cv, px: cx - x, py: cy - y, n, ang: F.A0, at: 0 };
                F.drawNeedleAt(cv, r.px, r.py, F.A0, n.len, n.tail, n.wid, REDRAW_PIECES);
                const ref = img({ z, x, y, w, h });
                cr.pixels(ref, null, buf(cv));
                this.redraw[ref] = r;
                return ref;
            }
            const ref = img({ z, x: Math.round(cx - n.px), y: Math.round(cy - n.py), w: n.w, h: n.h,
                px: n.px, py: n.py, rotate: F.A0, sampling: this.mode === 'sharp' ? 'nearest' : 'bilinear' });
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

        // which group each layer is in, for the app's diagnostics
        this.groups = {};
        const g = (name, refs) => refs.forEach((ref) => { if (ref) this.groups[ref] = name; });
        g('background', [R.back]); g('centre', [R.center]); g('dials', [R.speedo, R.tach]);
        g('lcds', [R.lcdSpeed, R.lcdGear]); g('segments', R.segs);
        g('needles', [R.speed, R.rpm, R.fuel, R.oil]); g('hubs', [R.fuelHub, R.oilHub, R.speedHub, R.rpmHub]);
        this.state.layers = {}; this.state.why = {};
        this.sends = 0;

        Object.keys(this.needles).forEach((k) => { this.needles[k].sent = null; });
        this.log.info('faces drawn in ' + (Date.now() - t0) + ' ms');
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
        if (this.mode === 'redraw') return 'not with redrawn needles (too much data)';
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
            if (this.mode === 'redraw') {
                const r = this.redraw[this.refs[k]];
                if (!r || (now - r.at < 1000 / REDRAW_FPS) || Math.abs(r.ang - ang) < 0.3) return;
                n[k].sent = ang; this.sends++;
                this.redrawNeedle(this.refs[k], r, ang, now);
                return;
            }
            n[k].sent = ang;
            this.sends++;
            const deg = Math.round(ang * 100) / 100;
            if (this.mode === 'shader') this.cr.uniform(this.refs[k], 'u_a', [deg]);
            else this.cr.set(this.refs[k], { rotate: deg });
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

    /** Redraw mode: clear where the needle was, draw it where it is, send only those pieces. */
    redrawNeedle(ref, r, ang, now) {
        const n = r.n, cv = r.cv, d = cv.d;
        const clip = (q) => {
            const x0 = Math.max(0, q.x), y0 = Math.max(0, q.y), x1 = Math.min(cv.w, q.x + q.w), y1 = Math.min(cv.h, q.y + q.h);
            return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
        };
        const old = F.needleRects(r.px, r.py, r.ang, n.len, n.tail, n.wid, REDRAW_PIECES);
        const now2 = F.needleRects(r.px, r.py, ang, n.len, n.tail, n.wid, REDRAW_PIECES);
        // one rectangle per piece where the old and the new piece overlap enough, else both
        let rects = [];
        old.forEach((a, i) => {
            const b = now2[i], u = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
            u.w = Math.max(a.x + a.w, b.x + b.w) - u.x; u.h = Math.max(a.y + a.h, b.y + b.h) - u.y;
            if (u.w * u.h <= 1.5 * (a.w * a.h + b.w * b.h)) rects.push(u); else rects.push(a, b);
        });
        rects = rects.map(clip).filter(Boolean);
        rects.forEach((q) => { for (let y = q.y; y < q.y + q.h; y++) d.fill(0, (y * cv.w + q.x) * 4, (y * cv.w + q.x + q.w) * 4); });
        F.drawNeedleAt(cv, r.px, r.py, ang, n.len, n.tail, n.wid, REDRAW_PIECES);
        r.ang = ang; r.at = now;
        const bytes = rects.reduce((t, q) => t + q.w * q.h * 4, 0);
        if (rects.length > 16) { this.cr.pixels(ref, null, buf(cv)); return; }
        const out = Buffer.alloc(bytes);
        let off = 0;
        rects.forEach((q) => { for (let y = q.y; y < q.y + q.h; y++) { Buffer.from(d.buffer, d.byteOffset + (y * cv.w + q.x) * 4, q.w * 4).copy(out, off); off += q.w * 4; } });
        this.cr.pixels(ref, rects, out);
    }

    lcd(key, ref, text, unit, now, s, center) {
        text = text == null ? '' : String(text);
        if (text === this.lcdText[key] || now - this.lcdAt[key] < LCD_MIN_MS) return;
        this.lcdText[key] = text; this.lcdAt[key] = now;
        this.cr.pixels(ref, null, buf(F.lcd(text, unit, { illum: s.illum, center })));
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
            groups, mode: this.mode, sends: this.sends || 0, sweeping: !!this.sweep,
            refused: st.refused || 0, lastRefused: st.lastRefused || '' };
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
