import BlobCore
import Foundation
import Testing

struct BoardSketchTests {
    func shape(_ id: String, _ kind: BoardShapeKind, _ box: BoardRect, ref: String? = nil) -> BoardElement {
        BoardElement(id: id, ref: ref, content: .shape(box, kind: kind, points: kind == .line ? [BoardPoint(0, 0), BoardPoint(box.w, box.h)] : nil))
    }

    func path(_ el: BoardElement, with others: [BoardElement] = []) -> SketchPath? {
        let layout = BoardLayout(elements: others + [el])
        return Sketch.path(for: layout.item(el.id)!, in: layout)
    }

    @Test func `the same element draws the same path on every call`() throws {
        let board = try DemoBoards.load("release")
        let first = BoardLayout(elements: board.elements)
        let second = BoardLayout(elements: board.elements)
        var drawn = 0
        for item in first.items {
            let a = Sketch.path(for: item, in: first)
            let b = Sketch.path(for: second.item(item.element.id)!, in: second)
            let c = Sketch.path(for: item, in: first)
            #expect(a == b && a == c, "\(item.element.id) never wobbles between redraws")
            if a != nil { drawn += 1 }
        }
        #expect(drawn >= 15)
    }

    @Test(arguments: [BoardShapeKind.rect, .ellipse, .diamond, .line])
    func `each shape is seeded by its id`(kind: BoardShapeKind) throws {
        let box = BoardRect(x: 10, y: 20, w: 120, h: 60)
        let a = try #require(path(shape("a", kind, box)))
        #expect(path(shape("a", kind, box)) == a)
        #expect(path(shape("b", kind, box)) != a, "another id wobbles differently")
        #expect(path(shape("a", kind, box.offsetBy(dx: 30))) != a, "new geometry, new shape")
        let bounds = try #require(a.bounds)
        // Wobble under a few points: the sketch stays on its box.
        #expect(bounds.minX > box.minX - 6 && bounds.maxX < box.maxX + 6)
        #expect(bounds.minY > box.minY - 8 && bounds.maxY < box.maxY + 8)
    }

    @Test func `lines and boxes draw two passes, ellipses one looping pass`() throws {
        let box = BoardRect(x: 0, y: 0, w: 200, h: 80)
        func moves(_ p: SketchPath?) -> Int { p?.commands.filter { if case .move = $0 { return true }; return false }.count ?? 0 }
        #expect(moves(path(shape("r", .rect, box))) == 8)
        #expect(moves(path(shape("d", .diamond, box))) == 8)
        #expect(moves(path(shape("e", .ellipse, box))) == 1)
        #expect(moves(path(shape("l", .line, box))) == 2)
        let tally = BoardElement(id: "t", content: .shape(BoardRect(x: 0, y: 0, w: 2, h: 20), kind: .line, points: [BoardPoint(0, 0), BoardPoint(1, 20)]))
        #expect(moves(path(tally)) == 1, "a short tally is one confident stroke")
    }

    @Test func `clean elements, text and images draw no sketch`() {
        #expect(path(shape("c", .rect, BoardRect(x: 0, y: 0, w: 80, h: 40), ref: "pr:acme#1")) == nil)
        let text = BoardElement(id: "t", content: .text(x: 0, y: 0, w: 80, h: nil, role: .title, text: "Hi", sub: nil, status: nil))
        #expect(path(text) == nil)
        let frame = BoardElement(id: "f", content: .frame(BoardRect(x: 0, y: 0, w: 80, h: 40), title: "Why"))
        #expect(path(frame) == nil, "a frame has no chrome")
        let outlined = BoardElement(id: "f", style: BoardStyle(stroke: .ink), content: .frame(BoardRect(x: 0, y: 0, w: 80, h: 40), title: "Why"))
        #expect(path(outlined) != nil, "unless Blob outlines it")
    }

    @Test func `arrows have a head, strokes follow their points`() throws {
        let a = BoardElement(id: "a", content: .frame(BoardRect(x: 0, y: 0, w: 100, h: 50), title: nil))
        let arrow = BoardElement(id: "x", content: .arrow(start: .element(id: "a", side: .right), end: .point(BoardPoint(300, 25)), bend: 0, label: nil))
        let drawn = try #require(path(arrow, with: [a]))
        #expect(drawn.commands.count == 1 + 8 + 2 * 2, "the curve, then two one-pass head lines")
        let stroke = BoardElement(id: "s", content: .stroke(BoardRect(x: 10, y: 10, w: 20, h: 20), points: [BoardPoint(0, 0), BoardPoint(20, 20)]))
        let s = try #require(path(stroke))
        guard case .move(let start) = s.commands.first else { Issue.record("starts with a move"); return }
        #expect(start.distance(to: BoardPoint(10, 10)) < 0.6)
    }

