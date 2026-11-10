import SwiftUI

/// Something the supervisor's run stopped to ask you, and waits on: a
/// question it asked (`ask_question`, answered as the OS app's
/// `AskQuestionCard` does) or a force merge it wants confirmed
/// (`force_merge_pull_request`, answered as `ForceMergeCard` does). Blob
/// shows it where replies render, like a decision, because until it is
/// answered the run does nothing else.
enum BlobAsk: Equatable, Identifiable {
    case question(AskQuestion)
    case forceMerge(PendingForceMerge)

    /// One way to answer.
    struct Option: Equatable {
        enum Action: Equatable { case answer(String), skip, confirmMerge, cancelMerge }
        let label: String
        var detail: String?
        let action: Action
    }

    init?(question: AskQuestion) {
        guard question.questions.first != nil else { return nil }
        self = .question(question)
    }

    var id: String {
        switch self {
        case .question(let ask): "ask-\(ask.id)"
        case .forceMerge(let pending): "merge-\(pending.request.id)"
        }
    }

    var title: String {
        switch self {
        case .question(let ask):
            let header = ask.questions.first?.header?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return header.isEmpty ? "Question" : header
        case .forceMerge(let pending):
            return "Force merge \(pending.request.ghRepo)#\(pending.request.number)"
        }
    }

    /// Markdown split like a reply (`BlobReply`): the first paragraph is the
    /// question, read aloud and shown as the Say line.
    var body: String {
        switch self {
        case .question(let ask):
            return ask.questions.first?.question ?? ""
        case .forceMerge(let pending):
            let request = pending.request
            let ask = pending.canConfirm
                ? "Should I merge #\(request.number), \(request.title)?"
                : "Waiting for \(request.driver) to confirm a merge of #\(request.number), \(request.title)."
            let bypass = request.bypass.isEmpty
                ? "Nothing to bypass."
                : request.bypass.map { "- \($0.label)" }.joined(separator: "\n")
            var parts = [ask, bypass]
            if !request.reason.isEmpty { parts.append("Reason: \(request.reason)") }
            parts.append("\(request.head) into \(request.base), \(request.method), at `\(request.headSha.prefix(7))`.")
            return parts.joined(separator: "\n\n")
        }
    }

    var options: [Option] {
        switch self {
        case .question(let ask):
            return (ask.questions.first?.options ?? []).map {
                Option(label: $0.label, detail: $0.description, action: .answer($0.label))
            }
        case .forceMerge(let pending):
            let cancel = Option(label: "Cancel", action: .cancelMerge)
            return pending.canConfirm ? [Option(label: "Merge anyway", action: .confirmMerge), cancel] : [cancel]
        }
    }

    /// A question takes a written answer too, through the write bar.
    var takesText: Bool {
        if case .question = self { return true }
        return false
    }
}

/// A `BlobAsk` where replies render, styled like `BlobDecisionView`: title,
/// the question as the Say line, the rest with the block catalog, then the
/// options as buttons, the first filled. A question can also be answered
/// in writing ("Write an answer" opens the write bar) or skipped, which lets
/// the run go on on its own judgment.
struct BlobAskView: View {
    let ask: BlobAsk
    /// Room the question and its body may take before they scroll.
    let maxHeight: CGFloat
    let answer: (BlobAsk.Option.Action) async throws -> Void
    let write: () -> Void

    @State private var busy = false
    @State private var error: String?
    @State private var confirmingMerge = false
    @ScaledMetric(relativeTo: .subheadline) private var titleSize: CGFloat = 14

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    Text(ask.title)
                        .font(.system(size: titleSize, weight: .semibold))
                        .lineSpacing(titleSize * 3 / 14)
                        .foregroundStyle(OS1VisualStyle.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    let reply = BlobReply(ask.body)
                    if !reply.isEmpty {
                        BlobReplyView(reply: reply)
                            .padding(.top, 10)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: maxHeight)
            .fixedSize(horizontal: false, vertical: true)
            .scrollBounceBehavior(.basedOnSize)

            VStack(spacing: 8) {
                ForEach(Array(ask.options.enumerated()), id: \.offset) { index, option in
                    BlobOptionButton(label: option.label, detail: option.detail, number: index + 1) {
                        if option.action == .confirmMerge {
                            confirmingMerge = true
                        } else {
                            submit(option.action)
                        }
                    }
                }
            }
            .padding(.top, 18)

            if let error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)
            }

            if ask.takesText {
                HStack(spacing: 20) {
                    quietButton("Write an answer", action: write)
                        .accessibilityHint("Opens the write bar; sending answers the question")
                    quietButton("Skip") { submit(.skip) }
                        .accessibilityHint("Lets the agent go on without your answer")
                }
                .padding(.top, 4)
            }
        }
        .disabled(busy)
        .frame(maxWidth: 560, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .confirmationDialog(ask.title + "?", isPresented: $confirmingMerge, titleVisibility: .visible) {
            Button("Merge anyway", role: .destructive) { submit(.confirmMerge) }
            Button("Not now", role: .cancel) {}
        } message: {
            Text("Merges with your GitHub account at this exact commit.")
        }
    }

    private func quietButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .font(.footnote)
            .foregroundStyle(OS1VisualStyle.textDim)
            .buttonStyle(.plain)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
    }

    private func submit(_ action: BlobAsk.Option.Action) {
        busy = true
        error = nil
        Task {
            do {
                try await answer(action)
                Haptics.play(.commit)
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? "Couldn't send that answer"
            }
            busy = false
        }
    }
}
