import SwiftUI

/// One decision the supervisor is waiting on, shown where Blob's replies
/// render: the question, what it is about (split like a reply: the first
/// paragraph, which Blob reads aloud when the decision comes up, as the Say
/// line, the rest drawn with the block catalog), then its options as
/// numbered buttons. The first option is
/// the recommended one and the only filled button on the screen.
///
/// A lead's proposal with steps adds the server's own section between the
/// body and the options (`BlobActSection`): the steps, when they run and
/// when they expire. It is drawn from the item's structured `act`, never
/// from the Markdown, and the body drops the same lines the server wrote
/// into it for older clients.
///
/// A card for an item rewritten while Blob had it (`revised`) holds its
/// options for a moment, so a tap meant for the old card can't land on it.
///
/// The brief holds up to three of these on one page. Only one of them fills
/// its recommended option (`prominent`), so the page has one primary action;
/// the others keep the recommendation first, unfilled.
///
/// Long-press for "Dismiss", which closes it on the server without an answer.
struct BlobDecisionView: View {
    let item: OS1API.SupervisorItem
    let sending: Bool
    /// This decision's recommended option is the page's filled button.
    let prominent: Bool
    /// One of the brief's decisions: the title leads, the body reads as
    /// prose under Blob's own Say line.
    var inBrief = false
    let answer: (String) -> Void
    let dismiss: () -> Void

    @ScaledMetric(relativeTo: .subheadline) private var titleSize: CGFloat = 14
    /// Options held after a revision change; set once per card, as the
    /// view is keyed on the card.
    @State private var holding: Bool

    /// How long a re-raised card holds its options.
    static let revisedHold: Duration = .milliseconds(600)

    init(
        item: OS1API.SupervisorItem, sending: Bool, prominent: Bool = true, inBrief: Bool = false,
        revised: Bool = false, answer: @escaping (String) -> Void, dismiss: @escaping () -> Void
    ) {
        self.item = item; self.sending = sending; self.prominent = prominent; self.inBrief = inBrief
        self.answer = answer; self.dismiss = dismiss
        _holding = State(initialValue: revised)
    }

    var body: some View {
        content
            // On the open Duo or an iPad, a decision reads as a column, not a
            // banner across the whole screen.
            .frame(maxWidth: 560, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text(item.title)
                    .font(inBrief ? .headline : .system(size: titleSize, weight: .semibold))
                    .lineSpacing(inBrief ? 2 : titleSize * 3 / 14)
                    .foregroundStyle(OS1VisualStyle.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                TimelineView(.periodic(from: .now, by: 60)) { _ in
                    if let meta {
                        Text(meta)
                            .font(.caption2)
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .accessibilityLabel(metaSpoken ?? meta)
                    }
                }
                let reply = BlobReply(item.shownBody)
                if !reply.isEmpty {
                    // The card carries its script as the Say line, so it is
                    // not lost when reading aloud is off.
                    BlobReplyView(reply: reply, sayStyle: inBrief ? .prose : .line)
                        .padding(.top, inBrief ? 8 : 10)
                }
                if let act = item.act, !act.steps.isEmpty {
                    BlobActSection(act: act)
                        .padding(.top, 16)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            VStack(spacing: 8) {
                ForEach(Array(item.options.enumerated()), id: \.offset) { index, option in
                    optionButton(option, number: index + 1)
                }
            }
            // Held without any visual change, so nothing moves under Reduce
            // Motion.
            .disabled(holding)
            .padding(.top, 18)
        }
        .disabled(sending)
        .task {
            guard holding else { return }
            try? await Task.sleep(for: Self.revisedHold)
            holding = false
        }
        .contentShape(Rectangle())
        .contextMenu {
            Button("Dismiss", systemImage: "xmark", role: .destructive, action: dismiss)
        }
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Dismiss", dismiss)
    }

    /// "betterbahn · 2h ago"
    private var meta: String? {
        let parts = [item.project, ago(.narrow)].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
    }

    /// The same, as VoiceOver reads it: "betterbahn, 2 hours ago".
    private var metaSpoken: String? {
        let parts = [item.project, ago(.wide)].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    private func ago(_ style: Date.RelativeFormatStyle.UnitsStyle) -> String? {
        item.created.map { date in
            Date.now.timeIntervalSince(date) < 60
                ? "just now"
                : date.formatted(.relative(presentation: .numeric, unitsStyle: style))
        }
    }

    private func optionButton(_ option: String, number: Int) -> some View {
        BlobOptionButton(
            label: option,
            number: number,
            role: number == 1 && prominent ? .recommended : .plain,
            recommended: number == 1
        ) {
            answer(option)
        }
    }
}

/// What approving runs, from the server's record (`OS1API.SupervisorItemAct`):
/// a hairline, then the numbered steps, when they run and when they expire.
/// Quieter than the lead's prose above it and set apart from it, so nothing
/// in the prose passes for it. Blob shows only open items, so there is no
/// approval state to draw.
struct BlobActSection: View {
    let act: OS1API.SupervisorItemAct

    @ScaledMetric(relativeTo: .subheadline) private var numberWidth: CGFloat = 16

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Rectangle()
                .fill(OS1VisualStyle.border)
                .frame(height: 1 / displayScale)
                .accessibilityHidden(true)

            Text("Steps")
                .font(.footnote.weight(.medium))
                .foregroundStyle(OS1VisualStyle.textDim)
                .padding(.top, 14)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(act.steps.enumerated()), id: \.offset) { index, step in
                    stepRow(step, number: index + 1)
                }
            }
            .padding(.top, 8)

            VStack(alignment: .leading, spacing: 4) {
                if let runsWhen = act.runsWhen, !runsWhen.isEmpty {
                    Text(Self.runsWhen(runsWhen))
                }
                if let expires = act.expires {
                    TimelineView(.periodic(from: .now, by: 60)) { _ in
                        Text(Self.expiry(expires))
                    }
                }
            }
            .font(.footnote)
            .foregroundStyle(OS1VisualStyle.textDim)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 12)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    @Environment(\.displayScale) private var displayScale

