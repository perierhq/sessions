import BlobCore
import Foundation
import Testing

/// The first real board, as the server sent it to an open Duo (project
/// names replaced): a count line too wide for its box, ref cards drawn
/// shorter than their words, frames whose titles sat where the count line
/// wrapped to.
enum LiveBoard {
    static func load() throws -> BoardSnapshot {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/live-board-duo-open.json")
        return try JSONDecoder().decode(BoardSnapshot.self, from: Data(contentsOf: url))
    }

    static func layout() throws -> BoardLayout {
        let board = try load()
        return BoardLayout(elements: board.elements, refs: board.refs)
    }
}

struct BoardTextFitTests {
    private func texts(_ layout: BoardLayout) -> [(String, BoardRect)] {
        layout.items.compactMap { item in
            guard case .text = item.element.content, let frame = item.frame else { return nil }
            return (item.element.id, frame)
        }
    }

    @Test func `no text on the live board overlaps other text after layout`() throws {
        let layout = try LiveBoard.layout()
        let boxes = texts(layout)
        #expect(boxes.count == 8)
        for (i, a) in boxes.enumerated() {
            for b in boxes[(i + 1)...] {
                #expect(!a.1.intersects(b.1), "\(a.0) \(a.1) overlaps \(b.0) \(b.1)")
            }
        }
    }

    @Test func `no text sits in a frame's title band`() throws {
        let layout = try LiveBoard.layout()
        for item in layout.items {
            guard case .frame(_, let title?) = item.element.content, !title.isEmpty, let box = item.frame else { continue }
            let band = BoardRect(x: box.x, y: box.y, w: box.w, h: BoardLayout.frameTitleBand)
            for (id, frame) in texts(layout) {
                #expect(!frame.intersects(band), "\(id) is under \(item.element.id)'s title")
            }
            // The title is drawn inside the band, in line with the cards.
            let at = try #require(layout.titles[item.element.id])
            #expect(at.y > box.y && at.y + BoardTextRole.meta.lineHeight <= box.y + BoardLayout.frameTitleBand)
            #expect(at.x == box.x + 12)
        }
    }

    @Test func `the count line widens to one line and stays on the closed screen`() throws {
        let layout = try LiveBoard.layout()
        let count = try #require(layout.frame("brief-count"))
        let words = BoardTextMetrics.width("6 handled alone \u{00B7} 8 asked you", role: .stat)
        #expect(count.w >= words)
        #expect(count.w > 350)
        #expect(count.maxX <= BoardLayout.closedWidth)
        #expect(count.h == BoardTextRole.stat.lineHeight, "one line")
        #expect(layout.adjustments.contains { $0.id == "brief-count" && $0.kind == .widened })
        // And it ends above the first region and its title.
        let region = try #require(layout.frame("region-acme"))
        #expect(count.maxY <= region.y)
    }

    @Test func `a card taller than its box moves what is under it, frames included`() throws {
        let board = try LiveBoard.load()
        let layout = try LiveBoard.layout()
        let support = try #require(layout.frame("dec-example-support"))
        let csp = try #require(layout.frame("dec-example-csp"))
        let pr = try #require(layout.frame("du-pr78"))
        #expect(support.h >= 55, "a card: title, status and padding")
        #expect(csp.y >= support.maxY)
        #expect(pr.y >= csp.maxY)
        // Its frame grows around it, and the next region moves down with
        // everything in it.
        let region = try #require(layout.frame("region-example"))
        #expect(region.maxY >= pr.maxY)
        let next = try #require(layout.frame("region-globex"))
        #expect(next.y >= region.maxY)
        let original = try #require(board.elements.first { $0.id == "bb-533" })
        guard case .text(_, let y, _, _, _, _, _, _) = original.content else { Issue.record("bb-533 is text"); return }
        let moved = try #require(layout.frame("bb-533"))
        #expect(moved.y - y == next.y - 478, "a region's elements move with it")
        // The arrow between them follows.
        let route = try #require(layout.arrows["bb-arrow"])
        #expect(route.start.y >= moved.maxY)
        // Nothing moved silently.
        #expect(layout.adjustments.contains { $0.id == "dec-example-csp" && $0.kind == .moved && $0.cause == "dec-example-support" })
    }

    @Test func `the circle around a text moves with it`() {
        let frame = BoardElement(id: "f", content: .frame(BoardRect(x: 0, y: 40, w: 360, h: 200), title: "acme"))
        let card = BoardElement(id: "c", ref: "pr:acme#1", content: .text(x: 12, y: 68, w: 300, h: 30, role: .title, text: "A card", sub: nil, status: nil))
        let label = BoardElement(id: "t", content: .text(x: 12, y: 104, w: 200, h: nil, role: .supporting, text: "Blocked", sub: nil, status: nil))
        let ring = BoardElement(id: "r", content: .shape(BoardRect(x: 4, y: 96, w: 220, h: 32), kind: .ellipse, points: nil))
        let layout = BoardLayout(elements: [frame, card, label, ring], refs: ["pr:acme#1": BoardRefInfo(ok: true, title: "A card", status: "open")])
        let t = layout.frame("t")!
        let r = layout.frame("r")!
        #expect(t.y >= layout.frame("c")!.maxY)
        #expect(r.y - 96 == t.y - 104)
    }

