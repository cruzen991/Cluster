'use strict';
/**
 * fx.js - everything on a dial that moves, as ONE layer: the main needle, its hub, the small
 * (fuel or oil) needle and hub, the lit ring and the shift lights.
 *
 * cluster-render lets one app have 8 layers at most (CompositorLimits.per_client), so a dial is
 * two layers: its face (a still image, faces.js) and this. The same description is turned into
 *   shader(spec)            a GLSL ES 1.00 fragment shader for an effect layer the size of the
 *                           face; the whole state comes in one vec4 uniform, u_v;
 *   shade(spec, x, y, st)   the same picture in JavaScript, pixel by pixel, which the
 *                           "redrawn images" mode composites into the face image itself.
 * Keep the two in step: every term of one has its twin in the other.
 *
 * Coordinates: pixels of the face image, y down. Angles: degrees clockwise from 12 o'clock.
 * State (u_v): { a (x): main needle angle, b (y) and c (w): the small needles' angles,
 *          lv (z): shift lights lit, 0..n; n+1 all lit (flash on), n+2 all dim (flash off) }.
 * The app turns the flash on and off by sending lv: nothing here depends on a clock, so the
 * shader needs no highp (many embedded GPUs have none in fragment shaders, and a shader that
 * demands it does not compile there: that is why 0.7.0's shader needles did not show).
 */

const RAD = Math.PI / 180;
const FLASH_HZ = 4;

/* ---------- GLSL helpers ---------- */
const f = (v) => { const s = (Math.round(v * 10000) / 10000).toString(); return /[.e]/.test(s) ? s : s + '.0'; };
const v3 = (c) => 'vec3(' + c.slice(0, 3).map((x) => f(x / 255)).join(', ') + ')';

/** The kite outline of a hollow needle, right half: points in needle space (x right, y down, tip up). */
function kite(n) {
    const hw = n.wid / 2;
    // n.inner: a needle that starts that far out from the pivot (the arc style's, around the gear);
    // its tail is then -inner, so the cap below cuts it there
    // widest: where along it the needle is widest (0 = its base, 1 = the tip; 0.3 by default); base: its
    // width at the base as a share of the widest (0.77)
    if (n.inner) return { T: [0, -n.len - 3], R1: [hw, -(n.inner + (n.len - n.inner) * (n.widest == null ? 0.3 : n.widest))], R2: [hw * (n.base == null ? 0.77 : n.base), -n.inner] };
    return { T: [0, -n.len - 3], R1: [hw, -n.len * 0.2], R2: [hw * 0.77, n.tail] };
}
/** Outward unit normal and offset of the line through P0, P1 (right half, so outward is +x side). */
function edge(P0, P1) {
    const dx = P1[0] - P0[0], dy = P1[1] - P0[1], l = Math.hypot(dx, dy);
    const nx = dy / l, ny = -dx / l;                  // right-hand normal of P0->P1 (clockwise outline)
    return { nx, ny, c: nx * P0[0] + ny * P0[1] };
}

