import BlobCore
import Foundation
import Testing

/// Inbox items on the board (`item:si-<id>`): reading the ref, how
/// VoiceOver says it, and when the brief shows on the board.
struct BoardItemRefTests {
    static let itemBoard = """
    {"revision": 4, "updatedAt": 1700000000000,
     "elements": [
       {"id": "d1", "type": "text", "role": "title", "ref": "item:si-1b2c-3d", "x": 10, "y": 40, "w": 300},
       {"id": "d2", "type": "text", "role": "title", "ref": "item:si-gone", "x": 10, "y": 120, "w": 300, "text": "Rotate the key?"},
       {"id": "d3", "type": "text", "role": "title", "ref": "item:not-an-item", "x": 10, "y": 200, "w": 300, "text": "Odd"},
       {"id": "pr", "type": "text", "role": "title", "ref": "pr:acme#12", "x": 10, "y": 280, "w": 300}
     ],
     "refs": {
       "item:si-1b2c-3d": {"ok": true, "kind": "item", "title": "Merge the checkout fix?", "status": "waiting for you",
                           "statusTone": "amber", "updatedAt": "2026-11-14T08:00:00.000Z",
                           "fields": {"itemId": "si-1b2c-3d", "kind": "needs-you", "options": "Approve · Not now", "later": 3}},
       "item:si-gone": {"ok": false, "reason": "not-found"},
       "pr:acme#12": {"ok": true, "kind": "pr", "title": "#12 Fix it", "status": "open", "statusTone": "green"}
     }}
    """

    // MARK: The ref

    @Test func `an item ref names its inbox item`() {
        #expect(BoardItemRef.itemId("item:si-1b2c-3d") == "si-1b2c-3d")
        #expect(BoardItemRef.itemId(" item:si-abc ") == "si-abc")
        #expect(BoardItemRef.isItem("item:anything"))
        #expect(!BoardItemRef.isItem("pr:acme#12"))
        #expect(!BoardItemRef.isItem(nil))
    }

    @Test(arguments: ["item:", "item:si-", "item:abc", "item:si-a b", "item:si-a/b", "item:si-\("x".repeated(77))", "pr:acme#12", "itemsi-1", "si-1"])
    func `what isn't an inbox item id is no item`(ref: String) {
        #expect(BoardItemRef.itemId(ref) == nil)
    }

    @Test func `the resolved itemId wins, and a bad one falls back to the locator`() {
        let resolved = BoardRefInfo(ok: true, kind: "item", fields: ["itemId": "si-server"])
        #expect(BoardItemRef.itemId("item:si-locator", info: resolved) == "si-server")
        let bad = BoardRefInfo(ok: true, kind: "item", fields: ["itemId": "../x"])
        #expect(BoardItemRef.itemId("item:si-locator", info: bad) == "si-locator")
        #expect(BoardItemRef.itemId("item:si-locator", info: .missing) == "si-locator")
        // Only an item ref opens as one, whatever the fields say.
        #expect(BoardItemRef.itemId("pr:acme#12", info: resolved) == nil)
    }

    @Test func `a board with item refs decodes, unknown fields and all`() throws {
        let board = try decodeBoard(Self.itemBoard)
        #expect(board.elements.map(\.id) == ["d1", "d2", "d3", "pr"])
        let info = try #require(board.ref("item:si-1b2c-3d"))
        #expect(info.ok && info.kind == "item" && info.statusTone == .amber)
        #expect(info.fields["itemId"] == "si-1b2c-3d")
        #expect(info.fields["later"] == "3")
        #expect(board.itemId(for: "item:si-1b2c-3d") == "si-1b2c-3d")
        // Not found on the server: still the item it names, to try.
        #expect(board.itemId(for: "item:si-gone") == "si-gone")
        #expect(board.itemId(for: "item:not-an-item") == nil)
        #expect(board.itemId(for: "pr:acme#12") == nil)
        #expect(board.itemId(for: nil) == nil)
    }

    @Test func `a tap on an item finds its ref`() throws {
        let board = try decodeBoard(Self.itemBoard)
        let layout = BoardLayout(elements: board.elements)
        let frame = try #require(layout.frame("d1"))
        let hit = try #require(BoardHitTest.ref(at: frame.center, in: layout))
        #expect(hit == BoardHitTest.Hit(id: "d1", ref: "item:si-1b2c-3d"))
        #expect(board.itemId(for: hit.ref) == "si-1b2c-3d")
    }

    // MARK: VoiceOver

    @Test func `VoiceOver reads an item as the decision it opens`() throws {
        let board = try decodeBoard(Self.itemBoard)
        let lines = BoardReading.lines(board, layout: BoardLayout(elements: board.elements))
        let byId = Dictionary(uniqueKeysWithValues: lines.map { ($0.id, $0) })
        #expect(byId["d1"]?.text == "Decision: Merge the checkout fix?")
        #expect(byId["d1"]?.ref == "item:si-1b2c-3d")
        // Its own words when the board wrote some, found or not.
        #expect(byId["d2"]?.text == "Decision: Rotate the key?")
        // Not an inbox item id: an ordinary ref that wasn't found.
        #expect(byId["d3"]?.text == "Odd: not found")
        #expect(byId["pr"]?.text == "#12 Fix it: open")
    }

