import Foundation

/// One step of a sketch path, in board points.
public enum SketchCommand: Sendable, Equatable {
    case move(BoardPoint)
    case curve(BoardPoint, BoardPoint, to: BoardPoint)
}

/// Blob's hand-drawn marks, rough.js style: two slightly offset passes for
/// lines and boxes, one looping pass for ellipses, wobble under 2 pt.
///
/// Seeded: each element's wobble comes from a hash of its id, so it draws
/// the same on every render, device and version, and only changes shape
/// when its geometry does. Redraws (a pan, a zoom, a refresh) never wobble.
/// The maths follows the design's renderer (Paper "Blob · Canvas").
public struct SketchPath: Sendable, Equatable {
    public var commands: [SketchCommand]
    public init(_ commands: [SketchCommand] = []) { self.commands = commands }

    public static func + (a: SketchPath, b: SketchPath) -> SketchPath { SketchPath(a.commands + b.commands) }

    public var bounds: BoardRect? {
        var xs: [Double] = [], ys: [Double] = []
        for c in commands {
            switch c {
            case .move(let p): xs.append(p.x); ys.append(p.y)
            case .curve(let a, let b, let p): xs += [a.x, b.x, p.x]; ys += [a.y, b.y, p.y]
            }
        }
        guard let x0 = xs.min(), let x1 = xs.max(), let y0 = ys.min(), let y1 = ys.max() else { return nil }
        return BoardRect(x: x0, y: y0, w: x1 - x0, h: y1 - y0)
    }
}

/// A small deterministic generator (mulberry32), seeded per element.
public struct SketchRandom: Sendable {
    private var state: UInt32
    public init(seed: UInt32) { state = seed }
    public init(id: String) { self.init(seed: Self.hash(id)) }

    /// FNV-1a over the id's UTF-16 units, as the design's renderer hashes.
    public static func hash(_ s: String) -> UInt32 {
        var h: UInt32 = 2_166_136_261
        for unit in s.utf16 {
            h ^= UInt32(unit)
            h = h &* 16_777_619
        }
        return h
    }

    /// 0 ..< 1.
    public mutating func next() -> Double {
        state = state &+ 0x6D2B_79F5
        var t = state
        t = (t ^ (t >> 15)) &* (1 | t)
        t = (t &+ ((t ^ (t >> 7)) &* (61 | t))) ^ t
        return Double(t ^ (t >> 14)) / 4_294_967_296
    }

    /// A jitter in -m ... m.
    public mutating func jitter(_ m: Double) -> Double { (next() * 2 - 1) * m }
}

public enum Sketch {
    /// A rough line from `a` to `b`, in `passes` slightly offset strokes.
    public static func line(_ r: inout SketchRandom, _ a: BoardPoint, _ b: BoardPoint, passes: Int = 2) -> SketchPath {
        let dx = b.x - a.x, dy = b.y - a.y
        let length = max(hypot(dx, dy), 1)
        let offset = min(length * 0.025, 2.2) + 0.5
        let nx = -dy / length, ny = dx / length
        var out: [SketchCommand] = []
        for pass in 0..<max(1, passes) {
            let o = pass > 0 ? offset * 0.7 : offset
            let s = BoardPoint(a.x + r.jitter(o), a.y + r.jitter(o))
            let e = BoardPoint(b.x + r.jitter(o), b.y + r.jitter(o))
            let m1 = 0.3 + r.next() * 0.2, m2 = 0.6 + r.next() * 0.2
            let b1 = r.jitter(o * 1.3), b2 = r.jitter(o * 1.3)
            out.append(.move(s))
            out.append(.curve(
                BoardPoint(a.x + dx * m1 + nx * b1, a.y + dy * m1 + ny * b1),
                BoardPoint(a.x + dx * m2 + nx * b2, a.y + dy * m2 + ny * b2),
                to: e
            ))
        }
        return SketchPath(out)
    }

    /// A smooth curve through `points` (Catmull-Rom as cubic Béziers).
    public static func through(_ points: [BoardPoint]) -> SketchPath {
        guard let first = points.first else { return SketchPath() }
        var out: [SketchCommand] = [.move(first)]
        for i in 0..<(points.count - 1) {
            let p0 = i > 0 ? points[i - 1] : points[i]
            let p1 = points[i], p2 = points[i + 1]
            let p3 = i + 2 < points.count ? points[i + 2] : p2
            out.append(.curve(
                BoardPoint(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6),
                BoardPoint(p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6),
                to: p2
            ))
        }
        return SketchPath(out)
    }

