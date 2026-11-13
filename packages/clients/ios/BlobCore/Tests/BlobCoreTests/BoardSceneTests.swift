import BlobCore
import Foundation
import Testing

struct BoardSceneTests {
    @Test(arguments: ["release", "morning"])
    func `a scene holds every sketch the renderer would draw`(name: String) throws {
        let board = try DemoBoards.load(name)
        let scene = BoardScene(board, key: BoardSceneKey(board, noteSize: 16))
        let layout = BoardLayout(elements: board.elements)
        #expect(scene.marks.map(\.id) == layout.painted.map(\.element.id))
        for (mark, item) in zip(scene.marks, layout.painted) {
            #expect(mark.sketch == Sketch.path(for: item, in: layout))
            #expect(mark.front == (item.element.z >= 1))
        }
        #expect(scene.reading.map(\.line) == BoardReading.lines(board, layout: layout))
        #expect(!scene.words.isEmpty)
    }

    @Test func `panning and zooming never rebuild the scene`() throws {
        let board = try DemoBoards.load("release")
        let cache = BoardDerivedCache<BoardSceneKey, BoardScene>()
        var camera = BoardCamera.home
        for step in 0..<120 {
            // A pan and a pinch, frame by frame: the key never sees them.
            camera = camera.panned(by: BoardPoint(-3, -1)).zoomed(by: 1.004, anchor: BoardPoint(100, 100), in: .duoClosed)
            let key = BoardSceneKey(board, noteSize: 16)
            let scene = cache.value(key, valid: { $0.draws(board, key: key) }) { BoardScene(board, key: key) }
            #expect(scene.key == key, "step \(step)")
        }
        #expect(cache.builds == 1)
    }

    @Test func `a new revision, Dynamic Type or a font change rebuilds once`() throws {
        let board = try DemoBoards.load("release")
        let cache = BoardDerivedCache<BoardSceneKey, BoardScene>()
        func scene(_ b: BoardSnapshot, _ note: Double, _ fonts: Int) -> BoardScene {
            let key = BoardSceneKey(b, noteSize: note, fonts: fonts)
            return cache.value(key, valid: { $0.draws(b, key: key) }) { BoardScene(b, key: key) }
        }
        _ = scene(board, 16, 0)
        _ = scene(board, 16, 0)
        #expect(cache.builds == 1)
        var next = board
        next.revision += 1
        next.latestRevision += 1
        _ = scene(next, 16, 0)
        _ = scene(next, 16, 0)
        #expect(cache.builds == 2)
        _ = scene(next, 20, 0)
        #expect(cache.builds == 3)
        _ = scene(next, 20, 1)
        #expect(cache.builds == 4)
    }

    @Test func `a ref refreshed under the same revision rebuilds the scene`() throws {
        let board = try DemoBoards.load("release")
        let cache = BoardDerivedCache<BoardSceneKey, BoardScene>()
        let key = BoardSceneKey(board, noteSize: 16)
        _ = cache.value(key, valid: { $0.draws(board, key: key) }) { BoardScene(board, key: key) }
        var refreshed = board
        refreshed.refs["pr:acme/app#1"] = BoardRefInfo(ok: true, kind: "pr", title: "New", status: "open")
        let scene = cache.value(key, valid: { $0.draws(refreshed, key: key) }) { BoardScene(refreshed, key: key) }
        #expect(cache.builds == 2)
        #expect(scene.refs == refreshed.refs)
    }

    @Test func `the cache lets the least recently used go`() {
        let cache = BoardDerivedCache<Int, Int>(limit: 2)
        _ = cache.value(1) { 1 }
        _ = cache.value(2) { 2 }
        _ = cache.value(1) { 1 }
        _ = cache.value(3) { 3 }
        #expect(cache.count == 2)
        _ = cache.value(1) { 1 }
        #expect(cache.builds == 3)
        _ = cache.value(2) { 2 }
        #expect(cache.builds == 4)
    }
}

struct BoardRevisionTests {
    func board(_ revision: Int) -> BoardSnapshot { BoardSnapshot(revision: revision, latestRevision: revision) }

    @Test func `a slow read never replaces a newer board`() {
        #expect(BoardRevisions.accepts(board(3), over: nil))
        #expect(BoardRevisions.accepts(board(3), over: board(3)))
        #expect(BoardRevisions.accepts(board(4), over: board(3)))
        #expect(!BoardRevisions.accepts(board(2), over: board(3)))
    }

    @Test func `the socket's revision skips reads the board already has`() {
        #expect(BoardRevisions.needsRead(announced: nil, have: board(3)))
        #expect(BoardRevisions.needsRead(announced: 1, have: nil))
        #expect(!BoardRevisions.needsRead(announced: 3, have: board(3)))
        #expect(!BoardRevisions.needsRead(announced: 2, have: board(3)))
        #expect(BoardRevisions.needsRead(announced: 4, have: board(3)))
    }
}

struct BoardReportThrottleTests {
    @Test func `at most one write per half second, the last state kept`() {
        var throttle = BoardReportThrottle()
        #expect(throttle.request(at: 0) == .send)
        #expect(throttle.request(at: 0.25) == .wait(0.25))
        // Gesture ends inside the wait fold into it.
        #expect(throttle.request(at: 0.375) == .folded)
        #expect(throttle.request(at: 0.45) == .folded)
        throttle.fired(at: 0.5)
        #expect(throttle.request(at: 0.75) == .wait(0.25))
        throttle.fired(at: 1.0)
        #expect(throttle.request(at: 2.0) == .send)
    }
}

struct BoardRevealTests {
    let viewport = BoardViewport.duoClosed // board x 0–382, y 0–678 at 100%

    @Test func `an element in view keeps the camera`() {
        let camera = BoardCamera.home
        #expect(camera.revealing(BoardRect(x: 40, y: 40, w: 100, h: 40), in: viewport) == nil)
    }

    @Test func `an element past the trailing edge pans just far enough`() throws {
        let camera = BoardCamera.home
        let rect = BoardRect(x: 500, y: 100, w: 100, h: 40)
        let next = try #require(camera.revealing(rect, in: viewport))
        #expect(next.zoom == 1)
        #expect(next.origin.x == 600 + 24 - 382)
        #expect(next.origin.y == 0)
        #expect(next.revealing(rect, in: viewport) == nil)
    }

    @Test func `an element above the camera comes in at the top, zoom kept`() throws {
        let camera = BoardCamera(origin: BoardPoint(0, 400), zoom: 0.5)
        let rect = BoardRect(x: 10, y: 100, w: 100, h: 40)
        let next = try #require(camera.revealing(rect, in: viewport))
        #expect(next.zoom == 0.5)
        #expect(next.origin.y == 76)
    }

    @Test func `a box wider than the camera shows its start, never past the origin`() throws {
        let camera = BoardCamera(origin: BoardPoint(900, 0), zoom: 1)
        let next = try #require(camera.revealing(BoardRect(x: 10, y: 10, w: 2000, h: 40), in: viewport))
        #expect(next.origin.x == 0)
    }
}
