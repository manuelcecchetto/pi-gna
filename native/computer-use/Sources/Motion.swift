import CoreGraphics
import Foundation

// Agent cursor trajectories: a Swift port of Cua Driver's six cursor motions (github.com/trycua/cua, MIT,
// libs/cua-driver/rust/crates/cursor-overlay/src/trajectory.rs, itself a port of its motion lab). A move is planned once
// as timed samples in global top-left points (y down, like the lab); Overlay plays them back by time. `classic` uses the
// lab's Fitts min-jerk glide instead of Cua's Dubins planner.
//
// MIT License
//
// Copyright (c) 2025 Cua AI, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

enum MotionStyle: String, CaseIterable {
    case signatureArc = "signature_arc", springSettle = "spring_settle", magnetic, cometSwoop = "comet_swoop", adaptive, classic
}

struct MotionSample { var t: Double; var p: CGPoint; var heading: Double }   // t in seconds; heading in radians from rest

struct Trajectory {
    let samples: [MotionSample]
    /// When the hotspot first reaches the target (within 1 pt): the action may go then while a settle keeps playing.
    let arrival: Double
    var duration: Double { samples.last?.t ?? 0 }

    func at(_ t: Double) -> MotionSample {
        guard let first = samples.first, let last = samples.last else { return MotionSample(t: t, p: .zero, heading: 0) }
        if t <= first.t { return first }
        if t >= last.t { return last }
        var lo = 0, hi = samples.count - 1
        while hi - lo > 1 { let mid = (lo + hi) / 2; if samples[mid].t <= t { lo = mid } else { hi = mid } }
        let a = samples[lo], b = samples[hi], f = (t - a.t) / max(b.t - a.t, 1e-9)
        return MotionSample(t: t, p: CGPoint(x: a.p.x + (b.p.x - a.p.x) * f, y: a.p.y + (b.p.y - a.p.y) * f),
                            heading: a.heading + wrapAngle(b.heading - a.heading) * f)
    }
}

private let dtMs = 1000.0 / 120
private let defaultTargetPt = 24.0
private let tipAngle = -0.75 * Double.pi   // the hand's tip at rest points up-left in screen space
private let maxLean = Double.pi / 6

private func dist(_ a: CGPoint, _ b: CGPoint) -> Double { hypot(b.x - a.x, b.y - a.y) }
private func unit(_ a: CGPoint, _ b: CGPoint) -> CGPoint {
    let d = dist(a, b) == 0 ? 1 : dist(a, b)
    return CGPoint(x: (b.x - a.x) / d, y: (b.y - a.y) / d)
}
private func lerp(_ a: CGPoint, _ b: CGPoint, _ t: Double) -> CGPoint { CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t) }

func wrapAngle(_ a: Double) -> Double {
    var r = a.truncatingRemainder(dividingBy: 2 * .pi)
    if r > .pi { r -= 2 * .pi }
    if r < -.pi { r += 2 * .pi }
    return r
}

// MARK: easing and profiles

private func minJerk(_ t: Double) -> Double { t * t * t * (10 - 15 * t + 6 * t * t) }
private func smootherstep(_ t: Double) -> Double { t * t * t * (t * (6 * t - 15) + 10) }
private func inOutCubic(_ t: Double) -> Double { t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2 }
private func inOutSine(_ t: Double) -> Double { 0.5 - 0.5 * cos(.pi * t) }

/// Base profile plus a smooth bump that pushes `over` past the end around `overAt` and settles.
private func bumpProfile(_ base: @escaping (Double) -> Double, over: Double, overAt: Double) -> (Double) -> Double {
    let a = max(overAt * 10, 1.5), b = max((1 - overAt) * 10, 1.5)
    let peak = pow(a / (a + b), a) * pow(b / (a + b), b)
    return { tau in base(tau) + over * pow(tau, a) * pow(1 - tau, b) / peak }
}

/// Damped wobble around the end from `start` on.
private func wobbleProfile(_ base: @escaping (Double) -> Double, amp: Double, cycles: Double, decay: Double, start: Double) -> (Double) -> Double {
    { tau in
        guard tau > start else { return base(tau) }
        let u = (tau - start) / (1 - start)
        let ramp = smootherstep(min(u / 0.18, 1))
        return base(tau) + amp * ramp * exp(-decay * u) * sin(2 * .pi * cycles * u) * pow(1 - u, 2) / max(exp(-decay * 0.12) * 0.77, 1e-6)
    }
}

