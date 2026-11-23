'use strict';
/**
 * controls.js - the iDrive controller -> Dead Rim's moves. Built on Road Hopper's reading of
 * FrontCCU.statusRotaryEncoderState (the kit's Doom reads it the same way).
 *
 *   turn the knob     one lane round the rim per click (clockwise: clockwise; setting "Knob" reverses)
 *   press             'press' as the press starts (no wait for the release: a shooter has to be quick)
 *   press and hold    'hold' once, when the controller calls it a long press (about half a second)
 *   push up / down    'press' / 'hold', and left / right a lane, only where the HMI lets the game
 *                     have the controller; the knob and press are the way to play
 *
 * main.js turns 'press' / 'hold' into fire / grenade by the Fire setting.
 *
 * Without controller data the GAME screen's hidden buttons are under the picture: turn to pick
 * Left / Fire / Grenade / Right, press to use it.
 */

const DEFL = { MITTELSTELLUNG: 0, NORD_KURZ_GEDRUECKT: 1, NORD_LANG_GEDRUECKT: 2, NORD_UNWIRKSAM: 3, OST_KURZ_GEDRUECKT: 4,
    OST_LANG_GEDRUECKT: 5, OST_UNWIRKSAM: 6, SUED_KURZ_GEDRUECKT: 7, SUED_LANG_GEDRUECKT: 8, SUED_UNWIRKSAM: 9,
    WEST_KURZ_GEDRUECKT: 10, WEST_LANG_GEDRUECKT: 11, WEST_UNWIRKSAM: 12, SIGNAL_UNGUELTIG: 15 };
const PUSH = { KEINE_BETAETIGUNG: 0, DREHGEBER_KURZ_GEDRUECKT: 1, DREHGEBER_LANG_GEDRUECKT: 2, UNWIRKSAM: 3, SIGNAL_UNGUELTIG: 15 };
const num = (v, names) => (typeof v === 'number' ? v : v != null && names[v] != null ? names[v] : 15);
const DIR = { 1: 'press', 2: 'press', 4: 'right', 5: 'right', 7: 'hold', 8: 'hold', 10: 'left', 11: 'left' };
const BAR = { BTN_LEFT: 'left', BTN_FIRE: 'fire', BTN_BOMB: 'bomb', BTN_RIGHT: 'right' };
const MAX_QUEUE = 6;                  // a quick spin carries you several lanes, not round and round
const MAX_CLICKS = 4;                 // clicks taken from one message (a counter jump is not a spin)

class Controls {
    /** opts: { log, reversed(): bool } */
    constructor(opts) {
        this.o = opts || {};
        this.log = this.o.log || { info() {} };
        this.live = false;
        this.pos = null;
        this.press = 0;
        this.defl = 0;
        this.queue = [];
        this.enabled = false;
        this.logged = 0;
        this.lastMsg = '';
    }

    take() { const q = this.queue; this.queue = []; return q; }

    put(what) {
        if (!this.enabled || this.queue.length >= MAX_QUEUE) return;
        this.queue.push(what);
    }

    /** One FrontCCU.statusRotaryEncoderState (enums by name or number). */
    raw(v) {
        if (!v) return;
        const key = JSON.stringify(v);
        if (this.logged < 30 && key !== this.lastMsg) { this.logged++; this.log.info('controller ' + key); }
        this.lastMsg = key;
        const pushBtn = num(v.frontRotaryEncoderPushButton, PUSH), defl = num(v.frontRotaryEncoderDeflection, DEFL), pos = v.frontRotaryEncoderOperation;
        if (pushBtn === 15 && defl === 15) return;
        if (!this.live) { this.live = true; this.log.info('controller: live'); }
        if (typeof pos === 'number') {
            if (this.pos !== null) {
                const d = ((pos - this.pos + 32768) & 0xffff) - 32768;
                if (d && Math.abs(d) <= 64) {
                    const cw = (d > 0) !== !!(this.o.reversed && this.o.reversed());
                    for (let i = 0; i < Math.min(Math.abs(d), MAX_CLICKS); i++) this.put(cw ? 'right' : 'left');
                }
            }
            this.pos = pos;
        }
        const dir = DIR[defl] || null;
        if (dir && DIR[this.defl] !== dir) this.put(dir);
        this.defl = defl;
        // the press: 'press' as it starts, 'hold' once when it turns long
        const p = pushBtn === 1 || pushBtn === 2 ? pushBtn : 0;
        if (p !== 0 && this.press === 0) this.put('press');
        if (p === 2 && this.press !== 2) this.put('hold');
        this.press = p;
    }

    /** A hidden button was clicked (only counts without controller data: else it's the same press again). */
    barClick(name) {
        if (this.live) return;
        const w = BAR[name];
        if (w) this.put(w);
    }

    enable(on) { this.enabled = !!on; if (!on) { this.queue = []; } }
}

/** 'press' / 'hold' -> the game's input, by the Fire setting. */
function action(what, fireMode) {
    if (what === 'left' || what === 'right' || what === 'fire' || what === 'bomb') return what;     // moves and the hidden buttons
    if (fireMode === 'manual') return what === 'press' ? 'fire' : 'bomb';
    return what === 'press' ? 'bomb' : null;          // auto fire: a press throws the grenade; hold adds nothing
}

module.exports = { Controls, action, BAR, MAX_QUEUE };
