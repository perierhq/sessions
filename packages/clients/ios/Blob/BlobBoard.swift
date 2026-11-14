import BlobCore
import CoreText
import Foundation
import Observation
import SwiftUI
#if os(iOS)
import UIKit
#endif

/// Blob's board (server: blob-board.ts): the board the canvas draws, its
/// camera, and the revision a reply pinned. The model, layout, camera
/// maths, sketches, hit testing and reading order are BlobCore's, where
/// `swift test` covers them; this class reads, refreshes and remembers.
///
/// The camera lives here, above the view, so a size change (the Duo
/// opening or closing) never resets it: the leading screen keeps the same
/// board at the same points. It is its own observable (`BlobBoardCamera`),
/// so a pan redraws the canvas and never the home that holds it.
@MainActor
@Observable
final class BlobBoard {
    /// The newest board the server sent.
    private(set) var latest: BoardSnapshot?
    /// Kept revisions a reply's ```canvas fence named, by revision.
    private var pinnedBoards: [Int: BoardSnapshot] = [:]
    /// The revision a reply on screen showed, or nil for the latest.
    private(set) var pinned: Int?
    /// Where the camera rests and how it moves. Not observed through the
    /// board: only the canvas reads it.
    @ObservationIgnored let camera = BlobBoardCamera()

    /// `touched` per revision, read when Fit first needs it.
    @ObservationIgnored private var touched: [Int: [String]] = [:]
    /// What the canvas draws, per revision and note size (BlobCore
    /// `BoardScene`, with its sketches as paths).
    @ObservationIgnored private let scenes = BoardDerivedCache<BoardSceneKey, BlobBoardScene>(limit: 8)
    /// A scene's words set at a settled zoom (BlobCore `BoardWords`), per
    /// scene and zoom bucket. Text only: the ink is vector and needs none.
    @ObservationIgnored private let words = BoardDerivedCache<BoardWordsKey, BlobBoardWords>(limit: 8)
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    /// The fonts' generation the kept scenes were measured with.
    @ObservationIgnored private var measuredFonts = 0

    /// The board to draw: the pinned revision once it is read, else the
    /// latest.
    var shown: BoardSnapshot? {
        if let pinned {
            if let board = pinnedBoards[pinned] { return board }
            if latest?.revision == pinned { return latest }
        }
        return latest
    }

    /// What the canvas draws for a board at a note size, built once per
    /// revision: drawing and gestures read it every frame.
    func scene(_ snapshot: BoardSnapshot, noteSize: Double) -> BlobBoardScene {
        // A face registered or the text size changed: measure notes again.
        let fonts = BlobHand.fonts.generation
        if fonts != measuredFonts {
            scenes.removeAll()
            words.removeAll()
            measuredFonts = fonts
        }
        let key = BoardSceneKey(snapshot, noteSize: noteSize, fonts: fonts)
        return scenes.value(key, valid: { $0.core.draws(snapshot, key: key) }) {
            BlobBoardScene(BoardScene(snapshot, key: key, measureNote: BlobHand.measure(size: noteSize)))
        }
    }

    /// A scene's words set at the zoom bucket the camera rests on. A pan
    /// never asks for another; a pinch asks once, when it ends.
    func words(_ scene: BlobBoardScene, bucket: Int) -> BlobBoardWords {
        let key = BoardWordsKey(scene: scene.core.key, bucket: bucket)
        return words.value(key, valid: { $0.scene === scene }) {
            BlobBoardWords(BoardWords(scene.core, bucket: bucket), scene: scene)
        }
    }

    // MARK: Reading

    /// Reads the latest board. A newer read replaces one on its way; a
    /// change the socket announced (`announced`) that the board on screen
    /// already has is skipped, and a read older than the board on screen
    /// is dropped.
    func refresh(announced: Int? = nil) {
        #if DEBUG
        if Self.demo != nil { loadDemo(); return }
        #endif
        guard BoardRevisions.needsRead(announced: announced, have: latest) else { return }
        refreshTask?.cancel()
        refreshTask = Task {
            guard let board = try? await OS1API.supervisorBoard() else { return }
            guard !Task.isCancelled, BoardRevisions.accepts(board, over: latest) else { return }
            latest = board
        }
    }

    /// Shows the revision a reply named, or the latest again (nil).
    func show(revision: Int?) {
        guard pinned != revision else { return }
        pinned = revision
        guard let revision, pinnedBoards[revision] == nil, latest?.revision != revision else { return }
        #if DEBUG
        if Self.demo != nil { return }
        #endif
        Task {
            guard let board = try? await OS1API.supervisorBoard(revision: revision) else { return }
            if pinnedBoards.count > 6 { pinnedBoards.removeAll() }
            pinnedBoards[revision] = board
        }
    }

    // MARK: Fit