// MARK: paths

/// A parametric path with an arc-length table so profiles act on distance; past either end it continues along the end
/// tangent, which is how an overshoot leaves the path and comes back.
private struct Path {
    let f: (Double) -> CGPoint
    var us: [Double] = [0], ss: [Double] = [0]
    var length = 0.0
    let p0: CGPoint, p1: CGPoint, t0: CGPoint, t1: CGPoint

    init(_ f: @escaping (Double) -> CGPoint, n: Int = 256) {
        self.f = f
        var prev = f(0)
        for i in 1...n {
            let u = Double(i) / Double(n), p = f(u)
            length += dist(prev, p); us.append(u); ss.append(length); prev = p
        }
        p0 = f(0); p1 = f(1); t0 = unit(f(1e-3), p0); t1 = unit(f(1 - 1e-3), p1)
    }

    func at(_ frac: Double) -> CGPoint {
        if length < 1e-9 { return f(min(max(frac, 0), 1)) }
        if frac > 1 { return CGPoint(x: p1.x + t1.x * (frac - 1) * length, y: p1.y + t1.y * (frac - 1) * length) }
        if frac < 0 { return CGPoint(x: p0.x - t0.x * frac * length, y: p0.y - t0.y * frac * length) }
        let target = frac * length
        var lo = 0, hi = ss.count - 1
        while hi - lo > 1 { let mid = (lo + hi) / 2; if ss[mid] < target { lo = mid } else { hi = mid } }
        let span = ss[hi] - ss[lo] == 0 ? 1 : ss[hi] - ss[lo]
        return f(us[lo] + (us[hi] - us[lo]) * (target - ss[lo]) / span)
    }
}

/// Cua's cubic bezier arc: handles along the chord, deflected sideways by `arcSize` of the distance, `arcFlow` > 0
/// moving the apex toward the destination.
private func cuaPath(_ a: CGPoint, _ b: CGPoint, arcSize: Double, arcFlow: Double, handle: Double = 0.3) -> Path {
    let dx = b.x - a.x, dy = b.y - a.y, len = max(hypot(dx, dy), 1)
    let px = -dy / len, py = dx / len
    let deflection = len * arcSize, flow = (arcFlow + 1) / 2
    let c1d = deflection * (1 - 0.5 * flow), c2d = deflection * (1 - 0.5 * (1 - flow))
    let c1 = CGPoint(x: a.x + dx * handle + px * c1d, y: a.y + dy * handle + py * c1d)
    let c2 = CGPoint(x: b.x - dx * handle + px * c2d, y: b.y - dy * handle + py * c2d)
    return Path({ u in
        let v = 1 - u, k0 = v * v * v, k1 = 3 * v * v * u, k2 = 3 * v * u * u, k3 = u * u * u
        return CGPoint(x: k0 * a.x + k1 * c1.x + k2 * c2.x + k3 * b.x, y: k0 * a.y + k1 * c1.y + k2 * c2.y + k3 * b.y)
    })
}

/// Gentle single-sided quadratic curve.
private func bowPath(_ a: CGPoint, _ b: CGPoint, _ amount: Double) -> Path {
    let d = dist(a, b), u = unit(a, b), m = lerp(a, b, 0.5)
    let c = CGPoint(x: m.x - u.y * amount * d, y: m.y + u.x * amount * d)
    return Path({ t in
        let v = 1 - t
        return CGPoint(x: v * v * a.x + 2 * v * t * c.x + t * t * b.x, y: v * v * a.y + 2 * v * t * c.y + t * t * b.y)
    })
}

// MARK: generators (times in ms, like the lab)

private struct Raw { var t: Double; var p: CGPoint }

private struct MoveCtx {
    let from: CGPoint, aim: CGPoint, targetWidth: Double
    var d: Double { dist(from, aim) }
    /// Bends horizontal moves upward.
    var side: Double { unit(from, aim).x >= 0 ? -1 : 1 }
}

