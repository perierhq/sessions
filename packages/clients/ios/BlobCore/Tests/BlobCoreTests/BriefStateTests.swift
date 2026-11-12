import BlobCore
import Foundation
import Testing

/// The brief's state rules: which page Blob holds and which decisions are
/// still open.
struct BriefStateTests {
    typealias Item = SupervisorItem

    static func item(_ id: String, revision: Int64? = 1, state: String = "open", options: [String] = ["Yes", "No"]) -> Item {
        Item(id: id, kind: "needs-you", title: "Decide \(id)", options: options, state: state, revision: revision)
    }

    static func brief(_ items: [Item], seen: Bool = false, recommended: String? = nil, day: String = "2026-11-12") -> SupervisorBrief {
        SupervisorBrief(
            day: day, asOf: 1_000, say: "Morning.", seenAt: seen ? 2_000 : nil,
            handled: ["Closed one"],
            decisions: items.map { .init(item: $0, recommended: recommended) },
            laterCount: 2
        )
    }

    static func ready(_ brief: SupervisorBrief, newSince: [String] = []) -> SupervisorBriefResponse {
        .init(state: "ready", brief: brief, newSince: newSince)
    }

    /// A state showing an unseen brief with `items`.
    static func showing(_ items: [Item]) -> BlobBriefState {
        var state = BlobBriefState()
        let follow = state.apply(ready(brief(items)), offered: [])
        #expect(follow == .none)
        return state
    }

    // MARK: Phase and polling

    @Test(arguments: [("ready", BlobBriefState.Phase.ready), ("preparing", .preparing), ("none", .none), ("later", .none)])
    func `phase from the response`(state: String, phase: BlobBriefState.Phase) {
        #expect(BlobBriefState.Phase(state: state) == phase)
    }

    @Test func `polls every minute, every 10 seconds while preparing`() {
        #expect(BlobBriefState.Phase.ready.pollDelay == .seconds(60))
        #expect(BlobBriefState.Phase.none.pollDelay == .seconds(60))
        #expect(BlobBriefState.Phase.preparing.pollDelay == .seconds(10))
    }

    @Test func `preparing is said once per run`() {
        var state = BlobBriefState()
        _ = state.apply(.init(state: "preparing", brief: nil, preparingSince: 500), offered: [])
        #expect(state.phase == .preparing)
        #expect(state.page == nil)
        let first = state.shouldSayPreparing(), again = state.shouldSayPreparing()
        #expect(first && !again)
        _ = state.apply(.init(state: "preparing", brief: nil, preparingSince: 900), offered: [])
        let nextRun = state.shouldSayPreparing()
        #expect(nextRun)
    }

    // MARK: Which items show

    @Test func `an unseen brief shows its open decisions, recommended option first`() throws {
        var state = BlobBriefState()
        let items = [Self.item("a"), Self.item("b", state: "answered"), Self.item("c")]
        _ = state.apply(Self.ready(Self.brief(items, recommended: "No")), offered: [])
        let page = try #require(state.page)
        #expect(page.kind == .brief)
        #expect(page.decisions.map(\.id) == ["a", "c"])
        #expect(page.decisions.allSatisfy { $0.options == ["No", "Yes"] })
        #expect(state.unseen)
        #expect(state.menuLine == "2 decisions")
        let first = state.shown(page), again = state.shown(page)
        #expect(first && !again)
        #expect(!state.unseen)
    }

    @Test func `a seen brief shows nothing`() {
        var state = BlobBriefState()
        _ = state.apply(Self.ready(Self.brief([Self.item("a")], seen: true)), offered: [])
        #expect(state.page == nil)
        #expect(state.menuLine == nil)
    }

    @Test func `a brief put away doesn't come back before the seen mark lands`() {
        var state = Self.showing([Self.item("a")])
        state.dismissPage()
        #expect(state.page == nil)
        _ = state.apply(Self.ready(Self.brief([Self.item("a")])), offered: [])
        #expect(state.page == nil)
        #expect(!state.unseen)
    }

    @Test func `a newer brief replaces the page`() {
        var state = Self.showing([Self.item("a")])
        let next = SupervisorBrief(day: "2026-11-13", asOf: 5_000, say: "Next.", decisions: [.init(item: Self.item("z"), recommended: nil)])
        _ = state.apply(Self.ready(next), offered: [])
        #expect(state.page?.key == next.key)
        #expect(state.page?.decisions.map(\.id) == ["z"])
    }

    // MARK: Answers

