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
 *
 * 0.13.0: the arc style "pre-loaded" (preload.js, the default) uses cluster-render 0.4.2's 64 layers a
 * client and its assets: about 45 still layers sent once, then moved by the renderer only. On an
 * older cluster-render it falls back to the rotating layer by itself (preloadFailed).
 */
const F = require('./faces');
const FX = require('./fx');
const A = require('./arc');
const PL = require('./preload');
let rgba;
try { ({ rgba } = require('./kit/canvas')); } catch (e) { ({ rgba } = require('../../kit/runtime/canvas')); }
const { ClusterRender } = require('./cluster_render_client');

const TARGET = 'panel';
const W = 1920, H = 720;
const FPS = 30;
const MIN_STEP_DEG = 0.1;
const LCD_MIN_MS = 200;            // an LCD's text is redrawn at most 5 times a second
const REDRAW_FPS = 5;              // redrawn mode: dial updates a second at most (each costs CPU)
/* Smooth motion: the needle's turn (rotating layer) and the shader's u_v are sent as renderer
 * animations - from where it is to where it is going over ANIM_MS - and the renderer plays them on
 * the cluster's own clock, every frame. Before 0.12.0 each step was a set / uniform in the renderer's
 * next flush, and a flush waits for that tick's pixel uploads: the needle moved in jerks. */
const ANIM_MS = 100;
const ROTATE_FPS = 15;             // rotating mode (arc): the lit arc / lights / numerals redrawn up to this often; tiny rectangles
const ROTATE_MIN_DEG = 0.1;        // and the needle layer turned for a move of at least this
const REDRAW_MIN_DEG = 0.5;        // and none for a smaller move
const MAX_LAYERS = 8;              // cluster-render's per-client limit before 0.4.2
const MAX_LAYERS_PRE = 64;         // and from 0.4.2 (the pre-loaded mode needs it)
const SCALE_MIN = 0.003;           // pre-loaded: a numeral's scale animated for a change of at least this
/* the needle sweep: slow enough that the redrawn mode's 5 pictures a second show it (0.11.2 and
 * before: 0.8 s up, 0.8 s down, 8 pictures in all, and the one at start lost in the first upload) */
