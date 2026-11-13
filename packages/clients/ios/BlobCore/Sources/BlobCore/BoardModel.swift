import Foundation

// Blob's board (server: shared/blob-board.ts): one surface in points, built
// from seven primitives. The server validates every element strictly; the
// app decodes a tolerant subset, so an element this build can't read drops
// that element, never the board, and a field the server adds is ignored.

/// A point on the board, or in a view, in points.
public struct BoardPoint: Sendable, Equatable, Hashable {
    public var x: Double
    public var y: Double
    public init(_ x: Double, _ y: Double) { self.x = x; self.y = y }

    public static func + (a: BoardPoint, b: BoardPoint) -> BoardPoint { BoardPoint(a.x + b.x, a.y + b.y) }
    public static func - (a: BoardPoint, b: BoardPoint) -> BoardPoint { BoardPoint(a.x - b.x, a.y - b.y) }
    public static func * (a: BoardPoint, k: Double) -> BoardPoint { BoardPoint(a.x * k, a.y * k) }
    public func distance(to other: BoardPoint) -> Double { hypot(other.x - x, other.y - y) }
}

public struct BoardSize: Sendable, Equatable, Hashable {
    public var w: Double
    public var h: Double
    public init(_ w: Double, _ h: Double) { self.w = w; self.h = h }
}

/// A box on the board: `x`, `y` is its top-left.
public struct BoardRect: Sendable, Equatable, Hashable {
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double
    public init(x: Double, y: Double, w: Double, h: Double) {
        self.x = x; self.y = y; self.w = w; self.h = h
    }

    public var minX: Double { x }
    public var minY: Double { y }
    public var maxX: Double { x + w }
    public var maxY: Double { y + h }
    public var midX: Double { x + w / 2 }
    public var midY: Double { y + h / 2 }
    public var center: BoardPoint { BoardPoint(midX, midY) }

    public func intersects(_ other: BoardRect) -> Bool {
        x < other.maxX && maxX > other.x && y < other.maxY && maxY > other.y
    }

    public func contains(_ p: BoardPoint) -> Bool {
        p.x >= x && p.x <= maxX && p.y >= y && p.y <= maxY
    }

    /// Whether `inner`'s centre lies inside: how the text fallback groups
    /// an element under a frame or a circling shape.
    public func holdsCentre(of inner: BoardRect) -> Bool { contains(inner.center) }

    public func union(_ other: BoardRect) -> BoardRect {
        let x0 = min(x, other.x), y0 = min(y, other.y)
        return BoardRect(x: x0, y: y0, w: max(maxX, other.maxX) - x0, h: max(maxY, other.maxY) - y0)
    }

    public func insetBy(_ d: Double) -> BoardRect {
        BoardRect(x: x + d, y: y + d, w: max(0, w - 2 * d), h: max(0, h - 2 * d))
    }

    public func offsetBy(dx: Double, dy: Double = 0) -> BoardRect {
        BoardRect(x: x + dx, y: y + dy, w: w, h: h)
    }

    /// The point of this box nearest to `p`.
    public func clamp(_ p: BoardPoint) -> BoardPoint {
        BoardPoint(min(max(p.x, x), maxX), min(max(p.y, y), maxY))
    }
}

/// The palette: elements name a token, never a colour, so the board draws
/// in light and dark without edits.
public enum BoardToken: String, Sendable, CaseIterable {
    case ink, ink2, tangerine, green, red, amber, quiet

    /// The token's colour as 0xRRGGBB and an alpha, in light or dark.
    /// `quiet` is a tint of ink (5%) or white (7%).
    public func rgba(dark: Bool) -> (rgb: UInt32, alpha: Double) {
        switch (self, dark) {
        case (.ink, false): (0x1A1A1A, 1)
        case (.ink, true): (0xE9E9E9, 1)
        case (.ink2, false): (0x646464, 1)
        case (.ink2, true): (0xA2A2A2, 1)
        case (.tangerine, false): (0xD3571C, 1)
        case (.tangerine, true): (0xEB6221, 1)
        case (.green, false): (0x009740, 1)
        case (.green, true): (0x00BC52, 1)
        case (.red, false): (0xDE3334, 1)
        case (.red, true): (0xFC4A47, 1)
        case (.amber, false): (0x9A6700, 1)
        case (.amber, true): (0xD29922, 1)
        case (.quiet, false): (0x1A1A1A, 0.05)
        case (.quiet, true): (0xFFFFFF, 0.07)
        }
    }
}

