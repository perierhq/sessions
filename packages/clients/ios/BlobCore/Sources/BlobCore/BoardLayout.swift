import Foundation

/// Where every element of a board sits, ready to draw: boxes for elements
/// that have one, notes placed beside their anchors, arrows routed between
/// the boxes they bind. Camera-free: the same layout serves every camera,
/// so opening the Duo or panning never moves anything on the board.
///
/// The one move the client makes is the hinge rule (spec "Camera, viewport
/// and the hinge"): text, notes and ref elements never sit in the fold's
/// band at the home camera (board x 455.5–495.5). The server nudges what a
/// reply touches; the layout applies the same smallest move to anything
/// older still on the band, so no text is ever drawn on the fold. Arrows
/// and leaders follow the moved boxes.
public struct BoardLayout: Sendable {
    public struct Item: Sendable, Equatable {
        public var element: BoardElement
        /// Its box on the board; nil for arrows.
        public var frame: BoardRect?
        /// How far the hinge rule moved it, in points.
        public var nudge: Double
    }

    /// Note text size: measured by the app in Blob's hand, estimated here
    /// the way the server does (`noteSize` in shared/blob-board.ts).
    public typealias NoteMeasure = @Sendable (_ text: String) -> BoardSize

    public let items: [Item]
    public let byId: [String: Int]
    /// Arrows and note leaders, routed.
    public let arrows: [String: BoardArrowRoute]
    public let leaders: [String: BoardArrowRoute]
    /// The band text stays off, in board points.
    public let hinge: ClosedRange<Double>

    public static let noteGap = 8.0
    /// A ref element without a height: a title line and a status line.
    public static let refHeight = 58.0

    public init(
        elements: [BoardElement],
        hinge: ClosedRange<Double> = BoardViewport.homeHinge,
        measureNote: NoteMeasure = BoardLayout.estimateNote
    ) {
        self.hinge = hinge
        var items: [Item] = []
        var index: [String: Int] = [:]
        for el in elements {
            index[el.id] = items.count
            items.append(Item(element: el, frame: nil, nudge: 0))
        }
        // Boxes first, then notes, which may anchor to boxes and to notes.
        for i in items.indices {
            guard var frame = Self.ownFrame(items[i].element) else { continue }
            if Self.carriesText(items[i].element) {
                let shift = Self.hingeShift(frame, hinge)
                frame = frame.offsetBy(dx: shift)
                items[i].nudge = shift
            }
            items[i].frame = frame
        }
        func placeNote(_ i: Int, depth: Int) {
            guard items[i].frame == nil, depth < 5,
                  case .note(let anchor, let text, _) = items[i].element.content,
                  let a = index[anchor.id]
            else { return }
            if items[a].frame == nil { placeNote(a, depth: depth + 1) }
            guard let anchorFrame = items[a].frame else { return }
            var frame = Self.noteFrame(anchor: anchor, size: measureNote(text), anchorFrame: anchorFrame)
            let shift = Self.hingeShift(frame, hinge)
            frame = frame.offsetBy(dx: shift)
            items[i].nudge = shift
            items[i].frame = frame
        }
        for i in items.indices { placeNote(i, depth: 0) }
        self.items = items
        self.byId = index

        var arrows: [String: BoardArrowRoute] = [:]
        var leaders: [String: BoardArrowRoute] = [:]
        for item in items {
            switch item.element.content {
            case .arrow(let start, let end, let bend, _):
                if let route = BoardArrowRoute.route(start: start, end: end, bend: bend, frames: { id in
                    index[id].flatMap { items[$0].frame }
                }) { arrows[item.element.id] = route }
            case .note(let anchor, _, let leader?):
                if let noteFrame = item.frame, let a = index[anchor.id], let anchorFrame = items[a].frame {
                    leaders[item.element.id] = BoardArrowRoute.leader(note: noteFrame, anchor: anchorFrame, leader: leader)
                }
            default: break
            }
        }
        self.arrows = arrows
        self.leaders = leaders
    }

    public func item(_ id: String) -> Item? { byId[id].map { items[$0] } }
    public func frame(_ id: String) -> BoardRect? { item(id)?.frame }

    /// Paint order: by z, then board order.
    public var painted: [Item] {
        items.enumerated().sorted { a, b in
            a.element.element.z != b.element.element.z ? a.element.element.z < b.element.element.z : a.offset < b.offset
        }.map(\.element)
    }