    /// A rough ellipse in `box`. `loop`: one pass that overshoots its start,
    /// the way a hand circles something.
    public static func ellipse(_ r: inout SketchRandom, in box: BoardRect, loop: Bool, rotation: Double = 0) -> SketchPath {
        let cx = box.midX, cy = box.midY, rx = box.w / 2, ry = box.h / 2
        let ca = cos(rotation), sa = sin(rotation)
        let n = max(8, min(18, Int(((rx + ry) / 8).rounded())))
        let start = -Double.pi * 0.6 + r.jitter(0.3)
        let total = Double.pi * 2 * (loop ? 1.07 : 1.03)
        let wobble = min(0.8, min(rx, ry) * 0.06)
        var points: [BoardPoint] = []
        for i in 0...n {
            let a = start + total * Double(i) / Double(n)
            let k = 1 + r.jitter(0.025) + (loop ? Double(i) / Double(n) * 0.1 : 0)
            let px = cos(a) * rx * k + r.jitter(wobble)
            let py = sin(a) * ry * k + r.jitter(wobble)
            points.append(BoardPoint(cx + px * ca - py * sa, cy + px * sa + py * ca))
        }
        return through(points)
    }

    /// A rough box: four lines, each overshooting its corner a little.
    public static func rect(_ r: inout SketchRandom, _ b: BoardRect) -> SketchPath {
        let o = 2.0
        return line(&r, BoardPoint(b.x - o, b.y), BoardPoint(b.maxX + o, b.y))
            + line(&r, BoardPoint(b.maxX, b.y - o), BoardPoint(b.maxX, b.maxY + o))
            + line(&r, BoardPoint(b.maxX + o, b.maxY), BoardPoint(b.x - o, b.maxY))
            + line(&r, BoardPoint(b.x, b.maxY + o), BoardPoint(b.x, b.y - o))
    }

    public static func diamond(_ r: inout SketchRandom, _ b: BoardRect) -> SketchPath {
        let top = BoardPoint(b.midX, b.y), right = BoardPoint(b.maxX, b.midY)
        let bottom = BoardPoint(b.midX, b.maxY), left = BoardPoint(b.x, b.midY)
        return line(&r, top, right) + line(&r, right, bottom) + line(&r, bottom, left) + line(&r, left, top)
    }

    /// The sketch for one element, or nil when it draws none (text, images,
    /// notes, and anything clean). Arrows and notes' leaders are routed by
    /// `BoardLayout`.
    public static func path(for item: BoardLayout.Item, in layout: BoardLayout) -> SketchPath? {
        let el = item.element
        var r = SketchRandom(id: el.id)
        switch el.content {
        case .shape(let box, let kind, let points):
            guard el.ref == nil else { return nil }
            switch kind {
            case .rect: return rect(&r, box)
            case .diamond: return diamond(&r, box)
            case .ellipse:
                // Small marks (step dots) close neatly; bigger ones circle
                // something, one looping pass, tilted a few degrees.
                let loop = min(box.w, box.h) >= 30
                let tilt = loop ? r.jitter(3) * .pi / 180 : 0
                return ellipse(&r, in: box, loop: loop, rotation: tilt)
            case .line:
                let pts = (points ?? []).map { BoardPoint(box.x + $0.x, box.y + $0.y) }
                var out = SketchPath()
                for i in 0..<max(0, pts.count - 1) {
                    // Short strokes (tallies, ticks) are one confident pass.
                    let passes = pts[i].distance(to: pts[i + 1]) < 40 ? 1 : 2
                    out = out + line(&r, pts[i], pts[i + 1], passes: passes)
                }
                return out
            }
        case .frame(let box, _):
            return el.style.stroke != nil ? rect(&r, box) : nil
        case .stroke(let box, let points):
            return through(points.map { BoardPoint(box.x + $0.x + r.jitter(0.4), box.y + $0.y + r.jitter(0.4)) })
        case .arrow:
            guard let route = layout.arrows[el.id] else { return nil }
            return arrow(&r, route)
        case .note:
            guard let route = layout.leaders[el.id] else { return nil }
            let mid = route.middle + BoardPoint(r.jitter(0.6), r.jitter(0.6))
            return through([route.start, mid, route.end])
        case .text, .image:
            return nil
        }
    }

    /// A curved stroke with a two-line head at its end.
    public static func arrow(_ r: inout SketchRandom, _ route: BoardArrowRoute, head: Double = 9) -> SketchPath {
        var points: [BoardPoint] = []
        for k in 0...8 {
            let p = route.point(at: Double(k) / 8)
            points.append(k > 0 && k < 8 ? p + BoardPoint(r.jitter(0.9), r.jitter(0.9)) : p)
        }
        var out = through(points)
        let t = route.end, before = points[7]
        let angle = atan2(t.y - before.y, t.x - before.x)
        for spread in [-0.45, 0.45] {
            let tip = BoardPoint(t.x - head * cos(angle + spread), t.y - head * sin(angle + spread))
            out = out + line(&r, t, tip, passes: 1)
        }
        return out
    }

    /// A note's seeded tilt, in degrees, within ±1.5°.
    public static func noteTilt(id: String) -> Double {
        var r = SketchRandom(seed: SketchRandom.hash(id) ^ 0x5EED)
        return r.jitter(1.5)
    }
}
