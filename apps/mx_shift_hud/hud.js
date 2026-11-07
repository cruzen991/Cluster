'use strict';
/**
 * hud.js - puts the Shift HUD on the head-up display through cluster-render
 * (robertnisipeanu/idrive-apps, native/cluster-render): its `hud` target, 800 x 480, slot 0x323,
 * the area of the HUD above BMW's own speed bar.
 *
 * Layers (6 of the 8 one app may have), all image layers:
 *
 *   lit     every shift light lit, in its colour                  sent once
 *   cover   the band's ring in black with the lights unlit on it,  sent once; TURNED by the renderer
 *           turned clockwise by (lights lit) x one light's step   about the band's centre, so the revs
 *           so it hides the lights not lit                        moving the lights cost one message, no pixels
 *   mask    black past the band's end: hides the cover's far end  sent once
 *           as it turns
 *   flash   every light red, shown and hidden in turns from the   sent once; flashing costs no pixels
 *           redline (the cover turned back over every light then)
 *   gear    the gear                                              on a gear change: the rectangle it changed
 *   boost   boost in whole psi                                    the changed figures, at most 4 times a second
 *
 * So an upshift at the redline sends about the gear's rectangle (some 60 KB) and a few small messages.
 *
 * The HUD is shown while the car sends data (and, with the setting "When: Sport modes only", in a
 * Sport mode); otherwise every layer is hidden and cluster-render gives the slot back after its
 * linger (3 s). Turning the app off closes the connection: cluster-render drops every layer.
 *
 * The HUD and the cluster's `panel` target share a scene, so cluster-render never shows both:
 * with Classic Cluster on the cluster, the HUD waits.
 */
const A = require('./art');
const { ClusterRender } = require('./cluster_render_client');

const TARGET = 'hud';
const FPS = 30;
const FLASH_MS = 110;              // the redline flash: this long on, this long off (about 4.5 a second)
const BOOST_MS = 250;              // boost figures redrawn at most this often
const MAX_LAYERS = 8;

const buf = (cv) => Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.length);
function crop(cv, q) {
    const out = Buffer.alloc(q.w * q.h * 4);
    for (let y = 0; y < q.h; y++) Buffer.from(cv.d.buffer, cv.d.byteOffset + ((q.y + y) * cv.w + q.x) * 4, q.w * 4).copy(out, y * q.w * 4);
    return out;
}

class ShiftHud {
    /**
     * opts: { log, settings: () => { redline, span, flash, boost }, app (client name), socket (optional),
     *         onError(e) }
     */
    constructor(opts) {
        this.opts = opts;
        this.log = opts.log;
        this.S = opts.settings;
        this.cr = null;
        this.L = null;
        this.enabled = false;
        this.v = { rpm: 0, gearText: '-', boostPsi: null, show: false };
        this.state = { target: 'off', reason: '', disabled: false, layers: {}, budget: '', refused: 0, lastRefused: '' };
        this.timer = null;
    }

