'use strict';
/**
 * Classic Cluster - classic BMW round dials with orange needles on the instrument cluster.
 *
 * The app reads the car's speed, engine speed, oil temperature, gear and fuel level the way
 * the other kit apps do (kit/car.js, SOME/IP fields the head unit already receives) and draws
 * the dials on the cluster through cluster-render (cluster.js). Its own screen in the head
 * unit shows a small copy of the dials, the cluster's state and the settings.
 *
 * Safety rules kept here:
 *   - no demo data ever reaches the cluster unless the "Demo" setting is on;
 *   - values older than STALE_MS park the needles at zero and blank the LCDs, rather than
 *     freezing a speed that is no longer true;
 *   - the start-up sweep only runs with the car standing still.
 */
const mgu = require('./kit/mgu');
const { Canvas } = require('./kit/canvas');
const Car = require('./kit/car');
const F = require('./faces');
const { ClassicCluster, tachMax } = require('./cluster');
const { Guard } = require('./guard');

const W = 1600, H = 520;
const STALE_MS = 1500;
const KOMBI = 'de.bmw.infotainment.KombiIF';
const FES = 'de.bmw.infotainment.drivingexcitement.FES';
const { modeOf } = require('./modes');

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const S = () => ({
            on: settings.get('on') !== false,
            units: settings.get('units') || 'mph',
            tempUnit: settings.get('tempUnit') || 'f',
            illum: settings.get('illum') || 'orange',
            redline: Number(settings.get('redline')) || 7000,
            sweep: settings.get('sweep') !== false,
            backdrop: settings.get('backdrop') === 'none' ? 'none' : 'full',
            tank: Number(settings.get('tank')) || 59,
            dx: Number(settings.get('dx')) || 0,
            dy: Number(settings.get('dy')) || 0,
            demo: settings.get('demo') === 'on',
            retake: settings.get('retake') === true,
            style: settings.get('style') === 'classic' ? 'classic' : 'sport',
            needles: ['image', 'sharp', 'redraw'].indexOf(settings.get('needles')) >= 0 ? settings.get('needles') : 'shader',
        });

        // fuel: litres in the tank from the cluster's own range / tank status
        // and the range and odometer for the centre panel, from the same field
        let fuelL = null, rangeKm = null, odoKm = null, modeText = '';
        const car = new Car(ctx, ['rpm', 'speed', 'temps', 'gear'], {
            [KOMBI]: { statusRangeTankStatus: (v) => {
                if (!v) return;
                const l = v.fluidLevelFuelTank, r = v.range, o = v.mileageKilometre;
                if (typeof l === 'number' && l >= 0 && l < 255) fuelL = l;
                if (typeof r === 'number' && r >= 0 && r < 4095) rangeKm = r;
                if (typeof o === 'number' && o >= 0 && o < 16777215) odoKm = o;
            } },
            [FES]: { statusFESVehicleDynamicSwitchHMI: (v) => {
                const raw = v && v.actualValueModeDrivingExperience, m = modeOf(raw);
                if (m !== modeText && m !== null) log.info('drive mode ' + JSON.stringify(raw) + ' -> ' + m);
                if (m !== null) modeText = m;
            } },
        });
        car.setRedline(S().redline);
        let lastTick = 0;
        car.onSample((d, t) => { lastTick = Date.now(); }, () => { lastTick = 0; });

        /* ---------- on / off, and the guard that turns it off by itself ---------- */
        let tripped = '';
        const guard = new Guard({
            dir: ctx.dataDir, log,
            disable: (why) => { tripped = why; log.warn('cluster turned off by the guard: ' + why); settings.set('on', false); },
        });
        const cluster = new ClassicCluster({
            log, settings: S, app: ctx.spec.id,
            onTarget: (state, holder, reason) => guard.target(state, holder, reason),
            onDisconnected: () => guard.disconnected(),
            onError: (e) => guard.error(e),
        });
        const apply = () => {
            const on = S().on;
            if (on && !cluster.enabled) guard.want();
            if (!on && cluster.enabled) guard.off();
            cluster.enable(on);
        };
        if (!guard.boot()) {
            tripped = guard.status().tripped;
            if (S().on) settings.set('on', false);
        }
        cluster.start();
        apply();
        settings.onChange((key, value) => {
            const s = S();
            if (key === 'redline') car.setRedline(s.redline);
            if (key === 'on' && value === true) { tripped = ''; guard.retry(); }
            if (key === 'retake' && cluster.enabled) { cluster.enable(false); }     // the layers are made again with it
            cluster.build();
            apply();
        });

        /* ---------- values for the cluster, 30 times a second ---------- */
        const read = () => {
            const s = S(), d = car.data(), now = Date.now();
            const fresh = lastTick && now - lastTick < STALE_MS;
            const usable = fresh && (!d.demo || s.demo);
            const dist = (km) => (km === null ? '---' : String(Math.round(s.units === 'kmh' ? km : km / 1.609344)));
            const du = s.units === 'kmh' ? 'km' : 'mi';
            const info = { modeText: d.demo && s.demo ? 'Sport' : modeText, rangeText: (d.demo && s.demo ? '312' : dist(rangeKm)) + ' ' + du, odoText: (d.demo && s.demo ? '23817' : dist(odoKm)) + ' ' + du };
            if (!usable) return Object.assign({ speed: 0, rpm: 0, fuel: null, oil: null, oilC: null, speedText: '---', gearText: '-', live: false }, info);
            const kmh = d.speed || 0, speed = s.units === 'kmh' ? kmh : kmh / 1.609344;
            const oilC = typeof d.oil === 'number' ? d.oil : null;
            const oilDial = oilC === null ? null : s.tempUnit === 'f' ? ((oilC * 9 / 5 + 32) - 120) / 180 : (oilC - 50) / 100;
            const fuel = d.demo ? 0.62 : fuelL === null ? null : fuelL / s.tank;
            return {
                speed, rpm: d.rpm || 0, fuel, oil: oilDial, oilC,
                speedText: String(Math.round(speed)), gearText: gearText(d), live: !d.demo,
                rangeText: info.rangeText, odoText: info.odoText, modeText: info.modeText,
            };
        };
        setInterval(() => cluster.update(read()), 1000 / 30);

        /* ---------- the head unit screen: a small copy of the dials and the status ---------- */
        let mini = null, miniKey = '';
        const miniFaces = () => {
            const s = S(), key = JSON.stringify([s.style, s.units, s.illum, s.redline, s.tempUnit]);
            if (key === miniKey) return mini;
            miniKey = key;
            const sp = F.speedoFace({ style: s.style, units: s.units, illum: s.illum });
            const tc = F.tachFace({ style: s.style, illum: s.illum, redline: s.redline, max: tachMax(s.redline), tempUnit: s.tempUnit });
            const shrink = (src) => { const c = new Canvas(400, 400); c.drawImage(src.d, src.w, src.h, 0, 0, 400, 400); return c; };
            mini = { sp: shrink(sp), tc: shrink(tc) };
            return mini;
        };
        const needleLine = (cv, cx, cy, ang, len, col) => {
            const a = ang * Math.PI / 180;
            cv.line(cx, cy, cx + Math.sin(a) * len, cy - Math.cos(a) * len, 5, col);
            cv.circle(cx, cy, 16, '#1a1a1b');
        };
        ctx.loop('MAIN', 4, () => {
            const t = ctx.theme(), s = S(), v = read(), st = cluster.status(), m = miniFaces();
            const cv = new Canvas(W, H).clear(t.bg);
            const k = 400 / F.D;
            cv.blit(m.sp, 40, 60); cv.blit(m.tc, W - 440, 60);
            needleLine(cv, 240, 260, lerp(F.A0, F.A1, clamp01(v.speed / (s.units === 'kmh' ? 260 : 160))), 270 * k, F.style(s.style).needle.core);
            needleLine(cv, W - 240, 260, lerp(F.A0, F.A1, clamp01(v.rpm / tachMax(s.redline))), 270 * k, F.style(s.style).needle.core);
            const mid = W / 2, col = st.target === 'shown' ? '#2fd27a' : st.target === 'idle' && !s.on ? t.dim : '#ffb020';
            cv.text('Classic Cluster', mid, 110, 44, t.text, { font: 'bold', align: 'center', literal: true });
            cv.text(!s.on ? (tripped ? 'Off for safety' : 'Off: stock cluster') : label(st.target), mid, 190, 44, col, { font: 'bold', align: 'center', literal: true });
            const why = !s.on ? (tripped ? 'Turned itself off: ' + tripped : 'Press "Cluster on / off" to show the dials') : st.reason;
            if (why) wrap(why, 60).slice(0, 2).forEach((line, i) => cv.text(line, mid, 236 + i * 28, 22, t.dim, { align: 'center', literal: true }));
            cv.text(v.live ? 'Live car data' : (s.demo ? 'Demo data' : 'No car data: needles parked'), mid, 302, 24, t.dim, { align: 'center', literal: true });
            cv.text(v.speedText + ' ' + (s.units === 'kmh' ? 'km/h' : 'mph') + '   ' + Math.round(v.rpm) + ' rpm   ' + v.gearText,
                mid, 350, 32, t.text, { align: 'center', literal: true });
            const extra = [v.oilC !== null ? 'Oil ' + fmtTemp(v.oilC, s.tempUnit) : '', st.budget ? 'Link ' + st.budget : ''].filter(Boolean).join('   ');
            if (extra) cv.text(extra, mid, 388, 22, t.dim, { align: 'center', literal: true });
            // diagnostics: what cluster-render says about each group of layers (a photo of this helps)
            if (s.on) {
                const groups = Object.keys(st.groups).map((n) => {
                    const g = st.groups[n];
                    return n + ' ' + Object.keys(g.counts).map((k) => g.counts[k] + ' ' + k).join('/') + (g.why ? ' (' + g.why + ')' : '');
                }).join(' | ');
                const sweepNote = sweepMsg && Date.now() - sweepMsg.at < 4000 ? '  Sweep: ' + sweepMsg.text : (st.sweeping ? '  Sweeping' : '');
                const lines = ['Needles: ' + st.mode + ', ' + st.sends + ' moves sent' + sweepNote]
                    .concat(wrap(groups, 74))
                    .concat(st.refused ? wrap('Refused ' + st.refused + ': ' + st.lastRefused, 74) : []);
                lines.slice(0, 5).forEach((line, i) => cv.text(line, mid, 420 + i * 22, 17, t.dim, { align: 'center', literal: true }));
            }
            return ui.image('MAIN_GFX', cv);
        });
        ui.onClick('BTN_TOGGLE', () => settings.set('on', !S().on));
        process.on('exit', () => cluster.stop());
        let sweepMsg = null;
        ui.onClick('BTN_SWEEP', () => {
            const why = cluster.startSweep(false);
            sweepMsg = { at: Date.now(), text: why ? 'not run: ' + why : 'running' };
        });
        log.info('classic cluster started');
    },
});

function wrap(s, n) {
    const out = [];
    let line = '';
    String(s).split(' ').forEach((w) => { if ((line + ' ' + w).trim().length > n) { out.push(line); line = w; } else line = (line + ' ' + w).trim(); });
    if (line) out.push(line);
    return out;
}
function gearText(d) {
    if (d.stage === 'P') return 'P';
    if (d.stage === 'R' || d.gear === -1) return 'R';
    if (d.stage === 'N') return 'N';
    if (typeof d.gear === 'number' && d.gear > 0) return (d.stage === 'D' ? 'D' : '') + d.gear;
    if (d.stage === 'D') return 'D';
    return d.gear === 0 ? 'N' : '-';
}
function label(state) {
    return { shown: 'On the cluster', parked: 'Waiting: cluster busy', acquiring: 'Asking the cluster', waiting: 'Waiting for the cluster',
        lingering: 'Leaving the cluster', idle: 'Starting', unavailable: 'Cluster not available', disconnected: 'Cluster renderer missing' }[state] || state;
}
function fmtTemp(c, unit) { return unit === 'f' ? Math.round(c * 9 / 5 + 32) + ' °F' : Math.round(c) + ' °C'; }
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;

