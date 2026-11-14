import BlobCore
import Foundation
import Testing

struct BoardCameraTests {
    /// Every element's place on the surface, as the app draws it.
    func drawn(_ layout: BoardLayout, _ camera: BoardCamera, _ viewport: BoardViewport) -> [String: BoardRect] {
        var out: [String: BoardRect] = [:]
        for item in layout.items { if let f = item.frame { out[item.element.id] = camera.toView(f, in: viewport) } }
        return out
    }

    /// A sketch path as drawn on the surface.
    func drawn(_ path: SketchPath, _ camera: BoardCamera, _ viewport: BoardViewport) -> [SketchCommand] {
        let map = { (p: BoardPoint) in camera.toView(p, in: viewport) }
        return path.commands.map {
            switch $0 {
            case .move(let p): .move(map(p))
            case .curve(let a, let b, let p): .curve(map(a), map(b), to: map(p))
            }
        }
    }

    @Test(arguments: ["release", "morning"])
    func `the open Duo's left screen is the closed view`(name: String) throws {
        let board = try DemoBoards.load(name)
        let layout = BoardLayout(elements: board.elements)
        let closed = BoardViewport.duoClosed
        let open = BoardViewport.duoOpen
        // Opening keeps the camera: nothing re-flows.
        let camera = BoardCamera.home
        #expect(camera.visible(in: closed) == BoardRect(x: 0, y: 0, w: 382, h: 678))
        #expect(camera.visible(in: open).maxX == 867)

        let shownClosed = drawn(layout, camera, closed)
        let shownOpen = drawn(layout, camera, open)
        let closedScreen = BoardRect(x: 0, y: 0, w: 382, h: 669)
        var compared = 0
        for (id, frame) in shownClosed where frame.intersects(closedScreen) {
            #expect(shownOpen[id] == frame, "\(id) sits at the same points on both")
            compared += 1
        }
        #expect(compared > 5)
        // The marks too, stroke for stroke.
        for item in layout.items {
            guard let path = Sketch.path(for: item, in: layout), let b = path.bounds,
                  camera.toView(b, in: closed).intersects(closedScreen) else { continue }
            #expect(drawn(path, camera, closed) == drawn(path, camera, open), "\(item.element.id)")
        }
    }

    @Test func `a panned or zoomed camera stays put when the Duo opens`() throws {
        let board = try DemoBoards.load("release")
        let layout = BoardLayout(elements: board.elements)
        let camera = BoardCamera.home
            .panned(by: BoardPoint(-40, -12))
            .zoomed(by: 1.4, anchor: BoardPoint(100, 200), in: .duoClosed)
        let closed = drawn(layout, camera, .duoClosed)
        let open = drawn(layout, camera, .duoOpen)
        for (id, frame) in closed where frame.maxX <= 382 && frame.minX >= 0 {
            #expect(open[id] == frame, "\(id)")
        }
    }