private func sampleTimed(_ duration: Double, _ pos: (Double) -> CGPoint) -> [Raw] {
    let n = max(Int((duration / dtMs).rounded(.up)), 2)
    return (0...n).map { i in let tau = Double(i) / Double(n); return Raw(t: tau * duration, p: pos(tau)) }
}

private func pinEnds(_ s: [Raw], _ ctx: MoveCtx) -> [Raw] {
    var s = s
    if !s.isEmpty { s[0].p = ctx.from; s[s.count - 1].p = ctx.aim }
    return s
}

private func glide(_ ctx: MoveCtx, _ path: Path, _ profile: (Double) -> Double, _ duration: Double) -> [Raw] {
    pinEnds(sampleTimed(duration) { path.at(profile($0)) }, ctx)
}

/// Integrates a speed shape v(s) over the path into a timed glide.
private func speedShaped(_ ctx: MoveCtx, _ path: Path, _ shape: (Double) -> Double, _ duration: Double) -> [Raw] {
    let n = 600
    var ts = [Double](repeating: 0, count: n + 1)
    for i in 1...n { ts[i] = ts[i - 1] + 1 / max(shape((Double(i) - 0.5) / Double(n)), 1e-3) }
    let total = ts[n]
    return pinEnds(sampleTimed(duration) { tau in
        let target = tau * total
        var lo = 0, hi = n
        while hi - lo > 1 { let mid = (lo + hi) / 2; if ts[mid] < target { lo = mid } else { hi = mid } }
        let f = (target - ts[lo]) / max(ts[hi] - ts[lo], 1e-9)
        return path.at((Double(lo) + f) / Double(n))
    }, ctx)
}

private func fittsMs(_ ctx: MoveCtx) -> Double { min(max(50 + 150 * log2(ctx.d / max(ctx.targetWidth, 4) + 1), 180), 1400) }
/// The "director's cut" duration of the hand-tuned styles.
private func dcMs(_ ctx: MoveCtx, _ scale: Double) -> Double { min(max(150 + 120 * log2(ctx.d / ctx.targetWidth + 1), 300), 1000) * scale }

private func signatureArc(_ ctx: MoveCtx) -> [Raw] {
    let path = cuaPath(ctx.from, ctx.aim, arcSize: 0.16 * ctx.side, arcFlow: 0.15)
    return glide(ctx, path, bumpProfile(minJerk, over: min(0.018, 8 / max(ctx.d, 1)), overAt: 0.82), dcMs(ctx, 1.1))
}

private func springSettle(_ ctx: MoveCtx) -> [Raw] {
    let path = cuaPath(ctx.from, ctx.aim, arcSize: 0.12 * ctx.side, arcFlow: 0)
    let profile = wobbleProfile({ minJerk(min($0 / 0.68, 1)) }, amp: min(0.05, 6 / max(ctx.d, 1)), cycles: 1.3, decay: 2.6, start: 0.55)
    return glide(ctx, path, profile, dcMs(ctx, 1.35))
}

private func cometSwoop(_ ctx: MoveCtx) -> [Raw] {
    glide(ctx, cuaPath(ctx.from, ctx.aim, arcSize: 0.24 * ctx.side, arcFlow: 0.2), inOutCubic, dcMs(ctx, 1.15))
}

/// Decelerates to a 40 pt capture radius, then the target pulls it in.
private func magnetic(_ ctx: MoveCtx) -> [Raw] {
    let path = bowPath(ctx.from, ctx.aim, 0.04 * ctx.side)
    let len = path.length, radius = min(40, len * 0.5), dt = dtMs / 1000
    var out = [Raw(t: 0, p: ctx.from)]
    var s = 0.0, v = 0.0, t = 0.0
    while s < len && t < 4 {
        let rem = len - s
        if rem > radius { v = min(1500, v + 7000 * dt, 300 + 5.5 * (rem - radius)) }
        else { v += 26000 * 0.45 * (radius / max(rem, 6)) * dt }
        s = min(len, s + v * dt); t += dt
        out.append(Raw(t: t * 1000, p: path.at(s / len)))
    }
    return pinEnds(out, ctx)
}

private func fittsMinJerk(_ ctx: MoveCtx) -> [Raw] { glide(ctx, bowPath(ctx.from, ctx.aim, 0.02 * ctx.side), minJerk, fittsMs(ctx)) }

