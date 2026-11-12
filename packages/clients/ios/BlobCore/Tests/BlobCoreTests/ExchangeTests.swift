import BlobCore
import Foundation
import Testing

/// History: a supervisor transcript grouped into what you said and Blob's
/// reply.
struct ExchangeTests {
    struct Row: BlobTranscriptRow {
        var id: String
        var type: String
        var text: String
        var isReasoning: Bool? = nil
        var isNotice = false
        var turnBoundary: Bool? = nil
        var timestampDate: Date? = nil
        var isUser: Bool { type == "user" }
        var isAssistant: Bool { type == "assistant" }
        var isTool: Bool { type == "tool_use" || type == "tool_result" }
    }

    static func user(_ id: String, _ text: String, notice: Bool = false) -> Row {
        Row(id: id, type: "user", text: text, isNotice: notice)
    }

    static func blob(_ id: String, _ text: String, reasoning: Bool = false) -> Row {
        Row(id: id, type: "assistant", text: text, isReasoning: reasoning)
    }

    @Test func `the reply is the last run of text after the final tool`() {
        let rows = [
            Self.user("u1", "Did the fix go out?"),
            Self.blob("r", "thinking about it", reasoning: true),
            Self.blob("a1", "Let me check."),
            Row(id: "t", type: "tool_use", text: ""),
            Row(id: "tr", type: "tool_result", text: "ok"),
            Self.blob("a2", "Yes, it merged."),
            Self.blob("a3", "No errors since."),
        ]
        let exchanges = BlobExchange.exchanges(in: rows)
        #expect(exchanges == [BlobExchange(id: "u1", said: "Did the fix go out?", reply: "Yes, it merged.\n\nNo errors since.")])
    }

    @Test func `voice rows join, notices start no exchange`() {
        let rows = [
            Self.user("u1", "Anything"),
            Self.user("u2", "waiting on me?"),
            Self.blob("a1", "Two things."),
            Self.user("n", "Worker report", notice: true),
            Self.blob("a2", "Noted."),
            Row(id: "b", type: "user", text: "", turnBoundary: true),
            Self.user("u3", "  "),
            Self.user("u4", "Thanks"),
        ]
        let exchanges = BlobExchange.exchanges(in: rows, shownBeside: ["u1"])
        #expect(exchanges.map(\.said) == ["Anything\nwaiting on me?", "Thanks"])
        #expect(exchanges.map(\.reply) == ["Two things.", nil])
        #expect(exchanges.map(\.split) == [true, false])
    }

    @Test func `nothing said, no exchanges`() {
        #expect(BlobExchange.exchanges(in: [Self.blob("a", "Hello")]).isEmpty)
        #expect(BlobExchange.exchanges(in: [Row]()).isEmpty)
    }
}
