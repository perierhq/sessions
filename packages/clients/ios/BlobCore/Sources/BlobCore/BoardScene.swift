import Foundation

/// Everything the canvas draws for one revision of the board, derived once
/// and kept: the layout, every element's sketch, the elements that carry
/// words and the VoiceOver reading order, all in board points. The camera
/// is never part of it: the app applies the camera as a transform, so a pan
/// or a pinch rebuilds nothing. Sketches are vector paths in board points
/// and stay sharp under any transform, so they need no zoom bucket; the
/// words do (`BoardWords`), since text scaled as a layer blurs.
public struct BoardScene: Sendable {
    /// One painted element: its place, and its sketch when it draws one.
    public struct Mark: Sendable, Equatable {
        public var item: BoardLayout.Item
        /// Over the text (z ≥ 1, like a circle drawn around a card).
        public var front: Bool
        public var sketch: SketchPath?
        public var id: String { item.element.id }
    }

    /// One line of the reading order, over the box it reads.
    public struct Spot: Sendable, Equatable {
        public var line: BoardReading.Line
        public var frame: BoardRect
    }

    public let key: BoardSceneKey
    public let layout: BoardLayout
    /// Live fields of the refs, as they were when the scene was built.
    public let refs: [String: BoardRefInfo]
    /// Every element in paint order.
    public let marks: [Mark]
    /// The elements drawn as views (text, ref cards, images, notes, frame
    /// titles, arrow labels), in paint order.
    public let words: [BoardLayout.Item]
    public let reading: [Spot]
    /// Everything the board holds, for More and Fit.
    public let bounds: BoardRect?
    /// Where each element starts on the board, for More.
    public let starts: [Double]

    public init(
        _ snapshot: BoardSnapshot, key: BoardSceneKey,
        measureNote: @escaping BoardLayout.NoteMeasure = BoardLayout.estimateNote,
        measureText: @escaping BoardLayout.TextMeasure = BoardTextMetrics.estimate()
    ) {
        let layout = BoardLayout(elements: snapshot.elements, refs: snapshot.refs,
                                 measureNote: measureNote, measureText: measureText)
        self.key = key
        self.layout = layout
        refs = snapshot.refs
        let painted = layout.painted
        marks = painted.map { item in
            Mark(item: item, front: item.element.z >= 1, sketch: Sketch.path(for: item, in: layout))
        }
        words = painted.filter { item in
            switch item.element.content {
            case .shape, .stroke: return false
            case .arrow(_, _, _, let label): return label != nil && layout.arrows[item.element.id] != nil
            case .frame(_, let title): return title != nil && item.frame != nil
            default: return item.frame != nil
            }
        }
        reading = BoardReading.lines(snapshot, layout: layout).map { line in
            Spot(line: line, frame: layout.frame(line.id) ?? layout.arrows[line.id]?.bounds ?? BoardRect(x: 0, y: 0, w: 1, h: 1))
        }
        bounds = layout.bounds
        starts = layout.items.compactMap { $0.frame?.minX }
    }

    /// Whether this scene still draws `snapshot`: the same key and the
    /// same live fields (a refresh can update a ref without a new revision).
    public func draws(_ snapshot: BoardSnapshot, key: BoardSceneKey) -> Bool {
        self.key == key && refs == snapshot.refs
    }
}

/// What a scene depends on: the revision it draws, the note size (Dynamic
/// Type) and the fonts' generation (a face registered or changed after a
/// note was measured). Never the camera.
public struct BoardSceneKey: Sendable, Hashable {
    public var revision: Int
    public var latestRevision: Int
    public var updatedAt: Double
    public var count: Int
    public var noteSize: Double
    public var fonts: Int

    public init(_ snapshot: BoardSnapshot, noteSize: Double, fonts: Int = 0) {
        revision = snapshot.revision
        latestRevision = snapshot.latestRevision
        updatedAt = snapshot.updatedAt
        count = snapshot.elements.count
        self.noteSize = noteSize
        self.fonts = fonts
    }
}

/// A scene's words laid out at one settled zoom, in surface points from
/// board (0, 0): text set at its size times the zoom, not a 100% layer
/// scaled up, so it stays sharp. Built when a gesture or a camera move
/// settles on a new zoom bucket (`BoardCamera.zoomBucket`); while a pinch
/// runs, the app scales the last one by `live zoom / zoom`.
public struct BoardWords: Sendable {
    /// One element's words at this zoom.
    public struct Placed: Sendable, Equatable {
        public var item: BoardLayout.Item
        /// Its box at this zoom, or nil for an arrow label.
        public var frame: BoardRect?
        /// An arrow label's centre, or a frame title's top-left, at this
        /// zoom.
        public var label: BoardPoint?
        public var id: String { item.element.id }
    }

    public let key: BoardWordsKey
    /// The zoom everything is set at: `BoardCamera.zoom(bucket:)`.
    public let zoom: Double
    public let placed: [Placed]