    // MARK: The brief on the board

    @Test func `the brief's board revision decodes tolerantly`() throws {
        func revision(_ value: String) throws -> Int? {
            try JSONDecoder().decode(SupervisorBriefResponse.self, from: Data("""
            {"state": "ready", "brief": {"day": "2026-11-14", "asOf": 1, "say": "Morning.", "boardRevision": \(value)}}
            """.utf8)).brief?.boardRevision
        }
        #expect(try revision("12") == 12)
        #expect(try revision("null") == nil)
        #expect(try revision("0") == nil)
        #expect(try revision("-3") == nil)
        #expect(try revision("2.5") == nil)
        #expect(try revision("\"12\"") == nil)
        let older = try JSONDecoder().decode(SupervisorBrief.self, from: Data("""
        {"day": "2026-11-14", "asOf": 1, "say": "Morning."}
        """.utf8))
        #expect(older.boardRevision == nil)
        #expect(BlobBriefState.page(for: SupervisorBrief(day: "d", asOf: 1, say: "", boardRevision: 7)).boardRevision == 7)
    }

    static let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    /// 2026-11-14 08:00 UTC, in ms.
    static let morning = 1_794_643_200_000.0

    /// A board at `revision` with a title and an `item:` element for each of
    /// `items`.
    static func board(updatedAt: Double, empty: Bool = false, revision: Int = 3, items: [String] = []) -> BoardSnapshot {
        let title = BoardElement(id: "t", content: .text(x: 0, y: 0, w: 100, h: nil, role: .title, text: "Hi", sub: nil, status: nil))
        let refs = items.enumerated().map { index, id in
            BoardElement(id: "d\(index)", ref: "item:\(id)", content: .text(x: 0, y: Double(40 * (index + 1)), w: 300, h: nil, role: .title, text: nil, sub: nil, status: nil))
        }
        return BoardSnapshot(
            revision: revision, latestRevision: revision, updatedAt: updatedAt,
            elements: empty ? [] : [title] + refs
        )
    }

    static func page(boardRevision: Int?, kind: BlobBriefState.Page.Kind = .brief, decisions: [SupervisorItem] = []) -> BlobBriefState.Page {
        .init(kind: kind, key: "k", say: "Morning.", decisions: decisions, boardRevision: boardRevision)
    }

    @Test func `a brief with a board revision shows on the board`() {
        let old = Self.board(updatedAt: Self.morning - 3 * 86_400_000)
        #expect(Self.page(boardRevision: 3).drawn(on: old, open: [], today: "2026-11-14", calendar: Self.utc))
    }

    @Test func `a board older than the brief's revision keeps the cards`() {
        let earlier = Self.board(updatedAt: Self.morning, revision: 2)
        #expect(!Self.page(boardRevision: 3).drawn(on: earlier, open: [], today: "2026-11-14", calendar: Self.utc))
        let later = Self.board(updatedAt: Self.morning, revision: 4)
        #expect(Self.page(boardRevision: 3).drawn(on: later, open: [], today: "2026-11-14", calendar: Self.utc))
    }

    @Test func `a brief without one shows on a board drawn today`() {
        let today = Self.board(updatedAt: Self.morning)
        let yesterday = Self.board(updatedAt: Self.morning - 86_400_000)
        #expect(Self.page(boardRevision: nil).drawn(on: today, open: [], today: "2026-11-14", calendar: Self.utc))
        #expect(!Self.page(boardRevision: nil).drawn(on: yesterday, open: [], today: "2026-11-14", calendar: Self.utc))
        #expect(!Self.page(boardRevision: nil).drawn(on: Self.board(updatedAt: 0), open: [], today: "1970-01-01", calendar: Self.utc))
    }

    @Test func `the cards stay when the board is empty or missing, or the page isn't the brief`() {
        let empty = Self.board(updatedAt: Self.morning, empty: true)
        #expect(!Self.page(boardRevision: 3).drawn(on: empty, open: [], today: "2026-11-14", calendar: Self.utc))
        #expect(!Self.page(boardRevision: 3).drawn(on: nil, open: [], today: "2026-11-14", calendar: Self.utc))
        let today = Self.board(updatedAt: Self.morning)
        #expect(!Self.page(boardRevision: 3, kind: .linked).drawn(on: today, open: [], today: "2026-11-14", calendar: Self.utc))
        #expect(!Self.page(boardRevision: 3, kind: .newSince).drawn(on: today, open: [], today: "2026-11-14", calendar: Self.utc))
    }