function shader(spec) {
    const m = spec.main, H = spec.hub, SH = spec.subHub, R = spec.ring, L = spec.lights;
    const out = [];
    out.push('#version 100');
    out.push('// cc-fx ' + JSON.stringify(spec));
    // highp where the GPU has it, else mediump (as cluster-render's own examples do)
    out.push('#ifdef GL_FRAGMENT_PRECISION_HIGH');
    out.push('precision highp float;');
    out.push('#else');
    out.push('precision mediump float;');
    out.push('#endif');
    out.push('uniform vec4 u_v;');
    out.push('varying vec2 v_uv;');
    out.push('vec4 acc;');
    out.push('void over(vec3 c, float a) { a = clamp(a, 0.0, 1.0); acc = vec4(c * a + acc.rgb * (1.0 - a), a + acc.a * (1.0 - a)); }');
    out.push('vec2 rot(vec2 p, float ang) { float r = radians(ang); float c = cos(r), s = sin(r); return vec2(c * p.x + s * p.y, c * p.y - s * p.x); }');
    // tapered needle: returns signed distance
    out.push('float taper(vec2 q, float len, float tail, float wid) {');
    out.push('  float hw = q.y <= 0.0 ? mix(wid * 0.14, wid * 0.5, clamp((q.y + len) / len, 0.0, 1.0)) : mix(wid * 0.5, wid * 0.7, clamp(q.y / tail, 0.0, 1.0));');
    out.push('  return max(abs(q.x) - hw, max(-len - q.y, q.y - tail)); }');
    out.push('void hub(vec2 p, float r, vec3 fill, vec3 ring, float rw, float r1, vec3 c1, float r2, vec3 c2) {');
    out.push('  float d = length(p);');
    out.push('  over(fill, r + 0.5 - d);');
    out.push('  over(ring, min(r + 0.5 - d, d - (r - rw) + 0.5));');
    out.push('  if (r1 > 0.0) over(c1, r1 + 0.5 - d);');
    out.push('  if (r2 > 0.0) over(c2, r2 + 0.5 - d); }');
    out.push('void main() {');
    out.push('  acc = vec4(0.0);');
    out.push('  vec2 p = v_uv * vec2(' + f(spec.w) + ', ' + f(spec.h) + ');');
    out.push('  vec2 pc = p - vec2(' + f(spec.cx) + ', ' + f(spec.cy) + ');');
    out.push('  float rr = length(pc);');
    out.push('  float th = degrees(atan(pc.x, -pc.y));');
    if (R) {
        out.push('  if (abs(rr - ' + f(R.r) + ') < ' + f(R.w / 2 + 1) + ') {');
        out.push('    float band = clamp(' + f(R.w / 2 + 0.5) + ' - abs(rr - ' + f(R.r) + '), 0.0, 1.0);');
        out.push('    float lit = clamp((min(u_v.x, ' + f(R.a1) + ') - th) * ' + f(RAD * R.r) + ' + 0.5, 0.0, 1.0) * clamp((th - ' + f(R.a0) + ') * ' + f(RAD * R.r) + ' + 0.5, 0.0, 1.0);');
        out.push('    over(th > ' + f(R.aRed) + ' ? ' + v3(R.red) + ' : ' + v3(R.lit) + ', band * lit);');
        out.push('  }');
    }
    if (L) {
        const step = (L.a1 - L.a0) / L.n;
        out.push('  if (abs(rr - ' + f(L.r) + ') < ' + f(L.w / 2 + 1) + ' && th > ' + f(L.a0) + ' && th < ' + f(L.a1) + ') {');
        out.push('    float u = (th - ' + f(L.a0) + ') / ' + f(step) + ';');
        out.push('    float i = floor(u);');
        out.push('    float e = min(u - i, i + 1.0 - u) * ' + f(step * RAD * L.r) + ' - ' + f(L.gap * RAD * L.r) + ';');
        out.push('    float a = clamp(' + f(L.w / 2 + 0.5) + ' - abs(rr - ' + f(L.r) + '), 0.0, 1.0) * clamp(e + 0.5, 0.0, 1.0);');
        out.push('    vec3 c = i < ' + f(L.green) + ' ? ' + v3(L.cGreen) + ' : (i < ' + f(L.yellow) + ' ? ' + v3(L.cYellow) + ' : ' + v3(L.cRed) + ');');
        out.push('    if (u_v.z > ' + f(L.n + 0.5) + ') { c = u_v.z < ' + f(L.n + 1.5) + ' ? ' + v3(L.cRed) + ' : ' + v3(L.cDim) + '; }');
        out.push('    else if (i + 0.5 > u_v.z) { a = 0.0; }');
        out.push('    over(c, a);');
        out.push('  }');
    }
    (spec.subs || []).forEach((s) => {
        out.push('  { vec2 q = rot(p - vec2(' + f(s.cx) + ', ' + f(s.cy) + '), u_v.' + s.u + ');');
        out.push('    float d = taper(q, ' + f(s.len) + ', ' + f(s.tail) + ', ' + f(s.wid) + ');');
        out.push('    if (d < 8.0) { over(' + v3(m.col.glow) + ', (1.0 - smoothstep(0.0, 6.0, d)) * 0.16); over(' + v3(m.col.edge) + ', 0.5 - d); over(' + v3(m.col.core) + ', -0.7 - d); } }');
        if (SH) out.push('  hub(p - vec2(' + f(s.cx) + ', ' + f(s.cy) + '), ' + hubArgs(Object.assign({}, SH, { r: s.hr || SH.r })) + ');');
    });
    out.push('  { vec2 q = rot(pc, u_v.x);');
    if (m.shape === 'hollow') {
        const k = kite(m), e1 = edge(k.T, k.R1), e2 = edge(k.R1, k.R2);
        out.push('    vec2 h = vec2(abs(q.x), q.y);');
        out.push('    float d = max(max(' + f(e1.nx) + ' * h.x + ' + f(e1.ny) + ' * h.y - ' + f(e1.c) + ', ' + f(e2.nx) + ' * h.x + ' + f(e2.ny) + ' * h.y - ' + f(e2.c) + '), max(h.y - ' + f(m.tail) + ', -' + f(m.len + 3) + ' - h.y));');
        out.push('    if (d < 16.0) {');
        out.push('      over(' + v3(m.col.glow) + ', ' + f(m.glowA) + ' * exp(-max(d, 0.0) / ' + f(m.glowR) + ') * step(-' + f(m.ow) + ', d) * (1.0 - smoothstep(10.0, 16.0, d)));');
        out.push('      over(' + v3(m.col.fill) + ', ' + f(m.fillA) + ' * clamp(0.5 - d, 0.0, 1.0));');
        out.push('      over(' + v3(m.col.edge) + ', ' + f(m.ow / 2 + 0.5) + ' - abs(d + ' + f(m.ow / 2) + '));');
        out.push('    } }');
    } else {
        out.push('    float d = taper(q, ' + f(m.len) + ', ' + f(m.tail) + ', ' + f(m.wid) + ');');
        out.push('    if (d < 8.0) {');
        out.push('      over(' + v3(m.col.glow) + ', (1.0 - smoothstep(0.0, 7.0, d)) * 0.16);');
        out.push('      over(' + v3(m.col.edge) + ', 0.5 - d);');
        out.push('      float spine = (1.0 - smoothstep(0.6, 1.6, abs(q.x))) * step(-' + f(m.len - 4) + ', q.y) * step(q.y, -' + f(Math.round(m.len * 0.15)) + ');');
        out.push('      over(mix(' + v3(m.col.core) + ', ' + v3(m.col.hi) + ', spine), -0.7 - d);');
        out.push('    } }');
    }
    if (H) out.push('  hub(pc, ' + hubArgs(H) + ');');
    out.push('  gl_FragColor = acc.a > 0.0 ? vec4(acc.rgb / acc.a, acc.a) : vec4(0.0);');
    out.push('}');
    return out.join('\n');
}
function hubArgs(h) {
    return [f(h.r), v3(h.fill), v3(h.ring), f(h.rw), f(h.r1 || 0), v3(h.c1 || [0, 0, 0]), f(h.r2 || 0), v3(h.c2 || [0, 0, 0])].join(', ');
}