    @Test func `two quick answers both close`() {
        var state = Self.showing([Self.item("a"), Self.item("b")])
        let a = Self.item("a"), b = Self.item("b")
        state.close(a, saying: "Done.")
        state.close(b, saying: "Done.")
        #expect(state.open.isEmpty)
        #expect(state.notes == ["a": "Done.", "b": "Done."])
        // The first note going leaves the second, and the page, be.
        state.noteExpired("a")
        #expect(state.page != nil)
        #expect(state.notes == ["b": "Done."])
        state.noteExpired("b")
        #expect(state.page == nil)
        // Put away: the same brief doesn't come back on the next read.
        _ = state.apply(Self.ready(Self.brief([Self.item("a"), Self.item("b")])), offered: [])
        #expect(state.page == nil)
    }

    @Test func `an answer closes only its own decision`() {
        var state = Self.showing([Self.item("a"), Self.item("b")])
        state.close(Self.item("a"), saying: "Done.")
        state.noteExpired("a")
        #expect(state.open.map(\.id) == ["b"])
        #expect(state.page != nil)
    }

    @Test(arguments: [
        ("changed", 409, BlobBriefState.Failure.changed),
        (nil, 409, .alreadyClosed),
        ("already closed", 409, .alreadyClosed),
        ("not found", nil, .alreadyClosed),
        (nil, 404, .alreadyClosed),
        (nil, 500, .other),
        ("boom", nil, .other),
    ] as [(String?, Int?, BlobBriefState.Failure)])
    func `how an answer failed`(message: String?, status: Int?, failure: BlobBriefState.Failure) {
        #expect(BlobBriefState.Failure(serverMessage: message, httpStatus: status) == failure)
    }

    @Test func `a 409 changed replaces the stale revision`() throws {
        var state = Self.showing([Self.item("a", revision: 1), Self.item("b", revision: 1)])
        let shown = try #require(state.open.first)
        // The answer came back 409 `changed`: nothing closes, Blob says so.
        state.say("This changed. Have another look.", about: shown)
        #expect(state.open.count == 2)
        // The re-read brings the new card in the same place.
        _ = state.apply(Self.ready(Self.brief([Self.item("a", revision: 2), Self.item("b", revision: 1)])), offered: [])
        #expect(state.open.map(\.id) == ["a", "b"])
        #expect(state.open.map(\.revision) == [2, 1])
        #expect(state.isRevised(Self.item("a")))
        #expect(!state.isRevised(Self.item("b")))
        // An answer to it now names revision 2.
        #expect(state.open.first?.cardKey == "a@2")
    }

    @Test func `a 409 changed on a new-since page re-reads the items`() {
        var state = BlobBriefState()
        _ = state.apply(Self.ready(Self.brief([], seen: true)), offered: [])
        state.offerNew(["n"], items: [Self.item("n", revision: 1)], briefDay: "2026-11-12", today: "2026-11-12")
        let held = state.page!
        let follow = state.apply(Self.ready(Self.brief([], seen: true), newSince: ["n"]), offered: ["n"])
        #expect(follow == .reread(held))
        state.reread(held, items: [Self.item("n", revision: 7)], limit: 100)
        #expect(state.page?.decisions.map(\.revision) == [7])
        #expect(state.isRevised(Self.item("n")))
    }

    @Test func `a decision settled elsewhere goes`() {
        var state = Self.showing([Self.item("a"), Self.item("b")])
        _ = state.apply(Self.ready(Self.brief([Self.item("a"), Self.item("b", state: "answered")])), offered: [])
        #expect(state.open.map(\.id) == ["a"])
        // With none left, the brief stays, like one with nothing to decide,
        // until the owner puts it away.
        _ = state.apply(Self.ready(Self.brief([Self.item("a", state: "dismissed")])), offered: [])
        #expect(state.page?.decisions.isEmpty == true)
        #expect(state.menuLine == "Brief ready")
    }

    @Test func `a dismissal that fails brings the decision back`() {
        var state = Self.showing([Self.item("a"), Self.item("b")])
        state.dismissed(Self.item("a"))
        #expect(state.open.map(\.id) == ["b"])
        state.dismissFailed(Self.item("a"), saying: "I couldn't dismiss that.")
        #expect(state.open.map(\.id) == ["a", "b"])
    }

    // MARK: New since, and links

    @Test func `new items since a seen brief come up once`() throws {
        var state = BlobBriefState()
        let response = Self.ready(Self.brief([], seen: true), newSince: ["n1", "n2", "old"])
        let follow = state.apply(response, offered: ["old"])
        #expect(follow == .offerNew(ids: ["n1", "n2"], briefDay: "2026-11-12"))
        state.offerNew(["n1", "n2"], items: [Self.item("n2"), Self.item("n1"), Self.item("x")], briefDay: "2026-11-12", today: "2026-11-12")
        let page = try #require(state.page)
        #expect(page.kind == .newSince)
        #expect(page.say == "2 new things since this morning.")
        #expect(page.decisions.map(\.id) == ["n1", "n2"])
        #expect(page.offered == ["n1", "n2"])
        #expect(state.menuLine == "2 new things")
        // Offered: the next read asks for nothing.
        state.dismissPage()
        let after = state.apply(response, offered: ["old", "n1", "n2"])
        #expect(after == .none)
    }