public struct BoardStyle: Sendable, Equatable, Hashable {
    public var stroke: BoardToken?
    public var fill: BoardToken?
    public var color: BoardToken?
    public init(stroke: BoardToken? = nil, fill: BoardToken? = nil, color: BoardToken? = nil) {
        self.stroke = stroke; self.fill = fill; self.color = color
    }
    public static let none = BoardStyle()
}

/// The type scale. Text is always SF Pro in one of these roles.
public enum BoardTextRole: String, Sendable, CaseIterable {
    case stat, title, supporting, meta, say

    public var size: Double {
        switch self { case .stat: 28; case .title: 14; case .supporting: 13; case .meta: 11; case .say: 17 }
    }

    public var lineHeight: Double {
        switch self { case .stat: 32; case .title: 17; case .supporting: 16; case .meta: 13; case .say: 22 }
    }

    /// Only the item title is semibold.
    public var semibold: Bool { self == .title }

    /// Supporting text and meta lines are secondary ink unless styled.
    public var defaultToken: BoardToken { self == .supporting || self == .meta ? .ink2 : .ink }
}

/// Where an arrow end or a leader meets an element: a side's midpoint, the
/// centre, or fractions of its box.
public enum BoardSide: Sendable, Equatable, Hashable {
    case top, right, bottom, left, center
    case fraction(Double, Double)
}

public enum BoardShapeKind: String, Sendable { case rect, ellipse, diamond, line }

public enum BoardImageFit: String, Sendable { case contain, cover }

public enum BoardArrowEnd: Sendable, Equatable, Hashable {
    /// Bound to an element; `side` nil routes to the edge facing the other end.
    case element(id: String, side: BoardSide?)
    case point(BoardPoint)

    public var elementId: String? {
        if case .element(let id, _) = self { return id }
        return nil
    }
}

public struct BoardNoteAnchor: Sendable, Equatable, Hashable {
    public var id: String
    /// top, right, bottom or left.
    public var side: BoardSide
    public var dx: Double
    public var dy: Double
    public init(id: String, side: BoardSide, dx: Double = 0, dy: Double = 0) {
        self.id = id; self.side = side; self.dx = dx; self.dy = dy
    }
}

public struct BoardLeader: Sendable, Equatable, Hashable {
    /// A side or fractions of the anchor; nil goes to its nearest edge.
    public var to: BoardSide?
    public var bend: Double
    public init(to: BoardSide? = nil, bend: Double = 0.12) { self.to = to; self.bend = bend }
}

/// One element on the board.
public struct BoardElement: Sendable, Equatable, Identifiable {
    public var id: String
    /// Paint order; higher is on top.
    public var z: Int
    public var style: BoardStyle
    /// `kind:locator` of a real object: drawn clean and tappable.
    public var ref: String?
    public var content: Content

    public enum Content: Sendable, Equatable {
        case frame(BoardRect, title: String?)
        /// `h` nil: the engine measures it (`BoardLayout.textHeight`).
        case text(x: Double, y: Double, w: Double, h: Double?, role: BoardTextRole,
                  text: String?, sub: String?, status: String?)
        case shape(BoardRect, kind: BoardShapeKind, points: [BoardPoint]?)
        case arrow(start: BoardArrowEnd, end: BoardArrowEnd, bend: Double, label: String?)
        /// Points relative to the box's top-left.
        case stroke(BoardRect, points: [BoardPoint])
        case image(BoardRect, src: String, fit: BoardImageFit, alt: String?)
        /// No box of its own: placed beside its anchor (`BoardLayout`).
        case note(anchor: BoardNoteAnchor, text: String, leader: BoardLeader?)
    }