    /// Everything the board holds, arrows and leaders included.
    public var bounds: BoardRect? {
        var out: BoardRect?
        func add(_ r: BoardRect) { out = out.map { $0.union(r) } ?? r }
        for item in items { if let f = item.frame { add(f) } }
        for route in arrows.values { add(route.bounds) }
        return out
    }

    /// The box around `ids`, for "Fit what changed": arrows count by their
    /// route.
    public func bounds(of ids: [String]) -> BoardRect? {
        var out: BoardRect?
        for id in ids {
            let r = frame(id) ?? arrows[id]?.bounds
            if let r { out = out.map { $0.union(r) } ?? r }
        }
        return out
    }

    // MARK: Rules

    /// Elements that read as text: the hinge rule keeps them off the fold.
    public static func carriesText(_ el: BoardElement) -> Bool {
        switch el.content {
        case .text, .note: return true
        case .frame, .arrow: return false
        default: return el.ref != nil
        }
    }

    /// A text element's height: given, a ref card's, or its role's line
    /// plus a supporting line.
    public static func textHeight(_ el: BoardElement) -> Double? {
        guard case .text(_, _, _, let h, let role, _, let sub, _) = el.content else { return nil }
        if let h { return h }
        if el.ref != nil { return refHeight }
        return role.lineHeight + (sub != nil ? 18 : 0)
    }

    static func ownFrame(_ el: BoardElement) -> BoardRect? {
        switch el.content {
        case .frame(let r, _), .shape(let r, _, _), .stroke(let r, _), .image(let r, _, _, _): return r
        case .text(let x, let y, let w, _, _, _, _, _):
            return BoardRect(x: x, y: y, w: w, h: textHeight(el) ?? 0)
        case .arrow, .note: return nil
        }
    }

    /// The server's estimate of a note's box: Kalam 16/20, two lines at
    /// most, 180 pt wide at most.
    public static let estimateNote: NoteMeasure = { text in
        let width = Double(text.count) * 8 + 4
        return BoardSize(min(180, width), width > 180 ? 40 : 20)
    }

    /// Where a note sits: outside its anchor's side, 8 pt away, then
    /// shifted by dx, dy.
    public static func noteFrame(anchor: BoardNoteAnchor, size: BoardSize, anchorFrame a: BoardRect) -> BoardRect {
        let (w, h) = (size.w, size.h)
        var x: Double, y: Double
        switch anchor.side {
        case .top: x = a.midX - w / 2; y = a.y - noteGap - h
        case .bottom: x = a.midX - w / 2; y = a.maxY + noteGap
        case .left: x = a.x - noteGap - w; y = a.midY - h / 2
        default: x = a.maxX + noteGap; y = a.midY - h / 2
        }
        return BoardRect(x: x + anchor.dx, y: y + anchor.dy, w: w, h: h)
    }

    /// The smallest horizontal move that takes `frame` off `band`: to the
    /// nearer side, rightwards when the left has no room (server:
    /// `hingeShift`).
    public static func hingeShift(_ frame: BoardRect, _ band: ClosedRange<Double>) -> Double {
        let (a, b) = (band.lowerBound, band.upperBound)
        guard frame.x < b, frame.maxX > a else { return 0 }
        let left = a - frame.maxX
        let right = b - frame.x
        if frame.x + left < 0 { return right }
        return abs(left) <= abs(right) ? left : right
    }
}

/// A routed arrow or leader: a quadratic curve from `start` to `end`
/// through `control`, in board points.
public struct BoardArrowRoute: Sendable, Equatable {
    public var start: BoardPoint
    public var end: BoardPoint
    public var control: BoardPoint

    /// Where the label sits: the curve's middle.
    public var middle: BoardPoint { point(at: 0.5) }

    public func point(at t: Double) -> BoardPoint {
        let a = (1 - t) * (1 - t), b = 2 * t * (1 - t), c = t * t
        return BoardPoint(a * start.x + b * control.x + c * end.x, a * start.y + b * control.y + c * end.y)
    }

    public var bounds: BoardRect {
        let xs = [start.x, end.x, control.x], ys = [start.y, end.y, control.y]
        return BoardRect(x: xs.min()!, y: ys.min()!, w: xs.max()! - xs.min()!, h: ys.max()! - ys.min()!)
    }

