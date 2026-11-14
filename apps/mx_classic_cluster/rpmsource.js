'use strict';
/**
 * rpmsource.js - which engine-speed signal drives the needle.
 *
 * The head unit has the engine speed in two places:
 *   cds  CDS.statusEngineSpeed2 (via kit/runtime/car.js), already in rpm; about 9 a second on the car;
 *   bds  BasicDataSet.statusEngineSpeed, raw, its scaling not documented; its rate unknown.
 * Whichever comes more often is the better needle, but only once bds is known to say the same thing:
 * its scale is learned by pairing it with a fresh cds reading (it must agree, at one scale, MATCHES
 * times, and disagree rarely). It is then used while it comes at least FASTER times as often as cds
 * and is not late; otherwise cds. Each new reading of the source in use goes to onReading(rpm, every).
 */
const SCALES = [0.25, 0.125, 0.5, 1];
const MATCHES = 15, AGREE = 0.06, FASTER = 0.8, FRESH_MS = 150;

class RpmSource {
    constructor(onReading) {
        this.onReading = onReading;
        this.src = { cds: this._blank(), bds: this._blank() };
        this.scale = null;                            // bds's scale, once learned
        this.votes = SCALES.map(() => 0); this.misses = 0;
        this.using = 'cds';
    }
    _blank() { return { at: 0, every: 0, last: null, n: 0 }; }

    /** A value from source k ('cds': rpm; 'bds': raw). */
    feed(k, v, now) {
        if (typeof v !== 'number' || !(v >= 0) || v === 65535) return;
        const s = this.src[k];
        if (k === 'bds') {
            this._learn(v, now);
            if (this.scale === null) { this._rate(s, v, now); return; }
            v *= this.scale;
        }
        if (v === s.last) return;                      // a repeat: nothing new
        this._rate(s, v, now);
        this._choose(now);
        if (k === this.using) this.onReading(v, s.every || 111);
    }

    _rate(s, v, now) {
        if (s.at && now - s.at < 1000) s.every = s.every ? s.every + ((now - s.at) - s.every) * 0.2 : now - s.at;
        s.at = now; s.last = v; s.n++;
    }

    _learn(raw, now) {
        if (this.scale !== null) return;
        const c = this.src.cds;
        if (!c.at || now - c.at > FRESH_MS || !(c.last > 900)) return;
        const k = SCALES.findIndex((f) => Math.abs(raw * f - c.last) / c.last < AGREE);
        if (k < 0) { this.misses++; return; }
        this.votes[k]++;
        if (this.votes[k] >= MATCHES && this.misses <= this.votes[k] / 4) this.scale = SCALES[k];
    }

    _choose(now) {
        const c = this.src.cds, b = this.src.bds;
        const bOk = this.scale !== null && b.every > 0 && now - b.at < b.every * 3 &&
            (!c.every || now - c.at > c.every * 3 || b.every <= c.every * FASTER);
        this.using = bOk ? 'bds' : 'cds';
    }

    /** For the app's screen: e.g. "9/s CDS (basic data 4/s, scale 0.25)". */
    describe(now) {
        const r = (s) => (s.every && now - s.at < 2000 ? Math.round(1000 / s.every) : 0);
        const b = this.src.bds;
        const other = this.using === 'cds' ? (b.n ? ', basic data ' + r(b) + '/s' + (this.scale === null ? ', checking it' : '') : '') : ', CDS ' + r(this.src.cds) + '/s';
        return r(this.src[this.using]) + '/s ' + (this.using === 'cds' ? 'CDS' : 'basic data') + other;
    }
}

module.exports = { RpmSource, SCALES, MATCHES };
