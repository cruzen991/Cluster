'use strict';
/**
 * Shift HUD - shift lights, the gear and boost on the head-up display (the "Arc" design, art.js).
 *
 * Reads the engine speed, the gear and the boost the way Classic Cluster does (kit/car.js and
 * FES statusSwitchDriveDynamicSport2) and draws them on the HUD through cluster-render (hud.js).
 * The app's own screen shows what the HUD shows and its state.
 *
 * Safety rules kept here:
 *   - demo data never reaches the HUD unless the "Demo" setting is on;
 *   - data older than STALE_MS hides the HUD rather than freezing an rpm that is no longer true;
 *   - nothing is ever drawn but the lights, the gear and boost: no pop-ups, no text to read.
 */
const mgu = require('./kit/mgu');
const { Canvas } = require('./kit/canvas');
const Car = require('./kit/car');
const { ShiftHud } = require('./hud');
const { modeOf, boostPsiOf } = require('./modes');

const W = 1600, H = 520;
const STALE_MS = 3000;
const START_DELAY_MS = 1500;
const TOGGLE_MS = 1000;
const FES = 'de.bmw.infotainment.drivingexcitement.FES';

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const S = () => ({
            on: settings.get('on') !== false,
            show: settings.get('show') === 'sport' ? 'sport' : 'always',
            redline: Number(settings.get('redline')) || 7000,
            span: Number(settings.get('span')) || 2500,
            flash: settings.get('flash') !== false,
            boost: settings.get('boost') !== false,
            boostRef: settings.get('boostRef') === 'absolute' ? 'absolute' : 'gauge',
            demo: settings.get('demo') === 'on',
        });

        let boostBar = null, boostAt = 0, modeText = '';
        const car = new Car(ctx, ['rpm', 'speed', 'gear'], {
            [FES]: {
                statusFESVehicleDynamicSwitchHMI: (v) => {
                    const raw = v && v.actualValueModeDrivingExperience, m = modeOf(raw);
                    if (m !== null && m !== modeText) log.info('drive mode ' + JSON.stringify(raw) + ' -> ' + m);
                    if (m !== null) modeText = m;
                },
                statusSwitchDriveDynamicSport2: (v) => {
                    const b = v && v.displayBoostPressure;
                    if (typeof b === 'number' && b >= 0 && b < 255) { boostBar = b * 0.01; boostAt = Date.now(); }
                },
            },
        });
        car.setRedline(S().redline);
        let lastTick = 0;
        car.onSample(() => { lastTick = Date.now(); }, () => { lastTick = 0; });

        const hud = new ShiftHud({ log, settings: S, app: ctx.spec.id });
        hud.start();
        let started = false, toggling = null;
        const apply = () => hud.enable(S().on);
        setTimeout(() => { started = true; apply(); }, START_DELAY_MS);
        settings.onChange((key) => {
            if (key === 'redline') car.setRedline(S().redline);
            if (started) apply();
        });

        /* ---------- values for the HUD, 30 times a second ---------- */
        const read = () => {
            const s = S(), d = car.data(), now = Date.now();
            const fresh = lastTick && now - lastTick < STALE_MS;
            const usable = fresh && (!d.demo || s.demo);
            const mode = d.demo ? 'Sport' : modeText;
            const sporty = /^Sport/.test(mode);
            const why = !usable ? (fresh ? 'demo data (turn on Demo to show it)' : 'no data from the car') : s.show === 'sport' && !sporty ? 'waiting for a Sport mode' : '';
            const boostPsi = !usable ? null : d.demo ? Math.max(0, Math.min(19, ((d.rpm || 0) - 1500) / 3500 * 19)) : boostPsiOf(boostBar, boostAt, now, s.boostRef);
            return { rpm: usable ? d.rpm || 0 : 0, gearText: usable ? gearText(d) : '-', boostPsi, show: !why, why, mode, live: usable && !d.demo };
        };
        setInterval(() => hud.update(read()), 1000 / 30);

        /* ---------- the app's screen: what the HUD shows, and its state ---------- */
        ctx.loop('MAIN', 2, () => {
            const t = ctx.theme(), s = S(), v = read(), st = hud.status();
            const cv = new Canvas(W, H).clear(t.bg);
            // the HUD's picture, as it would float on the glass (black is see-through there)
            cv.fillRect(18, 18, 804, 484, '#30343a');
            cv.blit(hud.picture(Canvas), 20, 20);
            if (!st.showing) cv.text(s.on ? 'Nothing on the HUD now' : 'Off', 420, 270, 28, '#7a8088', { align: 'center', literal: true });
            const x = 1210, busy = toggling && Date.now() - toggling.at < TOGGLE_MS;
            const col = st.target === 'shown' && st.showing ? '#2fd27a' : !s.on ? t.dim : '#ffb020';
            cv.text('Shift HUD', x, 80, 44, t.text, { font: 'bold', align: 'center', literal: true });
            cv.text(busy ? (toggling.on ? 'Turning on...' : 'Turning off...') : !s.on ? 'Off' : st.disabled ? 'HUD disabled by the renderer' : label(st.target, st.showing),
                x, 150, 36, busy ? t.text : col, { font: 'bold', align: 'center', literal: true });
            const lines = [];
            if (s.on && st.reason) lines.push(st.reason);
            if (s.on && v.why) lines.push('Hidden: ' + v.why);
            if (s.on && st.target === 'waiting' && !st.reason) lines.push('Classic Cluster on the cluster? The HUD waits while it is on.');
            lines.slice(0, 3).forEach((l, i) => wrap(l, 40).slice(0, 2).forEach((w, j) => cv.text(w, x, 198 + i * 56 + j * 26, 22, t.dim, { align: 'center', literal: true })));
            cv.text(Math.round(v.rpm) + ' rpm   gear ' + v.gearText + '   ' + (v.boostPsi == null ? '-- psi' : v.boostPsi.toFixed(1) + ' psi'), x, 380, 28, t.text, { align: 'center', literal: true });
            cv.text((v.mode || 'Drive mode --') + '   lights ' + st.lit + ' of 12' + (st.flashing ? ', flashing' : ''), x, 418, 22, t.dim, { align: 'center', literal: true });
            if (s.on) cv.text('Layers ' + st.shown + '/' + st.layers + ' shown' + (st.budget ? '   link ' + st.budget : '') + (st.refused ? '   refused ' + st.refused : ''), x, 452, 18, t.dim, { align: 'center', literal: true });
            if (st.refused) wrap(st.lastRefused, 60).slice(0, 1).forEach((w) => cv.text(w, x, 478, 16, t.dim, { align: 'center', literal: true }));
            return ui.image('MAIN_GFX', cv);
        });
        ui.onClick('BTN_TOGGLE', () => {
            const now = Date.now();
            if (toggling && now - toggling.at < TOGGLE_MS) return;
            toggling = { at: now, on: !S().on };
            settings.set('on', toggling.on);
            if (!started) { started = true; apply(); }
        });
        process.on('exit', () => hud.stop());
        log.info('shift hud started');
    },
});

function gearText(d) {
    if (d.stage === 'P') return 'P';
    if (d.stage === 'R' || d.gear === -1) return 'R';
    if (d.stage === 'N') return 'N';
    if (typeof d.gear === 'number' && d.gear > 0) return String(d.gear);
    if (d.stage === 'D') return 'D';
    return d.gear === 0 ? 'N' : '-';
}
function label(state, showing) {
    if (state === 'shown') return showing ? 'On the HUD' : 'HUD ready';
    return { parked: 'Waiting: HUD busy', acquiring: 'Asking for the HUD', waiting: 'Waiting for the HUD', lingering: 'Leaving the HUD', idle: 'Ready',
        unavailable: 'HUD not available', disconnected: 'Cluster renderer missing', connecting: 'Connecting', off: 'Off' }[state] || state;
}
function wrap(s, n) {
    const out = [];
    let line = '';
    String(s).split(' ').forEach((w) => { if ((line + ' ' + w).trim().length > n) { out.push(line); line = w; } else line = (line + ' ' + w).trim(); });
    if (line) out.push(line);
    return out;
}
