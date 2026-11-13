import Foundation

/// Any JSON value, for reading the board tolerantly: each element is read
/// field by field, so one the app can't read is dropped on its own.
public enum BoardJSON: Decodable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([BoardJSON])
    case object([String: BoardJSON])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([BoardJSON].self) { self = .array(a) }
        else if let o = try? c.decode([String: BoardJSON].self) { self = .object(o) }
        else { self = .null }
    }

    public subscript(key: String) -> BoardJSON? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public var string: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    /// A non-empty string, trimmed.
    public var text: String? {
        guard let s = string?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return s
    }

    /// A finite number.
    public var number: Double? {
        if case .number(let n) = self, n.isFinite { return n }
        return nil
    }

    public var array: [BoardJSON]? {
        if case .array(let a) = self { return a }
        return nil
    }

    public var bool: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }
}

extension BoardSnapshot: Decodable {
    public init(from decoder: Decoder) throws {
        let json = try BoardJSON(from: decoder)
        self = BoardDecoding.snapshot(json)
    }
}

/// Reading the server's board JSON into the app's model.
public enum BoardDecoding {
    /// Element sizes the server allows; anything larger is not drawn.
    static let maxCoord = 3 * 16_384.0
    static let maxSize = 4_096.0

    public static func snapshot(_ json: BoardJSON) -> BoardSnapshot {
        let revision = json["revision"]?.number.map { max(0, Int($0)) } ?? 0
        let latest = json["latestRevision"]?.number.map { max(0, Int($0)) } ?? revision
        var refs: [String: BoardRefInfo] = [:]
        if case .object(let raw)? = json["refs"] {
            for (key, value) in raw { if let info = refInfo(value) { refs[key] = info } }
        }
        let touched = (json["touched"]?.array ?? []).compactMap(\.string)
        return BoardSnapshot(
            revision: revision,
            latestRevision: latest,
            updatedAt: json["updatedAt"]?.number ?? 0,
            elements: elements(json["elements"]),
            refs: refs,
            text: json["text"]?.string ?? "",
            touched: touched
        )
    }

    /// Every element that reads, ids unique (the first wins).
    public static func elements(_ json: BoardJSON?) -> [BoardElement] {
        var seen = Set<String>()
        return (json?.array ?? []).compactMap { raw in
            guard let el = element(raw), seen.insert(el.id).inserted else { return nil }
            return el
        }
    }

    public static func refInfo(_ json: BoardJSON) -> BoardRefInfo? {
        guard case .object = json else { return nil }
        guard json["ok"]?.bool == true else {
            return BoardRefInfo(ok: false, reason: json["reason"]?.string ?? "not-found")
        }
        var fields: [String: String] = [:]
        if case .object(let raw)? = json["fields"] {
            for (key, value) in raw {
                if let s = value.string { fields[key] = s } else if let n = value.number { fields[key] = String(format: "%g", n) }
            }
        }
        return BoardRefInfo(
            ok: true,
            kind: json["kind"]?.string,
            title: json["title"]?.text ?? "",
            status: json["status"]?.text ?? "",
            statusTone: json["statusTone"]?.string.flatMap(BoardToken.init(rawValue:)) ?? .ink2,
            url: json["url"]?.text,
            updatedAt: json["updatedAt"]?.string,
            fields: fields
        )
    }

