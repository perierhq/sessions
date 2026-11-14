import Foundation

/// Finding the real object under a tap.
public enum BoardHitTest {
    public struct Hit: Sendable, Equatable {
        public var id: String
        public var ref: String
        public init(id: String, ref: String) { self.id = id; self.ref = ref }
    }

    /// The topmost ref element whose box holds `point` (board points),
    /// within `slop` of its edge. Sketches, notes and arrows never take a
    /// tap: only real objects open.
    public static func ref(at point: BoardPoint, in layout: BoardLayout, slop: Double = 4) -> Hit? {
        for item in layout.painted.reversed() {
            guard let ref = item.element.ref, let frame = item.frame else { continue }
            if frame.insetBy(-slop).contains(point) { return Hit(id: item.element.id, ref: ref) }
        }
        return nil
    }
}

/// The board in reading order, each element with the words VoiceOver
/// reads for it: the same order and words as the server's plain-text
/// fallback (shared/blob-board-text.ts `boardText`). Left screen first
/// (before the fold's far edge), then the right; top to bottom, then left
/// to right; a frame's title, then what sits inside it; a note right after
/// its anchor ("Note on ci-success: GitHub billing, only you"); an arrow
/// after the element it starts from. One difference: an inbox item
/// (`item:` ref) reads "Decision: <title>", since activating it opens the
/// decision.
public enum BoardReading {
    public struct Line: Sendable, Equatable {
        /// The element this line reads.
        public var id: String
        public var text: String
        /// A frame's title.
        public var heading: Bool
        /// A real object: opens on activation.
        public var ref: String?
    }

