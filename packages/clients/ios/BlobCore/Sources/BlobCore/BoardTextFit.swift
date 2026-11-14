import Foundation

/// What a text element shows, line by line: the main line in its role, and
/// the supporting line under it (status and sub). A ref element is a card:
/// its live title (or its own text, filled) and its live status. The canvas
/// draws exactly these words, and the layout measures them.
public struct BoardTextBlock: Sendable, Equatable {
    public var title: String?
    public var role: BoardTextRole
    public var status: String?
    public var sub: String?
    /// A clean card for a real object: padded, with a status dot.
    public var card: Bool

    /// Horizontal padding of a card: 12 leading, an 8 pt dot, 10 after it,
    /// 14 trailing. Vertical: 10 above and below.
    public static let cardPadding = BoardSize(44, 20)
    /// Between the main line and the supporting line.
    public static let lineGap = 2.0

    /// The supporting line: status and sub, joined.
    public var tail: String? {
        let parts = [status, sub].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
    }

    public static func of(_ el: BoardElement, refs: [String: BoardRefInfo]) -> BoardTextBlock? {
        guard case .text(_, _, _, _, let role, let text, let sub, let status) = el.content else { return nil }
        guard let refId = el.ref else {
            return BoardTextBlock(title: text, role: role, status: status, sub: sub, card: false)
        }
        let ref = refs[refId] ?? .missing
        let locator = refId.firstIndex(of: ":").map { String(refId[refId.index(after: $0)...]) } ?? ""
        let title = text.map { BoardLiveText.fill($0, ref) }.flatMap { $0.isEmpty ? nil : $0 }
            ?? (ref.ok ? ref.title : locator)
        let statusLine = status.map { BoardLiveText.fill($0, ref) } ?? (ref.ok ? ref.status : "not found")
        let subLine = sub.map { BoardLiveText.fill($0, ref) }
        return BoardTextBlock(title: title, role: .title, status: statusLine,
                              sub: subLine?.isEmpty == true ? nil : subLine, card: true)
    }

    /// The width it needs to set every line on one line, padding included.
    public func naturalWidth(_ measure: BoardLayout.TextMeasure) -> Double {
        let main = title.map { measure($0, role, nil).w } ?? 0
        let support = tail.map { measure($0, .supporting, nil).w } ?? 0
        return max(main, support) + (card ? Self.cardPadding.w : 0)
    }

    /// Its height set in a box `width` wide, the lines wrapping.
    public func height(width: Double, _ measure: BoardLayout.TextMeasure) -> Double {
        let inner = max(1, width - (card ? Self.cardPadding.w : 0))
        let main = title.map { measure($0, role, inner).h }
        let support = tail.map { measure($0, .supporting, inner).h }
        var h = (main ?? 0) + (support ?? 0)
        if main != nil, support != nil { h += Self.lineGap }
        return h + (card ? Self.cardPadding.h : 0)
    }
}

/// SF Pro widths, estimated per character in ems, for when the app can't
/// measure (tests) and for the server's guard (shared/blob-board.ts
/// `charEm`, the same table). Close to the real face at the board's sizes,
/// slightly generous so an estimate wraps no later than the real text.
public enum BoardTextMetrics {
    public static func em(_ c: Character) -> Double {
        switch c {
        case " ": return 0.25
        case "i", "l", "j", "!", "'", ".", ",", ":", ";", "|", "\u{00B7}", "(", ")", "[", "]": return 0.27
        case "f", "t", "r", "I", "-", "/": return 0.35
        case "m", "w": return 0.8
        case "M", "W": return 0.85
        case "0"..."9": return 0.58
        case "A"..."Z": return 0.65
        case "a"..."z": return 0.53
        default:
            return c.isASCII ? 0.55 : 0.9
        }
    }

    /// One line of `text` in `role`, in points.
    public static func width(_ text: String, role: BoardTextRole, scale: Double = 1) -> Double {
        let ems = text.reduce(0.0) { $0 + em($1) }
        return ems * role.size * scale * (role.semibold ? 1.04 : 1)
    }

    /// The estimate as a measure: one line, or greedy word wrap at `width`.
    public static func estimate(scale: Double = 1) -> BoardLayout.TextMeasure {
        { text, role, limit in
            let line = role.lineHeight * scale
            let one = BoardTextMetrics.width(text, role: role, scale: scale)
            guard let limit, one > limit else { return BoardSize(one, line) }
            return BoardSize(limit, Double(BoardTextMetrics.lines(text, role: role, width: limit, scale: scale)) * line)
        }
    }

    /// How many lines greedy word wrap takes at `width`.
    public static func lines(_ text: String, role: BoardTextRole, width limit: Double, scale: Double = 1) -> Int {
        let space = width(" ", role: role, scale: scale)
        var lines = 1
        var used = 0.0
        for word in text.split(separator: " ", omittingEmptySubsequences: true) {
            let w = width(String(word), role: role, scale: scale)
            if used == 0 {
                used = w
            } else if used + space + w <= limit {
                used += space + w
            } else {
                lines += 1
                used = w
            }
            // A word longer than the line breaks across lines.
            while used > limit {
                lines += 1
                used -= limit
            }
        }
        return lines
    }
}

