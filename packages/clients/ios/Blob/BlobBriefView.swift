import SwiftUI

/// The brief on Blob's page: what Blob said, the decisions it picked, and
/// one quiet line for what it handled and what can wait, which opens to the
/// handled lines. The quiet line sits right under what Blob said, above the
/// decisions. "Done" puts the whole page away; it is not "Not now", which a
/// decision may carry as an option and which answers it.
///
/// On two panes the page re-arranges rather than stretching: what Blob said
/// and the quiet line stay with the conversation (`.conversation`), the
/// decisions go to the second pane (`.decisions`). There the handled lines
/// start open, since the pane has the room; on one pane they start closed.
///
/// A brief the supervisor drew on the board (`Page.drawn(on:)`) shows the
/// board instead of the decisions: what Blob said and the quiet line sit
/// over it (`.board`), and each decision opens from its element there.
struct BlobBriefView: View {
    enum Part { case all, conversation, decisions, board }

    let brief: BlobBrief
    let page: BlobBrief.Page
    var part: Part = .all

    @State private var expanded: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(brief: BlobBrief, page: BlobBrief.Page, part: Part = .all) {
        self.brief = brief; self.page = page; self.part = part
        _expanded = State(initialValue: part == .conversation || Self.demoExpanded)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if part != .decisions, !page.say.isEmpty {
                BlobSayLine(text: page.say)
                    .accessibilityLabel("Blob says: \(page.say)")
                    .padding(.bottom, 28)
            }
            if part != .decisions {
                footer
                    .padding(.bottom, part == .all ? 20 : 0)
            }
            if part == .all || part == .decisions {
                decisions
            }
        }
        .frame(maxWidth: 560, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Done with brief") { brief.dismiss() }
    }

    private var decisions: some View {
        let first = brief.open.first?.id
        return VStack(alignment: .leading, spacing: 36) {
            ForEach(page.decisions.filter { brief.open.contains($0) || brief.note(for: $0.id) != nil }) { item in
                if let note = brief.note(for: item.id) {
                    BlobSayLine(text: note)
                        .transition(.opacity)
                } else {
                    BlobDecisionView(
                        item: item,
                        sending: brief.sending == item.id,
                        prominent: item.id == first,
                        inBrief: true,
                        revised: brief.isRevised(item),
                        answer: { option in Task { await brief.answer(item, with: option) } },
                        dismiss: { Task { await brief.dismiss(item) } }
                    )
                    // A re-raised item is a new card.
                    .id(item.cardKey)
                    .transition(reduceMotion ? .opacity : .offset(y: 12).combined(with: .opacity))
                }
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.2) : .smooth(duration: 0.35), value: brief.open.map(\.id))
        .animation(.easeOut(duration: 0.2), value: brief.notes)
    }

    /// "Handled 4 things · 3 can wait", which opens, then "Done".
    private var footer: some View {
        VStack(alignment: .leading, spacing: 0) {
            if summary == nil {
                closeButton
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: 16) {
                        summaryButton
                        Spacer(minLength: 0)
                        closeButton
                    }
                    VStack(alignment: .leading, spacing: 0) {
                        summaryButton
                        closeButton
                    }
                }
            }
            if expanded {
                details
                    .padding(.top, 4)
                    .transition(.opacity)
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: expanded)
    }

    @ViewBuilder
    private var summaryButton: some View {
        if let summary {
            Button {
                expanded.toggle()
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(summary)
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.semibold))
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                        .accessibilityHidden(true)
                }
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.textDim)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            .accessibilityHint(expanded ? "Hides what was handled" : "Shows what was handled")
        }
    }

    private var closeButton: some View {
        Button("Done") { brief.dismiss() }
            .font(.footnote)
            .foregroundStyle(OS1VisualStyle.textDim)
            .buttonStyle(.plain)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
            .accessibilityHint("Puts the brief away. Ask Blob about anything still open.")
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(page.handled.enumerated()), id: \.offset) { _, line in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "checkmark")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(OS1VisualStyle.textFaint)
                        .accessibilityHidden(true)
                    Text(line)
                        .foregroundStyle(OS1VisualStyle.textDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
            if page.later > 0 {
                Text(page.later == 1
                     ? "1 more can wait. Ask \u{201C}What can wait?\u{201D} to go through it."
                     : "\(page.later) more can wait. Ask \u{201C}What can wait?\u{201D} to go through them.")
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, page.handled.isEmpty ? 0 : 4)
            }
        }
        .font(.footnote)
    }

    /// `BLOB_DEMO_BRIEF_EXPANDED=1`: the handled lines start open.
    private static var demoExpanded: Bool {
        #if DEBUG
        ProcessInfo.processInfo.environment["BLOB_DEMO_BRIEF_EXPANDED"] != nil
        #else
        false
        #endif
    }

    /// "Handled 4 things · 3 can wait", or either half alone.
    private var summary: String? {
        let handled = page.handled.count
        let parts = [
            handled == 0 ? nil : handled == 1 ? "Handled 1 thing" : "Handled \(handled) things",
            page.later == 0 ? nil : "\(page.later) can wait",
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
    }
}
