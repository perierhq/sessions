import SwiftUI

/// One exchange with the supervisor: what you said, then Blob's reply.
struct BlobExchange: Identifiable, Equatable {
    let id: String
    /// What you said: typed, dictated, or spoken on the voice call.
    var said: String
    /// Blob's reply as markdown: its first paragraph as the Say line, the
    /// rest drawn with the block catalog (`BlobReply`). Nil while there is
    /// no answer yet.
    var reply: String?
    /// The entry the reply came from, so its `choices` know whether they are
    /// still current.
    var replyId: String?
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
                current?.replyId = entry.id
            } else if entry.isTool {
                afterTool = true
            }
        }
        flush()
        return out
    }
}

/// Earlier exchanges with Blob, newest at the bottom. Opened with a swipe up
/// on the home; pulling down past the oldest one, or tapping Blob, goes back.
struct BlobHistoryView: View {
    let exchanges: [BlobExchange]
    let relay: QuickReplyRelay?
    let canLoadEarlier: Bool
    let loadingEarlier: Bool
    let loadEarlier: () -> Void
    let dismiss: () -> Void
    /// Room kept clear on each side: the safe area, plus Blob's slot.
    let margins: EdgeInsets

    @State private var dismissed = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if loadingEarlier {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.bottom, 24)
                }
                ForEach(Array(exchanges.enumerated()), id: \.element.id) { index, exchange in
                    let day = Self.day(exchange.date)
                    if let day, index == 0 || Self.day(exchanges[index - 1].date) != day {
                        Text(day)
                            .font(.caption2)
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .frame(maxWidth: .infinity)
                            .padding(.top, index == 0 ? 0 : 12)
                            .padding(.bottom, 20)
                            .accessibilityAddTraits(.isHeader)
                    }
                    row(exchange)
                        .padding(.bottom, 32)
                        .onAppear {
                            if index == 0, canLoadEarlier, !loadingEarlier { loadEarlier() }
                        }
                }
            }
            .padding(.leading, margins.leading)
            .padding(.trailing, margins.trailing)
            .padding(.top, margins.top)
            .padding(.bottom, margins.bottom)
        }
        .defaultScrollAnchor(.bottom)
        // Older pages arrive at the top; keep what you're reading in place.
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
        .scrollBounceBehavior(.always)
        .scrollIndicators(.hidden)
        // Older exchanges fade out at the top edge instead of being cut off.
        .mask {
            VStack(spacing: 0) {
                LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom)
                    .frame(height: margins.top)
                Rectangle()
            }
            .ignoresSafeArea()
        }
        .onScrollGeometryChange(for: Bool.self) { geometry in
            // Pulled well past the oldest exchange: back to the home.
            geometry.contentOffset.y + geometry.contentInsets.top < -72
        } action: { _, pulled in
            if pulled, !dismissed {
                dismissed = true
                dismiss()
            }
        }
        .overlay {
            if exchanges.isEmpty, !loadingEarlier {
                Text("Nothing yet")
                    .font(.caption2)
                    .foregroundStyle(OS1VisualStyle.textDim)
            }
        }
        .accessibilityAction(.escape, dismiss)
    }

    private func row(_ exchange: BlobExchange) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(exchange.said)
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.textDim)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .multilineTextAlignment(.trailing)
                .accessibilityLabel("You: \(exchange.said)")
            if let reply = exchange.reply {
                BlobReplyView(reply: BlobReply(reply), entryId: exchange.replyId, relay: relay)
            }
        }
        .accessibilityElement(children: .contain)
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
    /// fills it, `BLOB_DEMO_HISTORY=open` also opens it at launch.
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

    static var demoOpen: Bool { ProcessInfo.processInfo.environment["BLOB_DEMO_HISTORY"] == "open" }
}
#endif