    private func stepRow(_ step: String, number: Int) -> some View {
        let (line, detail) = Self.split(step)
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(verbatim: "\(number)")
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(OS1VisualStyle.textFaint)
                .frame(minWidth: numberWidth, alignment: .leading)
            VStack(alignment: .leading, spacing: 6) {
                Text(verbatim: line)
                    .font(.subheadline)
                    .foregroundStyle(OS1VisualStyle.text)
                if let detail {
                    Text(verbatim: detail)
                        .font(.footnote.monospaced())
                        .foregroundStyle(OS1VisualStyle.textDim)
                        .textSelection(.enabled)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Steps, \(number) of \(act.steps.count): \(line)\(detail.map { ". \($0)" } ?? "")")
    }

    /// A step's first line, and what follows it: a worker's prompt, without
    /// the fence and indent the server wraps it in.
    static func split(_ step: String) -> (String, String?) {
        var rows = step.components(separatedBy: "\n")
        let line = rows.removeFirst()
        rows = rows.map { $0.hasPrefix("   ") ? String($0.dropFirst(3)) : $0 }
        if rows.count >= 2, rows.first?.hasPrefix("```") == true,
           let last = rows.last, !last.isEmpty, last.allSatisfy({ $0 == "`" }) {
            rows = Array(rows.dropFirst().dropLast())
        }
        let detail = rows.joined(separator: "\n").trimmingCharacters(in: .newlines)
        return (line, detail.isEmpty ? nil : detail)
    }

    /// "Runs when PR #556 in acme/app is merged", "Runs when checks pass on …".
    static func runsWhen(_ condition: String) -> String {
        let words = condition.split(separator: " ", maxSplits: 1)
        // A name in capitals (PR) keeps its case; a plain word starts lower.
        guard let first = words.first, first.dropFirst().allSatisfy(\.isLowercase) else {
            return "Runs when \(condition)"
        }
        return "Runs when \(first.prefix(1).lowercased())\(condition.dropFirst())"
    }

    /// "Expires in 7 days", "Expired 2 hours ago": one format string each,
    /// the relative date its argument.
    static func expiry(_ date: Date) -> String {
        let relative = date.formatted(.relative(presentation: .numeric, unitsStyle: .wide))
        return date > .now
            ? String(localized: "Expires \(relative)", comment: "When an approval's steps expire; the argument is a relative date such as \"in 7 days\"")
            : String(localized: "Expired \(relative)", comment: "When an approval's steps expired; the argument is a relative date such as \"2 hours ago\"")
    }
}

/// What an option is to the one answering: the recommended one, filled; one
/// that can't be taken back, in red; or a plain one, soft.
enum BlobOptionRole: Equatable { case recommended, destructive, plain }

/// One numbered option as a button, for decisions and questions alike.
struct BlobOptionButton: View {
    let label: String
    var detail: String?
    let number: Int
    let role: BlobOptionRole
    /// Read as recommended, filled or not.
    var recommended: Bool? = nil
    let action: () -> Void

    private var primary: Bool { recommended ?? (role == .recommended) }

    private var ink: Color {
        switch role {
        case .recommended: OS1VisualStyle.onAccent
        case .destructive: OS1VisualStyle.redInk
        case .plain: OS1VisualStyle.text
        }
    }

    private var fill: Color {
        switch role {
        case .recommended: OS1VisualStyle.accent
        case .destructive: OS1VisualStyle.red.opacity(0.12)
        case .plain: OS1VisualStyle.hover
        }
    }

    var body: some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(verbatim: "\(number)")
                    .font(.body.monospacedDigit())
                    .opacity(0.6)
                VStack(alignment: .leading, spacing: 2) {
                    Text(label)
                        .font(.body.weight(role == .plain ? .regular : .semibold))
                    if let detail, !detail.isEmpty {
                        Text(detail)
                            .font(.footnote)
                            .opacity(0.75)
                    }
                }
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .foregroundStyle(ink)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .background(fill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(BlobPressStyle())
        .accessibilityLabel("\(number). \(label)")
        .accessibilityHint(primary ? "Recommended" : "")
    }
}

/// A slight dim while pressed, nothing else.
private struct BlobPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.7 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
