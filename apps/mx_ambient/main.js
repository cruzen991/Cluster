'use strict';
/**
 * Ambient Light Lab - finds out what this car's ambient lighting takes from an app, one change at
 * a time, and puts it back. A first step towards a real ambient light app: once we know what the
 * car honours (fixed presets only, or free colours, zones, brightness), that app is built on it.
 *
 * Read first: the screen shows what the car reports (its colour setting, brightness, which services
 * answer). Every button sends one setting the car's own Ambient light menu also sends; every other
 * part of the message says "leave as is". The results (sent / refused, and what the car reported
 * afterwards) are on the screen and in the log.
 *
 * At start the app notes what the car reports; "Put it back how it was" sends that again. If the
 * car never reported its colour, there is nothing to put back: use the car's own Ambient light menu.
 */
const mgu = require('./kit/mgu');
const { Lab, IUK, AMB } = require('./ambient');

mgu.run({
    async start(ctx) {
        const { ui, settings, log, signals } = ctx;
        let iuk = null, amb = null;
        const lab = new Lab({
            setColour: (msg) => (iuk && iuk.proxy ? signals.set(iuk.proxy, 'ambientLightInteriorColour', msg) : Promise.reject(new Error('the colour service is not connected'))),
            setAmb: (f, v) => (amb && amb.proxy ? signals.set(amb.proxy, f, v) : Promise.reject(new Error('the ambient light service is not connected'))),
        }, log);

        iuk = await signals.watch(IUK, '1', { statusAmbientLightInteriorColour: (v) => lab.onColour(v) }, log, { pollMs: 5000 });
        log.info('colour service: ' + (iuk.error ? 'error ' + iuk.error : 'watching'));
        amb = await signals.watch(AMB, '1', {
            brightnessAmbientLight: (v) => lab.onAmb('brightnessAmbientLight', v),
            brightnessAmbientContourLine: (v) => lab.onAmb('brightnessAmbientContourLine', v),
            ambientLightActive: (v) => lab.onAmb('ambientLightActive', v),
            currentInteriorLightProfile: (v) => lab.onAmb('currentInteriorLightProfile', v),
        }, log, { pollMs: 5000 });
        log.info('ambient light service: ' + (amb.error ? 'error ' + amb.error : 'watching'));

        // one action at a time: a press while one is on its way is ignored
        let busy = false;
        const act = (fn) => () => {
            if (busy) return;
            busy = true;
            Promise.resolve().then(fn).catch((e) => log.warn('ambient: ' + e)).then(() => { busy = false; show(); });
            show();
        };
        ui.onClick('BTN_NEXT', act(() => lab.stepPreset(1)));
        ui.onClick('BTN_PREV', act(() => lab.stepPreset(-1)));
        ui.onClick('BTN_HUE', act(() => lab.stepHue(settings.get('hueScale') === 'degrees' ? 'degrees' : 'scale12')));
        // three zones a third of the way round from each other (0-254 each)
        ui.onClick('BTN_ZONES', act(() => lab.zones(0, 85, 170)));
        ui.onClick('BTN_FES', act(() => lab.followDriveMode()));
        ui.onClick('BTN_BRIGHTER', act(() => lab.brightness(10)));
        ui.onClick('BTN_DIMMER', act(() => lab.brightness(-10)));
        ui.onClick('BTN_RESTORE', act(() => lab.restore()));

        function show() {
            lab.avail.iuk = !!(iuk && iuk.available);
            lab.avail.amb = !!(amb && amb.available);
            const L = lab.lines();
            ['S1', 'S2', 'S3', 'S4'].forEach((k, i) => ui.text(k, L[i] || ''));
            ['L1', 'L2', 'L3'].forEach((k, i) => ui.text(k, L[4 + i] || (i === 0 && !lab.attempts.length ? 'Try one button at a time and watch the lights' : '')));
        }
        show();
        setInterval(() => { if (ui.isVisible('MAIN')) show(); }, 1000);
        log.info('ambient light lab started');
    },
});