    @Test func `board and surface points round-trip`() {
        let viewport = BoardViewport(size: BoardSize(402, 874), top: 62, leading: 0, trailing: 0)
        let camera = BoardCamera(origin: BoardPoint(30, 10), zoom: 1.5)
        let p = BoardPoint(120, 340)
        let back = camera.toBoard(camera.toView(p, in: viewport), in: viewport)
        #expect(abs(back.x - p.x) < 1e-9 && abs(back.y - p.y) < 1e-9)
        #expect(BoardCamera.home.toView(BoardPoint(0, 0), in: viewport) == BoardPoint(0, 62),
                "board (0, 0) is the content area's top-left")
    }

    @Test func `pinch keeps the point under the fingers`() {
        let viewport = BoardViewport.duoClosed
        let anchor = BoardPoint(200, 300)
        let before = BoardCamera.home.toBoard(anchor, in: viewport)
        let zoomed = BoardCamera.home.zoomed(by: 1.8, anchor: anchor, in: viewport)
        let after = zoomed.toBoard(anchor, in: viewport)
        #expect(abs(before.x - after.x) < 1e-9 && abs(before.y - after.y) < 1e-9)
        #expect(zoomed.zoom == 1.8)
    }

    @Test func `zoom stays between 25 and 200 percent`() {
        let viewport = BoardViewport.duoClosed
        #expect(BoardCamera.home.zoomed(by: 10, anchor: BoardPoint(0, 0), in: viewport).zoom == 2)
        #expect(BoardCamera.home.zoomed(by: 0.01, anchor: BoardPoint(0, 0), in: viewport).zoom == 0.25)
        #expect(BoardCamera(origin: BoardPoint(0, 0), zoom: 9).zoom == 2)
    }

    @Test func `a drag pans by the finger's travel in board points`() {
        let camera = BoardCamera(origin: BoardPoint(100, 100), zoom: 2).panned(by: BoardPoint(40, -20))
        #expect(camera.origin == BoardPoint(80, 110))
        #expect(BoardCamera(origin: BoardPoint(-30, -90), zoom: 1).settled.origin == BoardPoint(0, 0))
    }

    @Test func `the fold in board points follows the camera`() {
        #expect(BoardCamera.home.hinge(in: .duoOpen) == 455.5...495.5)
        #expect(BoardCamera.home.hinge(in: .duoClosed) == nil)
        let panned = BoardCamera(origin: BoardPoint(100, 0), zoom: 1)
        #expect(panned.hinge(in: .duoOpen) == 555.5...595.5)
    }

    @Test func `fit frames what changed, never past 100 percent`() throws {
        let board = try DemoBoards.load("release")
        let layout = BoardLayout(elements: board.elements)
        let changed = try #require(layout.bounds(of: ["s1", "s2", "s3"]))
        let fit = BoardCamera.fitting(changed, in: .duoClosed)
        #expect(fit.zoom <= 1)
        let visible = fit.visible(in: .duoClosed)
        #expect(visible.minX <= changed.minX && visible.maxX >= changed.maxX)
        #expect(visible.minY <= changed.minY && visible.maxY >= changed.maxY)
        let small = BoardCamera.fitting(BoardRect(x: 10, y: 10, w: 40, h: 40), in: .duoOpen)
        #expect(small.zoom == 1)
        #expect(small.origin == BoardPoint(0, 0))
    }

    @Test func `More on the closed Duo pans to the right screen`() throws {
        let board = try DemoBoards.load("release")
        let layout = BoardLayout(elements: board.elements)
        let sides = BoardCamera.home.offCamera(layout.bounds, in: .duoClosed)
        #expect(sides.trailing && !sides.leading)
        #expect(!BoardCamera.home.offCamera(layout.bounds, in: BoardViewport(size: BoardSize(1280, 748))).trailing)
        let starts = layout.items.compactMap { $0.frame?.minX }
        let next = BoardCamera.home.revealingTrailing(starts: starts, in: .duoClosed)
        #expect(next.origin.x == 496, "the right screen's content starts at 520")
        #expect(next.revealingLeading(in: .duoClosed).origin.x == 114)
    }

    @Test func `a camera move interpolates from one end to the other`() {
        let a = BoardCamera.home
        let b = BoardCamera(origin: BoardPoint(200, 40), zoom: 0.5)
        #expect(a.interpolated(to: b, t: 0) == a)
        let end = a.interpolated(to: b, t: 1)
        #expect(abs(end.zoom - 0.5) < 1e-9 && abs(end.origin.x - 200) < 1e-9)
        #expect(a.interpolated(to: b, t: 0.5).origin == BoardPoint(100, 20))
    }

    @Test func `the open Duo reports its camera as the server reads it`() {
        let report = BoardViewportReport(viewport: .duoOpen, camera: .home)
        let json = report.json
        #expect(json["w"] as? Double == 951)
        #expect(json["h"] as? Double == 669)
        #expect(json["hinge"] as? [Double] == [455.5, 495.5])
        #expect(json["strip"] as? [Double] == [867, 951])
        #expect((json["closed"] as? [String: Double])?["w"] == 382)
        #expect(json["origin"] as? [Double] == [0, 0])
        let closed = BoardViewportReport(viewport: .duoClosed, camera: .home).json
        // The closed Duo says it is one (its hardware strip), so Blob
        // knows the open camera is a fold away.
        #expect(closed["hinge"] == nil)
        #expect((closed["closed"] as? [String: Double])?["w"] == 382)
        #expect(closed["strip"] as? [Double] == [382, 466])
    }
}