/// Long throws get a wide swoop; the lab draws its arc from 0.25-0.35, here the middle.
private func keynoteSwoop(_ ctx: MoveCtx) -> [Raw] {
    glide(ctx, cuaPath(ctx.from, ctx.aim, arcSize: 0.3 * ctx.side, arcFlow: 0.2), inOutCubic, min(max(350 + 0.35 * ctx.d, 450), 1100))
}

/// Cruise, then the final 15% at most 35% speed, no overshoot.
private func preciseClick(_ ctx: MoveCtx) -> [Raw] {
    let fp = 0.15, fs = 0.35
    let shape = { (s: Double) -> Double in
        if s < 0.4 { return 0.04 + sin(.pi * s / 0.8) }
        if s < 1 - fp { return 1 - (1 - fs) * inOutSine((s - 0.4) / (0.6 - fp)) }
        return 0.02 + fs * max((1 - s) / fp, 0).squareRoot()
    }
    return speedShaped(ctx, bowPath(ctx.from, ctx.aim, 0.03 * ctx.side), shape, fittsMs(ctx) * 1.2)
}

private func adaptive(_ ctx: MoveCtx) -> [Raw] {
    ctx.targetWidth < 16 ? preciseClick(ctx) : ctx.d > 900 ? keynoteSwoop(ctx) : fittsMinJerk(ctx)
}

// MARK: plan

/// Plans a move of the hotspot from `from` to `to` (global top-left points). `target` is the element's size when the
/// action knows it (timing follows Fitts' law on its smaller side), else a 24 pt box.
func planMove(_ style: MotionStyle, from: CGPoint, to: CGPoint, target: CGSize?) -> Trajectory {
    let w = target.map { max(min($0.width, $0.height), 4) }.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? defaultTargetPt
    let ctx = MoveCtx(from: from, aim: to, targetWidth: w)
    let raw: [Raw]
    switch style {
    case .signatureArc: raw = signatureArc(ctx)
    case .springSettle: raw = springSettle(ctx)
    case .magnetic: raw = magnetic(ctx)
    case .cometSwoop: raw = cometSwoop(ctx)
    case .adaptive: raw = adaptive(ctx)
    case .classic: raw = fittsMinJerk(ctx)
    }
    return finish(raw, to: to, tangent: style != .magnetic)
}

/// Adds the heading channel and a short tail that brings it back to rest, then finds the arrival time. Cua turns its
/// arrow until the tip leads; the hand would turn upside down on a move away from its tip, so it only leans up to 30°
/// toward the direction of travel (most when moving sideways to the tip), once faster than ~40 pt/s, eased so it never snaps.
private func finish(_ raw: [Raw], to: CGPoint, tangent: Bool) -> Trajectory {
    let raw = raw.isEmpty ? [Raw(t: 0, p: to)] : raw
    let n = raw.count
    var rot = 0.0
    var samples: [MotionSample] = []
    for i in 0..<n {
        let a = raw[max(i - 2, 0)], b = raw[min(i + 2, n - 1)]
        let dt = max((b.t - a.t) / 1000, 1e-3)
        let vx = (b.p.x - a.p.x) / dt, vy = (b.p.y - a.p.y) / dt
        let want = tangent ? maxLean * sin(atan2(vy, vx) - tipAngle) * min(max((hypot(vx, vy) - 40) / 260, 0), 1) : 0
        let step = i > 0 ? (raw[i].t - raw[i - 1].t) / 1000 : 0
        rot += (want - rot) * (1 - exp(-step * 22))
        samples.append(MotionSample(t: raw[i].t / 1000, p: raw[i].p, heading: rot))
    }
    let end = samples[samples.count - 1]
    var t = end.t
    for _ in 0..<36 where abs(rot) >= 0.002 {
        t += dtMs / 1000
        rot -= rot * (1 - exp(-dtMs / 1000 * 22))
        samples.append(MotionSample(t: t, p: end.p, heading: rot))
    }
    samples[samples.count - 1].heading = 0
    let arrival = samples.first { dist($0.p, to) <= 1 }?.t ?? samples[samples.count - 1].t
    return Trajectory(samples: samples, arrival: arrival)
}
