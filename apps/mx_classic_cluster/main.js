'use strict';
/**
 * Classic Cluster - custom gauges on the instrument cluster: the Arc and Tech styles.
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
const START_DELAY_MS = 1500;       // the cluster starts this long after the app
const TOGGLE_MS = 1000;            // presses of on / off closer than this are one press
const KOMBI = 'de.bmw.infotainment.KombiIF';
const FES = 'de.bmw.infotainment.drivingexcitement.FES';
const ENV = 'de.bmw.infrastructure.EnvironmentalInformation';
const IAT_MS = 2000;               // intake air temperature: one read from the engine unit every 2 s (arc style only)
const IAT_STALE_MS = 15000;        // and shown as -- when the last good one is older than this
const { modeOf, boostPsiOf } = require('./modes');

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const S = () => ({
            on: settings.get('on') !== false,
            units: settings.get('units') || 'mph',
            tempUnit: settings.get('tempUnit') || 'f',
            redline: Number(settings.get('redline')) || 7000,
            sweep: settings.get('sweep') !== false,
            backdrop: settings.get('backdrop') === 'none' ? 'none' : 'full',
            tank: Number(settings.get('tank')) || 59,
            boostRef: settings.get('boostRef') === 'absolute' ? 'absolute' : 'gauge',
            dx: Number(settings.get('dx')) || 0,
            dy: Number(settings.get('dy')) || 0,
            demo: settings.get('demo') === 'on',
            retake: settings.get('retake') === true,
            style: settings.get('style') === 'arc' ? 'arc' : 'tech',     // 'sport' / 'classic' saved by an older version: tech
            torqueUnit: settings.get('torqueUnit') === 'nm' ? 'nm' : 'lbft',
            needleResponse: settings.get('needleResponse') === 'quick' ? 'quick' : 'smooth',
            notch: settings.get('notch') !== false,
            arcBg: ['graphite', 'dusk', 'twin'].indexOf(settings.get('arcBg')) >= 0 ? settings.get('arcBg') : 'grid',
            shift: settings.get('shift') !== false,
            needles: ['preload', 'shader', 'rotate', 'redraw'].indexOf(settings.get('needles')) >= 0 ? settings.get('needles') : 'preload',
        });

        // fuel: litres in the tank from the cluster's own range / tank status
        // and the range and odometer for the centre panel, from the same field
        let fuelL = null, rangeKm = null, odoKm = null, modeText = '';
        // boost: the sport display's boost pressure (FES statusSwitchDriveDynamicSport2), raw x 0.01 bar,
        // 255 = no value; the scaling is the idrive7-apps Live Data app's (marked "scale?" there)
        let boostBar = null, boostAt = 0;
        // outside temperature (raw x 0.5 - 40 deg C, 255 = none; the kit apps' scaling), for the arc style
        let outsideC = null, outsideAt = 0;
        const car = new Car(ctx, ['rpm', 'speed', 'temps', 'gear', 'torque'], {
            [ENV]: { ExteriorTemperature: (v) => {
                const r = v && v.temperatureExterior;
                if (typeof r === 'number' && r >= 0 && r < 255) { outsideC = r * 0.5 - 40; outsideAt = Date.now(); }
            } },
            [KOMBI]: { statusRangeTankStatus: (v) => {
                if (!v) return;
                const l = v.fluidLevelFuelTank, r = v.range, o = v.mileageKilometre;
                if (typeof l === 'number' && l >= 0 && l < 255) fuelL = l;
                if (typeof r === 'number' && r >= 0 && r < 4095) rangeKm = r;
                if (typeof o === 'number' && o >= 0 && o < 16777215) odoKm = o;
            } },
            [FES]: {
                statusFESVehicleDynamicSwitchHMI: (v) => {
                    const raw = v && v.actualValueModeDrivingExperience, m = modeOf(raw);
                    if (m !== modeText && m !== null) log.info('drive mode ' + JSON.stringify(raw) + ' -> ' + m);
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
        // how often the car sends a new rpm: the needle glides from one to the next over that time
        let rpmSeq = 0, rpmLast = null, rpmAt = 0, rpmEvery = 100;
        car.onSample((d, t) => {
            lastTick = Date.now();
            if (typeof d.rpm === 'number' && d.rpm !== rpmLast) {
                const now = Date.now();
                if (rpmAt && now - rpmAt < 1000) rpmEvery += ((now - rpmAt) - rpmEvery) * 0.2;
                rpmLast = d.rpm; rpmAt = now; rpmSeq++;
            }
        }, () => { lastTick = 0; });

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
        // the cluster starts a moment after the app, so the app's own screen opens first
        let started = false, toggling = null, sweepMsg = null;
        setTimeout(() => { started = true; apply(); }, START_DELAY_MS);
        settings.onChange((key, value) => {
            if (!started) return;                 // picked up when the cluster starts
            const s = S();
            if (key === 'redline') car.setRedline(s.redline);
            if (key === 'on' && value === true) { tripped = ''; guard.retry(); }
            if (key === 'retake' && cluster.enabled) { cluster.enable(false); }     // the layers are made again with it
            cluster.build();
            apply();
        });

        /* ---------- intake air temperature, only while the arc style is on the cluster ----------
         * Read from the engine unit (DME, 0x12) over the head unit's diagnostic link, READ-ONLY
         * (kit/readonly-diag.js: it refuses anything but 0x22 / OBD 01 reads), the candidates M Vitals
         * uses (app.json config.dme.iat). The link is made the first time it is needed. */
        let iatC = null, iatAt = 0, iatBusy = false, diag = null;
        setInterval(async () => {
            const s = S();
            if (iatBusy || s.style !== 'arc' || !cluster.enabled) return;
            iatBusy = true;
            try {
                if (!diag) {
                    const { ReadOnlyDiag } = require('./kit/readonly-diag');
                    const { DidReader } = require('./kit/dids');
                    const link = new ReadOnlyDiag(ctx.signals, log);
                    link.quiet = true;
                    link.init().catch((e) => log.warn('diagnostic link: ' + e));
                    diag = new DidReader(link, { ecu: 0x12 });
                }
                const dme = (ctx.spec.config && ctx.spec.config.dme) || {};
                const v = await diag.value('iat', dme.iat);
                if (v !== null && v > -40 && v < 150) { iatC = v; iatAt = Date.now(); }
            } catch (e) { log.warn('intake temperature: ' + (e && e.message || e)); }
            iatBusy = false;
        }, IAT_MS);

        /* ---------- values for the cluster, 30 times a second ---------- */
        const read = () => {
            const s = S(), d = car.data(), now = Date.now();
            const fresh = lastTick && now - lastTick < STALE_MS;
            const usable = fresh && (!d.demo || s.demo);
            const dist = (km) => (km === null ? '---' : commas(Math.round(s.units === 'kmh' ? km : km / 1.609344)));
            const du = s.units === 'kmh' ? 'km' : 'mi';
            const demo = d.demo && s.demo;
            const info = { modeText: demo ? 'Sport' : modeText, rangeText: (demo ? '312' : dist(rangeKm)) + ' ' + du, odoText: (demo ? '23,817' : dist(odoKm)) + ' ' + du,
                // slow values: shown while they are recent, whatever the engine is doing
                outsideC: demo ? 18 : outsideC,     // the car sends it only when it changes: the last one stays true
                iatC: demo ? 34 : (now - iatAt < IAT_STALE_MS ? iatC : null) };
            if (!usable) return Object.assign({ speed: 0, rpm: 0, fuel: null, oil: null, oilC: null, coolC: null, boost: null, boostPsi: null, torqueNm: null, speedText: '---', gearText: '-', live: false }, info);
            const kmh = d.speed || 0, speed = s.units === 'kmh' ? kmh : kmh / 1.609344;
            const oilC = typeof d.oil === 'number' ? d.oil : null;
            const oilDial = oilC === null ? null : s.tempUnit === 'f' ? ((oilC * 9 / 5 + 32) - 120) / 180 : (oilC - 50) / 100;
            const fuel = d.demo ? 0.62 : fuelL === null ? null : fuelL / s.tank;
            const boostPsi = d.demo ? Math.max(0, Math.min(19, ((d.rpm || 0) - 1500) / 3500 * 19)) : boostPsiOf(boostBar, boostAt, now, s.boostRef);
            return {
                speed, rpm: d.rpm || 0, rpmSeq: d.demo ? null : rpmSeq, rpmEvery, fuel, oil: oilDial, oilC, boostPsi, boost: boostPsi === null ? null : boostPsi / F.BOOST_MAX,
                coolC: typeof d.coolant === 'number' ? d.coolant : null, torqueNm: typeof d.torque === 'number' ? d.torque : null,
                speedText: String(Math.round(speed)), gearText: gearText(d), live: !d.demo,
                rangeText: info.rangeText, odoText: info.odoText, modeText: info.modeText, outsideC: info.outsideC, iatC: info.iatC,
            };
        };
        setInterval(() => cluster.update(read()), 1000 / 30);

        /* ---------- the head unit screen: the status, as text ----------
         * Twice a second, and a frame that has not changed is not sent again (the kit compares
         * pixels), so with steady values the app does almost nothing here. 0.8.0 drew two small
         * moving dials here four times a second: every frame changed and was re-encoded. */
        ctx.loop('MAIN', 2, () => {
            const t = ctx.theme(), s = S(), v = read(), st = cluster.status();
            const cv = new Canvas(W, H).clear(t.bg);
            const mid = W / 2, col = st.target === 'shown' ? '#2fd27a' : st.target === 'idle' && !s.on ? t.dim : '#ffb020';
            cv.text('Classic Cluster', mid, 110, 44, t.text, { font: 'bold', align: 'center', literal: true });
            const busy = toggling && Date.now() - toggling.at < TOGGLE_MS;
            cv.text(busy ? (toggling.on ? 'Turning on...' : 'Turning off...') : !s.on ? (tripped ? 'Off for safety' : 'Off: stock cluster') : label(st.target),
                mid, 190, 44, busy ? t.text : col, { font: 'bold', align: 'center', literal: true });
            const why = !s.on ? (tripped ? 'Turned itself off: ' + tripped : 'Press "Cluster on / off" to show the dials') : st.reason;
            if (why) wrap(why, 60).slice(0, 2).forEach((line, i) => cv.text(line, mid, 236 + i * 28, 22, t.dim, { align: 'center', literal: true }));
            cv.text(v.live ? 'Live car data' : (s.demo ? 'Demo data' : 'No car data: needles parked'), mid, 302, 24, t.dim, { align: 'center', literal: true });
            cv.text(v.speedText + ' ' + (s.units === 'kmh' ? 'km/h' : 'mph') + '   ' + Math.round(v.rpm) + ' rpm   ' + v.gearText,
                mid, 350, 32, t.text, { align: 'center', literal: true });
            const extra = [v.oilC !== null ? 'Oil ' + fmtTemp(v.oilC, s.tempUnit) : '', v.boostPsi != null ? 'Boost ' + v.boostPsi.toFixed(1) + ' psi' : '',
                st.budget ? 'Link ' + st.budget : ''].filter(Boolean).join('   ');
            if (extra) cv.text(extra, mid, 388, 22, t.dim, { align: 'center', literal: true });
            // diagnostics: what cluster-render says about each group of layers (a photo of this helps)
            if (s.on) {
                const groups = Object.keys(st.groups).map((n) => {
                    const g = st.groups[n];
                    return n + ' ' + Object.keys(g.counts).map((k) => g.counts[k] + ' ' + k).join('/') + (g.why ? ' (' + g.why + ')' : '');
                }).join(' | ');
                const sweepNote = sweepMsg && Date.now() - sweepMsg.at < 4000 ? '  Sweep: ' + sweepMsg.text : (st.sweeping ? '  Sweeping' : '');
                const lines = ['Layers: ' + st.layers + ' of ' + (st.mode === 'preload' ? 64 : 8) + '   Drawing: ' + (st.mode === 'preload' ? 'pre-loaded' : st.mode) + '   rpm from the car: ' + (v.live ? Math.round(1000 / Math.max(1, v.rpmEvery)) + ' a second' : '-') + sweepNote]
                    .concat(st.preloadOff ? wrap('Pre-loaded off (' + st.preloadOff + ')' + (/memory/.test(st.preloadOff) ? ': other apps on the cluster renderer (maps, say) use its memory; turn one off and restart this' : /too many layers/.test(st.preloadOff) ? ': update cluster-render to 0.4.2 or later' : ''), 74) : [])
                    .concat(wrap(groups, 74))
                    .concat(st.refused ? wrap('Refused ' + st.refused + ': ' + st.lastRefused, 74) : []);
                lines.slice(0, 5).forEach((line, i) => cv.text(line, mid, 420 + i * 22, 17, t.dim, { align: 'center', literal: true }));
            }
            return ui.image('MAIN_GFX', cv);
        });
        // on / off: one press is one change. Presses within TOGGLE_MS of the last are ignored
        // (0.8.0 blocked for seconds turning on, so a second press queued up and turned it off again)
        ui.onClick('BTN_TOGGLE', () => {
            const now = Date.now();
            if (toggling && now - toggling.at < TOGGLE_MS) return;
            toggling = { at: now, on: !S().on };
            settings.set('on', toggling.on);
            if (!started) { started = true; apply(); }
        });
        process.on('exit', () => cluster.stop());
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
function commas(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function fmtTemp(c, unit) { return unit === 'f' ? Math.round(c * 9 / 5 + 32) + ' °F' : Math.round(c) + ' °C'; }
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;

