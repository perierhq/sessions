import SwiftUI

/// One decision the supervisor is waiting on, shown where Blob's replies
/// render: the question, what it is about (drawn with the block catalog,
/// like a reply), then its options as numbered buttons. The first option is
/// the recommended one and the only filled button on the screen.
///
/// "Not now" skips it for this launch. Long-press for "Dismiss", which closes
/// it on the server without an answer.
struct BlobDecisionView: View {
    let item: OS1API.SupervisorItem
    /// 1-based place in the queue, and its length.
    let position: Int
    let count: Int
    let sending: Bool
    /// Room the question and its body may take before they scroll.
    let maxHeight: CGFloat
    let answer: (String) -> Void
    let notNow: () -> Void
    let dismiss: () -> Void

    @ScaledMetric(relativeTo: .subheadline) private var titleSize: CGFloat = 14

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.title)
                        .font(.system(size: titleSize, weight: .semibold))
                        .lineSpacing(titleSize * 3 / 14)
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
                    if !item.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        MarkdownBody(item.body)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.top, 10)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: maxHeight)
            .fixedSize(horizontal: false, vertical: true)
            .scrollBounceBehavior(.basedOnSize)

            VStack(spacing: 8) {
                ForEach(Array(item.options.enumerated()), id: \.offset) { index, option in
                    optionButton(option, number: index + 1)
                }
            }
            .padding(.top, 18)

            if showsNotNow {
                Button("Not now", action: notNow)
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .buttonStyle(.plain)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                    .padding(.top, 4)
                    .accessibilityHint("Shows it again next time you open Blob")
            }
        }
        .disabled(sending)
        .contentShape(Rectangle())
        .contextMenu {
            Button("Dismiss", systemImage: "xmark", role: .destructive, action: dismiss)
        }
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Dismiss", dismiss)
    }

    /// "betterbahn · 2h ago · 1 of 3"
    private var meta: String? {
        let parts = [item.project, ago(.narrow), place].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
    }

    /// The same, as VoiceOver reads it: "betterbahn, 2 hours ago, decision 1 of 3".
    private var metaSpoken: String? {
        let parts = [item.project, ago(.wide), count > 1 ? "decision \(position) of \(count)" : nil]
            .compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    private var place: String? { count > 1 ? "\(position) of \(count)" : nil }

    private func ago(_ style: Date.RelativeFormatStyle.UnitsStyle) -> String? {
        item.created.map { date in
            Date.now.timeIntervalSince(date) < 60
                ? "just now"
                : date.formatted(.relative(presentation: .numeric, unitsStyle: style))
        }
    }

    /// An option that already says "Not now" does that job, and answers it.
    private var showsNotNow: Bool {
        !item.options.contains { $0.caseInsensitiveCompare("Not now") == .orderedSame }
    }

    private func optionButton(_ option: String, number: Int) -> some View {
        let primary = number == 1
        return Button { answer(option) } label: {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(verbatim: "\(number)")
                    .font(.body.monospacedDigit())
                    .opacity(0.6)
                Text(option)
                    .font(.body.weight(primary ? .semibold : .regular))
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .foregroundStyle(primary ? OS1VisualStyle.onAccent : OS1VisualStyle.text)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .background(
                primary ? AnyShapeStyle(OS1VisualStyle.accent) : AnyShapeStyle(OS1VisualStyle.hover),
                in: RoundedRectangle(cornerRadius: 14, style: .continuous)
            )
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(BlobPressStyle())
        .accessibilityLabel("\(number). \(option)")
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