    /// How far a bound end keeps from its element's edge.
    public static let gap = 4.0

    /// Route between two ends. A bound end with a side meets that side
    /// (just outside it); without one, the edge facing the other end.
    static func route(
        start: BoardArrowEnd, end: BoardArrowEnd, bend: Double,
        frames: (String) -> BoardRect?
    ) -> BoardArrowRoute? {
        enum End { case fixed(BoardPoint), edge(BoardRect) }
        func resolve(_ e: BoardArrowEnd) -> End? {
            switch e {
            case .point(let p): return .fixed(p)
            case .element(let id, let side):
                guard let f = frames(id) else { return nil }
                return side.map { .fixed(anchorPoint(f, $0, outward: gap)) } ?? .edge(f)
            }
        }
        guard let a = resolve(start), let b = resolve(end) else { return nil }
        func reference(_ e: End) -> BoardPoint {
            switch e { case .fixed(let p): p; case .edge(let f): f.center }
        }
        let s: BoardPoint = switch a {
        case .fixed(let p): p
        case .edge(let f): edgePoint(f, toward: reference(b))
        }
        let t: BoardPoint = switch b {
        case .fixed(let p): p
        case .edge(let f): edgePoint(f, toward: s)
        }
        return curve(from: s, to: t, bend: bend)
    }

    static func curve(from s: BoardPoint, to t: BoardPoint, bend: Double) -> BoardArrowRoute {
        let control = BoardPoint((s.x + t.x) / 2 - (t.y - s.y) * bend, (s.y + t.y) / 2 + (t.x - s.x) * bend)
        return BoardArrowRoute(start: s, end: t, control: control)
    }

    /// A note's leader: from the note's nearest edge to the anchor's
    /// nearest edge (or `leader.to`), 3 pt short at both ends, bowed.
    static func leader(note: BoardRect, anchor: BoardRect, leader: BoardLeader) -> BoardArrowRoute {
        let target = leader.to.map { anchorPoint(anchor, $0, outward: 0) } ?? anchor.clamp(note.center)
        let source = note.clamp(target)
        let d = target - source
        let length = max(hypot(d.x, d.y), 1)
        let u = BoardPoint(d.x / length, d.y / length)
        let s = source + u * 3
        let t = target - u * 3
        let bow = leader.bend * length
        let mid = BoardPoint((s.x + t.x) / 2 - u.y * bow, (s.y + t.y) / 2 + u.x * bow)
        // The quadratic through `mid` at its middle.
        let control = BoardPoint(2 * mid.x - (s.x + t.x) / 2, 2 * mid.y - (s.y + t.y) / 2)
        return BoardArrowRoute(start: s, end: t, control: control)
    }

    /// A side's point on `r`, pushed `outward` from the edge it lies on.
    public static func anchorPoint(_ r: BoardRect, _ side: BoardSide, outward: Double) -> BoardPoint {
        switch side {
        case .top: return BoardPoint(r.midX, r.y - outward)
        case .bottom: return BoardPoint(r.midX, r.maxY + outward)
        case .left: return BoardPoint(r.x - outward, r.midY)
        case .right: return BoardPoint(r.maxX + outward, r.midY)
        case .center: return r.center
        case .fraction(let fx, let fy):
            var p = BoardPoint(r.x + fx * r.w, r.y + fy * r.h)
            if fy == 0 { p.y -= outward } else if fy == 1 { p.y += outward }
            if fx == 0 { p.x -= outward } else if fx == 1 { p.x += outward }
            return p
        }
    }

    /// Where the line from `r`'s centre toward `p` leaves `r`, plus the gap.
    static func edgePoint(_ r: BoardRect, toward p: BoardPoint) -> BoardPoint {
        let c = r.center
        let d = p - c
        guard d.x != 0 || d.y != 0 else { return c }
        let sx = d.x == 0 ? Double.infinity : (r.w / 2) / abs(d.x)
        let sy = d.y == 0 ? Double.infinity : (r.h / 2) / abs(d.y)
        let k = min(sx, sy)
        let length = hypot(d.x, d.y)
        let edge = c + d * k
        return edge + BoardPoint(d.x / length, d.y / length) * gap
    }
}
