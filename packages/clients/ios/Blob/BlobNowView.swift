import SwiftUI

/// The trailing pane's quiet "Now" view on a wide surface
/// (`BlobWideLayout.now`), while the current reply has nothing of its own
/// for that pane: what is going on, at a glance. It is built only from what
/// Blob already loads, the supervisor's run and the decisions waiting on
/// you (`BlobDecisions`). Nothing in it is a control: a decision is
/// answered where it comes up.
struct BlobNowView: View {
    /// The supervisor is working.
    let running: Bool
    /// When its run started, if known.
    let since: Date?
    /// Decisions waiting on you, without the one already on the page.
    let waiting: [OS1API.SupervisorItem]

    @ScaledMetric(relativeTo: .subheadline) private var titleSize: CGFloat = 14
    @ScaledMetric(relativeTo: .footnote) private var supportingSize: CGFloat = 13
    @ScaledMetric(relativeTo: .caption2) private var metaSize: CGFloat = 11

    var body: some View {
        Group {
            if !running && waiting.isEmpty {
                Text("Nothing needs you right now.")
                    .font(.system(size: supportingSize))
                    .foregroundStyle(OS1VisualStyle.textDim)
            } else {
                VStack(alignment: .leading, spacing: 20) {
                    meta("Now")
                        .accessibilityAddTraits(.isHeader)
                    if running {
                        row(title: "Working", supporting: nil, meta: since.map { "Since \(Self.time($0))" })
                    }
                    if !waiting.isEmpty {
                        VStack(alignment: .leading, spacing: 14) {
                            meta(waiting.count == 1 ? "1 decision waiting" : "\(waiting.count) decisions waiting")
                            ForEach(waiting) { item in
                                row(title: item.title, supporting: Self.summary(item), meta: Self.meta(item))
                            }
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func row(title: String, supporting: String?, meta: String?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.system(size: titleSize, weight: .semibold))
                .foregroundStyle(OS1VisualStyle.text)
                .lineSpacing(titleSize * 3 / 14)
                .lineLimit(2)
            if let supporting, !supporting.isEmpty {
                Text(supporting)
                    .font(.system(size: supportingSize))
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .lineSpacing(supportingSize * 3 / 13)
                    .lineLimit(2)
            }
            if let meta {
                self.meta(meta)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }

    private func meta(_ text: String) -> some View {
        Text(text)
            .font(.system(size: metaSize))
            .lineSpacing(metaSize * 2 / 11)
            .foregroundStyle(OS1VisualStyle.textFaint)
    }

    /// What Blob would say about it: the body's first paragraph.
    private static func summary(_ item: OS1API.SupervisorItem) -> String {
        BlobReply(item.body).spoken
    }

    /// The project, "Down" when something is fully down, and how long it
    /// has waited, as the decision itself says it.
    private static func meta(_ item: OS1API.SupervisorItem) -> String? {
        let parts = [
            item.project,
            item.urgency == "down" ? "Down" : nil,
            BlobDecisionView.ago(item, .narrow),
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private static func time(_ date: Date) -> String {
        Calendar.current.isDateInToday(date)
            ? date.formatted(date: .omitted, time: .shortened)
            : date.formatted(.dateTime.weekday(.abbreviated).hour().minute())
    }
}