    @Test func `the board shows only when it holds every open decision`() {
        let a = BriefStateTests.item("si-a"), b = BriefStateTests.item("si-b")
        let page = Self.page(boardRevision: 3, decisions: [a, b])
        let both = Self.board(updatedAt: Self.morning, items: ["si-a", "si-b"])
        #expect(page.drawn(on: both, open: [a, b], today: "2026-11-14", calendar: Self.utc))
        // One decision isn't on the board: it couldn't be opened, so the cards.
        let missingOne = Self.board(updatedAt: Self.morning, items: ["si-a"])
        #expect(!page.drawn(on: missingOne, open: [a, b], today: "2026-11-14", calendar: Self.utc))
        // Drawn today without a revision, the same rule.
        let undated = Self.page(boardRevision: nil, decisions: [a, b])
        #expect(!undated.drawn(on: missingOne, open: [a, b], today: "2026-11-14", calendar: Self.utc))
        // Once the missing one is closed, the board holds every open one.
        #expect(page.drawn(on: missingOne, open: [a], today: "2026-11-14", calendar: Self.utc))
        // An item element with an unreadable id is no decision.
        let odd = Self.board(updatedAt: Self.morning, items: ["si-a", "not-an-item"])
        #expect(!page.drawn(on: odd, open: [a, b], today: "2026-11-14", calendar: Self.utc))
    }

    @Test func `a brief state's open decisions decide the board`() {
        let a = BriefStateTests.item("si-a"), b = BriefStateTests.item("si-b")
        var state = BriefStateTests.showing([a, b])
        let board = Self.board(updatedAt: Self.morning, items: ["si-a"])
        let today = BlobBriefState.day(of: Date(timeIntervalSince1970: Self.morning / 1000), in: Self.utc)
        #expect(state.page?.drawn(on: board, open: state.open, today: today, calendar: Self.utc) == false)
        state.close(b, saying: "Done.")
        #expect(state.page?.drawn(on: board, open: state.open, today: today, calendar: Self.utc) == true)
    }

    // MARK: Looking up a tapped item

    @Test func `a tapped item is open, closed, or can't be told`() {
        let a = BriefStateTests.item("si-a", revision: 4)
        #expect(BlobBriefState.lookup("si-a", in: [a], limit: 100) == .open(a))
        #expect(BlobBriefState.lookup("si-b", in: [a], limit: 100) == .closed)
        #expect(BlobBriefState.lookup("si-b", in: [], limit: 100) == .closed)
        let answered = BriefStateTests.item("si-a", state: "answered")
        #expect(BlobBriefState.lookup("si-a", in: [answered], limit: 100) == .closed)
        // The read failed: a network error, not a closed item.
        #expect(BlobBriefState.lookup("si-a", in: nil, limit: 100) == .unavailable)
        // A full list may have left it out.
        #expect(BlobBriefState.lookup("si-b", in: [a], limit: 1) == .unavailable)
    }

    @Test func `a board revision written after the brief comes with the next read`() throws {
        var state = BlobBriefState()
        let item = BriefStateTests.item("si-a")
        _ = state.apply(BriefStateTests.ready(BriefStateTests.brief([item])), offered: [])
        #expect(state.page?.boardRevision == nil)
        let drawn = SupervisorBrief(day: "2026-11-12", asOf: 1_000, say: "Morning.", decisions: [.init(item: item, recommended: nil)], boardRevision: 9)
        _ = state.apply(BriefStateTests.ready(drawn), offered: [])
        #expect(state.page?.boardRevision == 9)
    }

    // MARK: Opening a decision from the board

    @Test func `a decision opened from the brief's board gives the brief back when answered`() throws {
        let a = BriefStateTests.item("si-a"), b = BriefStateTests.item("si-b")
        var state = BriefStateTests.showing([a, b])
        let brief = try #require(state.page)
        state.focus(BriefStateTests.item("si-a", revision: 5))
        #expect(state.page?.kind == .linked)
        #expect(state.page?.decisions.map(\.revision) == [5])
        state.close(a, saying: "Done.")
        state.noteExpired(a.id)
        #expect(state.page?.key == brief.key)
        #expect(state.open.map(\.id) == ["si-b"])
    }

    @Test func `putting the decision away gives the brief back`() throws {
        var state = BriefStateTests.showing([BriefStateTests.item("si-a")])
        let brief = try #require(state.page)
        state.focus(BriefStateTests.item("si-a"))
        state.dismissPage()
        #expect(state.page?.key == brief.key)
        state.dismissPage()
        #expect(state.page == nil)
    }

    @Test func `the brief's last decision answered from the board settles the brief too`() {
        let a = BriefStateTests.item("si-a")
        var state = BriefStateTests.showing([a])
        state.focus(a)
        state.close(a, saying: "Done.")
        state.noteExpired(a.id)
        #expect(state.page == nil)
    }

    @Test func `a new brief while a decision is open drops the old one behind it`() {
        var state = BriefStateTests.showing([BriefStateTests.item("si-a")])
        state.focus(BriefStateTests.item("si-x"))
        let next = SupervisorBrief(day: "2026-11-13", asOf: 5_000, say: "Next.", decisions: [.init(item: BriefStateTests.item("si-c"), recommended: nil)])
        _ = state.apply(BriefStateTests.ready(next), offered: [])
        #expect(state.page?.key == next.key)
        state.dismissPage()
        #expect(state.page == nil)
    }
}

private extension String {
    func repeated(_ count: Int) -> String { String(repeating: self, count: count) }
}