    public init(_ scene: BoardScene, bucket: Int) {
        let zoom = BoardCamera.zoom(bucket: bucket)
        key = BoardWordsKey(scene: scene.key, bucket: bucket)
        self.zoom = zoom
        placed = scene.words.compactMap { item in
            if case .arrow = item.element.content {
                guard let mid = scene.layout.arrows[item.element.id]?.middle else { return nil }
                return Placed(item: item, frame: nil, label: mid * zoom)
            }
            guard let r = item.frame else { return nil }
            let title = scene.layout.titles[item.element.id].map { $0 * zoom }
            return Placed(item: item, frame: BoardRect(x: r.x * zoom, y: r.y * zoom, w: r.w * zoom, h: r.h * zoom), label: title)
        }
    }
}

/// What a scene's words depend on: the scene, and the zoom bucket they are
/// set at. Pans never change it; a pinch changes it once, when it ends.
public struct BoardWordsKey: Sendable, Hashable {
    public var scene: BoardSceneKey
    public var bucket: Int

    public init(scene: BoardSceneKey, bucket: Int) {
        self.scene = scene
        self.bucket = bucket
    }
}

/// Ink widths for the zoom the board rests at. The sketches are paths in
/// board points, so a width in board points grows and shrinks with the
/// camera; at rest it is never thinner on screen than `minimum`, so a
/// zoomed-out board keeps visible lines. While a pinch runs the width
/// stays the one set for the last settled zoom and rides the transform.
public enum BoardStroke {
    /// Blob's sketches: 1.6 board points, at least 1 pt on screen.
    public static func sketch(zoom: Double) -> Double { width(1.6, minimum: 1, zoom: zoom) }
    /// The edge of a ref's clean shape: 1 board point, at least 0.5 pt.
    public static func edge(zoom: Double) -> Double { width(1, minimum: 0.5, zoom: zoom) }

    /// `base` board points, or wider where that would be under `minimum`
    /// surface points at `zoom`. In board points.
    public static func width(_ base: Double, minimum: Double, zoom: Double) -> Double {
        max(base, minimum / max(zoom, BoardCamera.minZoom))
    }
}

/// A small cache of derived values by key, the least recently used going
/// first past `limit`. Not thread-safe: one owner (the app's main actor).
public final class BoardDerivedCache<Key: Hashable, Value> {
    public let limit: Int
    /// How many values `make` has built, for tests.
    public private(set) var builds = 0
    private var entries: [Key: Value] = [:]
    private var order: [Key] = []

    public init(limit: Int = 8) { self.limit = max(1, limit) }

    /// The value for `key`, built once. `valid` can turn down a kept value
    /// (it is rebuilt).
    public func value(_ key: Key, valid: (Value) -> Bool = { _ in true }, make: () -> Value) -> Value {
        if let kept = entries[key], valid(kept) {
            if order.last != key {
                order.removeAll { $0 == key }
                order.append(key)
            }
            return kept
        }
        let made = make()
        builds += 1
        if entries[key] == nil {
            order.append(key)
            while order.count > limit { entries[order.removeFirst()] = nil }
        }
        entries[key] = made
        return made
    }

    public var count: Int { entries.count }

    public func removeAll() {
        entries.removeAll()
        order.removeAll()
    }
}

/// Which board reads to apply and which to skip, so a slow read never
/// replaces a newer board.
public enum BoardRevisions {
    /// Apply a read board over the one on screen only when it is at least
    /// as new.
    public static func accepts(_ incoming: BoardSnapshot, over current: BoardSnapshot?) -> Bool {
        guard let current else { return true }
        return incoming.revision >= current.revision
    }

    /// Read again for a change the socket announced, unless the board on
    /// screen already has that revision or a newer one. A change without a
    /// revision is always read.
    public static func needsRead(announced: Int?, have current: BoardSnapshot?) -> Bool {
        guard let announced, let current else { return true }
        return announced > current.revision
    }
}

/// At most one write per `interval`: a request inside it waits for the
/// interval's end, and further requests while one waits fold into it, so
/// the last state always goes out.
public struct BoardReportThrottle: Sendable {
    public enum Action: Sendable, Equatable {
        /// Write now.
        case send
        /// Write after this many seconds, then call `fired(at:)`.
        case wait(Double)
        /// A write is already waiting; it will carry this state.
        case folded
    }

    public let interval: Double
    private var lastSent: Double?
    private var waiting = false

    public init(interval: Double = 0.5) { self.interval = interval }

    public mutating func request(at now: Double) -> Action {
        if waiting { return .folded }
        if let lastSent, now - lastSent < interval {
            waiting = true
            return .wait(lastSent + interval - now)
        }
        lastSent = now
        return .send
    }

    /// The waiting write went out.
    public mutating func fired(at now: Double) {
        waiting = false
        lastSent = now
    }
}