struct BoardLayoutTests {
    func text(_ id: String, x: Double, y: Double = 0, w: Double, ref: String? = nil) -> BoardElement {
        BoardElement(id: id, ref: ref, content: .text(x: x, y: y, w: w, h: nil, role: .title, text: id, sub: nil, status: nil))
    }

    @Test(arguments: ["release", "morning"])
    func `no text on the designed boards touches the hinge band`(name: String) throws {
        let board = try DemoBoards.load(name)
        let layout = BoardLayout(elements: board.elements, refs: board.refs)
        for item in layout.items where BoardLayout.carriesText(item.element) {
            let frame = try #require(item.frame)
            #expect(!(frame.x < 495.5 && frame.maxX > 455.5), "\(item.element.id) is clear of the fold")
            #expect(item.nudge == 0, "the server already kept \(item.element.id) off it")
        }
    }

    @Test func `text an older board left on the fold is moved off it`() {
        let elements = [
            text("left", x: 300, w: 170),           // ends in the band: nearer the left
            text("right", x: 480, w: 200),          // starts in the band: nearer the right
            text("wide", x: 10, w: 470),            // left has no room: rightwards
            BoardElement(id: "n", content: .note(anchor: BoardNoteAnchor(id: "right", side: .left), text: "only you", leader: BoardLeader())),
            BoardElement(id: "s", content: .shape(BoardRect(x: 440, y: 0, w: 80, h: 20), kind: .ellipse, points: nil)),
        ]
        let layout = BoardLayout(elements: elements)
        for item in layout.items where BoardLayout.carriesText(item.element) {
            let f = item.frame!
            #expect(!(f.x < 495.5 && f.maxX > 455.5), "\(item.element.id) at \(f.x)–\(f.maxX)")
        }
        #expect(layout.frame("left")?.maxX == 455.5)
        #expect(layout.frame("right")?.x == 495.5)
        #expect(layout.frame("wide")?.x == 495.5)
        #expect(layout.item("s")?.nudge == 0, "sketches may cross the fold")
        // The open Duo draws no text on its fold.
        let camera = BoardCamera.home
        let fold = BoardViewport.duoOpen.fold!
        for item in layout.items where BoardLayout.carriesText(item.element) {
            let v = camera.toView(item.frame!, in: .duoOpen)
            #expect(!(v.x < fold.upperBound && v.maxX > fold.lowerBound))
        }
    }

    @Test func `a note sits outside its anchor's side and follows it`() {
        let anchor = text("c", x: 24, y: 166, w: 260, ref: "check:acme#1/ci")
        let note = BoardElement(id: "n", content: .note(anchor: BoardNoteAnchor(id: "c", side: .top, dx: 151, dy: -34),
                                                        text: "GitHub billing, only you", leader: BoardLeader(to: .fraction(0.8, 0))))
        let layout = BoardLayout(elements: [anchor, note], measureNote: { _ in BoardSize(118, 40) })
        let f = layout.frame("n")!
        // Top: centred over the anchor, 8 pt above, then dx, dy.
        #expect(f == BoardRect(x: 24 + 130 - 59 + 151, y: 166 - 8 - 40 - 34, w: 118, h: 40))
        let moved = BoardLayout(elements: [text("c", x: 64, y: 186, w: 260, ref: "check:acme#1/ci"), note],
                                measureNote: { _ in BoardSize(118, 40) })
        #expect(moved.frame("n") == f.offsetBy(dx: 40, dy: 20), "a move of the anchor moves its note")
        let leader = layout.leaders["n"]!
        #expect(abs(leader.end.x - (24 + 0.8 * 260)) < 3.1)
        #expect(f.insetBy(-3.1).contains(leader.start), "the leader leaves the note's edge")
    }

