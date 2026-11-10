import SwiftUI

/// One exchange with the supervisor: what you said, then Blob's reply.
struct BlobExchange: Identifiable, Equatable {
    let id: String
    /// What you said: typed, dictated, or spoken on the voice call.
    var said: String
    /// Blob's reply as markdown: what it said as a small "Blob said" line,
    /// then what it showed, drawn with the block catalog (`BlobReply`). Nil
    /// while there is no answer yet.
    var reply: String?
    var date: Date?

    /// Groups a supervisor transcript into exchanges, oldest first.
    ///
    /// A turn starts at a message from you; consecutive user rows (the voice
    /// call splits speech into rows) join into one. The reply is the turn's
    /// last run of assistant text: the answer after the final tool call, or
    /// the spoken rows of a voice reply. Reasoning, tools and operational
    /// notices (worker reports and the like) are left out, and so are the
    /// turns notices start, since Blob only shows what was said to you.
    static func exchanges(in entries: [TranscriptEntry]) -> [BlobExchange] {
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
                if entry.notice != nil {
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
            } else if entry.isAssistant {
                guard current != nil, entry.isReasoning != true, entry.notice == nil, !text.isEmpty else { continue }
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

/// One earlier exchange on Blob's page, above the current one: an optional
/// day header, what you said, then Blob's reply. The header and the exchange
/// are one row, so each scroll target has one id and one height.
///
/// It is laid out the way it was shown: on a wide surface a reply with
/// visual blocks is split across the two panes, conversation leading and
/// visuals trailing, and one without is centered (`BlobColumns`). On one
/// column everything is inline, as it was there.
struct BlobHistoryRow: View {
    let exchange: BlobExchange
    /// "Today", "Yesterday" or the date, on the first exchange of each day.
    let day: String?
    let first: Bool
    let columns: BlobColumns

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let day {
                Text(day)
                    .font(.caption2)
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .frame(maxWidth: .infinity)
                    .blobColumn(columns.centered)
                    .padding(.top, first ? 0 : 12)
                    .padding(.bottom, 20)
                    .accessibilityAddTraits(.isHeader)
            }
            row
        }
        .padding(.bottom, 32)
    }

    /// The day header for `exchanges[index]`: only where the day changes.
    static func header(_ exchanges: [BlobExchange], at index: Int) -> String? {
        guard let day = day(exchanges[index].date) else { return nil }
        return index == 0 || Self.day(exchanges[index - 1].date) != day ? day : nil
    }

    // Past replies are read, not answered: their quick replies are left
    // out, so no chip changes state or height as the conversation moves on.
    @ViewBuilder
    private var row: some View {
        let reply = exchange.reply.map(Self.withoutChoices)
        let split = columns.leading != nil ? reply.map(BlobReplySplit.init) : nil
        if let split, !split.visuals.isEmpty {
            BlobSplitRow(columns: columns, visuals: split.visuals) {
                conversation(split.conversation)
            }
            .accessibilityElement(children: .contain)
        } else {
            conversation(reply)
                .blobColumn(columns.centered)
        }
    }

    private func conversation(_ reply: String?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(exchange.said)
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.textDim)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .multilineTextAlignment(.trailing)
                .accessibilityLabel("You: \(exchange.said)")
            if let reply {
                // A spoken script is a small "Blob said" line; an older reply
                // without one keeps its first paragraph as the Say line.
                let past = BlobReply(reply)
                BlobReplyView(reply: past, sayStyle: past.scripted ? .said : .line)
            }
        }
        .accessibilityElement(children: .contain)
    }

    /// The reply without its ```choices fences.
    static func withoutChoices(_ markdown: String) -> String {
        var kept: [Substring] = []
        var closing: String?
        for line in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let fence = closing {
                if trimmed.hasPrefix(fence), trimmed.allSatisfy({ $0 == fence.first }) {
                    closing = nil
                }
                continue
            }
            let marker = trimmed.prefix(while: { $0 == "`" || $0 == "~" })
            if marker.count >= 3, Set(marker).count == 1,
               trimmed.dropFirst(marker.count).trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("choices") {
                closing = String(marker)
                continue
            }
            kept.append(line)
        }
        return kept.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// "Today", "Yesterday", or the date; nil without a timestamp.
    static func day(_ date: Date?) -> String? {
        guard let date else { return nil }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        if calendar.isDate(date, equalTo: .now, toGranularity: .year) {
            return date.formatted(.dateTime.weekday(.wide).day().month(.wide))
        }
        return date.formatted(.dateTime.day().month(.wide).year())
    }
}

#if DEBUG
extension BlobExchange {
    /// Canned history for screenshots without a server: `BLOB_DEMO_HISTORY=1`
    /// fills it; `open` and `top` reveal it at launch (`demoReveal`).
    static let demo: [BlobExchange]? = {
        guard ProcessInfo.processInfo.environment["BLOB_DEMO_HISTORY"] != nil else { return nil }
        let now = Date.now
        let yesterday = now.addingTimeInterval(-26 * 3600)
        return [
            BlobExchange(
                id: "demo-1",
                said: "Did the payout fix go out?",
                reply: "Yes, it merged at 16:40 and the deploy finished ten minutes later. No new payout errors since.",
                date: yesterday
            ),
            BlobExchange(
                id: "demo-2",
                said: "How was support yesterday?",
                reply: """
                **Quieter than Monday.** Most of it was refunds.

                ```metrics
                Tickets: 23 (+9)
                Answered: 21
                Median reply: 4 min (−2 min)
                ```
                """,
                date: yesterday.addingTimeInterval(600)
            ),
            BlobExchange(
                id: "demo-3",
                said: "Anything waiting on me?",
                reply: """
                Two things.

                ```csv
                What,Since
                Review the wallet pass PR,9:12
                Answer the refund question,10:05
                ```
                """,
                date: now.addingTimeInterval(-3 * 3600)
            ),
            BlobExchange(
                id: "demo-4",
                said: "Thanks, start on the PR review",
                reply: "On it. I'll tell you when it's done.",
                date: now.addingTimeInterval(-3 * 3600 + 120)
            ),
        ]
    }()

    /// `open` reveals history at launch; `top` also scrolls to its oldest
    /// exchange, as after scrolling up into it.
    static var demoReveal: String? {
        let value = ProcessInfo.processInfo.environment["BLOB_DEMO_HISTORY"]
        return value == "open" || value == "top" ? value : nil
    }
}
#endif
