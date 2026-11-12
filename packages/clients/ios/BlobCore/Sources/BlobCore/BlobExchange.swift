import Foundation

/// What history needs from one transcript row. The app's `TranscriptEntry`
/// conforms.
public protocol BlobTranscriptRow {
    var id: String { get }
    var text: String { get }
    var isUser: Bool { get }
    var isAssistant: Bool { get }
    var isTool: Bool { get }
    var isReasoning: Bool? { get }
    /// An operational notice (a worker's report, a recap), not a message.
    var isNotice: Bool { get }
    /// A content-free marker between turns.
    var turnBoundary: Bool? { get }
    var timestampDate: Date? { get }
}

/// One exchange with the supervisor: what you said, then Blob's reply.
public struct BlobExchange: Identifiable, Equatable, Sendable {
    public let id: String
    /// What you said: typed, dictated, or spoken on the voice call.
    public var said: String
    /// Blob's reply as markdown: what it said as a small "Blob said" line,
    /// then what it showed, drawn with the block catalog (`BlobReply`). Nil
    /// while there is no answer yet.
    public var reply: String?
    public var date: Date?
    /// It was shown across two panes, the conversation leading and what
    /// the reply showed (or a decision) trailing, so history lays it out
    /// that way again.
    public var split = false

    public init(id: String, said: String, reply: String? = nil, date: Date? = nil, split: Bool = false) {
        self.id = id
        self.said = said
        self.reply = reply
        self.date = date
        self.split = split
    }

    /// Groups a supervisor transcript into exchanges, oldest first.
    /// `shownBeside`: messages whose exchange was shown across two panes.
    ///
    /// A turn starts at a message from you; consecutive user rows (the voice
    /// call splits speech into rows) join into one. The reply is the turn's
    /// last run of assistant text: the answer after the final tool call, or
    /// the spoken rows of a voice reply. Reasoning, tools and operational
    /// notices (worker reports and the like) are left out, and so are the
    /// turns notices start, since Blob only shows what was said to you.
    public static func exchanges(
        in entries: [some BlobTranscriptRow], shownBeside: Set<String> = []
    ) -> [BlobExchange] {
        var out: [BlobExchange] = []
        var current: BlobExchange?
        var run: [String] = []
        var afterTool = false

        func flush() {
            if var exchange = current {
                if !run.isEmpty { exchange.reply = run.joined(separator: "\n\n") }
                out.append(exchange)
            }
            current = nil
            run = []
            afterTool = false
        }

        for entry in entries where entry.turnBoundary != true {
            let text = entry.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if entry.isUser {
                if entry.isNotice {
                    flush()
                    continue
                }
                guard !text.isEmpty else { continue }
                if var exchange = current, run.isEmpty, !afterTool {
                    exchange.said += "\n" + text
                    current = exchange
                } else {
                    flush()
                    current = BlobExchange(id: entry.id, said: text, date: entry.timestampDate)
                }
                if shownBeside.contains(entry.id) { current?.split = true }
            } else if entry.isAssistant {
                guard current != nil, entry.isReasoning != true, !entry.isNotice, !text.isEmpty else { continue }
                if afterTool { run = []; afterTool = false }
                run.append(text)
            } else if entry.isTool {
                afterTool = true
            }
        }
        flush()
        return out
    }
}
