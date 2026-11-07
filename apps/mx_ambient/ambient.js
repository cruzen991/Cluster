'use strict';
/**
 * ambient.js - talking to the car's ambient lighting, with no screen: builds the messages, keeps
 * what the car reports, remembers what it was when the app started (to put it back), and records
 * every attempt and how it went. main.js wires it to the head unit; test.js drives it with a fake.
 *
 * Two services on the head unit (both in this car's catalog, someip-interfaces.json):
 *
 *   de.bmw.infotainment.misc.ComfortFunctionIuK (0xB512)
 *     ambientLightInteriorColour (set only) - ControlAmbientLightInteriorColourWrapper:
 *       controlHueInteriorLighting                 UInt16   4095 = leave as is
 *       controlMenuAmbientePanoramicRoofInteriorLighting  enum: AMBIENTEBELEUCHTUNG_AUS 0 (off),
 *                                                  FARBAUSWAHL_1..12 (colour 1-12), INDIVIDUALMODUS 13,
 *                                                  KOPPLUNG_AN_FES 14 (follow the drive mode),
 *                                                  SIGNAL_UNBEFUELLT 15 = leave as is
 *       controlHueValueLayer1/2/3IndividualGroup   UInt8    255 = leave as is
 *       controlBrightnessValueBrightnessOffset...  UInt8    255 = leave as is
 *       controlModeAmbientePanoramicRoof...        enum AUS 0 / EIN 1 / SIGNAL_UNBEFUELLT 3 = leave
 *       controlDynamicInteriorLighting             same
 *       controlDynamicAmbienteInteriorLighting     same
 *     statusAmbientLightInteriorColour (read + notify) - the same members, named status...
 *
 *   de.bmw.body.interiorillumination.AmbientLight (0xB09E) - read, notify and set:
 *     ambientLightActive (Bool), brightnessAmbientLight (UInt8), brightnessAmbientContourLine (UInt8),
 *     currentInteriorLightProfile ({ currentLightProfileId: COLOUR1..50 | MODE0.. })
 *
 * Every write sends the "leave as is" value in every member it doesn't mean to change, so one
 * button changes one thing. These are the settings the car's own Ambient light menu makes; nothing
 * here codes a control unit. What the car does with a value it doesn't support (a free hue on a
 * car with 11 fixed colours) is what this app is for finding out.
 */

const LEAVE = { hue: 4095, menu: 15, layer: 255, offset: 255, mode: 3 };
const MENU = { OFF: 0, INDIVIDUAL: 13, FES: 14, LEAVE: 15 };
const MENU_NAMES = { 0: 'AMBIENTEBELEUCHTUNG_AUS', 13: 'INDIVIDUALMODUS', 14: 'KOPPLUNG_AN_FES', 15: 'SIGNAL_UNBEFUELLT' };
for (let i = 1; i <= 12; i++) MENU_NAMES[i] = 'FARBAUSWAHL_' + i;
const MODE_NAMES = { 0: 'AUS', 1: 'EIN', 3: 'SIGNAL_UNBEFUELLT' };

const IUK = 'de.bmw.infotainment.misc.ComfortFunctionIuK';
const AMB = 'de.bmw.body.interiorillumination.AmbientLight';

/** An enum read from the car (a name or a number) -> its number (or null). */
function enumNum(v, names) {
    if (typeof v === 'number') return v;
    if (v == null) return null;
    for (const k of Object.keys(names)) if (names[k] === v) return Number(k);
    return null;
}

/**
 * The colour message. change: { hue, menu, layers: [h1, h2, h3], offset, mode, dynamic, dynamicAmbiente }
 * (numbers; anything absent is left as is). style 'names' writes enums by name, 'numbers' as numbers.
 */