/* ---------- the JavaScript twin ---------- */
const cl = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sm = (e0, e1, v) => { const t = cl((v - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

/** Straight RGBA 0..255 of the fx layer at face pixel centre (x, y). */
function shade(spec, x, y, st) {
    const acc = [0, 0, 0, 0];
    const over = (c, a) => {
        a = cl(a); if (a <= 0) return;
        acc[0] = c[0] * a + acc[0] * (1 - a); acc[1] = c[1] * a + acc[1] * (1 - a); acc[2] = c[2] * a + acc[2] * (1 - a);
        acc[3] = a + acc[3] * (1 - a);
    };
    const rot = (px, py, ang) => { const r = ang * RAD, c = Math.cos(r), s = Math.sin(r); return [c * px + s * py, c * py - s * px]; };
    const taper = (qx, qy, len, tail, wid) => {
        const hw = qy <= 0 ? lerp(wid * 0.14, wid * 0.5, cl((qy + len) / len)) : lerp(wid * 0.5, wid * 0.7, cl(qy / tail));
        return Math.max(Math.abs(qx) - hw, Math.max(-len - qy, qy - tail));
    };
    const hub = (px, py, h) => {
        const d = Math.hypot(px, py);
        if (d > h.r + 1) return;
        over(h.fill, h.r + 0.5 - d);
        over(h.ring, Math.min(h.r + 0.5 - d, d - (h.r - h.rw) + 0.5));
        if (h.r1 > 0) over(h.c1, h.r1 + 0.5 - d);
        if (h.r2 > 0) over(h.c2, h.r2 + 0.5 - d);
    };
    const m = spec.main, R = spec.ring, L = spec.lights;
    const pcx = x - spec.cx, pcy = y - spec.cy, rr = Math.hypot(pcx, pcy);
    const th = Math.atan2(pcx, -pcy) / RAD;
    if (R && Math.abs(rr - R.r) < R.w / 2 + 1) {
        const band = cl(R.w / 2 + 0.5 - Math.abs(rr - R.r));
        const lit = cl((Math.min(st.a, R.a1) - th) * RAD * R.r + 0.5) * cl((th - R.a0) * RAD * R.r + 0.5);
        over(th > R.aRed ? R.red : R.lit, band * lit);
    }
    if (L && Math.abs(rr - L.r) < L.w / 2 + 1 && th > L.a0 && th < L.a1) {
        const step = (L.a1 - L.a0) / L.n, u = (th - L.a0) / step, i = Math.floor(u);
        const e = Math.min(u - i, i + 1 - u) * step * RAD * L.r - L.gap * RAD * L.r;
        let a = cl(L.w / 2 + 0.5 - Math.abs(rr - L.r)) * cl(e + 0.5);
        let c = i < L.green ? L.cGreen : i < L.yellow ? L.cYellow : L.cRed;
        if (st.lv > L.n + 0.5) c = st.lv < L.n + 1.5 ? L.cRed : L.cDim;
        else if (i + 0.5 > st.lv) a = 0;
        over(c, a);
    }
    for (const s of spec.subs || []) {
        const ang = s.u === 'w' ? st.c : st.b;
        const [qx, qy] = rot(x - s.cx, y - s.cy, ang);
        const d = taper(qx, qy, s.len, s.tail, s.wid);
        if (d < 8) { over(m.col.glow, (1 - sm(0, 6, d)) * 0.16); over(m.col.edge, 0.5 - d); over(m.col.core, -0.7 - d); }
        if (spec.subHub) hub(x - s.cx, y - s.cy, Object.assign({}, spec.subHub, { r: s.hr || spec.subHub.r }));
    }
    {
        const [qx, qy] = rot(pcx, pcy, st.a);
        if (m.shape === 'hollow') {
            const k = kite(m), e1 = edge(k.T, k.R1), e2 = edge(k.R1, k.R2), hx = Math.abs(qx);
            const d = Math.max(Math.max(e1.nx * hx + e1.ny * qy - e1.c, e2.nx * hx + e2.ny * qy - e2.c), Math.max(qy - m.tail, -(m.len + 3) - qy));
            if (d < 16) {
                over(m.col.glow, m.glowA * Math.exp(-Math.max(d, 0) / m.glowR) * (d >= -m.ow ? 1 : 0) * (1 - sm(10, 16, d)));
                over(m.col.fill, m.fillA * cl(0.5 - d));
                over(m.col.edge, m.ow / 2 + 0.5 - Math.abs(d + m.ow / 2));
            }
        } else {
            const d = taper(qx, qy, m.len, m.tail, m.wid);
            if (d < 8) {
                over(m.col.glow, (1 - sm(0, 7, d)) * 0.16);
                over(m.col.edge, 0.5 - d);
                const spine = (1 - sm(0.6, 1.6, Math.abs(qx))) * (qy >= -(m.len - 4) ? 1 : 0) * (qy <= -Math.round(m.len * 0.15) ? 1 : 0);
                over(m.col.core.map((v, i) => lerp(v, m.col.hi[i], spine)), -0.7 - d);
            }
        }
    }
    if (spec.hub) hub(pcx, pcy, spec.hub);
    return acc[3] > 0 ? [acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3], acc[3] * 255] : [0, 0, 0, 0];
}
const lerp = (a, b, t) => a + (b - a) * t;

/* ---------- the fast compositor (redrawn mode) ----------
 * The same picture as shade(), written straight into an RGBA buffer: trig done once per state
 * instead of once per pixel, each part skipped where it cannot reach, and no allocation per
 * pixel. shade() stays the reference; test.js checks the two agree.
 */
let AR = 0, AG = 0, AB = 0, AA = 0;
function ov(c, a) {
    if (!(a > 0)) return;
    if (a > 1) a = 1;
    const k = 1 - a;
    AR = c[0] * a + AR * k; AG = c[1] * a + AG * k; AB = c[2] * a + AB * k; AA = a + AA * k;
}
function hubPx(px, py, h, r) {
    const d2 = px * px + py * py;
    if (d2 > (r + 1) * (r + 1)) return;
    const d = Math.sqrt(d2);
    ov(h.fill, r + 0.5 - d);
    ov(h.ring, Math.min(r + 0.5 - d, d - (r - h.rw) + 0.5));
    if (h.r1 > 0) ov(h.c1, h.r1 + 0.5 - d);
    if (h.r2 > 0) ov(h.c2, h.r2 + 0.5 - d);
}

/**
 * Composite face + moving parts at state st into `live` (both RGBA, spec.w wide) over the given
 * rectangles; pixels with nothing on them are copied from the face.
 */
function compose(spec, st, face, live, rects) {
    const m = spec.main, R = spec.ring, L = spec.lights, H = spec.hub, SH = spec.subHub;
    const W = spec.w, cx = spec.cx, cy = spec.cy;
    const ra = st.a * RAD, ca = Math.cos(ra), sa = Math.sin(ra);
    const reachM = (m.len + 20) * (m.len + 20);
    const hollow = m.shape === 'hollow';
    let e1, e2;
    if (hollow) { const k = kite(m); e1 = edge(k.T, k.R1); e2 = edge(k.R1, k.R2); }
    const coreHi = m.col.core;
    const subs = (spec.subs || []).map((s) => {
        const ang = (s.u === 'w' ? st.c : st.b) * RAD;
        const reach = Math.max(s.len, s.tail) + 10;
        return { s, c: Math.cos(ang), n: Math.sin(ang), reach2: reach * reach, hr: s.hr || (SH && SH.r) };
    });
    const ringIn = R ? Math.max(0, R.r - R.w / 2 - 1) ** 2 : 0, ringOut = R ? (R.r + R.w / 2 + 1) ** 2 : -1;
    const litTo = R ? Math.min(st.a, R.a1) : 0;
    const lIn = L ? Math.max(0, L.r - L.w / 2 - 1) ** 2 : 0, lOut = L ? (L.r + L.w / 2 + 1) ** 2 : -1;
    const lStep = L ? (L.a1 - L.a0) / L.n : 0;
    const flash = L && st.lv > L.n + 0.5, flashOn = flash && st.lv < L.n + 1.5;
    const hubR2 = H ? (H.r + 1) * (H.r + 1) : -1;

    for (const q of rects) {
        for (let y = q.y; y < q.y + q.h; y++) {
            let i = (y * W + q.x) * 4;
            const py = y + 0.5 - cy;
            for (let x = q.x; x < q.x + q.w; x++, i += 4) {
                const px = x + 0.5 - cx, r2 = px * px + py * py;
                AR = AG = AB = AA = 0;
                if (r2 >= ringIn && r2 <= ringOut) {
                    const rr = Math.sqrt(r2), th = Math.atan2(px, -py) / RAD;
                    const band = cl(R.w / 2 + 0.5 - Math.abs(rr - R.r));
                    const lit = cl((litTo - th) * RAD * R.r + 0.5) * cl((th - R.a0) * RAD * R.r + 0.5);
                    ov(th > R.aRed ? R.red : R.lit, band * lit);
                }
                if (r2 >= lIn && r2 <= lOut) {
                    const rr = Math.sqrt(r2), th = Math.atan2(px, -py) / RAD;
                    if (th > L.a0 && th < L.a1) {
                        const u = (th - L.a0) / lStep, k = Math.floor(u);
                        const e = Math.min(u - k, k + 1 - u) * lStep * RAD * L.r - L.gap * RAD * L.r;
                        let a = cl(L.w / 2 + 0.5 - Math.abs(rr - L.r)) * cl(e + 0.5);
                        let c = k < L.green ? L.cGreen : k < L.yellow ? L.cYellow : L.cRed;
                        if (flash) c = flashOn ? L.cRed : L.cDim;
                        else if (k + 0.5 > st.lv) a = 0;
                        ov(c, a);
                    }
                }
                for (let j = 0; j < subs.length; j++) {
                    const S = subs[j], s = S.s, sx = x + 0.5 - s.cx, sy = y + 0.5 - s.cy;
                    if (sx * sx + sy * sy > S.reach2) continue;
                    const qx = S.c * sx + S.n * sy, qy = S.c * sy - S.n * sx;
                    const hw = qy <= 0 ? lerp(s.wid * 0.14, s.wid * 0.5, cl((qy + s.len) / s.len)) : lerp(s.wid * 0.5, s.wid * 0.7, cl(qy / s.tail));
                    const d = Math.max(Math.abs(qx) - hw, Math.max(-s.len - qy, qy - s.tail));
                    if (d < 8) { ov(m.col.glow, (1 - sm(0, 6, d)) * 0.16); ov(m.col.edge, 0.5 - d); ov(m.col.core, -0.7 - d); }
                    if (SH) hubPx(sx, sy, SH, S.hr);
                }
                if (r2 <= reachM) {
                    const qx = ca * px + sa * py, qy = ca * py - sa * px;
                    if (hollow) {
                        const hx = Math.abs(qx);
                        const d = Math.max(Math.max(e1.nx * hx + e1.ny * qy - e1.c, e2.nx * hx + e2.ny * qy - e2.c), Math.max(qy - m.tail, -(m.len + 3) - qy));
                        if (d < 16) {
                            ov(m.col.glow, m.glowA * Math.exp(-Math.max(d, 0) / m.glowR) * (d >= -m.ow ? 1 : 0) * (1 - sm(10, 16, d)));
                            ov(m.col.fill, m.fillA * cl(0.5 - d));
                            ov(m.col.edge, m.ow / 2 + 0.5 - Math.abs(d + m.ow / 2));
                        }
                    } else {
                        const hw = qy <= 0 ? lerp(m.wid * 0.14, m.wid * 0.5, cl((qy + m.len) / m.len)) : lerp(m.wid * 0.5, m.wid * 0.7, cl(qy / m.tail));
                        const d = Math.max(Math.abs(qx) - hw, Math.max(-m.len - qy, qy - m.tail));
                        if (d < 8) {
                            ov(m.col.glow, (1 - sm(0, 7, d)) * 0.16);
                            ov(m.col.edge, 0.5 - d);
                            const spine = (1 - sm(0.6, 1.6, Math.abs(qx))) * (qy >= -(m.len - 4) ? 1 : 0) * (qy <= -Math.round(m.len * 0.15) ? 1 : 0);
                            const a = -0.7 - d;
                            if (a > 0) { SPINE[0] = lerp(coreHi[0], m.col.hi[0], spine); SPINE[1] = lerp(coreHi[1], m.col.hi[1], spine); SPINE[2] = lerp(coreHi[2], m.col.hi[2], spine); ov(SPINE, a); }
                        }
                    }
                }
                if (H && r2 <= hubR2) hubPx(px, py, H, H.r);
                if (AA <= 0) { live[i] = face[i]; live[i + 1] = face[i + 1]; live[i + 2] = face[i + 2]; live[i + 3] = face[i + 3]; continue; }
                const fr = AR / AA, fg = AG / AA, fb = AB / AA;
                const ba = face[i + 3] / 255, oa = AA + ba * (1 - AA), k = ba * (1 - AA);
                live[i] = Math.round((fr * AA + face[i] * k) / oa);
                live[i + 1] = Math.round((fg * AA + face[i + 1] * k) / oa);
                live[i + 2] = Math.round((fb * AA + face[i + 2] * k) / oa);
                live[i + 3] = Math.round(oa * 255);
            }
        }
    }
}
const SPINE = [0, 0, 0];

/** Every rectangle the moving parts can cover at state st (for the first picture). */
function allRects(spec, st) {
    let r = needleRects(spec, st.a, 8);
    for (const s of spec.subs || []) r = r.concat(subRects(s, s.u === 'w' ? st.c : st.b));
    if (spec.ring && st.a > spec.ring.a0) r = r.concat(sectorRects(spec.cx, spec.cy, spec.ring.r, spec.ring.w, spec.ring.a0, Math.min(st.a, spec.ring.a1)));
    if (spec.lights && st.lv > 0) r = r.concat(sectorRects(spec.cx, spec.cy, spec.lights.r, spec.lights.w, spec.lights.a0, spec.lights.a1));
    return clip(r, spec.w, spec.h);
}

/* ---------- where a state change can change pixels (for the redrawn mode) ---------- */

/** Rectangles (face pixels, unclipped) covering the main needle at angle a: `n` pieces. */
function needleRects(spec, a, n) {
    const m = spec.main, mg = (m.shape === 'hollow' ? m.wid / 2 + 19 : m.wid * 0.7 + 9);
    return pieces(spec.cx, spec.cy, a, m.len + 4, m.tail + 4, mg, n);
}
function subRects(s, b) { return pieces(s.cx, s.cy, b, s.len + 2, s.tail + 2, s.wid * 0.7 + 7, 2); }
function pieces(cx, cy, a, len, tail, mg, n) {
    const s = Math.sin(a * RAD), c = Math.cos(a * RAD), out = [];
    for (let i = 0; i < n; i++) {
        const y0 = -len + (len + tail) * i / n, y1 = -len + (len + tail) * (i + 1) / n;
        const xa = cx - y0 * s, ya = cy + y0 * c, xb = cx - y1 * s, yb = cy + y1 * c;
        const x = Math.floor(Math.min(xa, xb) - mg), y = Math.floor(Math.min(ya, yb) - mg);
        out.push({ x, y, w: Math.ceil(Math.max(xa, xb) + mg) - x, h: Math.ceil(Math.max(ya, yb) + mg) - y });
    }
    return out;
}
/** An annulus sector from angle a0 to a1 (r +- w/2), in pieces of at most 10 degrees. */
function sectorRects(cx, cy, r, w, a0, a1) {
    if (a1 < a0) [a0, a1] = [a1, a0];
    const out = [], n = Math.max(1, Math.ceil((a1 - a0) / 10));
    for (let i = 0; i < n; i++) {
        const b0 = a0 + (a1 - a0) * i / n, b1 = a0 + (a1 - a0) * (i + 1) / n;
        const pts = [];
        [b0, b1, (b0 + b1) / 2].forEach((b) => [r - w / 2 - 2, r + w / 2 + 2].forEach((q) => pts.push([cx + Math.sin(b * RAD) * q, cy - Math.cos(b * RAD) * q])));
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const x = Math.floor(Math.min(...xs)) - 1, y = Math.floor(Math.min(...ys)) - 1;
        out.push({ x, y, w: Math.ceil(Math.max(...xs)) + 1 - x, h: Math.ceil(Math.max(...ys)) + 1 - y });
    }
    return out;
}
/** The rectangles a change from state o to state n touches. */
function dirty(spec, o, n) {
    let r = [];
    if (!o) return [{ x: 0, y: 0, w: spec.w, h: spec.h }];
    if (o.a !== n.a) {
        r = r.concat(pairUp(needleRects(spec, o.a, 8), needleRects(spec, n.a, 8)));
        if (spec.ring) r = r.concat(sectorRects(spec.cx, spec.cy, spec.ring.r, spec.ring.w, Math.max(spec.ring.a0, Math.min(o.a, spec.ring.a1)), Math.max(spec.ring.a0, Math.min(n.a, spec.ring.a1))));
    }
    for (const s of spec.subs || []) {
        const k = s.u === 'w' ? 'c' : 'b';
        if (o[k] !== n[k]) r = r.concat(pairUp(subRects(s, o[k]), subRects(s, n[k])));
    }
    const L = spec.lights;
    if (L && o.lv !== n.lv) {
        const step = (L.a1 - L.a0) / L.n;
        for (let i = 0; i < L.n; i++) {
            const was = o.lv > L.n || i < o.lv, now = n.lv > L.n || i < n.lv;
            if (was !== now || n.lv > L.n) r = r.concat(sectorRects(spec.cx, spec.cy, L.r, L.w, L.a0 + i * step, L.a0 + (i + 1) * step));
        }
    }
    r = clip(r, spec.w, spec.h);
    // overlapping rectangles are fine (the picture is recomposed from scratch in each); but
    // cluster-render writes the whole image when more than 16 are pending (Layer::kMaxRects),
    // so merge down to MAX_RECTS, always the pair whose union adds the least area
    return fewer(r, MAX_RECTS);
}
const MAX_RECTS = 12;
function fewer(r, n) {
    r = r.slice();
    const area = (q) => q.w * q.h;
    const union = (a, b) => { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }; };
    while (r.length > n) {
        let bi = 0, bj = 1, best = Infinity;
        for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
            const c = area(union(r[i], r[j])) - area(r[i]) - area(r[j]);
            if (c < best) { best = c; bi = i; bj = j; }
        }
        r[bi] = union(r[bi], r[bj]);
        r.splice(bj, 1);
    }
    return r;
}
/** Piece i of the old position with piece i of the new one, as one rectangle when that is not much bigger. */
function pairUp(a, b) {
    const out = [];
    a.forEach((p, i) => {
        const q = b[i], x = Math.min(p.x, q.x), y = Math.min(p.y, q.y);
        const u = { x, y, w: Math.max(p.x + p.w, q.x + q.w) - x, h: Math.max(p.y + p.h, q.y + q.h) - y };
        if (u.w * u.h <= 1.3 * (p.w * p.h + q.w * q.h)) out.push(u); else out.push(p, q);
    });
    return out;
}
function clip(rs, W, H) {
    return rs.map((q) => {
        const x0 = Math.max(0, q.x), y0 = Math.max(0, q.y), x1 = Math.min(W, q.x + q.w), y1 = Math.min(H, q.y + q.h);
        return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
    }).filter(Boolean);
}
/** Clip to the image, then merge rectangles that overlap until none do (or one is left). */
function clipMerge(rs, W, H) {
    let r = clip(rs, W, H);
    let merged = true;
    while (merged && r.length > 1) {
        merged = false;
        outer: for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
            const a = r[i], b = r[j];
            if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
                const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
                r[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
                r.splice(j, 1); merged = true; break outer;
            }
        }
    }
    return r;
}

module.exports = { shader, shade, compose, allRects, dirty, clipMerge, fewer, MAX_RECTS, needleRects, sectorRects, FLASH_HZ };
