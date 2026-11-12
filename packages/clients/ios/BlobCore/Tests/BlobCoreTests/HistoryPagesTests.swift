import BlobCore
import Foundation
import Testing

/// History pages from the server: each goes above the ones held, once.
struct HistoryPagesTests {
    typealias Exchange = SupervisorHistoryPage.Exchange

    static func exchange(_ id: String, at: Double? = nil) -> Exchange {
        Exchange(id: id, sessionId: "s", said: "said \(id)", reply: "reply \(id)", at: at)
    }

    @Test func `pages merge oldest first, without duplicates`() {
        var history = BlobHistoryPages()
        #expect(history.isEmpty && history.cursor == nil && !history.ended)
        history.add(.init(exchanges: [Self.exchange("c"), Self.exchange("d"), Self.exchange("e")], before: "c"))
        #expect(history.cursor == "c")
        // The page before overlaps the one held: "c" stays where it was read.
        history.add(.init(exchanges: [Self.exchange("a"), Self.exchange("b"), Self.exchange("c")], before: "a"))
        #expect(history.exchanges.map(\.id) == ["a", "b", "c", "d", "e"])
        #expect(history.cursor == "a" && !history.ended)
        // A page repeating itself adds nothing; no cursor is the start.
        history.add(.init(exchanges: [Self.exchange("a"), Self.exchange("a")], before: nil))
        #expect(history.exchanges.map(\.id) == ["a", "b", "c", "d", "e"])
        #expect(history.ended)
    }

    @Test func `the live transcript draws its own exchanges`() {
        var history = BlobHistoryPages()
        history.add(.init(exchanges: [Self.exchange("a", at: 1_000), Self.exchange("b"), Self.exchange("c")], before: nil))
        let past = history.past(excluding: ["c"], shownBeside: ["b"])
        #expect(past.map(\.id) == ["a", "b"])
        #expect(past.map(\.split) == [false, true])
        #expect(past[0] == BlobExchange(id: "a", said: "said a", reply: "reply a", date: Date(timeIntervalSince1970: 1)))
    }

    @Test func `a page decodes tolerantly`() throws {
        let page = try JSONDecoder().decode(SupervisorHistoryPage.self, from: Data("""
        {"exchanges": [
           {"id": "a", "sessionId": "s1", "said": "Hi", "reply": "Hello", "at": 1000, "new": 1},
           {"id": "b", "said": "Only said"},
           {"said": "no id"},
           {"id": "c"}
         ], "before": ""}
        """.utf8))
        #expect(page.exchanges.map(\.id) == ["a", "b"])
        #expect(page.exchanges[1].reply == nil && page.exchanges[1].sessionId == "")
        #expect(page.before == nil)
    }
}