    /// "Fit what changed": frames what the last reply touched; tapped
    /// again, back to the origin.
    func fit(in viewport: BoardViewport, noteSize: Double, animated: Bool) {
        guard let board = shown else { return }
        if camera.fitted {
            camera.fitted = false
            camera.go(to: .home, animated: animated)
            return
        }
        let revision = board.revision
        Task {
            var ids = board.touched
            if ids.isEmpty {
                if let known = touched[revision] {
                    ids = known
                } else if let read = try? await OS1API.supervisorBoardTouched(revision: revision) {
                    touched[revision] = read
                    ids = read
                }
            }
            let layout = scene(board, noteSize: noteSize).core.layout
            guard let rect = layout.bounds(of: ids) ?? layout.bounds else { return }
            camera.go(to: BoardCamera.fitting(rect, in: viewport), animated: animated)
            camera.fitted = true
        }
    }

    // MARK: Demo

    #if DEBUG
    /// `BLOB_DEMO_BOARD=release|morning`: the designed boards, bundled, for
    /// checks on a device without a server.
    static let demo: String? = ProcessInfo.processInfo.environment["BLOB_DEMO_BOARD"]

    /// The demo board's spoken line, shown as the caption under it.
    private(set) var demoSay: String?

    private func loadDemo() {
        guard let name = Self.demo,
              let url = Bundle.main.url(forResource: "blob-demo-\(name)", withExtension: "json"),
              let data = try? Data(contentsOf: url)
        else { return }
        latest = try? JSONDecoder().decode(BoardSnapshot.self, from: data)
        demoSay = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["say"] as? String
    }
    #endif
}

/// The board's camera: where it rests, the move the canvas animates, and
/// what goes to the server about it. Its own observable so a pan or a pinch
/// redraws the canvas, never the home.
@MainActor
@Observable
final class BlobBoardCamera {
    /// Where the camera rests. Gestures and buttons move it; the board
    /// never moves.
    private(set) var resting = BoardCamera.home
    /// A camera move the canvas animates (Fit, More, settling after a
    /// drag, VoiceOver focus); nil when the camera rests.
    private(set) var move: Move?
    /// Fit framed what changed; the next tap goes back to the origin.
    var fitted = false
    /// The zoom bucket the board's words are set at: where the camera last
    /// came to rest. A pinch leaves it alone, so its frames only scale the
    /// words already set; when the pinch or a move settles, the words are
    /// set again at the new zoom and drawn 1:1, sharp.
    private(set) var rendered = BoardCamera.home.zoomBucket

    struct Move: Equatable {
        var from: BoardCamera
        var to: BoardCamera
        var start: Date
        static let duration = 0.35
    }

    /// The surface the camera last reported on.
    @ObservationIgnored private var viewport: BoardViewport?
    @ObservationIgnored private var throttle = BoardReportThrottle()
    @ObservationIgnored private let clock = Date()

    /// The camera at `date`, part way through a move.
    func at(_ date: Date) -> BoardCamera {
        guard let move else { return resting }
        let t = min(1, date.timeIntervalSince(move.start) / Move.duration)
        // Ease out: quick to start, settling gently.
        let eased = 1 - pow(1 - t, 3)
        return move.from.interpolated(to: move.to, t: eased)
    }

    /// Moves the camera to `target`: animated, or at once under Reduce
    /// Motion. Where it ends goes to the server.
    func go(to target: BoardCamera, animated: Bool) {
        let from = at(.now)
        resting = target
        rest()
        guard animated, from != target else { move = nil; return }
        let next = Move(from: from, to: target, start: .now)
        move = next
        Task {
            try? await Task.sleep(for: .seconds(Move.duration))
            if move == next { move = nil }
        }
    }

    /// The camera came to rest where it is: its words are set at its zoom,
    /// and it goes to the server.
    func rest() {
        let bucket = resting.zoomBucket
        if bucket != rendered { rendered = bucket }
        report()
    }

    /// A gesture frame took the camera: any move stops where it is. Not
    /// reported, nor its words set again, until the gesture ends (`rest()`).
    func take(_ camera: BoardCamera) {
        if move != nil { move = nil }
        resting = camera
        if fitted { fitted = false }
    }

    // MARK: Report

    /// The camera goes with each message, so Blob knows what is on screen
    /// closed and open (server: blob-surface.ts). Called when the surface
    /// changes; the camera reports itself after a move or a gesture.
    func report(in viewport: BoardViewport) {
        guard viewport != self.viewport else { return }
        self.viewport = viewport
        report()
    }

    /// Writes the report at most once per 500 ms (BlobCore
    /// `BoardReportThrottle`); a write held back carries the latest camera.
    func report() {
        switch throttle.request(at: Date().timeIntervalSince(clock)) {
        case .send:
            write()
        case .wait(let delay):
            Task {
                try? await Task.sleep(for: .seconds(delay))
                throttle.fired(at: Date().timeIntervalSince(clock))
                write()
            }
        case .folded:
            break
        }
    }