    @Test(arguments: [
        (BoardSide.right, BoardRect(x: 168, y: 40, w: 50, h: 20)),
        (BoardSide.bottom, BoardRect(x: 55, y: 108, w: 50, h: 20)),
        (BoardSide.left, BoardRect(x: -58, y: 40, w: 50, h: 20)),
    ])
    func `notes on each side`(side: BoardSide, expected: BoardRect) {
        let anchor = BoardElement(id: "a", content: .frame(BoardRect(x: 0, y: 0, w: 160, h: 100), title: nil))
        let note = BoardElement(id: "n", content: .note(anchor: BoardNoteAnchor(id: "a", side: side), text: "x", leader: nil))
        let layout = BoardLayout(elements: [anchor, note], measureNote: { _ in BoardSize(50, 20) })
        #expect(layout.frame("n") == expected)
    }

    @Test func `an arrow meets the sides it binds to, just outside them`() {
        let a = BoardElement(id: "a", content: .frame(BoardRect(x: 0, y: 0, w: 100, h: 50), title: nil))
        let b = BoardElement(id: "b", content: .frame(BoardRect(x: 0, y: 200, w: 100, h: 50), title: nil))
        let arrow = BoardElement(id: "x", content: .arrow(start: .element(id: "a", side: .bottom), end: .element(id: "b", side: .fraction(0.2, 0)), bend: 0, label: nil))
        let route = BoardLayout(elements: [a, b, arrow]).arrows["x"]!
        #expect(route.start == BoardPoint(50, 54))
        #expect(route.end == BoardPoint(20, 196))
        #expect(route.control == BoardPoint(35, 125))
    }

    @Test func `without a side an arrow leaves the edge facing the other end`() {
        let a = BoardElement(id: "a", content: .frame(BoardRect(x: 0, y: 0, w: 100, h: 100), title: nil))
        let b = BoardElement(id: "b", content: .frame(BoardRect(x: 300, y: 0, w: 100, h: 100), title: nil))
        let arrow = BoardElement(id: "x", content: .arrow(start: .element(id: "a", side: nil), end: .element(id: "b", side: nil), bend: 0.2, label: "stops"))
        let route = BoardLayout(elements: [a, b, arrow]).arrows["x"]!
        #expect(route.start == BoardPoint(104, 50))
        #expect(route.end == BoardPoint(296, 50))
        #expect(route.control.y > 50, "a positive bend bows it")
    }

    @Test func `an arrow follows its element and keeps its seed`() {
        func layout(_ y: Double) -> BoardLayout {
            BoardLayout(elements: [
                BoardElement(id: "a", content: .frame(BoardRect(x: 0, y: 0, w: 100, h: 50), title: nil)),
                BoardElement(id: "b", content: .frame(BoardRect(x: 200, y: y, w: 100, h: 50), title: nil)),
                BoardElement(id: "x", content: .arrow(start: .element(id: "a", side: .right), end: .element(id: "b", side: .left), bend: 0, label: nil)),
            ])
        }
        let before = layout(0), after = layout(74)
        #expect(after.arrows["x"]!.end.y == before.arrows["x"]!.end.y + 74)
        let same = layout(74)
        #expect(Sketch.path(for: same.item("x")!, in: same) == Sketch.path(for: after.item("x")!, in: after))
    }

    @Test func `an arrow to a missing element is not drawn`() {
        let arrow = BoardElement(id: "x", content: .arrow(start: .element(id: "gone", side: nil), end: .point(BoardPoint(0, 0)), bend: 0, label: nil))
        #expect(BoardLayout(elements: [arrow]).arrows["x"] == nil)
    }

    @Test func `text heights come from the role or the ref card`() {
        #expect(BoardLayout.textHeight(text("t", x: 0, w: 10)) == 17)
        #expect(BoardLayout.textHeight(text("t", x: 0, w: 10, ref: "pr:acme#1")) == 58)
        let stat = BoardElement(id: "s", content: .text(x: 0, y: 0, w: 10, h: nil, role: .stat, text: "11", sub: "handled", status: nil))
        #expect(BoardLayout.textHeight(stat) == 50)
    }
}
