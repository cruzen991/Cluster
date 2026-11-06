'use strict';
/**
 * fx.js - everything on a dial that moves, as ONE layer: the main needle, its hub, the small
 * (fuel or oil) needle and hub, the lit ring and the shift lights.
 *
 * cluster-render lets one app have 8 layers at most (CompositorLimits.per_client), so a dial is
 * two layers: its face (a still image, faces.js) and this. The same description is turned into
 *   shader(spec)            a GLSL ES 1.00 fragment shader for an effect layer the size of the
 *                           face; the state comes in one vec4 uniform, u_v, and the flash from
 *                           the renderer's clock (u_time), so a flash costs no messages;
 *   shade(spec, x, y, st)   the same picture in JavaScript, pixel by pixel, which the
 *                           "redrawn images" mode composites into the face image itself.
 * Keep the two in step: every term of one has its twin in the other.
 *
 * Coordinates: pixels of the face image, y down. Angles: degrees clockwise from 12 o'clock.
 * State: { a: main needle angle, b: small needle angle, lv: shift lights lit (0..n, n+1 = flash),
 *          t: seconds, for the flash }.
 */

const RAD = Math.PI / 180;
const FLASH_HZ = 4;

/* ---------- GLSL helpers ---------- */
const f = (v) => { const s = (Math.round(v * 10000) / 10000).toString(); return /[.e]/.test(s) ? s : s + '.0'; };
const v3 = (c) => 'vec3(' + c.slice(0, 3).map((x) => f(x / 255)).join(', ') + ')';

/** The kite outline of a hollow needle, right half: points in needle space (x right, y down, tip up). */
function kite(n) {
    const hw = n.wid / 2;
    return { T: [0, -n.len - 3], R1: [hw, -n.len * 0.2], R2: [hw * 0.77, n.tail] };
}
/** Outward unit normal and offset of the line through P0, P1 (right half, so outward is +x side). */
function edge(P0, P1) {
    const dx = P1[0] - P0[0], dy = P1[1] - P0[1], l = Math.hypot(dx, dy);
    const nx = dy / l, ny = -dx / l;                  // right-hand normal of P0->P1 (clockwise outline)
    return { nx, ny, c: nx * P0[0] + ny * P0[1] };
}

function shader(spec) {
    const m = spec.main, s = spec.sub, H = spec.hub, SH = spec.subHub, R = spec.ring, L = spec.lights;
    const out = [];
    out.push('#version 100');
    out.push('// cc-fx ' + JSON.stringify(spec));
    out.push('precision highp float;');
    out.push('uniform vec4 u_v;');
    out.push('uniform highp float u_time;');
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
        out.push('    if (u_v.z > ' + f(L.n + 0.5) + ') { c = fract(u_time * ' + f(FLASH_HZ) + ') < 0.5 ? ' + v3(L.cRed) + ' : ' + v3(L.cDim) + '; }');
        out.push('    else if (i + 0.5 > u_v.z) { a = 0.0; }');
        out.push('    over(c, a);');
        out.push('  }');
    }
    if (s) {
        out.push('  { vec2 q = rot(p - vec2(' + f(s.cx) + ', ' + f(s.cy) + '), u_v.y);');
        out.push('    float d = taper(q, ' + f(s.len) + ', ' + f(s.tail) + ', ' + f(s.wid) + ');');
        out.push('    if (d < 8.0) { over(' + v3(m.col.glow) + ', (1.0 - smoothstep(0.0, 6.0, d)) * 0.16); over(' + v3(m.col.edge) + ', 0.5 - d); over(' + v3(m.col.core) + ', -0.7 - d); } }');
        if (SH) out.push('  hub(p - vec2(' + f(s.cx) + ', ' + f(s.cy) + '), ' + hubArgs(SH) + ');');
    }
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
    out.push('  hub(pc, ' + hubArgs(H) + ');');
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
    const m = spec.main, s = spec.sub, R = spec.ring, L = spec.lights;
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
        if (st.lv > L.n + 0.5) c = ((st.t * FLASH_HZ) % 1) < 0.5 ? L.cRed : L.cDim;
        else if (i + 0.5 > st.lv) a = 0;
        over(c, a);
    }
    if (s) {
        const [qx, qy] = rot(x - s.cx, y - s.cy, st.b);
        const d = taper(qx, qy, s.len, s.tail, s.wid);
        if (d < 8) { over(m.col.glow, (1 - sm(0, 6, d)) * 0.16); over(m.col.edge, 0.5 - d); over(m.col.core, -0.7 - d); }
        if (spec.subHub) hub(x - s.cx, y - s.cy, spec.subHub);
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
    hub(pcx, pcy, spec.hub);
    return acc[3] > 0 ? [acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3], acc[3] * 255] : [0, 0, 0, 0];
}
const lerp = (a, b, t) => a + (b - a) * t;

/* ---------- where a state change can change pixels (for the redrawn mode) ---------- */

/** Rectangles (face pixels, unclipped) covering the main needle at angle a: `n` pieces. */
function needleRects(spec, a, n) {
    const m = spec.main, mg = (m.shape === 'hollow' ? m.wid / 2 + 19 : m.wid * 0.7 + 9);
    return pieces(spec.cx, spec.cy, a, m.len + 4, m.tail + 4, mg, n);
}
function subRects(spec, b) {
    const s = spec.sub;
    return s ? pieces(s.cx, s.cy, b, s.len + 2, s.tail + 2, s.wid * 0.7 + 7, 2) : [];
}
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
function dirty(spec, o, n, flashChanged) {
    let r = [];
    if (!o) return [{ x: 0, y: 0, w: spec.w, h: spec.h }];
    if (o.a !== n.a) {
        r = r.concat(pairUp(needleRects(spec, o.a, 8), needleRects(spec, n.a, 8)));
        if (spec.ring) r = r.concat(sectorRects(spec.cx, spec.cy, spec.ring.r, spec.ring.w, Math.max(spec.ring.a0, Math.min(o.a, spec.ring.a1)), Math.max(spec.ring.a0, Math.min(n.a, spec.ring.a1))));
    }
    if (o.b !== n.b) r = r.concat(pairUp(subRects(spec, o.b), subRects(spec, n.b)));
    const L = spec.lights;
    if (L && (o.lv !== n.lv || (n.lv > L.n && flashChanged))) {
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

module.exports = { shader, shade, dirty, clipMerge, fewer, MAX_RECTS, needleRects, sectorRects, FLASH_HZ };
