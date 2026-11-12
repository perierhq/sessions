import BlobCore
import SwiftUI

/// History reads the supervisor's transcript rows (`BlobExchange.exchanges`).
extension TranscriptEntry: BlobTranscriptRow {
    var isNotice: Bool { notice != nil }
}

/// One earlier exchange on Blob's page, above the current one: an optional
/// day header, what you said, then Blob's reply. The header and the exchange
/// are one row, so each scroll target has one id and one height.
///
/// It is laid out the way it was shown (`BlobExchange.split`): an exchange
/// shown across two panes is split again, conversation leading and its
/// visual blocks trailing, and one shown in one column is centered with
/// everything inline (`BlobColumns`). On a surface too narrow for two
/// panes everything is inline.
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
        let split = exchange.split && columns.leading != nil ? reply.map(BlobReplySplit.init) : nil
        if let split {
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
                date: yesterday.addingTimeInterval(600),
                split: true
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
                date: now.addingTimeInterval(-3 * 3600),
                split: true
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
