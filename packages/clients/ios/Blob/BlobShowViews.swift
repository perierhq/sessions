import SwiftUI

/// One part of what a reply shows, drawn from its elements (`BlobShow`):
/// the same views while it streams and once it has settled, so nothing
/// reflows when it settles. Elements that aren't complete hold their space
/// with a placeholder until they are.
struct BlobShowBody: View {
    let blocks: [BlobShow.Block]
    /// The reply is streaming. Read once, by the prose views, which keep
    /// one streaming renderer for their whole life (`BlobProse`).
    let live: Bool
    /// The block that is the reply's one strong callout, if it is here.
    var strongCallout: Int?

    /// Between the elements of a reply.
    static let gap: CGFloat = 16

    var body: some View {
        VStack(alignment: .leading, spacing: Self.gap) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                view(for: block, at: index)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func view(for block: BlobShow.Block, at index: Int) -> some View {
        switch block {
        case .prose(let text):
            BlobProse(text, live: live)
        case .rows(let rows):
            BlobRowList(rows: rows)
                .transition(Self.arrival)
        case .callout(let kind, let body):
            CalloutView(
                callout: Callout(kind: Callout.Kind(rawValue: kind) ?? .note, body: body),
                strong: strongCallout == index
            )
            .transition(Self.arrival)
        case .quote(let text):
            BlobQuote(text: text)
                .transition(Self.arrival)
        case .fence(let raw):
            MarkdownBody(raw)
                .transition(Self.arrival)
        case .placeholder(let kind):
            BlobPlaceholder(kind: kind)
                .transition(.identity)
        }
    }

    /// An element replacing its placeholder fades in where the placeholder
    /// was; it never moves. Opacity only, so Reduce Motion keeps it.
    private static let arrival = AnyTransition.opacity.animation(.easeOut(duration: 0.2))
}

/// Prose in a reply, with the markdown renderer. A reply that is streaming
/// when this view is made keeps one streaming renderer (one parser fed each
/// snapshot) for the view's whole life, through settling, so the settled
/// text is drawn by the very view that drew it while it streamed. A reply
/// already settled (history, a decision) uses the cached static renderer.
/// Both at the same metrics: links in the accent, no underline.
struct BlobProse: View {
    let text: String
    @State private var live: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(_ text: String, live: Bool) {
        self.text = text
        _live = State(initialValue: live)
    }

    var body: some View {
        if live {
            StreamingMarkdownBody(text, config: .blob(animated: !reduceMotion))
        } else {
            CachedMarkdownView(text: text, config: .blob(animated: false))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Rows in a row: a status list, hairlines between.
struct BlobRowList: View {
    let rows: [BlobShow.Row]

    /// Above and below a hairline between two rows.
    static let rowGap: CGFloat = 10

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                if index > 0 { BlobRowRule() }
                BlobRowView(row: row)
            }
        }
    }
}

/// The hairline between two rows, from the title's edge, with the rows'
/// gap above and below it.
struct BlobRowRule: View {
    @ScaledMetric(relativeTo: .subheadline) private var inset: CGFloat = BlobRowView.markColumn
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        Rectangle()
            .fill(OS1VisualStyle.border)
            .frame(height: 1 / displayScale)
            .padding(.leading, inset)
            .padding(.vertical, BlobRowList.rowGap)
            .accessibilityHidden(true)
    }
}

/// A status row (Paper "Status list", "Reference"): a mark in the status's
/// tone, the title, the status as meta on the title's line when it is short
/// and the rest as one supporting line. A row with a link opens it.
struct BlobRowView: View {
    let row: BlobShow.Row

    /// The mark and the gap after it, where the title starts.
    static let markColumn: CGFloat = 18