    private func write() {
        guard let viewport else { return }
        BlobSurfaceReport.viewport = BoardViewportReport(viewport: viewport, camera: resting).json
    }
}

/// A BlobCore `BoardScene` with its sketches as SwiftUI paths, built once
/// per revision (`BlobBoard.scene`). Compared by identity: a new scene is a
/// new revision, note size or font.
final class BlobBoardScene {
    let core: BoardScene
    /// Each element's sketch, in board points, by id.
    let paths: [String: Path]
    /// Clean shapes by id, in board points: a ref's card and its status
    /// dot, or a sketched shape's fill. Built here so no frame makes one.
    let clean: [String: (shape: Path, dot: Path?)]

    init(_ core: BoardScene) {
        self.core = core
        var paths: [String: Path] = [:]
        var clean: [String: (shape: Path, dot: Path?)] = [:]
        for mark in core.marks {
            if let sketch = mark.sketch { paths[mark.id] = Path(sketch) }
            if case .shape(let box, let kind, _) = mark.item.element.content {
                let dot = mark.item.element.ref == nil ? nil
                    : Path(ellipseIn: CGRect(x: box.x + 12, y: box.y + 12, width: 8, height: 8))
                clean[mark.id] = (BoardColor.cleanPath(box, kind: kind), dot)
            }
        }
        self.paths = paths
        self.clean = clean
    }

    func ref(_ ref: String?) -> BoardRefInfo? {
        guard let ref else { return nil }
        return core.refs[ref] ?? .missing
    }
}

/// A scene's words at one settled zoom (BlobCore `BoardWords`). Compared by
/// identity, like the scene: a new one is a new scene or zoom bucket.
final class BlobBoardWords {
    let core: BoardWords
    /// The scene the words were set from; a new scene sets them again.
    let scene: BlobBoardScene

    init(_ core: BoardWords, scene: BlobBoardScene) {
        self.core = core
        self.scene = scene
    }
}

/// Blob's hand: Kalam Regular (Indian Type Foundry, SIL Open Font License
/// 1.1, `Board/Kalam/OFL.txt`), the one character face, used only by notes.
enum BlobHand {
    static let fontName = "Kalam-Regular"
    /// 16/20 at the default text size, scaling with Dynamic Type up to 22.
    static let baseSize = 16.0
    static let maxSize = 22.0

    /// Registers the bundled face once, for this process. Called at launch
    /// (`BlobApp.init`), before any board is laid out, so notes are never
    /// measured in a fallback face.
    @MainActor static func register() {
        guard !registered else { return }
        registered = true
        if let url = Bundle.main.url(forResource: "Kalam-Regular", withExtension: "ttf") {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
        // Registered before any scene exists, so nothing to measure again
        // now; from here a font or Dynamic Type change does.
        fonts.watch()
    }

    @MainActor private static var registered = false

    /// When fonts or Dynamic Type change, for the board's note measures.
    @MainActor static let fonts = BlobFonts()

    /// A note's box at `size`: the measured text, wrapped at 180 pt scaled
    /// with the size, two lines at most.
    static func measure(size: Double) -> BoardLayout.NoteMeasure {
        { text in
            let font = CTFontCreateWithName(fontName as CFString, size, nil)
            let attributed = NSAttributedString(string: text, attributes: [.font: font])
            let line = CTLineCreateWithAttributedString(attributed)
            let natural = CTLineGetTypographicBounds(line, nil, nil, nil)
            let lineHeight = size * 1.25
            let maxWidth = 180 * size / baseSize
            if natural + 4 <= maxWidth { return BoardSize(ceil(natural) + 4, lineHeight) }
            // Wrapped: as wide as the longer of two lines needs, at most the cap.
            let framesetter = CTFramesetterCreateWithAttributedString(attributed)
            let fit = CTFramesetterSuggestFrameSizeWithConstraints(
                framesetter, CFRange(location: 0, length: 0), nil,
                CGSize(width: maxWidth, height: lineHeight * 2 + 1), nil
            )
            return BoardSize(min(maxWidth, ceil(fit.width) + 4), lineHeight * 2)
        }
    }
}

/// A generation that moves when the registered fonts or the Dynamic Type
/// size change. The board keys its measured scenes on it, and the canvas
/// reads it, so a change measures notes again and redraws.
@MainActor
@Observable
final class BlobFonts {
    private(set) var generation = 0
    @ObservationIgnored private var observers: [NSObjectProtocol] = []

    func changed() { generation &+= 1 }

    /// Starts listening, once, for the life of the app.
    func watch() {
        guard observers.isEmpty else { return }
        var names = [Notification.Name(kCTFontManagerRegisteredFontsChangedNotification as String)]
        #if os(iOS)
        names.append(UIContentSizeCategory.didChangeNotification)
        #endif
        observers = names.map { name in
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.changed() }
            }
        }
    }
}