    start() {
        this.timer = setInterval(() => {
            try { this.tick(Date.now()); } catch (e) { if (this.opts.onError) this.opts.onError(e); else this.log.warn('hud tick: ' + (e && e.stack || e)); }
        }, 1000 / FPS);
    }
    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.enable(false); }

    /** The values to show: { rpm, gearText, boostPsi (or null), show (bool: data is live and wanted) }. */
    update(v) { this.v = v; }

    enable(on) {
        on = !!on;
        if (on === this.enabled) return;
        this.enabled = on;
        if (on) this._connect(); else this._disconnect();
        this.log.info(on ? 'hud on' : 'hud off');
    }

    _connect() {
        const cr = this.cr = new ClusterRender(this.opts.app || 'mx_shift_hud', this.opts.socket);
        this.state = { target: 'connecting', reason: '', disabled: false, layers: {}, budget: '', refused: 0, lastRefused: '' };
        cr.on('ready', () => this.log.info('cluster-render: backend ' + cr.backend + ', targets ' + cr.targets));
        cr.on('disconnected', () => { if (this.cr === cr) { this.state.target = 'disconnected'; this.state.reason = 'cluster renderer not reachable'; } });
        cr.on('target', (name, state, holder, reason, guideDisabled, disabled) => {
            if (name !== TARGET || this.cr !== cr) return;
            const was = this.state.target;
            this.state.target = state;
            this.state.reason = reason || (holder && holder !== 'none' ? 'held by ' + holder : '');
            this.state.disabled = !!disabled;
            if (state !== was) this.log.info('hud ' + state + (this.state.reason ? ': ' + this.state.reason : '') + (disabled ? ' (disabled by the renderer\'s guard)' : ''));
        });
        cr.on('layer', (ref, state, reason) => {
            this.state.layers[ref] = state;
            if (state === 'error') this.log.warn('layer ' + ref + ' refused: ' + (reason || ''));
        });
        cr.on('budget', (cap, max) => { this.state.budget = cap + '/' + max + ' KB/s'; });
        cr.on('refused', (op, ref, reason) => {
            this.state.refused++; this.state.lastRefused = op + ' ' + ref + ': ' + (reason || '');
            this.log.warn('refused ' + op + ' ' + ref + ': ' + (reason || ''));
        });
        this._layers();
        cr.connect();
    }

    _disconnect() {
        if (this.cr) this.cr.close();
        this.cr = null; this.L = null;
        this.state = { target: 'off', reason: '', disabled: false, layers: {}, budget: '', refused: 0, lastRefused: '' };
    }

    /** Make the layers, all hidden until there is something to show (tick shows them). */
    _layers() {
        const cr = this.cr, B = A.BAND;
        const img = (q, z, more) => cr.image(Object.assign({ target: TARGET, visible: false, contend: 0, z, x: q.x, y: q.y, w: q.w, h: q.h }, more || {}));
        if (!this.art) {
            const t0 = Date.now();
            this.art = { lit: A.litBand(), cover: A.coverBand(), mask: A.maskArt(), red: A.redBand() };
            this.log.info('band drawn in ' + (Date.now() - t0) + ' ms');
        }
        const L = this.L = {
            lit: img(B, 0),
            cover: img(B, 1, { px: A.PIVOT.x, py: A.PIVOT.y, rotate: 0, sampling: 'bilinear' }),
            mask: img(A.MASK, 2),
            flash: img(B, 3),
            gear: img(A.GEAR, 4), boost: img(A.BOOST, 4),
            turn: 0, gearText: null, gearCv: null, boostText: null, boostAt: 0, boostCv: null,
            shown: false, flashing: false, flashT0: 0, st: null, vis: {},
        };
        cr.pixels(L.lit, null, buf(this.art.lit));
        cr.pixels(L.cover, null, buf(this.art.cover));
        cr.pixels(L.mask, null, buf(this.art.mask));
        cr.pixels(L.flash, null, buf(this.art.red));
        this._gear('-');
        L.boostCv = A.boostArt('--'); L.boostText = '--';
        cr.pixels(L.boost, null, buf(L.boostCv));
        this.layerCount = 6;
        if (this.layerCount > MAX_LAYERS) this.log.warn(this.layerCount + ' layers, more than cluster-render allows one app');
    }

    /** A new gear: only the rectangle the old and the new gear cover is sent. */
    _gear(g) {
        const L = this.L;
        if (g === L.gearText) return;
        const old = L.gearCv, cv = A.gearArt(g);
        L.gearText = g; L.gearCv = cv;
        if (!old) { this.cr.pixels(L.gear, null, buf(cv)); return; }
        const all = { x: 0, y: 0, w: A.GEAR.w, h: A.GEAR.h };
        const q = A.union([A.inkRect(old, all), A.inkRect(cv, all)].filter(Boolean));
        if (q) this.cr.pixels(L.gear, [q], crop(cv, q));
    }

    /** Show or hide a layer; sent only when it changes. */
    _vis(ref, on) {
        const L = this.L;
        if (L.vis[ref] === on) return;
        L.vis[ref] = on;
        this.cr.set(ref, { visible: on });
    }

    tick(now) {
        const L = this.L;
        if (!this.cr || !L) return;
        const s = this.S(), v = this.v;
        const show = !!v.show;

        // the lights: the cover turned to leave st.lv lit; from the redline it covers them all and
        // the red layer flashes over it
        const st = L.st = A.shiftState(show ? v.rpm : 0, { redline: s.redline, span: s.span, flash: s.flash }, L.st);
        if (st.flash && !L.flashing) { L.flashing = true; L.flashT0 = now; }
        if (!st.flash) L.flashing = false;
        const flashOn = L.flashing && Math.floor((now - L.flashT0) / FLASH_MS) % 2 === 0;
        const turn = L.flashing ? 0 : A.coverAngle(st.lv);
        if (turn !== L.turn) { L.turn = turn; this.cr.set(L.cover, { rotate: turn }); }

        // the gear and boost
        if (show) this._gear(A.hudGear(v.gearText));
        const bt = A.boostText(v.boostPsi);
        if (show && s.boost && bt !== L.boostText && now - L.boostAt >= BOOST_MS) {
            L.boostText = bt; L.boostAt = now;
            const r = A.boostFigures(L.boostCv, bt);
            this.cr.pixels(L.boost, [r], crop(L.boostCv, r));
        }

        this._vis(L.lit, show);
        this._vis(L.cover, show);
        this._vis(L.mask, show);
        this._vis(L.flash, show && flashOn);
        this._vis(L.gear, show);
        this._vis(L.boost, show && !!s.boost);
        L.shown = show;
    }

    status() {
        const L = this.L, st = this.state;
        const shown = Object.keys(st.layers).filter((k) => st.layers[k] === 'shown').length;
        return { target: st.target, reason: st.reason, disabled: st.disabled, budget: st.budget, refused: st.refused, lastRefused: st.lastRefused,
            layers: this.layerCount || 0, shown, lit: L && L.st ? L.st.lv : 0, flashing: L ? L.flashing : false, showing: L ? L.shown : false };
    }

    /**
     * What the HUD shows now, composited on black (for the app's screen): a Canvas 800 x 480. The
     * lights are drawn from the lit and unlit art directly (no turning here).
     */
    picture(Canvas) {
        const cv = new Canvas(A.HW, A.HH).clear([0, 0, 0, 255]), L = this.L;
        if (!L || !L.shown) return cv;
        const s = this.S();
        const put = (src, q) => {
            for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
                const i = (y * src.w + x) * 4, a = src.d[i + 3];
                if (a) cv._blend(q.x + x, q.y + y, [src.d[i], src.d[i + 1], src.d[i + 2], 255], a / 255);
            }
        };
        if (!this.dark) this.dark = A.darkBand();
        if (L.flashing) put(Math.floor((Date.now() - L.flashT0) / FLASH_MS) % 2 === 0 ? this.art.red : this.dark, A.BAND);
        else {
            if (this.pictLv !== L.st.lv || !this.pictBand) {
                const b = this.pictBand = A.darkBand();
                for (let i = 0; i < L.st.lv; i++) A.drawLight(b, i, 'lit');
                this.pictLv = L.st.lv;
            }
            put(this.pictBand, A.BAND);
        }
        put(L.gearCv, A.GEAR);
        if (s.boost) put(L.boostCv, A.BOOST);
        return cv;
    }
}

module.exports = { ShiftHud, TARGET, FLASH_MS, BOOST_MS };
