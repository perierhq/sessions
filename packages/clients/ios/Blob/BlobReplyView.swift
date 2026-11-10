import SwiftUI

/// What Blob says, as a line of plain text at 17/22: the part of a reply or
/// a decision it reads aloud, for a reply without a spoken script.
struct BlobSayLine: View {
    let text: String

    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 17

    var body: some View {
        Text(text)
            .font(.system(size: size))
            .lineSpacing(size * 5 / 17)
            .foregroundStyle(OS1VisualStyle.text)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// What Blob said, small and dim, above what it showed: a past reply.
struct BlobSaidLine: View {
    let text: String

    var body: some View {
        Text("Blob said: \(text)")
            .font(.footnote)
            .foregroundStyle(OS1VisualStyle.textDim)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// A reply split into what Blob says and what it shows (`BlobReply`): the
/// Say line (`sayStyle`), then the rest drawn with the block catalog. While
/// the reply is still streaming the rest stays plain text.
///
/// What is shown is drawn in parts cut at its cue anchors (`BlobCues.parts`),
/// each with the scroll id `partId(index)`, so the words being spoken can
/// bring their element into view; the part `focus` points at pulses once.
struct BlobReplyView: View {
    enum SayStyle { case line, said, hidden }

    let reply: BlobReply
    var entryId: String?
    var relay: QuickReplyRelay?
    var streaming = false
    /// How the Say part is drawn. Unset: a spoken script is hidden (Blob says
    /// it, and the home shows it as a passing caption); a reply without one
    /// shows its first paragraph as the Say line.
    var sayStyle: SayStyle?
    var focus: BlobTextTalk.Focus?
    /// Give each part its scroll id (`partId`): only the one reply a page
    /// scrolls to, so ids never repeat on it.
    var scrollIds = false

    static func partId(_ index: Int) -> String { "blob-part-\(index)" }

    var body: some View {
        let style = sayStyle ?? (reply.scripted ? .hidden : .line)
        VStack(alignment: .leading, spacing: 12) {
            if !reply.say.isEmpty {
                switch style {
                case .line: BlobSayLine(text: reply.say)
                case .said: BlobSaidLine(text: reply.say)
                case .hidden: EmptyView()
                }
            }
            if !reply.show.isEmpty {
                let parts = reply.parts
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(parts.indices, id: \.self) { index in
                        BlobShownPart(
                            part: parts[index],
                            streaming: streaming,
                            entryId: entryId,
                            relay: relay,
                            pulse: focus.flatMap { parts[index].ids.contains($0.id) ? $0.tick : nil }
                        )
                        .id(scrollIds ? Self.partId(index) : "\(index)")
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One part of what a reply shows. When a cue points at it (`pulse` changes
/// to a new tick) an accent tint comes up and fades over about a second.
private struct BlobShownPart: View {
    let part: BlobCues.Part
    let streaming: Bool
    var entryId: String?
    var relay: QuickReplyRelay?
    let pulse: Int?

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .cuePulse(pulse)
    }

    @ViewBuilder
    private var content: some View {
        if streaming {
            Text(part.markdown)
                .font(.body)
                .foregroundStyle(OS1VisualStyle.text)
        } else {
            MarkdownBody(part.markdown)
                .environment(\.quickReplyRelay, relay)
                .environment(\.transcriptEntryId, entryId)
        }
    }
}

/// An element the spoken words point at: each new `tick` brings up an
/// accent tint that fades over about a second. A nil tick (focus moved
/// away) does nothing.
private struct CuePulse: ViewModifier {
    let tick: Int?
    /// The last tick that pointed here.
    @State private var pulsed = 0

    func body(content: Content) -> some View {
        content
            .onChange(of: tick, initial: true) { _, tick in if let tick { pulsed = tick } }
            .phaseAnimator([0.0, 1.0, 0.0], trigger: pulsed) { view, glow in
                view.background {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(OS1VisualStyle.accent.opacity(0.18 * glow))
                        .padding(-6)
                }
            } animation: { glow in
                glow > 0 ? .easeOut(duration: 0.25) : .easeInOut(duration: 1)
            }
    }
}

extension View {
    /// Pulses when a cue points here (`CuePulse`).
    func cuePulse(_ tick: Int?) -> some View { modifier(CuePulse(tick: tick)) }
}
