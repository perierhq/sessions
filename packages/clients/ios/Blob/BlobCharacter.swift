import SwiftUI

/// What Blob is doing. Each mode sets how lively its outline is, whether its
/// eyes are open or smiling, its halo and its colour.
enum BlobMode: Equatable {
    case quiet, listen, think, speak, you, draw

    fileprivate var targets: (energy: Double, open: Double, smile: Double, halo: Double, sky: Double) {
        switch self {
        case .quiet: (0.25, 0, 0, 0, 0)
        case .listen: (0.6, 1, 0, 1, 0)
        case .think: (0.8, 1, 0, 0, 0)
        case .speak: (1, 1, 1, 0, 0)
        case .you: (0.5, 1, 0, 0.6, 1)
        case .draw: (0.45, 1, 0, 0, 0)
        }
    }
}

/// Where Blob should be and what it should be doing this frame. The physics
/// chases these with springs, so any of them can change mid-move.
struct BlobTargets {
    var mode: BlobMode
    var position: CGPoint
    var size: Double
    /// A point Blob looks at, in the same space as `position`.
    var look: CGPoint?
    /// 0…1 voice loudness: yours while it listens, its own while it speaks.
    var level: Double
    /// Degrees, for hinge effects only.
    var tilt: Double = 0
}

/// A damped spring that keeps its velocity when the target moves.
private struct Spring {
    var x: Double
    var vel: Double = 0
    var target: Double
    let k: Double
    let d: Double

    init(_ v: Double, k: Double, d: Double) { x = v; target = v; self.k = k; self.d = d }

    mutating func step(_ dt: Double) {
        let f = -k * (x - target) - d * vel
        vel += f * dt
        x += vel * dt
    }

    mutating func snap(_ v: Double) { x = v; target = v; vel = 0 }
}

/// Blob's body: springs, blinking, breathing and the living outline. A port of
/// `design/blob-motion/blob.js`, the motion reference; keep the two in step.
///
/// A plain class on purpose. It is advanced from inside a `Canvas` render
/// closure once per frame, and making it observable would re-render the view
/// tree 60 times a second for state nothing else reads.
final class BlobPhysics {
    private var x = Spring(0, k: 120, d: 17)
    private var y = Spring(0, k: 120, d: 17)
    private var size = Spring(48, k: 140, d: 20)
    private var sky = Spring(0, k: 90, d: 18)
    private var open = Spring(0, k: 220, d: 24)
    private var smile = Spring(0, k: 200, d: 24)
    private var lookX = Spring(0, k: 260, d: 22)
    private var lookY = Spring(0, k: 260, d: 22)
    private var energy = Spring(0.25, k: 60, d: 14)
    private var halo = Spring(0, k: 140, d: 20)
    private var pulse = Spring(1, k: 300, d: 14)

    private var t = 0.0
    private var last: Date?
    private var placed = false
    private var mode: BlobMode = .quiet
    private var tilt = 0.0
    private var blinkAt = 2.2
    private var blinkT = -1.0
    private var envelope = 0.0
    private var seed: UInt64 = 7

    /// Where Blob is now, for hit testing.
    var position: CGPoint { CGPoint(x: x.x, y: y.x) }
    var radius: Double { size.x / 2 }

    func advance(to date: Date, targets: BlobTargets) {
        if !placed {
            x.snap(targets.position.x); y.snap(targets.position.y); size.snap(targets.size)
            placed = true
        }
        let dt = min(0.05, max(0, date.timeIntervalSince(last ?? date)))
        last = date
        apply(targets)
        // Fixed substeps keep the springs stable whatever the frame rate.
        let steps = max(1, Int((dt / (1.0 / 240)).rounded(.up)))
        for _ in 0..<steps { step(dt / Double(steps), targets: targets) }
    }

    private func apply(_ targets: BlobTargets) {
        if targets.mode == .you && mode != .you { pulse.x = 1; pulse.vel = 2.2 } // one soft pop, then still
        mode = targets.mode
        tilt = targets.tilt
        let m = mode.targets
        sky.target = m.sky; open.target = m.open; smile.target = m.smile
        energy.target = m.energy; halo.target = m.halo
        x.target = targets.position.x; y.target = targets.position.y; size.target = targets.size
    }