    @Test func `text with no room to widen wraps and grows`() {
        let frame = BoardElement(id: "f", content: .frame(BoardRect(x: 0, y: 0, w: 200, h: 120), title: nil))
        let long = BoardElement(id: "t", content: .text(x: 8, y: 8, w: 180, h: nil, role: .title,
                                                         text: "A title much too long for a box this narrow", sub: nil, status: nil))
        let below = BoardElement(id: "b", content: .text(x: 8, y: 30, w: 180, h: nil, role: .meta, text: "under it", sub: nil, status: nil))
        let layout = BoardLayout(elements: [frame, long, below])
        let t = layout.frame("t")!
        #expect(t.w <= 192, "no wider than its frame")
        #expect(t.h >= 2 * BoardTextRole.title.lineHeight)
        #expect(layout.frame("b")!.y >= t.maxY)
        #expect(layout.adjustments.contains { $0.id == "t" && $0.kind == .grew })
    }

    @Test func `widening stops at the next element on the right and at the fold`() {
        let a = BoardElement(id: "a", content: .text(x: 16, y: 0, w: 100, h: nil, role: .stat, text: "a long number line", sub: nil, status: nil))
        let b = BoardElement(id: "b", content: .text(x: 200, y: 0, w: 100, h: nil, role: .meta, text: "b", sub: nil, status: nil))
        let c = BoardElement(id: "c", content: .text(x: 400, y: 100, w: 40, h: nil, role: .stat, text: "nine hundred", sub: nil, status: nil))
        let layout = BoardLayout(elements: [a, b, c])
        #expect(layout.frame("a")!.maxX <= 192)
        #expect(layout.frame("c")!.maxX <= 455.5)
    }

    @Test func `the app's measure decides, not the estimate`() throws {
        let board = try LiveBoard.load()
        // A face twice as wide: the count line can't fit one line in 366 pt.
        let wide: BoardLayout.TextMeasure = { text, role, width in
            let base = BoardTextMetrics.estimate()(text, role, nil)
            let one = base.w * 2
            guard let width, one > width else { return BoardSize(one, base.h) }
            return BoardSize(width, ceil(one / width) * base.h)
        }
        let layout = BoardLayout(elements: board.elements, refs: board.refs, measureText: wide)
        let count = try #require(layout.frame("brief-count"))
        #expect(count.maxX <= BoardLayout.closedWidth)
        #expect(count.h >= 2 * BoardTextRole.stat.lineHeight)
        let boxes = texts(layout)
        for (i, x) in boxes.enumerated() {
            for y in boxes[(i + 1)...] { #expect(!x.1.intersects(y.1), "\(x.0) overlaps \(y.0)") }
        }
    }
}

struct BoardChromeTests {
    @Test func `the board never draws or fits under the controls band`() throws {
        let layout = try LiveBoard.layout()
        let band = BoardChrome.band(height: 669, bottomInset: 0, typing: false, caption: 64)
        let viewport = BoardViewport.duoOpen.reserving(bottom: band)
        #expect(viewport.content.maxY == 669 - band)
        let controls = try #require(viewport.controls)
        #expect(!controls.intersects(viewport.content))
        // Fit frames the whole board above the band.
        let bounds = try #require(layout.bounds)
        let fit = BoardCamera.fitting(bounds, in: viewport)
        let shown = fit.toView(bounds, in: viewport)
        #expect(shown.maxY <= viewport.content.maxY + 0.5)
        #expect(shown.maxX <= viewport.content.maxX + 0.5)
        // The camera shows only what the band leaves, and says so.
        #expect(BoardCamera.home.visible(in: viewport).h == viewport.content.h)
        let report = BoardViewportReport(viewport: viewport, camera: .home)
        #expect(report.h == 669 - band)
    }

    @Test func `the brief's caption sits in the band, never over the board`() {
        for base in [BoardViewport.duoOpen, .duoClosed, BoardViewport(size: BoardSize(402, 874), top: 62)] {
            for typing in [false, true] {
                let inset = base == .duoOpen || base == .duoClosed ? 0.0 : 34
                let caption = 20.0
                let band = BoardChrome.band(height: base.size.h, bottomInset: inset, typing: typing, caption: caption)
                let viewport = base.reserving(bottom: band)
                let rect = BoardChrome.captionRect(in: viewport, bottomInset: inset, typing: typing, caption: caption)
                #expect(!rect.intersects(viewport.content), "\(base.size) typing \(typing)")
                #expect(rect.minY >= viewport.content.maxY)
            }
        }
    }

    @Test func `Blob's corner is part of the band where it rests over the board`() {
        // A phone: Blob rests bottom trailing, its top 72 pt above the edge.
        let band = BoardChrome.band(height: 874, bottomInset: 34, typing: false, caption: 0, blobTop: 874 - 98)
        #expect(band >= 98)
    }
}
