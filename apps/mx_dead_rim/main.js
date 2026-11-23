'use strict';
/**
 * Dead Rim - hold the rim of a pit while the dead climb up its lanes. Turn the iDrive knob to move
 * round the rim and shoot down your lane; a grenade clears the pit once a level. An original game
 * in the spirit of the arcade tube shooters, for parked cars (setting "Parked only", on by default).
 *
 * Screens:
 *   MAIN  a menu: Play / Continue, New game, the settings.
 *   GAME  the game alone on the screen ("chrome": false). BACK (the HMI's own) returns to the menu;
 *         the game waits there and carries on with Play.
 *
 * Controls (controls.js): turn the knob to move round the rim. Fire setting "auto" (default): the
 * gun fires on its own and a press throws a grenade. "manual": press to fire, hold for a grenade.
 * Without the controller's own data: turn to pick Left / Fire / Grenade / Right, press to use it.
 *
 * Sound: none (the kit has no way for an app to play audio); the game's moments are only counted.
 *
 * Files: game.js (the rules), draw.js (the picture), controls.js (the controller).
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const Parked = require('./kit/parked');
const { Game } = require('./game');
const { Controls, action } = require('./controls');
const D = require('./draw');

const SPEED = { easy: 0.8, normal: 1, hard: 1.25 };

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const parked = Parked.watch(ctx, log);
        const driving = () => settings.get('parkedOnly') !== false && parked.moving();
        const fireMode = () => (settings.get('fire') === 'manual' ? 'manual' : 'auto');

        /* ---------- the best score, kept in the app's data folder ---------- */
        const bestFile = path.join(ctx.dataDir, 'best.json');
        let best = 0;
        try { best = Number(JSON.parse(fs.readFileSync(bestFile, 'utf8')).best) || 0; } catch (e) { /* first run */ }
        let savedBest = best;
        const saveBest = () => {
            if (game.best <= savedBest) return;
            try { fs.writeFileSync(bestFile, JSON.stringify({ best: game.best })); savedBest = game.best; } catch (e) { log.warn('best score not saved: ' + e.message); }
        };

        const game = new Game({ best, speed: SPEED[settings.get('difficulty')] || 1, fire: fireMode() });
        const counts = {};
        function sfx(type) { counts[type] = (counts[type] || 0) + 1; }

        /* ---------- controller ---------- */
        const ctl = new Controls({ log, reversed: () => settings.get('knob') === 'reversed' });
        let ccuT = 0;
        if (ctx.controller && ctx.controller.onInput) ctx.controller.onInput((v) => { ccuT = Date.now(); ctl.raw(v); });
        ctx.signals.watch('de.bmw.infotainment.controlelements.FrontCCU', '1', {
            statusRotaryEncoderState: (v) => { if (Date.now() - ccuT > 1000) ctl.raw(v); },
        }, log).then((s) => log.info('controller ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        ['BTN_LEFT', 'BTN_FIRE', 'BTN_BOMB', 'BTN_RIGHT'].forEach((b) => ui.onClick(b, () => ctl.barClick(b)));

        /* ---------- menu ---------- */
        const midGame = () => game.state === 'play' || game.state === 'dead' || game.state === 'level';
        function menu() {
            let info;
            if (driving()) info = 'Parked only - the game waits while you drive (Settings: Parked only)';
            else if (midGame()) info = 'Level ' + game.level + ', score ' + game.score + ', ' + game.lives + (game.lives === 1 ? ' life' : ' lives') + ' - Play carries on';
            else info = 'Best score ' + game.best + '. Turn the knob to move round the rim; ' + (fireMode() === 'manual' ? 'press to fire, hold for a grenade' : 'the gun fires itself, press for a grenade');
            ui.text('BTN_PLAY', midGame() ? 'Continue' : 'Play');
            ui.text('MENU_INFO', info);
        }
        ui.onClick('BTN_PLAY', () => ui.open('GAME'));
        ui.onClick('BTN_NEW', () => {
            game.diff = SPEED[settings.get('difficulty')] || 1; game.fireMode = fireMode();
            game.state = 'ready'; game.score = 0; game.setLevel(1, Date.now());
            ui.open('GAME');
        });
        menu();
        setInterval(() => { if (ui.isVisible('MAIN')) menu(); }, 2000);

        /* ---------- run while the game screen is up and the car stands ---------- */
        const shown = () => ui.isVisible('GAME') && (!ui.hasFocus || ui.hasFocus('GAME'));
        let going = false, paused = '', stoppedAt = Date.now();
        function sync() {
            const go = shown() && !driving();
            paused = shown() && driving() ? 'Parked only: the game waits while the car moves' : '';
            if (go !== going) {
                going = go;
                if (ctx.controller) ctx.controller.grab(go);
                ctl.enable(go);
                if (!go) { saveBest(); menu(); stoppedAt = Date.now(); }
                else game.shift(Date.now() - stoppedAt);        // nothing moves on while away
                last = Date.now();
            }
        }
        setInterval(sync, 200);
        if (ui.onFocus) ui.onFocus(() => sync());
        process.on('exit', () => { try { saveBest(); } catch (e) { /* exiting */ } });

        /* ---------- the frame: step the game, then draw ---------- */
        let last = Date.now();
        async function render() {
            const now = Date.now();
            if (going) {
                if (game.state === 'ready' || game.state === 'over') { game.diff = SPEED[settings.get('difficulty')] || 1; game.fireMode = fireMode(); }
                for (const w of ctl.take()) { const a = action(w, game.fireMode); if (a) game.input(a, now); }
                game.step(now - last, now);
                while (game.events.length) { const e = game.events.shift(); sfx(e.type); if (e.type === 'over' || e.type === 'level') saveBest(); }
            }
            last = now;
            const cv = ctx.canvas(D.W, D.H);
            D.frame(cv, game, now, { live: ctl.live, paused, fire: game.fireMode });
            await ui.image('GAME_GFX', cv);
        }
        // every screen refresh with the GPU renderer; 15 a second as PNG frames
        ctx.loop('GAME', 15, render);
        log.info('dead rim started');
    },
});