function colourMessage(change, style) {
    const c = change || {};
    const en = (n, names) => (style === 'numbers' ? n : names[n]);
    const L = c.layers || [];
    return {
        controlHueInteriorLighting: c.hue != null ? clamp(Math.round(c.hue), 0, 4094) : LEAVE.hue,
        controlMenuAmbientePanoramicRoofInteriorLighting: en(c.menu != null ? c.menu : LEAVE.menu, MENU_NAMES),
        controlHueValueLayer1IndividualGroup: L[0] != null ? clamp(Math.round(L[0]), 0, 254) : LEAVE.layer,
        controlHueValueLayer2IndividualGroup: L[1] != null ? clamp(Math.round(L[1]), 0, 254) : LEAVE.layer,
        controlHueValueLayer3IndividualGroup: L[2] != null ? clamp(Math.round(L[2]), 0, 254) : LEAVE.layer,
        controlBrightnessValueBrightnessOffsetAmbientePanoramicRoofInteriorLighting: c.offset != null ? clamp(Math.round(c.offset), 0, 254) : LEAVE.offset,
        controlModeAmbientePanoramicRoofInteriorLighting: en(c.mode != null ? c.mode : LEAVE.mode, MODE_NAMES),
        controlDynamicInteriorLighting: en(c.dynamic != null ? c.dynamic : LEAVE.mode, MODE_NAMES),
        controlDynamicAmbienteInteriorLighting: en(c.dynamicAmbiente != null ? c.dynamicAmbiente : LEAVE.mode, MODE_NAMES),
    };
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** The status message -> plain numbers ({ hue, menu, layers, offset, mode, dynamic, dynamicAmbiente }). */
function readColour(s) {
    if (!s || typeof s !== 'object') return null;
    const g = (k) => s[k];
    return {
        hue: num(g('statusHueInteriorLighting')),
        menu: enumNum(g('statusMenuAmbientePanoramicRoofInteriorLighting'), MENU_NAMES),
        layers: [num(g('statusHueValueLayer1IndividualGroup')), num(g('statusHueValueLayer2IndividualGroup')), num(g('statusHueValueLayer3IndividualGroup'))],
        offset: num(g('statusBrightnessValueBrightnessOffsetAmbientePanoramicRoofInteriorLighting')),
        mode: enumNum(g('statusModeAmbientePanoramicRoofInteriorLighting'), MODE_NAMES),
        dynamic: enumNum(g('statusDynamicInteriorLighting'), MODE_NAMES),
        dynamicAmbiente: enumNum(g('statusDynamicAmbienteInteriorLighting'), MODE_NAMES),
    };
}
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

/** A colour as people read it. */
function describeColour(c) {
    if (!c) return 'not reported';
    const m = c.menu;
    const what = m === 0 ? 'off' : m >= 1 && m <= 12 ? 'colour ' + m : m === 13 ? 'individual' : m === 14 ? 'follows drive mode' : m === 15 ? 'not set' : m == null ? '?' : 'menu ' + m;
    const hue = c.hue == null || c.hue === LEAVE.hue ? '' : ', hue ' + c.hue;
    const lay = c.layers && c.layers.some((x) => x != null && x !== LEAVE.layer) ? ', zones ' + c.layers.map((x) => (x == null || x === LEAVE.layer ? '-' : x)).join('/') : '';
    const off = c.offset == null || c.offset === LEAVE.offset ? '' : ', brightness offset ' + c.offset;
    return what + hue + lay + off;
}

/**
 * The lab: holds the proxies' writers, the car's reports, and the attempts.
 * io: { setColour(msg) -> Promise, setAmb(field, value) -> Promise, now() }
 */
class Lab {
    constructor(io, log) {
        this.io = io;
        this.log = log || { info() {}, warn() {} };
        this.now = io.now || Date.now;
        this.colour = null;          // the car's latest colour status
        this.colourAt = 0;
        this.original = null;        // the first colour status seen: what Restore puts back
        this.amb = {};               // AmbientLight fields as the car reports them
        this.ambOriginal = null;
        this.style = 'names';        // how enums are written; switches to numbers if names are refused
        this.styleTried = {};
        this.attempts = [];          // { t, what, ok, error, before, after }
        this.preset = null;          // the preset the buttons step from
        this.hueStep = 0;
        this.avail = { iuk: false, amb: false };
    }

    onColour(s) {
        const c = readColour(s);
        if (!c) return;
        this.colour = c; this.colourAt = this.now();
        if (!this.original) { this.original = c; this.log.info('ambient: at start ' + describeColour(c)); }
        const last = this.attempts[this.attempts.length - 1];
        if (last && last.after == null && this.now() - last.t < 4000) last.after = describeColour(c);
    }

    onAmb(field, v) {
        let val = v;
        if (field === 'currentInteriorLightProfile' && v && typeof v === 'object') val = v.currentLightProfileId;
        this.amb[field] = val;
        if (!this.ambOriginal && field === 'brightnessAmbientLight') this.ambOriginal = { brightnessAmbientLight: val };
    }

    record(what, p) {
        const a = { t: this.now(), what, ok: null, error: null, before: describeColour(this.colour), after: null };
        this.attempts.push(a);
        if (this.attempts.length > 20) this.attempts.shift();
        return Promise.resolve(p).then(() => { a.ok = true; this.log.info('ambient: ' + what + ': sent'); return a; },
            (e) => { a.ok = false; a.error = String(e && e.message || e); this.log.warn('ambient: ' + what + ': ' + a.error); return a; });
    }

    /**
     * Send a colour change. If the binding refuses the enums by name, try once more as numbers (and
     * keep doing that).
     */
    async colourChange(what, change) {
        const a = await this.record(what, this.io.setColour(colourMessage(change, this.style)));
        if (!a.ok && !this.styleTried.numbers && /enum|type|invalid|convert|serial|argument/i.test(a.error || '')) {
            this.styleTried.numbers = true;
            this.style = 'numbers';
            return this.record(what + ' (enums as numbers)', this.io.setColour(colourMessage(change, 'numbers')));
        }
        return a;
    }

    /* ---------- the buttons ---------- */

    /** Step the preset: +1 or -1 through colours 1-12. */
    stepPreset(d) {
        const cur = this.preset || (this.colour && this.colour.menu >= 1 && this.colour.menu <= 12 ? this.colour.menu : 0);
        let n = cur ? cur + d : 1;              // nothing known yet: start at colour 1
        if (n > 12) n = 1;
        if (n < 1) n = 12;
        this.preset = n;
        return this.colourChange('colour ' + n, { menu: n });
    }

    /**
     * A free hue: the 12-bit value, a twelfth of the circle further each press. The scale (0-4094 for
     * a full circle, or degrees) is not documented: the readback and your eyes tell.
     */
    stepHue(scale) {
        this.hueStep = (this.hueStep + 1) % 12;
        const hue = scale === 'degrees' ? this.hueStep * 30 : Math.round(this.hueStep * 4094 / 12);
        return this.colourChange('hue ' + hue + (scale === 'degrees' ? ' (as degrees)' : ' (0-4094 scale)'), { hue });
    }

    /** Individual mode with the three zones far apart on the circle (0-254 each). */
    zones(h1, h2, h3) {
        return this.colourChange('individual: zones ' + [h1, h2, h3].join('/'), { menu: MENU.INDIVIDUAL, layers: [h1, h2, h3] });
    }

    followDriveMode() { return this.colourChange('follow the drive mode', { menu: MENU.FES }); }

    offsetBrightness(v) { return this.colourChange('brightness offset ' + v, { offset: v }); }

    /** AmbientLight's own brightness (0-100 in steps; the scale is the car's). */
    brightness(d) {
        const cur = typeof this.amb.brightnessAmbientLight === 'number' ? this.amb.brightnessAmbientLight : 50;
        const v = clamp(cur + d, 0, 100);
        return this.record('brightness ' + v, this.io.setAmb('brightnessAmbientLight', v));
    }

    /** Put back what the car reported when the app started. */
    restore() {
        const o = this.original, jobs = [];
        if (o) {
            const back = { menu: o.menu != null && o.menu !== MENU.LEAVE ? o.menu : null, hue: o.hue != null && o.hue !== LEAVE.hue ? o.hue : null,
                layers: o.layers, offset: o.offset != null && o.offset !== LEAVE.offset ? o.offset : null };
            jobs.push(this.colourChange('restore: ' + describeColour(o), back));
        }
        if (this.ambOriginal && typeof this.ambOriginal.brightnessAmbientLight === 'number') {
            jobs.push(this.record('restore brightness ' + this.ambOriginal.brightnessAmbientLight, this.io.setAmb('brightnessAmbientLight', this.ambOriginal.brightnessAmbientLight)));
        }
        if (!jobs.length) return this.record('restore: nothing known to put back', Promise.reject(new Error('the car has not reported its ambient light yet')));
        this.preset = null;
        return Promise.all(jobs);
    }

    /** Lines for the screen. */
    lines() {
        const age = this.colourAt ? Math.round((this.now() - this.colourAt) / 1000) + ' s ago' : 'never';
        const out = [
            'Car reports: ' + describeColour(this.colour) + ' (' + age + ')',
            'At start: ' + describeColour(this.original),
            'Brightness: ' + (this.amb.brightnessAmbientLight != null ? this.amb.brightnessAmbientLight : '-') + ', contour line ' + (this.amb.brightnessAmbientContourLine != null ? this.amb.brightnessAmbientContourLine : '-') +
                ', on: ' + (this.amb.ambientLightActive == null ? '-' : this.amb.ambientLightActive ? 'yes' : 'no') + ', profile ' + (this.amb.currentInteriorLightProfile || '-'),
            'Services: colour ' + (this.avail.iuk ? 'answering' : 'not answering') + ', ambient light ' + (this.avail.amb ? 'answering' : 'not answering') + ', enums as ' + this.style,
        ];
        const now = this.now();
        this.attempts.slice(-3).reverse().forEach((a) => {
            // the car's answer is its status changing: give it 4 s before calling it no answer
            const res = a.after ? ' -> car now: ' + a.after : !a.ok ? '' : now - a.t < 4000 ? ' -> waiting for the car...' : ' -> car reported no change';
            out.push((a.ok === null ? '... ' : a.ok ? 'Sent: ' : 'FAILED: ') + a.what + (a.error ? ' - ' + a.error : '') + res);
        });
        return out;
    }
}

module.exports = { Lab, colourMessage, readColour, describeColour, enumNum, LEAVE, MENU, MENU_NAMES, MODE_NAMES, IUK, AMB };
