'use strict';
/**
 * gearmode.js - what the gear readout says in D: "D3" in drive, "S3" with the lever pushed left
 * into the sport gate, and "3" alone while shifting by hand (lever +/- or the paddles) until the
 * gearbox leaves manual.
 *
 * Two sources, the first that answers wins:
 *
 *   1. the gearbox's own display data, as the factory cluster gets it: MDrive.dataDisplayGearbox,
 *      displayProgramGearbox = S_MINUS_PROGRAMM (1) / M_MINUS_PROGRAMM (2) / DUNKELSCHALTUNG (0,
 *      nothing: drive). Exact, when the head unit has it.
 *   2. otherwise, worked out from what the driver does: the lever (BasicDataSet
 *      operationGearSelectorSwitch: D = 3, the S/M gate M_S = 6, a tap M_PLUS = 5 / M_MINUS = 4)
 *      and the paddles (FES operationPaddleSwitch: a tap 1, 2, 5, 6; a long pull on + (8) ends
 *      manual, as on the car). In the S gate, manual lasts until the lever goes back to D or + is
 *      held; from D, a paddle tap gives a while of manual that the gearbox ends by itself, which
 *      nothing here sees: it is taken to end TEMP_MANUAL_MS after the last tap.
 *
 * P, R or N end any of it.
 */
const TEMP_MANUAL_MS = 8000;

const PROGRAM = { DUNKELSCHALTUNG: 0, S_MINUS_PROGRAMM: 1, M_MINUS_PROGRAMM: 2, L_MINUS_PROGRAMM: 3, C_MINUS_PROGRAMM: 4, B_PROGRAMM: 5, SIGNAL_UNGUELTIG: 7 };
const LEVER = { NA: 0, R: 1, N: 2, D: 3, M_MINUS: 4, M_PLUS: 5, M_S: 6, M: 7, L: 8, INIT: 14, SIGNAL_UNGUELTIG: 15 };
const PADDLE = { PADDLE_NICHT_BETAETIGT__INIT: 0, TIP__MINUS__BETAETIGT__NICHT_ENTPRELLT: 1, TIP__PLUS__BETAETIGT_NICHT_ENTPRELLT: 2,
    FEHLER_PADDLE: 3, TIP__MINUS__BETAETIGT_UND_ENTPRELLT: 5, TIP__PLUS__BETAETIGT_UND_ENTPRELLT: 6, LANGZUG_MINUS: 7, LANGZUG_PLUS: 8, SIGNAL_UNGUELTIG: 15 };
/** An enum as a number: the binding may hand over names or wire numbers. */
const num = (x, names) => (typeof x === 'number' ? x : typeof x === 'string' && names[x] !== undefined ? names[x] : null);

class GearMode {
    constructor() {
        this.program = null;          // from the gearbox: 'D' | 'S' | 'M', or null (never heard)
        this.gate = 'D';              // from the lever: 'D' | 'S'
        this.manual = false;
        this.manualFromD = false;     // manual entered from the D gate (ends on its own)
        this.tapAt = 0;
        this.source = '';             // 'gearbox' | 'lever' | '' (what decides now)
    }

    /** MDrive dataDisplayGearbox.displayProgramGearbox. */
    onProgram(raw) {
        const n = num(raw, PROGRAM);
        if (n === 0) this.program = 'D';
        else if (n === 1) this.program = 'S';
        else if (n === 2) this.program = 'M';
        else return;
        this.source = 'gearbox';
    }

    /** BasicDataSet operationGearSelectorSwitch. */
    onLever(raw, now) {
        const n = num(raw, LEVER);
        if (n === 3) { this.gate = 'D'; this.manual = false; }
        else if (n === 6) this.gate = 'S';
        else if (n === 4 || n === 5) { this.gate = 'S'; this.tap(now, false); }
        else if (n === 7) { this.gate = 'S'; this.manual = true; this.manualFromD = false; }
        else if (n === 1 || n === 2) { this.gate = 'D'; this.manual = false; }
        else return;
        if (!this.source) this.source = 'lever';
    }

    /** FES operationPaddleSwitch. */
    onPaddle(raw, now) {
        const n = num(raw, PADDLE);
        if (n === 1 || n === 2 || n === 5 || n === 6) this.tap(now, this.gate === 'D');
        else if (n === 8) this.manual = false;                 // + held: back to automatic
        else return;
        if (!this.source) this.source = 'lever';
    }

    tap(now, fromD) {
        if (!this.manual) this.manualFromD = fromD;
        this.manual = true; this.tapAt = now;
    }

    /** The selector stage (P / R / N / D) as car.js has it: anything but D ends manual and the gate. */
    onStage(stage) {
        if (stage && stage !== 'D') { this.manual = false; this.gate = 'D'; }
    }

    /** 'D' | 'S' | 'M' now. */
    mode(now) {
        if (this.source === 'gearbox') return this.program || 'D';
        if (this.manual && this.manualFromD && now - this.tapAt > TEMP_MANUAL_MS) this.manual = false;
        return this.manual ? 'M' : this.gate;
    }

    /** The gear readout in drive for gear n: 'D3', 'S3' or '3'. */
    text(n, now) {
        const m = this.mode(now);
        return m === 'M' ? String(n) : m + n;
    }
}

module.exports = { GearMode, TEMP_MANUAL_MS, PROGRAM, LEVER, PADDLE };
