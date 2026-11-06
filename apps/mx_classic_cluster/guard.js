'use strict';
/**
 * guard.js - turns the cluster off by itself when showing it looks like it is hurting the
 * cluster, so a bad mapping can never leave the stock cluster stuck in a restart loop.
 *
 * cluster-render has a mapping guard of its own, but for the `panel` target it only logs
 * strikes; it never disables the panel (its README, "Mapping guard"). This is that guard for
 * this app, kept in the app's own data folder:
 *
 *   - Boot strikes. When the app asks for the panel it writes `pending`. Once the panel has
 *     been shown steadily for STABLE_MS, or the cluster is turned off from the app, `pending`
 *     is cleared and the strikes start over. An app start that finds `pending` still set
 *     means the head unit, the cluster renderer or this app went down while the panel was
 *     new: one strike.
 *   - Session strikes. The panel shown and then lost within LOSS_MS, while the app still
 *     wanted it and not to BMW's own content (stock or another app holding the slot, a
 *     door-open lock, parked behind something), is a loss; so is the renderer going away
 *     within LOSS_MS of a showing. LOSSES losses within LOSS_WINDOW_MS are one strike.
 *   - Errors. ERRORS exceptions in the drawing loop within a minute are one strike.
 *
 * STRIKES strikes turn the cluster off and keep it off (the "Show on the cluster" setting is
 * set to off, which is saved), until the driver turns it on again in the app.
 */
const fs = require('fs');
const path = require('path');

const STABLE_MS = 20000;
const LOSS_MS = 10000;
const LOSSES = 3, LOSS_WINDOW_MS = 120000;
const ERRORS = 5, ERROR_WINDOW_MS = 60000;
const STRIKES = 2;

class Guard {
    /**
     * opts: { dir (data folder), log, disable(reason) (turns the cluster off), now (clock, for tests) }
     */
    constructor(opts) {
        this.file = path.join(opts.dir, 'cluster-guard.json');
        this.log = opts.log;
        this.disable = opts.disable;
        this.now = opts.now || Date.now;
        this.st = { pending: false, strikes: 0, tripped: '' };
        try { Object.assign(this.st, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (e) { /* first start */ }
        this.shownAt = 0;
        this.losses = [];
        this.errors = [];
        this.wanted = false;
        this.stableTimer = null;
    }

    _save() {
        try {
            const tmp = this.file + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(this.st));
            fs.renameSync(tmp, this.file);
        } catch (e) { this.log.warn('guard save: ' + e); }
    }

    /** At app start, before anything is asked of the cluster. Returns false when it must stay off. */
    boot() {
        if (this.st.pending) {
            this.st.pending = false;
            this._strike('the head unit or the cluster restarted while the dials were new');
        }
        return !this.st.tripped;
    }

    /** The app is about to ask for the panel. */
    want() {
        this.wanted = true;
        this.st.pending = true;
        this._save();
    }

    /** The driver turned the cluster off: a clean stop, no strike. */
    off() {
        this.wanted = false;
        this.shownAt = 0;
        if (this.stableTimer) clearTimeout(this.stableTimer);
        this.stableTimer = null;
        if (this.st.pending) { this.st.pending = false; this._save(); }
    }

    /** The driver turned the cluster on again: they chose to retry, strikes start over. */
    retry() {
        this.st.strikes = 0; this.st.tripped = ''; this.losses = []; this.errors = [];
        this._save();
    }

    /** A panel target event from cluster-render. */
    target(state, holder, reason) {
        const now = this.now();
        if (state === 'shown') {
            if (!this.shownAt) {
                this.shownAt = now;
                if (this.stableTimer) clearTimeout(this.stableTimer);
                this.stableTimer = setTimeout(() => this._stable(), STABLE_MS);
                if (this.stableTimer.unref) this.stableTimer.unref();
            }
            return;
        }
        if (!this.shownAt) return;
        const since = now - this.shownAt;
        this.shownAt = 0;
        if (this.stableTimer) clearTimeout(this.stableTimer);
        this.stableTimer = null;
        if (!this.wanted || since >= LOSS_MS) return;
        const bmw = state === 'parked' || /stock|foreign/.test(String(holder)) || /stock|foreign|lock|yield|speech/i.test(String(reason || ''));
        if (bmw) return;
        this._loss('panel ' + state + (reason ? ' (' + reason + ')' : '') + ' ' + Math.round(since / 100) / 10 + ' s after it showed');
    }

    /** The connection to cluster-render dropped. */
    disconnected() {
        if (!this.shownAt) return;
        const since = this.now() - this.shownAt;
        this.shownAt = 0;
        if (this.wanted && since < LOSS_MS) this._loss('cluster renderer went away ' + Math.round(since / 100) / 10 + ' s after the dials showed');
    }

    /** An exception in the drawing loop. */
    error(e) {
        const now = this.now();
        this.errors = this.errors.filter((t) => now - t < ERROR_WINDOW_MS).concat(now);
        this.log.warn('cluster loop: ' + (e && e.stack || e));
        if (this.errors.length >= ERRORS) { this.errors = []; this._strike('repeated errors drawing the dials'); }
    }

    _loss(why) {
        const now = this.now();
        this.losses = this.losses.filter((t) => now - t < LOSS_WINDOW_MS).concat(now);
        this.log.warn('guard: loss: ' + why);
        if (this.losses.length >= LOSSES) { this.losses = []; this._strike(why); }
    }

    _stable() {
        this.stableTimer = null;
        if (!this.shownAt) return;
        if (this.st.pending || this.st.strikes) this.log.info('guard: dials steady, strikes cleared');
        this.st.pending = false; this.st.strikes = 0;
        this._save();
    }

    _strike(why) {
        this.st.strikes++;
        this.log.warn('guard: strike ' + this.st.strikes + ': ' + why);
        if (this.st.strikes >= STRIKES) {
            this.st.tripped = why;
            this.st.pending = false;
            this._save();
            this.wanted = false;
            this.disable(why);
        } else this._save();
    }

    status() { return { strikes: this.st.strikes, tripped: this.st.tripped }; }
}

module.exports = { Guard, STABLE_MS, LOSS_MS, LOSSES, STRIKES };