extension BoardLayout {
    /// What the layout changed to keep text readable: widened a box whose
    /// words would wrap, grew one whose words need more height, moved an
    /// element down out of the way of one that grew, or out of a frame's
    /// title band. The app logs them in debug builds; nothing is silent.
    public struct Adjustment: Sendable, Equatable, CustomStringConvertible {
        public enum Kind: String, Sendable { case widened, grew, moved }
        public var id: String
        public var kind: Kind
        /// Points: how much wider, taller or further down.
        public var amount: Double
        /// What it moved for, when it moved.
        public var cause: String?

        public var description: String {
            let by = (amount * 2).rounded() / 2
            return "\(id) \(kind.rawValue) by \(by) pt" + (cause.map { " for \($0)" } ?? "")
        }
    }

    /// The band at the top of a frame its title sits in; elements of the
    /// frame start below it (server: FRAME_TITLE_BAND).
    public static let frameTitleBand = 28.0
    /// Where a frame's title sits inside that band.
    public static let frameTitleInset = BoardPoint(12, 8)
    /// Space kept between an element and one moved down out of its way.
    public static let settleGap = 6.0
    /// Space kept under a frame's last element when the frame grows.
    public static let framePadding = 8.0

    /// Fits every text element to its words, then moves what would sit
    /// under one, so no text overlaps other text and nothing sits in a
    /// frame's title band.
    ///
    /// 1. A box too narrow for its words on one line widens, up to its
    ///    frame's inner edge, the column it is in (the closed Duo's 382 pt
    ///    for the leading column, then the fold, then the open Duo's strip)
    ///    and the next element on its right.
    /// 2. Still too narrow, the words wrap and the box grows taller.
    /// 3. An element a grown box (or a frame's title) now covers moves
    ///    down, with everything it holds (a frame's elements, the sketch
    ///    around a text); a frame grows around what it holds, and moves
    ///    what it then covers in turn.
    static func settleText(
        _ items: inout [Item], refs: [String: BoardRefInfo], measure: TextMeasure,
        hinge: ClosedRange<Double>, closedWidth: Double, openWidth: Double
    ) -> [Adjustment] {
        var adjustments: [Adjustment] = []
        let n = items.count
        let original = items.map(\.frame)
        func area(_ r: BoardRect) -> Double { r.w * r.h }
        func isFrame(_ i: Int) -> Bool { if case .frame = items[i].element.content { return true }; return false }
        func isText(_ i: Int) -> Bool { if case .text = items[i].element.content { return true }; return false }
        func hasTitle(_ i: Int) -> Bool { if case .frame(_, let t?) = items[i].element.content { return !t.isEmpty }; return false }
        /// Solid: what text must not overlap. Unbound sketches are not.
        func solid(_ i: Int) -> Bool {
            guard original[i] != nil else { return false }
            switch items[i].element.content {
            case .text, .frame, .image: return true
            case .shape: return items[i].element.ref != nil
            default: return false
            }
        }

        // The frame each element sits in: the smallest whose box holds its
        // top-left corner.
        let frameIds = items.indices.filter(isFrame)
        var parent = [Int?](repeating: nil, count: n)
        for i in items.indices {
            guard let r = original[i] else { continue }
            if case .note = items[i].element.content { continue }
            var best: Int?
            for f in frameIds where f != i {
                guard let box = original[f] else { continue }
                guard r.x >= box.x - 0.5, r.y >= box.y - 0.5, r.x < box.maxX, r.y < box.maxY else { continue }
                if isFrame(i), !(area(r) < area(box) || (area(r) == area(box) && f < i)) { continue }
                if let b = best, let bb = original[b], area(bb) <= area(box) { continue }
                best = f
            }
            parent[i] = best
        }
        // Sketches move with the element they overlap most (a circle
        // around a text); the rest move with their frame.
        var owner = [Int?](repeating: nil, count: n)
        for i in items.indices where !solid(i) {
            guard let r = original[i] else { continue }
            switch items[i].element.content {
            case .shape, .stroke: break
            default: continue
            }
            var best: (Int, Double)?
            for j in items.indices where j != i && solid(j) && !isFrame(j) {
                guard let o = original[j], r.intersects(o) else { continue }
                let w = min(r.maxX, o.maxX) - max(r.x, o.x), h = min(r.maxY, o.maxY) - max(r.y, o.y)
                if best == nil || w * h > best!.1 { best = (j, w * h) }
            }
            owner[i] = best?.0
        }
        var children = [[Int]](repeating: [], count: n)
        var satellites = [[Int]](repeating: [], count: n)
        for i in items.indices {
            if let o = owner[i] { satellites[o].append(i) } else if let p = parent[i] { children[p].append(i) }
        }
        func isAncestor(_ a: Int, of b: Int) -> Bool {
            var p = parent[b]
            var steps = 0
            while let q = p, steps < n {
                if q == a { return true }
                p = parent[q]
                steps += 1
            }
            return false
        }

        // 1–2. Widen, then wrap and grow.
        for i in items.indices where isText(i) {
            guard var r = items[i].frame, let block = BoardTextBlock.of(items[i].element, refs: refs) else { continue }
            let need = block.naturalWidth(measure) + 2
            if need > r.w + 0.5 {
                var edge: Double
                if r.x < closedWidth { edge = closedWidth } else if r.x < hinge.lowerBound { edge = hinge.lowerBound }
                else if r.x < openWidth { edge = openWidth } else { edge = r.x + max(r.w, 480) }
                edge = max(edge, r.maxX)
                if r.x < hinge.lowerBound { edge = min(edge, max(r.maxX, hinge.lowerBound)) }
                if let p = parent[i], let box = items[p].frame {
                    edge = min(edge, box.maxX - max(4, min(12, r.x - box.x)))
                }
                for j in items.indices where j != i && solid(j) {
                    guard let o = items[j].frame, !isAncestor(j, of: i), !isAncestor(i, of: j) else { continue }
                    if o.y < r.maxY, o.maxY > r.y, o.x >= r.maxX - 0.5 { edge = min(edge, o.x - 8) }
                }
                let room = max(r.w, edge - r.x)
                let wider = min(need.rounded(.up), room)
                if wider > r.w + 0.5 {
                    adjustments.append(Adjustment(id: items[i].element.id, kind: .widened, amount: wider - r.w))
                    r.w = wider
                }
            }
            let measured = block.height(width: r.w, measure)
            if measured > r.h + 0.5 {
                adjustments.append(Adjustment(id: items[i].element.id, kind: .grew, amount: measured - r.h))
                r.h = measured.rounded(.up)
            }
            items[i].frame = r
        }

        // 3. Move down what a grown box or a title band covers.
        func push(_ i: Int, _ dy: Double, depth: Int = 0) {
            guard depth < 32, let r = items[i].frame else { return }
            items[i].frame = r.offsetBy(dx: 0, dy: dy)
            for c in children[i] { push(c, dy, depth: depth + 1) }
            for s in satellites[i] { push(s, dy, depth: depth + 1) }
        }
        func record(_ i: Int, _ kind: Adjustment.Kind, _ amount: Double, cause: Int? = nil) {
            let id = items[i].element.id
            if let k = adjustments.lastIndex(where: { $0.id == id && $0.kind == kind }) {
                adjustments[k].amount += amount
            } else {
                adjustments.append(Adjustment(id: id, kind: kind, amount: amount, cause: cause.map { items[$0].element.id }))
            }
        }
        func moved(_ i: Int, _ dy: Double, for cause: Int) {
            push(i, dy)
            record(i, .moved, dy, cause: cause)
        }
        let order = items.indices.filter(solid).sorted { a, b in
            let (ya, yb) = (original[a]!.y, original[b]!.y)
            return ya != yb ? ya < yb : a < b
        }
        let depth: [Int] = items.indices.map { i in
            var d = 0
            var p = parent[i]
            while let q = p, d < n { d += 1; p = parent[q] }
            return d
        }
        let framesDeepestFirst = frameIds.sorted { depth[$0] > depth[$1] }
        for _ in 0..<64 {
            var changed = false
            for f in frameIds where hasTitle(f) {
                guard let box = items[f].frame else { continue }
                for c in children[f] where solid(c) {
                    guard let r = items[c].frame, r.y < box.y + frameTitleBand - 0.5 else { continue }
                    moved(c, box.y + frameTitleBand - r.y, for: f)
                    changed = true
                }
            }
            for (k, a) in order.enumerated() {
                for b in order[(k + 1)...] {
                    guard let ra = items[a].frame, let rb = items[b].frame else { continue }
                    if isAncestor(a, of: b) || isAncestor(b, of: a) { continue }
                    let ox = min(ra.maxX, rb.maxX) - max(ra.x, rb.x)
                    let oy = min(ra.maxY, rb.maxY) - max(ra.y, rb.y)
                    guard ox > 0.5, oy > 0.5 else { continue }
                    moved(b, ra.maxY + settleGap - rb.y, for: a)
                    changed = true
                }
            }
            for f in framesDeepestFirst {
                guard let box = items[f].frame else { continue }
                // Only what runs past its bottom grows it, with a margin.
                var deepest = box.maxY
                for c in children[f] + children[f].flatMap({ satellites[$0] }) {
                    if let r = items[c].frame { deepest = max(deepest, r.maxY) }
                }
                let bottom = deepest + framePadding
                if deepest > box.maxY + 0.5 {
                    items[f].frame?.h = bottom - box.y
                    record(f, .grew, bottom - box.maxY)
                    changed = true
                }
            }
            if !changed { break }
        }
        return adjustments
    }
}