    @Test func `new items from an earlier day`() {
        var state = BlobBriefState()
        state.offerNew(["n"], items: [Self.item("n")], briefDay: "2026-11-11", today: "2026-11-12")
        #expect(state.page?.say == "One new thing since your last brief.")
    }

    @Test func `a new item no longer open isn't offered`() {
        var state = BlobBriefState()
        state.offerNew(["n"], items: [Self.item("n", state: "answered")], briefDay: "d", today: "d")
        #expect(state.page == nil)
    }

    @Test func `a linked item shows on its own and goes when settled`() {
        var state = BlobBriefState()
        state.focus(Self.item("l", revision: 3))
        #expect(state.page?.kind == .linked)
        #expect(state.page?.key == "item:l@3")
        #expect(state.shows(id: "l"))
        let held = state.page!
        // A full list may have left it out: it stays.
        state.reread(held, items: (0..<100).map { Self.item("x\($0)") }, limit: 100)
        #expect(state.page != nil)
        // A shorter list is all of them: it was settled elsewhere.
        state.reread(held, items: [Self.item("other")], limit: 100)
        #expect(state.page == nil)
    }

    // MARK: Reopening

    @Test func `a seen brief reopens with what was raised since under it`() throws {
        var state = BlobBriefState()
        let brief = Self.brief([Self.item("a")], seen: true)
        _ = state.apply(.init(state: "ready", brief: brief, newSince: ["n", "a", "gone"], reopenLine: "Today's brief"), offered: ["n"])
        #expect(state.page == nil)
        #expect(state.reopenLine == "Today's brief")
        #expect(state.canReopen)
        state.reopen(items: [Self.item("n"), Self.item("a"), Self.item("gone", state: "answered")])
        let page = try #require(state.page)
        #expect(page.kind == .brief)
        #expect(page.decisions.map(\.id) == ["a", "n"])
        #expect(page.since == ["n"])
        // Said when it first came up, not again.
        let saidAgain = state.shown(page)
        #expect(!saidAgain)
        // A read of the same brief keeps what reopening put under it.
        _ = state.apply(.init(state: "ready", brief: brief, newSince: ["n"]), offered: ["n"])
        #expect(state.page?.decisions.map(\.id) == ["a", "n"])
    }

    @Test func `an item raised since and answered elsewhere leaves the reopened page`() throws {
        var state = BlobBriefState()
        let brief = Self.brief([Self.item("a")], seen: true)
        _ = state.apply(.init(state: "ready", brief: brief, newSince: ["n", "m"]), offered: ["n", "m"])
        state.reopen(items: [Self.item("n"), Self.item("m")])
        let held = try #require(state.page)
        #expect(held.decisions.map(\.id) == ["a", "n", "m"])
        // The next read of the brief asks for the items raised since again.
        let follow = state.apply(.init(state: "ready", brief: brief, newSince: ["m"]), offered: ["n", "m"])
        guard case .rereadSince(let page) = follow else {
            Issue.record("expected rereadSince, got \(follow)")
            return
        }
        #expect(page.since == ["n", "m"])
        // "n" was answered elsewhere; only the items raised since are read,
        // so "a" (the brief's own, missing from this list) stays.
        state.reread(page, items: [Self.item("m")], limit: 100, only: page.since)
        #expect(state.page?.decisions.map(\.id) == ["a", "m"])
        #expect(state.open.map(\.id) == ["a", "m"])
    }

    @Test func `a reopened brief with nothing raised since needs no second read`() {
        var state = BlobBriefState()
        let brief = Self.brief([Self.item("a")], seen: true)
        _ = state.apply(Self.ready(brief), offered: [])
        state.reopen(items: nil)
        #expect(state.apply(Self.ready(brief), offered: []) == .none)
    }

    @Test func `a brief put away reopens, and items that couldn't be read are left out`() {
        var state = Self.showing([Self.item("a")])
        state.dismissPage()
        #expect(state.page == nil)
        state.reopen(items: nil)
        #expect(state.page?.decisions.map(\.id) == ["a"])
        #expect(!state.canReopen)
    }

    @Test func `the server's day format`() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let date = Date(timeIntervalSince1970: 1_762_905_600) // 2025-11-12 00:00 UTC
        #expect(BlobBriefState.day(of: date, in: calendar) == "2025-11-12")
    }
}
