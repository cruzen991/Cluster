'use strict';
/**
 * controls.js - the iDrive controller -> hops.
 *
 * With the controller's own state (FrontCCU.statusRotaryEncoderState, as the kit's Doom reads it):
 *   turn the knob        one hop left or right per click (clockwise: right; setting "Knob" reverses)
 *   press                hop forward, as the knob is let go (also starts a game)
 *   press and hold       hop back (the controller's long press, about half a second)
 *   push up/down/left/right  hop that way - only where the HMI lets the game have the controller
 *                        (the controller gate); without it the HMI also acts on a push (its menu,
 *                        or back out of the app), so the knob and press are the way to play
 *
 * Without controller data (the car doesn't send it to apps, or the VM): the GAME screen's hidden
 * buttons are still under the picture. The knob moves the HMI's focus over them and a press "clicks"
 * the one it rests on: Left, Hop, Back, Right - turn to pick, press to hop.
 */

const DEFL = { MITTELSTELLUNG: 0, NORD_KURZ_GEDRUECKT: 1, NORD_LANG_GEDRUECKT: 2, NORD_UNWIRKSAM: 3, OST_KURZ_GEDRUECKT: 4,
    OST_LANG_GEDRUECKT: 5, OST_UNWIRKSAM: 6, SUED_KURZ_GEDRUECKT: 7, SUED_LANG_GEDRUECKT: 8, SUED_UNWIRKSAM: 9,
    WEST_KURZ_GEDRUECKT: 10, WEST_LANG_GEDRUECKT: 11, WEST_UNWIRKSAM: 12, SIGNAL_UNGUELTIG: 15 };
const PUSH = { KEINE_BETAETIGUNG: 0, DREHGEBER_KURZ_GEDRUECKT: 1, DREHGEBER_LANG_GEDRUECKT: 2, UNWIRKSAM: 3, SIGNAL_UNGUELTIG: 15 };
const num = (v, names) => (typeof v === 'number' ? v : v != null && names[v] != null ? names[v] : 15);
const DIR = { 1: 'up', 2: 'up', 4: 'right', 5: 'right', 7: 'down', 8: 'down', 10: 'left', 11: 'left' };
const BAR = { BTN_LEFT: 'left', BTN_HOP: 'up', BTN_BACK: 'down', BTN_RIGHT: 'right' };
const MAX_QUEUE = 2;                  // hops asked for ahead of the game (a fast spin doesn't run you over the screen)
const MAX_CLICKS = 3;                 // clicks taken from one message (a counter jump is not a spin)

class Controls {
    /** opts: { log, reversed(): bool, now() } */
    constructor(opts) {
        this.o = opts || {};
        this.log = this.o.log || { info() {} };
        this.now = this.o.now || Date.now;
        this.live = false;            // controller data arriving
        this.pos = null;              // the knob's counter
        this.press = 0;               // last press state (0 none, 1 short, 2 long)
        this.defl = 0;
        this.queue = [];
        this.enabled = false;
        this.logged = 0;
        this.lastMsg = '';
    }

    /** Take the queued hops (oldest first). */
    take() { const q = this.queue; this.queue = []; return q; }

    put(what) {
        if (!this.enabled) return;
        if (this.queue.length >= MAX_QUEUE) return;
        this.queue.push(what);
    }

    /** One FrontCCU.statusRotaryEncoderState (enums by name or number). */
    raw(v) {
        if (!v) return;
        const key = JSON.stringify(v);
        if (this.logged < 30 && key !== this.lastMsg) { this.logged++; this.log.info('controller ' + key); }
        this.lastMsg = key;
        const pushBtn = num(v.frontRotaryEncoderPushButton, PUSH), defl = num(v.frontRotaryEncoderDeflection, DEFL), pos = v.frontRotaryEncoderOperation;
        if (pushBtn === 15 && defl === 15) return;                  // no controller behind it
        if (!this.live) { this.live = true; this.log.info('controller: live'); }
        if (typeof pos === 'number') {
            if (this.pos !== null) {
                const d = ((pos - this.pos + 32768) & 0xffff) - 32768;
                if (d && Math.abs(d) <= 64) {
                    const right = (d > 0) !== !!(this.o.reversed && this.o.reversed());
                    for (let i = 0; i < Math.min(Math.abs(d), MAX_CLICKS); i++) this.put(right ? 'right' : 'left');
                }
            }
            this.pos = pos;
        }
        // a push: once when it starts (or turns from short to long), not while held
        const dir = DIR[defl] || null;
        if (dir && DIR[this.defl] !== dir) this.put(dir);
        this.defl = defl;
        // the press: a short one hops forward when it is let go; one held until the controller calls
        // it long hops back at that moment (and its release does nothing). The controller reports a
        // press as short first, so hopping on the press itself would hop forward, then back
        const p = pushBtn === 1 || pushBtn === 2 ? pushBtn : 0;
        if (p === 0 && this.press === 1) this.put('up');
        else if (p === 2 && this.press !== 2) this.put('down');
        this.press = p;
    }

    /** A hidden bar button was clicked (only counts without controller data: else it's a duplicate). */
    barClick(name) {
        if (this.live) return;
        const w = BAR[name];
        if (w) this.put(w);
    }

    enable(on) { this.enabled = !!on; if (!on) this.queue = []; }
}

module.exports = { Controls, BAR, MAX_QUEUE };
