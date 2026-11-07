'use strict';
/* node apps/mx_ambient/test.js - the Ambient Light Lab's messages and logic, with a fake car */
const assert = require('assert');
const A = require('./ambient');

/* a message changes only what it means to; everything else says "leave as is" */
{
    const m = A.colourMessage({ menu: 5 }, 'names');
    assert.strictEqual(m.controlMenuAmbientePanoramicRoofInteriorLighting, 'FARBAUSWAHL_5');
    assert.strictEqual(m.controlHueInteriorLighting, 4095);
    assert.strictEqual(m.controlHueValueLayer1IndividualGroup, 255);
    assert.strictEqual(m.controlBrightnessValueBrightnessOffsetAmbientePanoramicRoofInteriorLighting, 255);
    assert.strictEqual(m.controlModeAmbientePanoramicRoofInteriorLighting, 'SIGNAL_UNBEFUELLT');
    assert.strictEqual(m.controlDynamicAmbienteInteriorLighting, 'SIGNAL_UNBEFUELLT');
    assert.strictEqual(Object.keys(m).length, 9, 'every member of the struct');
    const n = A.colourMessage({ hue: 99999, layers: [-5, 300, 10] }, 'numbers');
    assert.strictEqual(n.controlMenuAmbientePanoramicRoofInteriorLighting, 15, 'leave, as a number');
    assert.strictEqual(n.controlHueInteriorLighting, 4094, 'a hue never becomes the "leave" value');
    assert.deepStrictEqual([n.controlHueValueLayer1IndividualGroup, n.controlHueValueLayer2IndividualGroup, n.controlHueValueLayer3IndividualGroup], [0, 254, 10]);
}

/* reading the car's status, names or numbers */
{
    const c = A.readColour({ statusHueInteriorLighting: 4095, statusMenuAmbientePanoramicRoofInteriorLighting: 'FARBAUSWAHL_3', statusHueValueLayer1IndividualGroup: 255,
        statusHueValueLayer2IndividualGroup: 255, statusHueValueLayer3IndividualGroup: 255, statusBrightnessValueBrightnessOffsetAmbientePanoramicRoofInteriorLighting: 255,
        statusModeAmbientePanoramicRoofInteriorLighting: 'EIN', statusDynamicInteriorLighting: 1, statusDynamicAmbienteInteriorLighting: 'AUS' });
    assert.strictEqual(c.menu, 3); assert.strictEqual(c.mode, 1); assert.strictEqual(c.dynamicAmbiente, 0);
    assert.strictEqual(A.describeColour(c), 'colour 3');
    assert.strictEqual(A.describeColour(A.readColour({ statusMenuAmbientePanoramicRoofInteriorLighting: 13, statusHueValueLayer1IndividualGroup: 10, statusHueValueLayer2IndividualGroup: 255, statusHueValueLayer3IndividualGroup: 90 })), 'individual, zones 10/-/90');
    assert.strictEqual(A.readColour(null), null);
}

/* the lab with a fake car: presets step and wrap, restore puts back the first status, names fall back to numbers */
(async () => {
    let t = 1000;
    const sent = [];
    let refuseNames = false;
    const car = {
        now: () => t,
        setColour: (m) => { sent.push(m); if (refuseNames && typeof m.controlMenuAmbientePanoramicRoofInteriorLighting === 'string') return Promise.reject(new Error('invalid enum value')); return Promise.resolve(); },
        setAmb: (f, v) => { sent.push({ [f]: v }); return Promise.resolve(); },
    };
    const lab = new A.Lab(car);
    const r0 = await lab.restore();
    assert.strictEqual(r0.ok, false, 'nothing to restore before the car reported');
    lab.onColour({ statusMenuAmbientePanoramicRoofInteriorLighting: 'FARBAUSWAHL_12', statusHueInteriorLighting: 4095 });
    lab.onAmb('brightnessAmbientLight', 60);
    await lab.stepPreset(1);
    assert.strictEqual(sent[sent.length - 1].controlMenuAmbientePanoramicRoofInteriorLighting, 'FARBAUSWAHL_1', '12 -> 1');
    await lab.stepPreset(-1); await lab.stepPreset(-1);
    assert.strictEqual(sent[sent.length - 1].controlMenuAmbientePanoramicRoofInteriorLighting, 'FARBAUSWAHL_11');
    // the car answers: the attempt shows what it reports
    t += 500; lab.onColour({ statusMenuAmbientePanoramicRoofInteriorLighting: 'FARBAUSWAHL_11' });
    assert(lab.lines().some((l) => /colour 11 -> car now: colour 11/.test(l)), lab.lines().join('\n'));
    // hue steps a twelfth of the circle
    await lab.stepHue('scale12'); await lab.stepHue('scale12');
    assert.strictEqual(sent[sent.length - 1].controlHueInteriorLighting, Math.round(2 * 4094 / 12));
    await lab.stepHue('degrees');
    assert.strictEqual(sent[sent.length - 1].controlHueInteriorLighting, 90);
    await lab.zones(0, 85, 170);
    const z = sent[sent.length - 1];
    assert.strictEqual(z.controlMenuAmbientePanoramicRoofInteriorLighting, 'INDIVIDUALMODUS');
    assert.deepStrictEqual([z.controlHueValueLayer1IndividualGroup, z.controlHueValueLayer2IndividualGroup, z.controlHueValueLayer3IndividualGroup], [0, 85, 170]);
    await lab.brightness(10);
    assert.deepStrictEqual(sent[sent.length - 1], { brightnessAmbientLight: 70 });
    // restore: the first colour and brightness seen
    await lab.restore();
    const back = sent.slice(-2);
    assert(back.some((m) => m.controlMenuAmbientePanoramicRoofInteriorLighting === 'FARBAUSWAHL_12'), 'colour 12 back');
    assert(back.some((m) => m.brightnessAmbientLight === 60), 'brightness back');
    // a binding that refuses enum names: the lab retries as numbers, then stays on numbers
    refuseNames = true;
    const a = await lab.stepPreset(1);
    assert.strictEqual(a.ok, true); assert.strictEqual(lab.style, 'numbers');
    assert.strictEqual(sent[sent.length - 1].controlMenuAmbientePanoramicRoofInteriorLighting, 12, 'after restore it steps on from what the car reports (11)');
    // nothing reported for 4 s: said so
    t += 5000;
    assert(lab.lines().some((l) => /car reported no change/.test(l)));
    // the manifest
    const spec = require('./app.json');
    assert.strictEqual(spec.signals['de.bmw.infotainment.misc.ComfortFunctionIuK'].ambientLightInteriorColour, 'w');
    assert(spec.signals['de.bmw.body.interiorillumination.AmbientLight']._optional, 'a car without the AmbientLight service still installs it');
    console.log('ambient light lab self-check ok');
})().catch((e) => { console.error(e); process.exit(1); });
