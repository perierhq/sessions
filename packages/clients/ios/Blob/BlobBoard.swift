import BlobCore
import CoreText
import Foundation
import Observation
import SwiftUI

/// Blob's board (server: blob-board.ts): the board the canvas draws, its
/// camera, and the revision a reply pinned. The model, layout, camera
/// maths, sketches, hit testing and reading order are BlobCore's, where
/// `swift test` covers them; this class reads, refreshes and remembers.
///
/// The camera lives here, above the view, so a size change (the Duo
/// opening or closing) never resets it: the leading screen keeps the same
/// board at the same points.
@MainActor
@Observable
final class BlobBoard {
    /// The newest board the server sent.
    private(set) var latest: BoardSnapshot?
    /// Kept revisions a reply's ```canvas fence named, by revision.
    private var pinnedBoards: [Int: BoardSnapshot] = [:]
    /// The revision a reply on screen showed, or nil for the latest.
    private(set) var pinned: Int?

    /// Where the camera rests. Gestures and buttons move it; the board
    /// never moves.
    var camera = BoardCamera.home
    /// A camera move the canvas animates (Fit, More, settling after a
    /// drag); nil when the camera rests.
    private(set) var move: Move?
    /// Fit framed what changed; the next tap goes back to the origin.
    private(set) var fitted = false

    struct Move: Equatable {
        var from: BoardCamera
        var to: BoardCamera
        var start: Date
        static let duration = 0.35
    }

    /// `touched` per revision, read when Fit first needs it.
    @ObservationIgnored private var touched: [Int: [String]] = [:]
    @ObservationIgnored private var layouts: [LayoutKey: BoardLayout] = [:]
    @ObservationIgnored private var refreshTask: Task<Void, Never>?

    /// The board to draw: the pinned revision once it is read, else the
    /// latest.
    var shown: BoardSnapshot? {
        if let pinned {
            if let board = pinnedBoards[pinned] { return board }
            if latest?.revision == pinned { return latest }
        }
        return latest
    }

    /// The board's layout for a note size, cached: drawing and gestures
    /// read it every frame.
    func layout(_ snapshot: BoardSnapshot, noteSize: Double) -> BoardLayout {
        let key = LayoutKey(revision: snapshot.revision, latest: snapshot.latestRevision,
                            stamp: snapshot.updatedAt, count: snapshot.elements.count, noteSize: noteSize)
        if let layout = layouts[key] { return layout }
        if layouts.count > 8 { layouts.removeAll() }
        let layout = BoardLayout(elements: snapshot.elements, measureNote: BlobHand.measure(size: noteSize))
        layouts[key] = layout
        return layout
    }

    private struct LayoutKey: Hashable {
        var revision: Int
        var latest: Int
        var stamp: Double
        var count: Int
        var noteSize: Double
    }

    // MARK: Reading

    /// Reads the latest board. A newer read replaces one on its way.
    func refresh() {
        #if DEBUG
        if Self.demo != nil { loadDemo(); return }
        #endif
        refreshTask?.cancel()
        refreshTask = Task {
            guard let board = try? await OS1API.supervisorBoard() else { return }
            guard !Task.isCancelled else { return }
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

    // MARK: Camera

    /// The camera at `date`, part way through a move.
    func camera(at date: Date) -> BoardCamera {
        guard let move else { return camera }
        let t = min(1, date.timeIntervalSince(move.start) / Move.duration)
        // Ease out: quick to start, settling gently.
        let eased = 1 - pow(1 - t, 3)
        return move.from.interpolated(to: move.to, t: eased)
    }

    /// Moves the camera to `target`: animated, or at once under Reduce
    /// Motion.
    func go(to target: BoardCamera, animated: Bool) {
        let from = camera(at: .now)
        camera = target
        guard animated, from != target else { move = nil; return }
        let next = Move(from: from, to: target, start: .now)
        move = next
        Task {
            try? await Task.sleep(for: .seconds(Move.duration))
            if move == next { move = nil }
        }
    }

    /// A gesture took the camera: any move stops where it is.
    func takeCamera(_ camera: BoardCamera) {
        move = nil
        self.camera = camera
        fitted = false
    }

    /// "Fit what changed": frames what the last reply touched; tapped
    /// again, back to the origin.
    func fit(in viewport: BoardViewport, noteSize: Double, animated: Bool) {
        guard let board = shown else { return }
        if fitted {
            fitted = false
            go(to: .home, animated: animated)
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
            let layout = layout(board, noteSize: noteSize)
            guard let rect = layout.bounds(of: ids) ?? layout.bounds else { return }
            fitted = true
            go(to: BoardCamera.fitting(rect, in: viewport), animated: animated)
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

/// Blob's hand: Kalam Regular (Indian Type Foundry, SIL Open Font License
/// 1.1, `Board/Kalam/OFL.txt`), the one character face, used only by notes.
enum BlobHand {
    static let fontName = "Kalam-Regular"
    /// 16/20 at the default text size, scaling with Dynamic Type up to 22.
    static let baseSize = 16.0
    static let maxSize = 22.0

    /// Registers the bundled face once, for this process.
    @MainActor static func register() {
        guard !registered else { return }
        registered = true
        guard let url = Bundle.main.url(forResource: "Kalam-Regular", withExtension: "ttf") else { return }
        CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    }

    @MainActor private static var registered = false

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