    public init(id: String, z: Int = 0, style: BoardStyle = .none, ref: String? = nil, content: Content) {
        self.id = id; self.z = z; self.style = style; self.ref = ref; self.content = content
    }

    public var typeName: String {
        switch content {
        case .frame: "frame"
        case .text: "text"
        case .shape: "shape"
        case .arrow: "arrow"
        case .stroke: "stroke"
        case .image: "image"
        case .note: "note"
        }
    }

    /// Clean (a real object you can open) or sketchy (Blob's own mark).
    public var isClean: Bool { ref != nil }

    public var noteAnchorId: String? {
        if case .note(let anchor, _, _) = content { return anchor.id }
        return nil
    }
}

/// A ref's live fields as the server resolved them, or why it shows as
/// plain text ("not found").
public struct BoardRefInfo: Sendable, Equatable {
    public var ok: Bool
    public var kind: String?
    public var title: String
    public var status: String
    public var statusTone: BoardToken
    public var url: String?
    public var updatedAt: String?
    public var fields: [String: String]
    /// `not-found`, `limit` or `unavailable` when not ok.
    public var reason: String?

    public init(ok: Bool, kind: String? = nil, title: String = "", status: String = "",
                statusTone: BoardToken = .ink2, url: String? = nil, updatedAt: String? = nil,
                fields: [String: String] = [:], reason: String? = nil) {
        self.ok = ok; self.kind = kind; self.title = title; self.status = status
        self.statusTone = statusTone; self.url = url; self.updatedAt = updatedAt
        self.fields = fields; self.reason = reason
    }

    public static let missing = BoardRefInfo(ok: false, reason: "not-found")

    /// `{ref.field}` for this object, or "" when it has none.
    public func field(_ name: String) -> String {
        guard ok else { return "" }
        switch name {
        case "title": return title
        case "status": return status
        case "statusTone": return statusTone.rawValue
        case "url": return url ?? ""
        case "updatedAt": return updatedAt ?? ""
        default: return fields[name] ?? ""
        }
    }
}

/// `GET /api/supervisor/board[?revision=]`: the board at a revision, its
/// refs' live fields and its plain-text rendering.
public struct BoardSnapshot: Sendable, Equatable {
    public var revision: Int
    public var latestRevision: Int
    /// Milliseconds since the epoch.
    public var updatedAt: Double
    public var elements: [BoardElement]
    public var refs: [String: BoardRefInfo]
    public var text: String
    /// What the reply that wrote this revision added, updated or moved
    /// (`/board/versions`), for "Fit what changed". Empty when unknown.
    public var touched: [String]

    public init(revision: Int = 0, latestRevision: Int = 0, updatedAt: Double = 0,
                elements: [BoardElement] = [], refs: [String: BoardRefInfo] = [:],
                text: String = "", touched: [String] = []) {
        self.revision = revision; self.latestRevision = latestRevision; self.updatedAt = updatedAt
        self.elements = elements; self.refs = refs; self.text = text; self.touched = touched
    }

    public var isEmpty: Bool { elements.isEmpty }

    public func ref(_ ref: String?) -> BoardRefInfo? {
        guard let ref else { return nil }
        return refs[ref] ?? .missing
    }
}

// MARK: - Live fields

public enum BoardLiveText {
    /// `text` with every `{ref.field}` filled from `ref`; without a resolved
    /// ref the token reads as nothing.
    public static func fill(_ text: String, _ ref: BoardRefInfo?) -> String {
        guard text.contains("{ref.") else { return text }
        var out = ""
        var rest = Substring(text)
        while let open = rest.range(of: "{ref.") {
            out += rest[..<open.lowerBound]
            let after = rest[open.upperBound...]
            guard let close = after.firstIndex(of: "}") else {
                out += rest[open.lowerBound...]
                rest = ""
                break
            }
            let name = after[..<close]
            if !name.isEmpty, name.allSatisfy({ $0.isLetter }) {
                out += ref?.field(String(name)) ?? ""
            } else {
                out += rest[open.lowerBound...close]
            }
            rest = after[after.index(after: close)...]
        }
        out += rest
        return out.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}