    private func random() -> Double {
        seed = (seed &* 16807) % 2_147_483_647
        return Double(seed) / 2_147_483_647
    }

    private func step(_ dt: Double, targets: BlobTargets) {
        t += dt
        for spring in [\BlobPhysics.x, \.y, \.size, \.sky, \.open, \.smile, \.lookX, \.lookY, \.energy, \.halo, \.pulse] as [ReferenceWritableKeyPath<BlobPhysics, Spring>] {
            self[keyPath: spring].step(dt)
        }
        // Random blinks every 2.5 to 6 s, 140 ms each.
        if t > blinkAt && mode != .quiet { blinkT = 0; blinkAt = t + 2.5 + random() * 3.5 }
        if blinkT >= 0 { blinkT += dt; if blinkT > 0.14 { blinkT = -1 } }
        // The body pulses with the voice: yours while listening, its own while speaking.
        let talking = mode == .speak || mode == .listen
        envelope += ((talking ? targets.level : 0) - envelope) * (1 - exp(-dt * 18))
        // Eyes: a look target wins, thinking glances up and right, listening looks up.
        var lx = 0.0, ly = 0.0
        if mode == .think { lx = 9 + 3 * (sin(t * 1.7) >= 0 ? 1 : -1); ly = -9 }
        else if mode == .listen { ly = -4 }
        if let look = targets.look {
            let dx = look.x - x.x, dy = look.y - y.x, m = max(hypot(dx, dy), 1)
            let reach = min(m / 60, 1)
            lx = dx / m * 12 * reach; ly = dy / m * 10 * reach
        }
        lookX.target = lx; lookY.target = ly
    }

    // MARK: Drawing

    /// Blob's awake colours, from the person's accent (set in Sessions, read
    /// by `AccentStore.hydrate`): a lifted highlight, the fill, and a shade.
    static func accentStops(dark: Bool) -> [(Double, Double, Double)] {
        let fills = AccentStore.shared.theme.fills
        let hex = dark ? fills.dark : fills.light
        let rgb = (Double((hex >> 16) & 0xFF), Double((hex >> 8) & 0xFF), Double(hex & 0xFF))
        func mix(_ c: (Double, Double, Double), _ t: Double, _ by: Double) -> (Double, Double, Double) {
            (c.0 + (t - c.0) * by, c.1 + (t - c.1) * by, c.2 + (t - c.2) * by)
        }
        return [mix(rgb, 255, 0.3), rgb, mix(rgb, 0, 0.18)]
    }