    @ScaledMetric(relativeTo: .subheadline) private var titleSize: CGFloat = 14
    @ScaledMetric(relativeTo: .footnote) private var supportSize: CGFloat = 13
    @ScaledMetric(relativeTo: .caption2) private var metaSize: CGFloat = 11
    @ScaledMetric(relativeTo: .subheadline) private var markSize: CGFloat = 7
    @ScaledMetric(relativeTo: .subheadline) private var markColumn: CGFloat = BlobRowView.markColumn
    @Environment(\.openURL) private var openURL
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if let url = row.url.flatMap(URL.init(string:)) {
            Button { openURL(url) } label: { content(link: true) }
                .buttonStyle(BlobRowPress())
                .accessibilityAddTraits(.isLink)
        } else {
            content(link: false)
        }
    }

    /// A short status sits on the title's line; a long one leads the
    /// supporting line, as it does at accessibility sizes.
    private var metaStatus: String? {
        guard let status = row.status, status.count <= 22, !typeSize.isAccessibilitySize else { return nil }
        return status
    }

    private var supporting: String {
        let lead = metaStatus == nil ? row.status : nil
        let line = [lead, row.detail.isEmpty ? nil : row.detail].compactMap { $0 }.joined(separator: " · ")
        guard let first = line.first, first.isLowercase else { return line }
        return first.uppercased() + line.dropFirst()
    }

    private func content(link: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            mark
                .frame(width: markColumn, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(AttributedString.inlineMarkdown(row.title, links: false))
                        .font(.system(size: titleSize, weight: .semibold))
                        .foregroundStyle(OS1VisualStyle.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let metaStatus {
                        Text(metaStatus)
                            .font(.system(size: metaSize))
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .fixedSize()
                    }
                    if link {
                        Image(systemName: "chevron.right")
                            .font(.system(size: metaSize, weight: .semibold))
                            .foregroundStyle(OS1VisualStyle.textFaint)
                            .accessibilityHidden(true)
                    }
                }
                if !supporting.isEmpty {
                    Text(AttributedString.inlineMarkdown(supporting, links: false))
                        .font(.system(size: supportSize))
                        .lineSpacing(supportSize * 2 / 13)
                        .foregroundStyle(OS1VisualStyle.textNarration)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    /// Filled in the status's colour; a hollow ring for a status that says
    /// nothing about health.
    @ViewBuilder
    private var mark: some View {
        Group {
            switch row.tone {
            case .attention: Circle().fill(OS1VisualStyle.red)
            case .running: Circle().fill(OS1VisualStyle.yellow)
            case .done: Circle().fill(OS1VisualStyle.green)
            case .neutral: Circle().strokeBorder(OS1VisualStyle.textFaint, lineWidth: 1.2)
            }
        }
        .frame(width: markSize, height: markSize)
        // Centred on the title's first line: its baseline sits this far
        // under the mark's bottom.
        .alignmentGuide(.firstTextBaseline) { d in d.height + titleSize * 0.12 }
        .accessibilityHidden(true)
    }
}

/// Pressed rows dim; nothing moves.
private struct BlobRowPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.55 : 1)
    }
}

/// Someone else's words (Paper "Quote"): dim italic on a quiet plate, never
/// in Blob's own voice.
struct BlobQuote: View {
    let text: String

    @ScaledMetric(relativeTo: .subheadline) private var size: CGFloat = 14

    var body: some View {
        Text(AttributedString.inlineMarkdown(text))
            .font(.system(size: size).italic())
            .lineSpacing(size * 4 / 14)
            .foregroundStyle(OS1VisualStyle.textNarration)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(OS1VisualStyle.chipFill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .accessibilityLabel("Quote: \(String(AttributedString.inlineMarkdown(text).characters))")
    }
}

/// The space an element still being written holds (the streaming states on
/// the Paper boards): quiet bars in its shape, never its source. Hidden from
/// VoiceOver, which reads the element once it lands.
struct BlobPlaceholder: View {
    let kind: BlobShow.Placeholder

    @ScaledMetric(relativeTo: .footnote) private var line: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var chipHeight: CGFloat = 34

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var content: some View {
        switch kind {
        case .row:
            HStack(alignment: .top, spacing: 0) {
                Circle().fill(Self.bar).frame(width: 7, height: 7)
                    .padding(.top, line * 0.35)
                    .frame(width: BlobRowView.markColumn, alignment: .leading)
                VStack(alignment: .leading, spacing: line - 9) {
                    bar(width: 120, height: 10)
                    bar(width: 220, height: 8)
                }
                .padding(.top, 3)
            }
        case .callout:
            HStack(alignment: .top, spacing: 10) {
                Circle().fill(Self.bar).frame(width: 13, height: 13)
                VStack(alignment: .leading, spacing: line - 8) {
                    bar(width: 240, height: 8)
                    bar(width: 150, height: 8)
                }
                .padding(.top, 2)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(OS1VisualStyle.chipFill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        case .quote, .block:
            VStack(alignment: .leading, spacing: line - 8) {
                bar(width: 140, height: 8)
                bar(width: 260, height: 8)
                bar(width: 200, height: 8)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(OS1VisualStyle.chipFill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        case .chips:
            HStack(spacing: 8) {
                ForEach([96, 72, 88], id: \.self) { width in
                    Capsule().fill(OS1VisualStyle.chipFill).frame(width: CGFloat(width), height: chipHeight)
                }
            }
        }
    }

    /// Bars sit a step darker than the plate under them.
    private static let bar = OS1VisualStyle.chipFill

    private func bar(width: CGFloat, height: CGFloat) -> some View {
        Capsule().fill(Self.bar).frame(maxWidth: width).frame(height: height)
    }
}