    public static func element(_ json: BoardJSON) -> BoardElement? {
        guard let id = json["id"]?.string, validId(id), let type = json["type"]?.string else { return nil }
        let z = json["z"]?.number.map { Int(max(-1000, min(1000, $0.rounded()))) } ?? 0
        let style = style(json["style"])
        let ref = json["ref"]?.text
        let content: BoardElement.Content
        switch type {
        case "frame":
            guard let box = box(json) else { return nil }
            content = .frame(box, title: json["title"]?.text ?? json["region"]?.text)
        case "text":
            guard let x = coord(json["x"]), let y = coord(json["y"]), let w = size(json["w"]),
                  let role = json["role"]?.string.flatMap(BoardTextRole.init(rawValue:))
            else { return nil }
            content = .text(x: x, y: y, w: w, h: size(json["h"]), role: role,
                            text: json["text"]?.text, sub: json["sub"]?.text, status: json["status"]?.text)
        case "shape":
            guard let box = box(json),
                  let kind = json["kind"]?.string.flatMap(BoardShapeKind.init(rawValue:))
            else { return nil }
            let points = points(json["points"])
            if kind == .line, (points?.count ?? 0) < 2 {
                // A line without points runs along the box's diagonal.
                content = .shape(box, kind: kind, points: [BoardPoint(0, 0), BoardPoint(box.w, box.h)])
            } else {
                content = .shape(box, kind: kind, points: points)
            }
        case "arrow":
            guard let start = arrowEnd(json["start"]), let end = arrowEnd(json["end"]) else { return nil }
            content = .arrow(start: start, end: end, bend: clampBend(json["bend"]?.number ?? 0), label: json["label"]?.text)
        case "stroke":
            guard let box = box(json), let points = points(json["points"]), points.count >= 2 else { return nil }
            content = .stroke(box, points: points)
        case "image":
            guard let box = box(json), let src = json["src"]?.string, BoardImageSource.isAllowed(src) else { return nil }
            content = .image(box, src: src, fit: json["fit"]?.string.flatMap(BoardImageFit.init(rawValue:)) ?? .contain,
                             alt: json["alt"]?.text)
        case "note":
            guard let anchorJSON = json["anchor"], let anchorId = anchorJSON["id"]?.string, validId(anchorId),
                  let anchorSide = side(anchorJSON["side"]), [.top, .right, .bottom, .left].contains(anchorSide),
                  let text = json["text"]?.text
            else { return nil }
            let anchor = BoardNoteAnchor(
                id: anchorId, side: anchorSide,
                dx: max(-400, min(400, anchorJSON["dx"]?.number ?? 0)),
                dy: max(-400, min(400, anchorJSON["dy"]?.number ?? 0))
            )
            var leader: BoardLeader?
            switch json["leader"] {
            case .bool(true)?: leader = BoardLeader()
            case .object?:
                leader = BoardLeader(to: side(json["leader"]?["to"]),
                                     bend: clampBend(json["leader"]?["bend"]?.number ?? 0.12))
            default: leader = nil
            }
            // Notes are ink: a style on one is ignored.
            return BoardElement(id: id, z: z, style: .none, ref: nil,
                                content: .note(anchor: anchor, text: text, leader: leader))
        default:
            return nil
        }
        return BoardElement(id: id, z: z, style: style, ref: ref, content: content)
    }

    static func validId(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 40 && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
    }

    static func coord(_ json: BoardJSON?) -> Double? {
        guard let n = json?.number, abs(n) <= maxCoord else { return nil }
        return n
    }

    static func size(_ json: BoardJSON?) -> Double? {
        guard let n = json?.number, n >= 1, n <= maxSize else { return nil }
        return n
    }

    static func box(_ json: BoardJSON) -> BoardRect? {
        guard let x = coord(json["x"]), let y = coord(json["y"]), let w = size(json["w"]), let h = size(json["h"])
        else { return nil }
        return BoardRect(x: x, y: y, w: w, h: h)
    }

    static func points(_ json: BoardJSON?) -> [BoardPoint]? {
        guard let list = json?.array else { return nil }
        let points = list.compactMap { p -> BoardPoint? in
            guard let pair = p.array, pair.count == 2, let x = coord(pair[0]), let y = coord(pair[1]) else { return nil }
            return BoardPoint(x, y)
        }
        return points.count == list.count ? points : nil
    }

    static func style(_ json: BoardJSON?) -> BoardStyle {
        guard let json else { return .none }
        func token(_ key: String) -> BoardToken? { json[key]?.string.flatMap(BoardToken.init(rawValue:)) }
        return BoardStyle(stroke: token("stroke"), fill: token("fill"), color: token("color"))
    }

    static func side(_ json: BoardJSON?) -> BoardSide? {
        if let s = json?.string {
            switch s {
            case "top": return .top
            case "right": return .right
            case "bottom": return .bottom
            case "left": return .left
            case "center": return .center
            default: return nil
            }
        }
        if let pair = json?.array, pair.count == 2, let fx = pair[0].number, let fy = pair[1].number {
            return .fraction(min(1, max(0, fx)), min(1, max(0, fy)))
        }
        return nil
    }

    static func arrowEnd(_ json: BoardJSON?) -> BoardArrowEnd? {
        guard let json else { return nil }
        if let id = json["id"]?.string, validId(id) { return .element(id: id, side: side(json["side"])) }
        if let x = coord(json["x"]), let y = coord(json["y"]) { return .point(BoardPoint(x, y)) }
        return nil
    }

    static func clampBend(_ bend: Double) -> Double { max(-0.5, min(0.5, bend)) }
}