const SWEEP_UP_MS = 1100, SWEEP_HOLD_MS = 300, SWEEP_DELAY_MS = 2500;
/* arc style: how often each slow value shown is refreshed (ms); a value that was missing shows at once */
const SLOW_MS = { oilC: 3000, coolC: 3000, iatC: 2000, outsideC: 120000 };
const PANEL_MS = 250;
const PEAK_MAX_PSI = 35;           // arc style: a boost above this is a bad sample, never a peak
const PEAK_SHOW_MS = 2000;         // and the one shown changes at most this often
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
        this.refs = {}; this.faceKey = ''; this.dials = null; this.assetRefs = null;
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
            // the sweep at start waits SWEEP_DELAY_MS after the panel shows: the first pictures (about
            // 6 MB) are still being uploaded then, and the renderer drops frames it has no budget for,
            // so a sweep started at once was never seen
            if (state === 'shown' && was !== 'shown' && !this.sweptOnce) {
                this.sweptOnce = true;
                setTimeout(() => { if (this.cr === cr && this.state.target === 'shown') this.startSweep(true); }, SWEEP_DELAY_MS);
            }
            if (this.opts.onTarget) this.opts.onTarget(state, holder, reason);
        });
        cr.on('layer', (ref, state, reason) => {
            this.state.layers[ref] = state;
            this.state.why[ref] = reason || '';
            if (state === 'error') { this.log.warn('layer ' + ref + ' refused: ' + (reason || '')); this.preloadFailed(cr, 'layer refused: ' + (reason || '')); }
        });
        cr.on('budget', (cap, max) => { this.state.budget = cap + '/' + max + ' KB/s'; });
        cr.on('refused', (op, ref, reason) => {
            this.state.refused = (this.state.refused || 0) + 1;
            this.state.lastRefused = op + ' ' + ((this.groups && this.groups[ref]) || ref) + ': ' + (reason || '');
            this.log.warn('refused ' + op + ' ' + ref + ': ' + (reason || ''));
            // only what the pre-loaded mode can't do without (an older cluster-render) turns it off; a
            // stray message refused (a set to a layer being rebuilt, say) does not
            if (['layer', 'asset', 'bind'].includes(op) || /too many|unknown op|not supported/.test(reason || '')) this.preloadFailed(cr, op + ' refused: ' + (reason || ''));
        });
        this.build();
        cr.connect();
    }

    /**
     * The pre-loaded mode needs cluster-render 0.4.2+ (64 layers a client, assets): on an older one,
     * or anything of it refused, the cluster goes back to the rotating mode for as long as the app
     * runs, and says why on its screen.
     */
    preloadFailed(cr, why) {
        if (this.cr !== cr || this.mode !== 'preload' || this.preloadOff) return;
        this.preloadOff = why;
        this.log.warn('pre-loaded mode off (' + why + '): using the rotating layer');
        later(() => { if (this.cr === cr) { this.faceKey = ''; this.build(); } });
    }

    _disconnect() {
        if (this.cr) this.cr.close();
        this.cr = null;
        this.refs = {}; this.faceKey = ''; this.dials = null; this.assetRefs = null;
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
        const key = JSON.stringify([s.shift, s.style, s.arcBg, s.notch, s.units, s.redline, s.tempUnit, s.dx, s.dy, s.backdrop, s.needles, s.retake, !!this.preloadOff]);
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
                    const bk = A.BACKGROUNDS[s.arcBg] ? s.arcBg : 'grid';
                    if (!art.bg || art.bgKind !== bk) { art.bg = A.background(bk); art.bgKind = bk; }
                    // the pre-loaded art, each part on a turn of its own (tens of ms each here, more on the head unit)
                    const pre = s.needles === 'preload' && !this.preloadOff;
                    later(() => {
                        if (!live()) return;
                        if (pre) this.preArt(art, o, s);
                        later(() => {
                            if (!live()) return;
                            if (pre) this.preAtlases(art);
                            later(() => { if (live()) this._arcLayers(s, o, art, t0); });
                        });
                    });
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
        const cr = this.cr, L = A.arcLayout(s.dy, s.notch);
        Object.keys(this.refs).forEach((k) => cr.drop(this.refs[k]));
        // the glyph atlases never change: kept for a pre-loaded rebuild on this connection, dropped otherwise
        const willPreload = s.needles === 'preload' && !this.preloadOff;
        if (!willPreload) this.dropAssets();
        const R = this.refs = {};
        const base = { target: TARGET, visible: true, contend: s.retake ? 1 : 0 };
        const img = (q) => cr.image(Object.assign({}, base, q));
        this.arc = true;
        // the stock cluster is always hidden in this style: the readouts cover the whole panel. The
        // background is the horizon grid, drawn at half size and stretched (bilinear) by the renderer
        R.back = img({ klass: 'ambient', x: 0, y: 0, w: W, h: H, iw: A.BG_W, ih: A.BG_H, sampling: 'bilinear' });
        cr.pixels(R.back, null, buf(art.bg));

        this.mode = s.needles === 'shader' ? 'shader' : s.needles === 'redraw' ? 'redraw' : s.needles === 'preload' && !this.preloadOff ? 'preload' : 'rotate';
        if (this.mode === 'preload') return this._preLayers(s, o, art, t0, L, base, img, R);
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
            d.fx = cr.effect(Object.assign({}, base, { z: 2, fs: FX.shader(spec), x: L.dial.x, y: L.dial.y, w: L.dial.w, h: L.dial.h }));
            cr.uniform(d.fx, 'u_v', [F.A0, F.SUB.a0, 0, F.SUB.a0]);
            R.dialFx = d.fx;
        } else {
            if (this.mode === 'rotate') {
                const n = A.needleSprite(o);
                const k = L.scale;           // the needle at the dial's size, turning about the dial's pivot
                d.needle = img({ z: 2, x: Math.round(L.cx - n.px * k), y: Math.round(L.cy - n.py * k), w: Math.round(n.w * k), h: Math.round(n.h * k),
                    iw: n.w, ih: n.h, px: n.px * k, py: n.py * k, rotate: F.A0, sampling: 'bilinear' });
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
            this.panels[k] = { ref: R[k], p: new A.Panel(L[k].iw || L[k].w, L[k].ih || L[k].h) };
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

    /** The pre-loaded dial art (preload.js) for these settings, cached with the arc art. */
    preArt(art, o, s) {
        if (art.pre && art.preShift === !!s.shift) return;
        const spec = A.arcFx(o);
        if (!s.shift) spec.lights = null;
        art.pre = PL.dialArt(art.base, art.nums, spec); art.preShift = !!s.shift;
        if (!art.basePad) { art.basePad = new F.Canvas(PL.SNAP * Math.ceil(A.DW / PL.SNAP), A.DH).clear([0, 0, 0, 0]); art.basePad.blit(art.base, 0, 0); }
    }
    /** The readouts' glyph atlases (the same for every setting). */
    preAtlases(art) {
        if (art.atlases) return;
        art.atlases = { figs96: PL.atlas('tabular', 96, A.ROW.v1.h, A.ROW.b1 - A.ROW.v1.y), figs64: PL.atlas('tabular', 64, A.CENTRE_SPEED.h, 247 - A.CENTRE_SPEED.y),
            gear: PL.atlas('gear', 118, A.CENTRE_GEAR.h, 160 - A.CENTRE_GEAR.y) };
    }

    /**
     * The arc style pre-loaded (preload.js): every picture sent once; the dial and readouts then move
     * only by the renderer (turns, scales, shows and hides, uniforms). About 45 layers and 3 assets.
     */
    _preLayers(s, o, art, t0, L, base, img, R) {
        const cr = this.cr, k = L.scale;
        const spec = A.arcFx(o);
        if (!s.shift) spec.lights = null;
        this.preArt(art, o, s); this.preAtlases(art);              // drawn already (build), unless called directly
        const pre = art.pre;
        // a sub-picture of the dial, at the dial's scale and place (dial pixels q: multiples of 25,
        // so at the notch scale they land on whole panel pixels, exactly over the face)
        const sub = (q, z, more) => img(Object.assign({ z, x: L.dial.x + Math.round(q.x * k), y: L.dial.y + Math.round(q.y * k), w: Math.round(q.w * k), h: Math.round(q.h * k) },
            k !== 1 ? { iw: q.w, ih: q.h, sampling: 'bilinear' } : {}, more || {}));
        const pivot = (q) => ({ px: (A.DCX - q.x) * k, py: (A.DCY - q.y) * k });

        // the face without numerals, padded to a width of whole 25s (725) so that at the notch scale
        // its rectangle is exact (754, not 748.8 rounded) and every layer over it lines up to the pixel
        const dial = Object.assign({}, L.dial, { w: Math.round(art.basePad.w * k), h: Math.round(art.basePad.h * k) }, k !== 1 ? { iw: art.basePad.w, ih: art.basePad.h, sampling: 'bilinear' } : {});
        const d = { ref: img(Object.assign({ z: 0 }, dial)), spec, pre: true, pending: false, needleAt: F.A0, rpmSeq: null, needleAnimAt: 0, lv: -1 };
        cr.pixels(d.ref, null, buf(art.basePad));
        R.dial = d.ref;
        d.pieces = pre.pieces.map((p, i) => {
            const lit = sub(p.lit.q, 1 + 2 * i), cov = sub(p.cover.q, 2 + 2 * i, Object.assign({ sampling: 'bilinear', rotate: 0 }, pivot(p.cover.q)));
            cr.pixels(lit, null, buf(p.lit.cv)); cr.pixels(cov, null, buf(p.cover.cv));
            R['lit' + i] = lit; R['cover' + i] = cov;
            return { lit, cov, turn: 0 };
        });
        d.mask = R.mask = sub(pre.mask.q, 20);
        cr.pixels(d.mask, null, buf(pre.mask.cv));
        d.lights = pre.lights.map((l, i) => { const ref = R['light' + i] = sub(l.q, 21, { visible: false }); cr.pixels(ref, null, buf(l.cv)); return { ref, on: false }; });
        if (pre.flash) { d.flash = { ref: R.flash = sub(pre.flash.q, 22, { visible: false }), on: false }; cr.pixels(d.flash.ref, null, buf(pre.flash.cv)); }
        d.nums = pre.numerals.map((n, i) => {
            const sc = PL.numeralScale(0, n.n);
            const ref = R['num' + i] = img({ z: 23, x: L.dial.x + Math.round(n.box.x * k), y: L.dial.y + Math.round(n.box.y * k), w: Math.round(n.box.w * k), h: Math.round(n.box.h * k),
                iw: n.box.w, ih: n.box.h, sampling: 'bilinear', sx: sc, sy: sc });
            cr.pixels(ref, null, buf(n.cv));
            return { ref, n: n.n, s: sc };
        });
        // the needle turning about the dial's own pivot as placed (not the panel's middle: they differ by
        // the dial rectangle's rounding)
        const nd = A.needleSprite(o), pvx = L.dial.x + A.DCX * k, pvy = L.dial.y + A.DCY * k;
        const nx = Math.floor(pvx - nd.px * k), ny = Math.floor(pvy - nd.py * k);
        d.needle = R.needle = img({ z: 30, x: nx, y: ny, w: Math.round(nd.w * k), h: Math.round(nd.h * k),
            iw: nd.w, ih: nd.h, px: Math.round((pvx - nx) * 100) / 100, py: Math.round((pvy - ny) * 100) / 100, rotate: F.A0, sampling: 'bilinear' });
        cr.pixels(d.needle, null, buf(nd.cv));
        this.dials = { tach: d };

        // readouts: the panels as before, but the changing figures drawn by effect layers from glyph atlases
        const assets = this.assetRefs || {};
        Object.keys(art.atlases).forEach((key) => {
            if (assets[key]) return;
            const at = art.atlases[key];
            assets[key] = cr.asset({ target: TARGET, format: 'rgba8', w: at.cv.w, h: at.cv.h, sampling: 'bilinear' });
            cr.pixels(assets[key], null, buf(at.cv));
        });
        this.assetRefs = assets;
        const FIELDS = { left: { oil: ['figs96', A.ROW.v1], cool: ['figs96', A.ROW.v2] }, right: { boost: ['figs96', A.ROW.v1], torque: ['figs96', A.ROW.v2] },
            centre: { gear: ['gear', A.CENTRE_GEAR], speed: ['figs64', A.CENTRE_SPEED] }, strip: {} };
        this.panels = {};
        for (const key of ['centre', 'left', 'right', 'strip']) {
            const Lk = L[key], z = key === 'centre' ? 31 : 1, kk = Lk.iw ? Lk.w / Lk.iw : 1;
            R[key] = img(Object.assign({ z }, Lk));
            const p = new A.Panel(Lk.iw || Lk.w, Lk.ih || Lk.h);
            p.gpu = {};
            Object.keys(FIELDS[key]).forEach((f) => {
                const [akey, q] = FIELDS[key][f], at = art.atlases[akey];
                const ref = R[key + '_' + f] = cr.effect(Object.assign({}, base, { z: z + 1, x: Lk.x + Math.round(q.x * kk), y: Lk.y + Math.round(q.y * kk), w: Math.round(q.w * kk), h: Math.round(q.h * kk),
                    fs: PL.readoutShader(q.w, q.h, at) }));
                cr.bind(ref, 'u_font', assets[akey]);
                cr.uniform(ref, 'u_g', [-1, -1, -1, -1]);
                cr.uniform(ref, 'u_x', [-10000, -10000, -10000, -10000]);
                cr.uniform(ref, 'u_col', [1, 1, 1, 1]);
                p.gpu[f] = { ref, at, text: '', col: A.WHITE, cx: 0, unitW: 0, sent: '' };
            });
            this.panels[key] = { ref: R[key], p };
        }
        this.panelAt = 0; this.slow = null;

        const count = Object.keys(R).length;
        if (count > MAX_LAYERS_PRE) this.log.warn(count + ' layers asked for, more than cluster-render allows one app (' + MAX_LAYERS_PRE + ')');
        this.groups = {};
        const g = (name, refs) => refs.forEach((ref) => { if (ref) this.groups[ref] = name; });
        g('background', [R.back]); g('dials', [R.dial, R.mask]);
        g('moving', Object.keys(R).filter((x) => /^(lit|cover|light|num)\d|^needle$|^flash$/.test(x)).map((x) => R[x]));
        g('readouts', Object.keys(R).filter((x) => /^(centre|left|right|strip)/.test(x)).map((x) => R[x]));
        this.state.layers = {}; this.state.why = {};
        this.sends = 0;
        this.layerCount = count;
        Object.keys(this.needles).forEach((x) => { this.needles[x].sent = null; });
        this.log.info(count + ' layers (arc, pre-loaded), drawn in ' + (Date.now() - t0) + ' ms');
    }

    _layers(s, faceOpts, speedo, tach, t0) {
        this.arc = false; this.panels = null;
        const L = layout(s.dx, s.dy);
        const cr = this.cr, r = this.refs;
        const D = F.D, C = F.C;
        const centre = s.backdrop === 'full';

        Object.keys(r).forEach((k) => cr.drop(r[k]));
        this.dropAssets();
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
     * The needle sweep: up to full scale (SWEEP_UP_MS), a moment there, and back: about 2.5 s. auto: the one at start, which the
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
            const t = now - this.sweep.t0, U = SWEEP_UP_MS, Hd = SWEEP_HOLD_MS;
            const p = t < U ? ease(t / U) : t < U + Hd ? 1 : t < 2 * U + Hd ? 1 - ease((t - U - Hd) / U) : null;
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
        if (d && d.pre) this._preDial(s, v, d, a, lv, now);
        else if (d && !d.pending) {
            const st = { a, b: F.SUB.a0, c: F.SUB.a0, lv };
            const lv2 = A.numeralLevels(rpm, d.nums.length);
            const changed = [];
            lv2.forEach((k, i) => { if (k !== d.levels[i]) changed.push(i); });
            // rotating mode: the needle layer glides (a renderer animation). With live data, once per new
            // rpm from the car, from the last one to this one over the time the car takes between rpms
            // (so it moves all the time, a sample behind); else (sweep, demo) every ANIM_MS
            if (d.needle) {
                if (!this.sweep && v.rpmSeq != null) {
                    if (v.rpmSeq !== d.rpmSeq) {
                        d.rpmSeq = v.rpmSeq;
                        const to = lerp(F.A0, F.A1, clamp01((v.rpm || 0) / (d.spec.max || 8000)));
                        const ms = Math.max(50, Math.min(400, Math.round(v.rpmEvery || ANIM_MS)));
                        if (Math.abs(to - d.needleAt) >= ROTATE_MIN_DEG) { this.glide(d.needle, 'rotate', [round2(d.needleAt)], [round2(to)], null, ms); d.needleAt = to; this.sends++; }
                    }
                } else if (Math.abs(a - d.needleAt) >= ROTATE_MIN_DEG && now - (d.needleAnimAt || 0) >= ANIM_MS) {
                    this.glide(d.needle, 'rotate', [round2(d.needleAt)], [round2(a)]);
                    d.needleAt = a; d.needleAnimAt = now; this.sends++;
                }
            }
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
        // the peak shown follows the peak at most every PEAK_SHOW_MS: during a pull it climbs every psi, and
        // each change is a picture of its own
        if (this.peakShown !== this.peak && (!this.peak || now - (this.peakShownAt || 0) >= PEAK_SHOW_MS)) { this.peakShown = this.peak; this.peakShownAt = now; }
        const t = arcTexts(s, Object.assign({}, v, sl.v, { peakPsi: this.peakShown }), this.sweep);
        A.drawCentre(this.panels.centre.p, t.centre);
        A.drawLeft(this.panels.left.p, t.left);
        A.drawRight(this.panels.right.p, t.right);
        A.drawStrip(this.panels.strip.p, t.strip);
        for (const k of ['centre', 'left', 'right', 'strip']) {
            const P = this.panels[k], out = P.p.take();
            if (out.whole) this.cr.pixels(P.ref, null, buf(P.p.cv));
            else if (out.rects.length) this.cr.pixels(P.ref, FX.fewer(out.rects, FX.MAX_RECTS), cropMany(P.p.cv, FX.fewer(out.rects, FX.MAX_RECTS)));
            if (P.p.gpu) Object.keys(P.p.gpu).forEach((f) => this._readout(P.p.gpu[f]));
        }
    }

    /** The glyph atlases go after the layers that sample them (cluster-render refuses otherwise). */
    dropAssets() {
        if (this.assetRefs && this.cr) Object.keys(this.assetRefs).forEach((k) => this.cr.drop(this.assetRefs[k]));
        this.assetRefs = null;
    }

    /** A GPU readout's new text and colour: its uniforms, only those that changed. */
    _readout(G) {
        const u = PL.readoutUniforms(G.at, G.text, G.cx, G.unitW), c = rgba(G.col);
        const col = [c[0] / 255, c[1] / 255, c[2] / 255, 1].map((x) => Math.round(x * 1000) / 1000);
        const sx = u.x.join(' '), sg = u.g.join(' '), sc = col.join(' ');
        if (sx !== G.sx) { G.sx = sx; this.cr.uniform(G.ref, 'u_x', u.x); this.sends++; }
        if (sg !== G.sg) { G.sg = sg; this.cr.uniform(G.ref, 'u_g', u.g); this.sends++; }
        if (sc !== G.sc) { G.sc = sc; this.cr.uniform(G.ref, 'u_col', col); this.sends++; }
    }

    /**
     * The pre-loaded dial each tick: the needle, the lit arc's covers and the numerals glide together
     * (one renderer animation each, from one rpm to the next over the time between them); the shift
     * lights shown and hidden. No pixels.
     */
    _preDial(s, v, d, a, lv, now) {
        const max = d.spec.max || 8000;
        if (!this.sweep && v.rpmSeq != null) {
            if (v.rpmSeq !== d.rpmSeq) {
                d.rpmSeq = v.rpmSeq;
                const to = lerp(F.A0, F.A1, clamp01((v.rpm || 0) / max));
                const ms = Math.max(50, Math.min(400, Math.round(v.rpmEvery || ANIM_MS)));
                if (Math.abs(to - d.needleAt) >= ROTATE_MIN_DEG) this._preGlide(d, d.needleAt, to, ms, max);
            }
        } else if (Math.abs(a - d.needleAt) >= ROTATE_MIN_DEG && now - (d.needleAnimAt || 0) >= ANIM_MS) {
            this._preGlide(d, d.needleAt, a, ANIM_MS, max);
            d.needleAnimAt = now;
        }
        // shift lights: lv 0..n lit, n+1 all red (the flash on), n+2 none (the flash off)
        if (lv !== d.lv && d.lights.length) {
            d.lv = lv;
            const n = d.lights.length, flash = lv > n;
            d.lights.forEach((l, i) => { const on = !flash && i < lv; if (on !== l.on) { l.on = on; this.cr.set(l.ref, { visible: on }); this.sends++; } });
            const fon = lv === n + 1;
            if (d.flash && fon !== d.flash.on) { d.flash.on = fon; this.cr.set(d.flash.ref, { visible: fon }); this.sends++; }
        }
    }

    /** The needle from angle `from` to `to` in `ms`, and with it the covers and the numerals. */
    _preGlide(d, from, to, ms, max) {
        this.glide(d.needle, 'rotate', [round2(from)], [round2(to)], null, ms);
        d.needleAt = to; this.sends++;
        d.pieces.forEach((p, i) => {
            const keys = PL.coverKeys(i, from, to, ms);
            if (keys.every((kk) => Math.abs(kk[1] - p.turn) < 0.01)) return;           // stays where it is
            this.animKeys(p.cov, 'rotate', keys.map((kk) => [kk[0], round2(kk[1])]));
            p.turn = keys[keys.length - 1][1]; this.sends++;
        });
        const rpmOf = (ang) => (ang - F.A0) / (F.A1 - F.A0) * max;
        d.nums.forEach((nm) => {
            const s0 = PL.numeralScale(rpmOf(from), nm.n), s1 = PL.numeralScale(rpmOf(to), nm.n);
            if (Math.abs(s0 - nm.s) < SCALE_MIN && Math.abs(s1 - nm.s) < SCALE_MIN) return;
            const r = (x) => Math.round(x * 1000) / 1000;
            this.animKeys(nm.ref, 'scale', [[0, r(s0), r(s0), 1], [ms, r(s1), r(s1), 1]]);
            nm.s = s1; this.sends++;
        });
    }

    /**
     * A renderer animation of a layer's property (keys [[t, v...], ...]), replacing this layer's last
     * one of that property (the same number: no layer collects more than its 16). Nothing is set
     * first: the animation holds its last key, and plays again from its start when the scene is
     * published again, ending at the same place.
     */
    animKeys(ref, property, keys) {
        const cr = this.cr, ks = keys.map((kk) => kk[0] + ':' + kk.slice(1).join(',')).join(' ');
        this.anims = this.anims || {};
        const key = ref + ':' + property, n = this.anims[key];
        const l = cr.layers && cr.layers.get(ref);
        if (n && l && l.anims && l.anims.has(n)) {
            const m = Object.assign({}, l.anims.get(n), { keys: ks });
            l.anims.set(n, m);
            cr._send(m);
        } else this.anims[key] = cr.animate(ref, { property, keys: ks, interp: 'linear' });
    }

    /**
     * Move a layer's property from `from` to `to` over ANIM_MS, played by the renderer. One animation
     * per layer and property, replaced each time (the same number: "sending it again replaces it"), so
     * a layer never collects more than its 16; the property is also set to `from` first, which is where
     * it goes back to if an animation is ever dropped.
     */
    glide(ref, property, from, to, name, ms) {
        const cr = this.cr;
        if (property === 'rotate') cr.set(ref, { rotate: from[0] });
        else cr.uniform(ref, name, from);
        const keys = '0:' + from.join(',') + ' ' + (ms || ANIM_MS) + ':' + to.join(',');
        this.anims = this.anims || {};
        const k = ref + ':' + property, n = this.anims[k];
        const l = cr.layers && cr.layers.get(ref);
        if (n && l && l.anims && l.anims.has(n)) {
            const m = Object.assign({}, l.anims.get(n), { keys });
            l.anims.set(n, m);                       // so a re-publish plays the latest
            cr._send(m);
        } else this.anims[k] = cr.animate(ref, { property, name, keys, interp: 'linear' });
    }

    /** A dial's moving parts to a new state: a uniform (shader), or changed rectangles (redrawn). */
    dialState(key, st, now) {
        const d = this.dials[key];
        if (!d || d.pending) return;
        const o = d.st;
        const moved = !o || o.lv !== st.lv || ['a', 'b', 'c'].some((k) => Math.abs(o[k] - st[k]) >= MIN_STEP_DEG);
        if (!moved) return;
        if (this.mode === 'shader') {
            // plain uniforms, every tick: 0.12.0's uniform animations left the shader's needle unseen on
            // the car, so the shader is back to what showed there before
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
            refused: st.refused || 0, lastRefused: st.lastRefused || '', preloadOff: this.preloadOff || '' };
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
