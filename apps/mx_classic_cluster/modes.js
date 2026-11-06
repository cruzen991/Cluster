'use strict';
/** modes.js - the drive mode as text. */
/* the driving experience switch's mode (FES statusFESVehicleDynamicSwitchHMI), as names or wire numbers,
 * the same table the idrive7-apps Live Data app reads it with; null: no mode to show */
const MODES = { SPORT_DYNAMIC: 'Sport', SPORT_EXPERT: 'Sport Plus', ECO_PRO_EFFICIENT: 'Eco Pro', 1: 'Sport', 2: 'Sport Plus',
    3: 'Sport Individual', 4: 'Comfort', 5: 'Comfort Plus', 6: 'Comfort Individual', 7: 'Eco Pro', 8: 'Eco Pro Plus',
    9: 'Eco Pro Individual', 10: 'Adaptive' };
function modeOf(x) {
    if (x === undefined || x === null) return null;
    if (Object.prototype.hasOwnProperty.call(MODES, x)) return MODES[x];
    const m = /^(SPORT|COMFORT|ECO_PRO|ADAPTIVE)/.exec(String(x));
    return m ? String(x).toLowerCase().split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') : null;
}

module.exports = { modeOf, MODES };