    @Test func `the generator is deterministic`() {
        #expect(SketchRandom.hash("") == 2_166_136_261)
        var a = SketchRandom(id: "c-ci"), b = SketchRandom(id: "c-ci")
        let first = (0..<20).map { _ in a.next() }
        #expect(first == (0..<20).map { _ in b.next() })
        #expect(first.allSatisfy { $0 >= 0 && $0 < 1 })
        let tilt = Sketch.noteTilt(id: "n-bill")
        #expect(tilt == Sketch.noteTilt(id: "n-bill") && abs(tilt) <= 1.5)
    }
}

struct BoardHitTestTests {
    @Test func `a tap on a ref card finds its object`() throws {
        let board = try DemoBoards.load("release")
        let layout = BoardLayout(elements: board.elements)
        #expect(BoardHitTest.ref(at: BoardPoint(100, 300), in: layout)?.ref == "pr:betterbahn#533")
        // Under the circling sketch (z 2) the check still opens.
        #expect(BoardHitTest.ref(at: BoardPoint(60, 190), in: layout) == .init(id: "c-ci", ref: "check:betterbahn#533/ci-success"))
        #expect(BoardHitTest.ref(at: BoardPoint(600, 166), in: layout)?.id == "s2")
    }

    @Test func `sketches, notes and plain text never open anything`() throws {
        let board = try DemoBoards.load("release")
        let layout = BoardLayout(elements: board.elements)
        #expect(BoardHitTest.ref(at: BoardPoint(60, 90), in: layout) == nil, "plain text")
        #expect(BoardHitTest.ref(at: BoardPoint(14, 196), in: layout) == nil, "the ellipse's edge")
        #expect(BoardHitTest.ref(at: BoardPoint(532, 125), in: layout) == nil, "a step line")
        #expect(BoardHitTest.ref(at: BoardPoint(470, 300), in: layout) == nil, "the fold")
    }

    @Test func `the topmost ref wins, within a little slop`() {
        let low = BoardElement(id: "low", z: 0, ref: "pr:acme#1", content: .frame(BoardRect(x: 0, y: 0, w: 100, h: 100), title: nil))
        let high = BoardElement(id: "high", z: 1, ref: "pr:acme#2", content: .shape(BoardRect(x: 40, y: 40, w: 20, h: 20), kind: .rect, points: nil))
        let layout = BoardLayout(elements: [high, low])
        #expect(BoardHitTest.ref(at: BoardPoint(50, 50), in: layout)?.id == "high")
        #expect(BoardHitTest.ref(at: BoardPoint(10, 10), in: layout)?.id == "low")
        #expect(BoardHitTest.ref(at: BoardPoint(103, 50), in: layout)?.id == "low")
        #expect(BoardHitTest.ref(at: BoardPoint(110, 50), in: layout) == nil)
    }
}

struct BoardReadingTests {
    /// The server's fallback without its markdown links.
    func plain(_ text: String) -> [String] {
        text.components(separatedBy: "\n").map {
            $0.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
        }
    }

    @Test(arguments: ["release", "morning"])
    func `VoiceOver reads what the text fallback writes, in the same order`(name: String) throws {
        let board = try DemoBoards.load(name)
        let lines = BoardReading.lines(board, layout: BoardLayout(elements: board.elements))
        #expect(lines.map(\.text) == plain(board.text))
    }

    @Test func `the left screen reads first, then top to bottom`() throws {
        let board = try DemoBoards.load("release")
        let lines = BoardReading.lines(board, layout: BoardLayout(elements: board.elements))
        let ids = lines.map(\.id)
        #expect(ids.first == "f-why")
        #expect(ids.firstIndex(of: "i-status")! < ids.firstIndex(of: "f-path")!)
        #expect(ids.firstIndex(of: "s1")! < ids.firstIndex(of: "s5")!)
        let note = try #require(lines.first { $0.id == "n-bill" })
        #expect(note.text == "Note on ci-success: GitHub billing, only you")
        #expect(ids.firstIndex(of: "n-bill") == ids.firstIndex(of: "c-ci")! + 1, "a note reads right after its anchor")
        #expect(lines.first { $0.id == "f-why" }?.heading == true)
        #expect(lines.first { $0.id == "p-533" }?.ref == "pr:betterbahn#533")
    }

    @Test func `a ref that no longer resolves reads as not found`() {
        let el = BoardElement(id: "p", ref: "pr:acme#12", content: .text(x: 0, y: 0, w: 200, h: nil, role: .title, text: nil, sub: "the fix", status: nil))
        let snapshot = BoardSnapshot(elements: [el])
        let lines = BoardReading.lines(snapshot, layout: BoardLayout(elements: [el]))
        #expect(lines.map(\.text) == ["acme#12: not found, the fix"])
    }
}