    public static func lines(_ snapshot: BoardSnapshot, layout: BoardLayout) -> [Line] {
        let elements = snapshot.elements
        let byId = Dictionary(elements.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        func box(_ id: String) -> BoardRect? { layout.frame(id) }
        let frames = elements.filter { if case .frame = $0.content { return true }; return false }

        var parent: [String: String] = [:]
        for el in elements {
            if case .arrow = el.content { continue }
            if case .note = el.content { continue }
            guard let b = box(el.id) else { continue }
            var best: (id: String, area: Double)?
            for f in frames where f.id != el.id {
                guard let fb = box(f.id) else { continue }
                let area = fb.w * fb.h
                guard fb.holdsCentre(of: b), area > b.w * b.h else { continue }
                if best == nil || area < best!.area { best = (f.id, area) }
            }
            if let best { parent[el.id] = best.id }
        }
        func screen(_ b: BoardRect) -> Int { b.x < BoardViewport.homeHinge.upperBound ? 0 : 1 }
        func children(of frame: String?) -> [BoardElement] {
            elements.filter { el in
                if case .arrow = el.content { return false }
                if case .note = el.content { return false }
                return box(el.id) != nil && parent[el.id] == frame
            }.sorted { a, b in
                let ba = box(a.id)!, bb = box(b.id)!
                if screen(ba) != screen(bb) { return screen(ba) < screen(bb) }
                if ba.y != bb.y { return ba.y < bb.y }
                return ba.x < bb.x
            }
        }

        var notesOn: [String: [BoardElement]] = [:]
        var arrowsFrom: [String: [BoardElement]] = [:]
        var loose: [BoardElement] = []
        for el in elements {
            switch el.content {
            case .note(let anchor, _, _): notesOn[anchor.id, default: []].append(el)
            case .arrow(let start, _, _, _):
                if let from = start.elementId, byId[from] != nil { arrowsFrom[from, default: []].append(el) } else { loose.append(el) }
            default: break
            }
        }

        var out: [Line] = []
        var emitted = Set<String>()
        func arrowLine(_ el: BoardElement) -> Line? {
            guard case .arrow(let start, let end, _, let label) = el.content else { return nil }
            let text = "\(endLabel(start, byId, snapshot)) → \(endLabel(end, byId, snapshot))" + (label.map { ": \($0)" } ?? "")
            return Line(id: el.id, text: text, heading: false, ref: nil)
        }
        func after(_ id: String) {
            for note in notesOn[id] ?? [] where !emitted.contains(note.id) {
                emitted.insert(note.id)
                guard case .note(_, let text, _) = note.content, let anchor = byId[id] else { continue }
                out.append(Line(id: note.id, text: "Note on \(label(anchor, snapshot)): \(text)", heading: false, ref: nil))
                after(note.id)
            }
            for arrow in arrowsFrom[id] ?? [] where !emitted.contains(arrow.id) {
                emitted.insert(arrow.id)
                if let line = arrowLine(arrow) { out.append(line) }
            }
        }
        func walk(_ frame: String?, depth: Int) {
            for el in children(of: frame) {
                if case .frame(_, let title) = el.content {
                    if let title { out.append(Line(id: el.id, text: title, heading: true, ref: el.ref)) }
                    after(el.id)
                    if depth < 4 { walk(el.id, depth: depth + 1) }
                    continue
                }
                if let own = ownLine(el, snapshot: snapshot, byId: byId, layout: layout) {
                    out.append(Line(id: el.id, text: own, heading: false, ref: el.ref))
                }
                after(el.id)
            }
        }
        walk(nil, depth: 0)
        for arrow in loose { if let line = arrowLine(arrow) { out.append(line) } }
        return out
    }

    /// What other lines call an element: its text, its live title, a
    /// frame's title, else its id.
    public static func label(_ el: BoardElement, _ snapshot: BoardSnapshot) -> String {
        let ref = snapshot.ref(el.ref)
        if case .text(_, _, _, _, _, let text?, _, _) = el.content {
            let filled = BoardLiveText.fill(text, ref)
            if !filled.isEmpty { return filled }
        }
        if let ref, ref.ok, !ref.title.isEmpty { return ref.title }
        if let r = el.ref, let colon = r.firstIndex(of: ":") { return String(r[r.index(after: colon)...]) }
        switch el.content {
        case .frame(_, let title?): return title
        case .image(_, _, _, let alt?): return alt
        case .note(_, let text, _): return text
        default: return el.id
        }
    }

    static func endLabel(_ end: BoardArrowEnd, _ byId: [String: BoardElement], _ snapshot: BoardSnapshot) -> String {
        switch end {
        case .point: return "(a point)"
        case .element(let id, _): return byId[id].map { label($0, snapshot) } ?? id
        }
    }

    /// An element's own line, or nil when it carries no words.
    static func ownLine(_ el: BoardElement, snapshot: BoardSnapshot, byId: [String: BoardElement], layout: BoardLayout) -> String? {
        // An inbox item reads as the decision it opens (`BoardItemRef`).
        if snapshot.itemId(for: el.ref) != nil { return "Decision: \(label(el, snapshot))" }
        let ref = snapshot.ref(el.ref)
        let isText: Bool = { if case .text = el.content { return true }; return false }()
        if isText || el.ref != nil {
            var main = label(el, snapshot)
            var status = ""
            var sub = ""
            if case .text(_, _, _, _, _, let text, let s, let st) = el.content {
                if text == nil, let ref, ref.ok { main = ref.title }
                status = st.map { BoardLiveText.fill($0, ref) } ?? (ref?.ok == true ? ref!.status : (el.ref != nil ? "not found" : ""))
                sub = s.map { BoardLiveText.fill($0, ref) } ?? ""
            } else {
                status = ref?.ok == true ? ref!.status : "not found"
            }
            let tail = [status, sub].filter { !$0.isEmpty }.joined(separator: ", ")
            return tail.isEmpty ? main : "\(main): \(tail)"
        }
        switch el.content {
        case .image(_, let src, _, let alt): return "Image: \(alt ?? src)"
        case .shape(let box, let kind, _):
            guard kind != .line else { return nil }
            let inside = byId.values.filter { other in
                guard other.id != el.id, let b = layout.frame(other.id) else { return false }
                switch other.content { case .frame, .shape, .note, .arrow: return false; default: break }
                return box.holdsCentre(of: b) && b.w * b.h < box.w * box.h
            }.max { a, b in
                let fa = layout.frame(a.id)!, fb = layout.frame(b.id)!
                return fa.w * fa.h < fb.w * fb.h
            }
            guard let inside else { return nil }
            let verb = kind == .ellipse ? "circled" : kind == .rect ? "boxed" : "marked"
            return "\(verb): \(label(inside, snapshot))"
        default:
            return nil
        }
    }
}