    func draw(in context: inout GraphicsContext, dark: Bool, reduceMotion: Bool) {
        let s0 = size.x
        let vx = reduceMotion ? 0 : x.vel, vy = reduceMotion ? 0 : y.vel
        let stretch = 1 + min(max(hypot(vx, vy) / 2600, 0), 0.22) // stretch along travel
        let angle = atan2(vy, vx)
        let breathe = reduceMotion ? 1 : 1 + 0.018 * sin(t * (mode == .quiet ? 1.4 : 2.2))
        let scale = s0 / 200 * breathe * (reduceMotion ? 1 : pulse.x) * (reduceMotion ? 1 : 1 + 0.035 * envelope)

        // Halo: follows the voice while listening, one soft ring when it needs you.
        let haloOpacity = min(max(halo.x, 0), 1.2)
        if haloOpacity > 0.01 {
            let d = s0 * (1.45 + (reduceMotion || mode != .listen ? 0 : 0.25 * envelope))
            let ring = Path(ellipseIn: CGRect(x: x.x - d / 2, y: y.x - d / 2, width: d, height: d))
            let tint = Self.accentStops(dark: dark)[1]
            let color: Color = sky.x > 0.5 ? Color(red: tint.0 / 255, green: tint.1 / 255, blue: tint.2 / 255).opacity(0.14)
                : (dark ? Color.white.opacity(0.08) : Color.black.opacity(0.05))
            context.fill(ring, with: .color(color.opacity(haloOpacity)))
        }

        var c = context
        c.translateBy(x: x.x, y: y.x)
        c.rotate(by: .degrees(reduceMotion ? 0 : tilt))
        c.scaleBy(x: scale, y: scale)
        c.rotate(by: .radians(angle))
        c.scaleBy(x: stretch, y: 1 / stretch)
        c.rotate(by: .radians(-angle))
        c.translateBy(x: -100, y: -100)

        let body = outline(energy: reduceMotion ? 0 : energy.x, speech: reduceMotion ? 0 : envelope)
        let k = min(max(sky.x, 0), 1)
        let base: [(Double, Double, Double)] = dark
            ? [(255, 255, 255), (218, 218, 218), (189, 189, 189)]
            : [(90, 90, 90), (35, 35, 35), (20, 20, 20)]
        let skyStops = Self.accentStops(dark: dark)
        let stops = zip(base, skyStops).map { a, b in
            Color(red: (a.0 + (b.0 - a.0) * k) / 255, green: (a.1 + (b.1 - a.1) * k) / 255, blue: (a.2 + (b.2 - a.2) * k) / 255)
        }
        c.fill(body, with: .radialGradient(
            Gradient(stops: [.init(color: stops[0], location: 0), .init(color: stops[1], location: 0.6), .init(color: stops[2], location: 1)]),
            center: CGPoint(x: 81, y: 65), startRadius: 0, endRadius: 136
        ))

        // Eyes close into the smile: ovals shrink over the first half, arcs grow over the second.
        let eyeColor: Color = dark && k < 0.5 ? Color(white: 0.11) : .white
        let blink = blinkT >= 0 ? sin(blinkT / 0.14 * .pi) : 0
        let opened = min(max(open.x, 0), 1.1) * (1 - blink)
        let sm = min(max(smile.x, 0), 1)
        let ex = lookX.x, ey = lookY.x
        let ry = max(0.6, 14 * opened * (mode == .you ? 1.2 : 1) * min(max(1 - sm * 2, 0), 1))
        if ry > 1 && opened > 0.06 {
            for cx in [82.0, 124.0] {
                c.fill(Path(ellipseIn: CGRect(x: cx + ex - 9, y: 100 + ey - ry, width: 18, height: ry * 2)), with: .color(eyeColor))
            }
        }
        let curve = 10 + (-14 - 10) * sm // + sleepy lid, - smile
        let arcOpacity = max(min(max(sm * 2 - 1, 0), 1), opened < 0.06 ? 1 : 0)
        if arcOpacity > 0.01 {
            for cx in [82.0, 124.0] {
                var arc = Path()
                arc.move(to: CGPoint(x: cx - 12 + ex, y: 104 + ey))
                arc.addQuadCurve(to: CGPoint(x: cx + 12 + ex, y: 104 + ey), control: CGPoint(x: cx + ex, y: 104 + ey + curve))
                c.stroke(arc, with: .color(eyeColor.opacity(arcOpacity)), style: StrokeStyle(lineWidth: 6 + 2 * sm, lineCap: .round))
            }
        }
    }

    /// A circle with slow travelling lobes, smoothed with Catmull-Rom.
    private func outline(energy: Double, speech: Double) -> Path {
        let n = 40
        let a2 = 0.035 * energy + 0.05 * speech, a3 = 0.025 * energy + 0.03 * speech, a4 = 0.012 * energy
        let points: [CGPoint] = (0..<n).map { i in
            let th = Double(i) / Double(n) * 2 * .pi
            let r = 80 * (1 + a2 * sin(2 * th + t * 0.9) + a3 * sin(3 * th - t * 1.3 + 1.2) + a4 * sin(4 * th + t * 2.1 + 0.4))
            return CGPoint(x: 100 + r * cos(th), y: 100 + r * sin(th))
        }
        var path = Path()
        path.move(to: points[0])
        for i in 0..<n {
            let p0 = points[(i - 1 + n) % n], p1 = points[i], p2 = points[(i + 1) % n], p3 = points[(i + 2) % n]
            path.addCurve(
                to: p2,
                control1: CGPoint(x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6),
                control2: CGPoint(x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6)
            )
        }
        path.closeSubpath()
        return path
    }
}
