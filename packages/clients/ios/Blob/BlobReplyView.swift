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
/// Say line (`sayStyle`), then the rest drawn as Blob's elements
/// (`BlobShow`, `BlobShowBody`): status rows, callouts, quotes, the block
/// catalog's fences and prose. While the reply streams it is drawn the same
/// way, with placeholders for what isn't complete yet, so settling changes
/// nothing on screen.
///
/// What is shown is drawn in parts cut at its cue anchors (`BlobCues.parts`),
/// each with the scroll id `partId(index)`, so the words being spoken can
/// bring their element into view; the part `focus` points at pulses once
/// per cue (not under Reduce Motion). Rows that run on from one part into
/// the next stay one list.
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
                let shown = parts.indices.map { index in
                    BlobShow.blocks(
                        of: parts[index].markdown,
                        open: streaming && index == parts.count - 1,
                        claims: TranscriptRichBlocks.claimedLangs.contains
                    )
                }
                let strong = Self.strongCallout(in: shown)
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(parts.indices, id: \.self) { index in
                        let runsOn = index > 0 && Self.endsInRows(shown[index - 1]) && Self.startsWithRows(shown[index])
                        BlobShownPart(
                            blocks: shown[index],
                            live: streaming,
                            runsOn: runsOn,
                            strongCallout: strong?.part == index ? strong?.block : nil,
                            entryId: entryId,
                            relay: relay,
                            pulse: focus.flatMap { parts[index].ids.contains($0.id) ? $0.tick : nil }
                        )
                        .padding(.top, index == 0 || runsOn ? 0 : BlobShowBody.gap)
                        .id(scrollIds ? Self.partId(index) : "\(index)")
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The reply's first warning or caution: the one callout drawn warm.
    private static func strongCallout(in parts: [[BlobShow.Block]]) -> (part: Int, block: Int)? {
        for (part, blocks) in parts.enumerated() {
            for (index, block) in blocks.enumerated() {
                if case .callout(let kind, _) = block, kind == "warning" || kind == "caution" {
                    return (part, index)
                }
            }
        }
        return nil
    }

    private static func endsInRows(_ blocks: [BlobShow.Block]) -> Bool {
        if case .rows? = blocks.last { return true }
        return false
    }

    private static func startsWithRows(_ blocks: [BlobShow.Block]) -> Bool {
        switch blocks.first {
        case .rows?, .placeholder(.row)?: return true
        default: return false
        }
    }
}

/// One part of what a reply shows. When a cue points at it (`pulse` changes
/// to a new tick) an accent tint comes up and fades over about a second.
/// A part whose rows carry on the list above it opens with the list's
/// hairline.
private struct BlobShownPart: View {
    let blocks: [BlobShow.Block]
    let live: Bool
    let runsOn: Bool
    let strongCallout: Int?
    var entryId: String?
    var relay: QuickReplyRelay?
    let pulse: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if runsOn { BlobRowRule() }
            BlobShowBody(blocks: blocks, live: live, strongCallout: strongCallout)
                .environment(\.quickReplyRelay, relay)
                .environment(\.transcriptEntryId, entryId)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cuePulse(pulse)
    }
}

/// The cue ticks that already pulsed, for the reply being read. A view that
/// is drawn again (the reply settling, a scroll, a pane opening) sees the
/// same tick and must not pulse twice; the first view to see a tick claims
/// it. Cleared with the reply (`BlobTextTalk`); ticks are never reused.
@MainActor
enum CuePulses {
    private static var claimed: Set<Int> = []

    /// True the first time `tick` is claimed.
    static func claim(_ tick: Int) -> Bool { claimed.insert(tick).inserted }

    static func reset() { claimed.removeAll() }
}

/// An element the spoken words point at: each new `tick` brings up an
/// accent tint that fades over about a second, once (`CuePulses`). A nil
/// tick (focus moved away) does nothing. With Reduce Motion there is no
/// pulse; the element is still scrolled into view.
private struct CuePulse: ViewModifier {
    let tick: Int?
    /// Counts this view's pulses; each change runs the tint once.
    @State private var pulsed = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .onChange(of: tick, initial: true) { _, tick in
                guard let tick, CuePulses.claim(tick), !reduceMotion else { return }
                pulsed += 1
            }
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
