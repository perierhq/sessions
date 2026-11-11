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
///
/// Once the reply has settled the prose gets `MarkdownBody`'s links (bare
/// URLs, PR and commit references, session ids, files), kept to links that
/// only recolour words (`BlobProseLinks`), so settling never reflows it.
/// While it streams it has none: a URL arrives a few characters at a time.
struct BlobProse: View {
    let text: String
    /// The reply has settled.
    let settled: Bool
    /// Made while the reply streamed: keeps the streaming renderer.
    @State private var streamed: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openPanel) private var openPanel
    @Environment(\.transcriptSessionId) private var transcriptSessionId

    init(_ text: String, live: Bool) {
        self.text = text
        settled = !live
        _streamed = State(initialValue: live)
    }

    var body: some View {
        let shown = settled
            ? BlobProseLinks.linked(text, sessionId: openPanel.sessionId, transcriptSessionId: transcriptSessionId)
            : text
        if streamed {
            StreamingMarkdownBody(shown, config: .blob(animated: !reduceMotion))
        } else {
            CachedMarkdownView(text: shown, config: .blob(animated: false))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// `MarkdownBody`'s link rewrites (`MarkdownBody.linkRewrites`) for Blob's
/// settled prose, kept to what only recolours words, so the prose a reply
/// streamed keeps its layout when it settles:
///
/// - A rewrite that changes a line's words (a chip, a PR URL relabelled
///   `PR #12`, a session id shown by its title) links the words as written
///   instead, to the same place.
/// - A line where that still changes what shows, or how it is set (a link
///   inside bold or italic takes the link's plain font, a heading or a table
///   has its own), keeps that rewrite out.
///
/// Each rewrite runs on its own and is kept or dropped per line.
@MainActor
enum BlobProseLinks {
    static func linked(_ text: String, sessionId: String?, transcriptSessionId: String?) -> String {
        // Subscribes the view to the registries the rewrites read, as
        // `MarkdownBody` does.
        let generation = TranscriptLinks.shared.generation
        let key = Key(text: text, sessionId: sessionId, transcriptSessionId: transcriptSessionId, generation: generation)
        if let cached = cache[key] { return cached }
        var lines = text.components(separatedBy: "\n")
        for rewrite in MarkdownBody.linkRewrites(sessionId: sessionId, transcriptSessionId: transcriptSessionId) {
            let next = rewrite(lines.joined(separator: "\n")).components(separatedBy: "\n")
            guard next.count == lines.count else { continue }
            for index in lines.indices where next[index] != lines[index] {
                if let kept = recoloured(lines[index], as: next[index]) { lines[index] = kept }
            }
        }
        let out = lines.joined(separator: "\n")
        if cache.count >= 300 { cache.removeAll(keepingCapacity: true) }
        cache[key] = out
        return out
    }

    private struct Key: Hashable {
        let text: String
        let sessionId: String?
        let transcriptSessionId: String?
        let generation: Int
    }

    private static var cache: [Key: String] = [:]

    /// `rewritten` with each new link put back on the words `line` had
    /// there, or nil when the line can't take its links without changing
    /// what it shows or how it is set.
    private static func recoloured(_ line: String, as rewritten: String) -> String? {
        if line.contains("|") || matches(heading, line) { return nil }
        // The rewritten line: runs of text copied from `line`, each followed
        // by a link (one `line` had, or a new one).
        var pieces: [(literal: String, link: (token: String, label: String, destination: String)?)] = []
        var last = rewritten.startIndex
        for match in linkToken.matches(in: rewritten, range: NSRange(rewritten.startIndex..., in: rewritten)) {
            guard let whole = Range(match.range, in: rewritten), let label = Range(match.range(at: 1), in: rewritten),
                  let target = Range(match.range(at: 2), in: rewritten) else { return nil }
            let link = (String(rewritten[whole]), String(rewritten[label]), String(rewritten[target]))
            pieces.append((String(rewritten[last..<whole.lowerBound]), link))
            last = whole.upperBound
        }
        pieces.append((String(rewritten[last...]), nil))

        var out = ""
        var cursor = line.startIndex
        var added: Set<String> = []
        // A new link whose words run up to the next text the two share.
        var pending: String?
        func place(_ destination: String, upTo end: String.Index) -> Bool {
            let words = line[cursor..<end]
            guard !words.isEmpty, !words.contains("["), !words.contains("]") else { return false }
            out += "[\(words)](\(destination))"
            cursor = end
            return true
        }
        for piece in pieces {
            if let destination = pending, !piece.literal.isEmpty {
                // The words are what comes before the next shared text; an
                // id or address has no space in it, so look up to the first.
                let stop = line[cursor...].firstIndex(where: \.isWhitespace) ?? line.endIndex
                var found: String.Index?
                var from = cursor
                while from < line.endIndex, let next = line.range(of: piece.literal, range: from..<line.endIndex),
                      next.lowerBound <= stop {
                    found = next.lowerBound
                    from = line.index(after: next.lowerBound)
                }
                guard let found, place(destination, upTo: found) else { return nil }
                pending = nil
            }
            guard line[cursor...].hasPrefix(piece.literal) else { return nil }
            out += piece.literal
            cursor = line.index(cursor, offsetBy: piece.literal.count)
            guard let link = piece.link else { continue }
            // Two new links in a row: nothing between them says where the
            // first one ends.
            guard pending == nil else { return nil }
            let rest = line[cursor...]
            if rest.hasPrefix(link.token) {
                // A link the line already had.
                out += link.token
                cursor = line.index(cursor, offsetBy: link.token.count)
                continue
            }
            let chip = link.label == TranscriptChip.marker
            let destination = chip ? String(link.destination.prefix { $0 != "?" }) : link.destination
            added.insert(destination)
            let restText = String(rest)
            if let had = linkToken.firstMatch(in: restText, range: NSRange(restText.startIndex..., in: restText)),
               had.range.location == 0, let whole = Range(had.range, in: restText), let label = Range(had.range(at: 1), in: restText) {
                // A link the rewrite pointed somewhere else: same words.
                out += "[\(restText[label])](\(destination))"
                cursor = line.index(cursor, offsetBy: restText[whole].count)
            } else if !chip, rest.hasPrefix(link.label) {
                // A link on the words as written.
                out += "[\(link.label)](\(destination))"
                cursor = line.index(cursor, offsetBy: link.label.count)
            } else {
                pending = destination
            }
        }
        if let destination = pending, !place(destination, upTo: line.endIndex) { return nil }
        guard cursor == line.endIndex, words(of: out) == words(of: line), !setApart(added, in: out) else { return nil }
        return out
    }

    private static func matches(_ regex: NSRegularExpression, _ text: String) -> Bool {
        regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    private static func parsed(_ line: String) -> AttributedString {
        (try? AttributedString(markdown: line, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(line)
    }

    private static func words(of line: String) -> String {
        String(parsed(line).characters)
    }

    /// Whether one of the new links sits in bold, italic or struck-through
    /// text, which the renderer would set in the link's plain font.
    private static func setApart(_ destinations: Set<String>, in line: String) -> Bool {
        let styled: InlinePresentationIntent = [.emphasized, .stronglyEmphasized, .strikethrough]
        return parsed(line).runs.contains { run in
            guard let link = run.link, destinations.contains(link.absoluteString) || destinations.contains(link.relativeString),
                  let intent = run.inlinePresentationIntent else { return false }
            return !intent.isDisjoint(with: styled)
        }
    }

    /// `[label](destination)`, a destination with one level of parentheses.
    private static let linkToken = try! NSRegularExpression(
        pattern: #"\[((?:[^\[\]\\]|\\.)*)\]\(((?:[^()\s]|\([^()\s]*\))*)\)"#
    )
    private static let heading = try! NSRegularExpression(pattern: #"^\s{0,3}#{1,6}(\s|$)"#)
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
    /// A stacked reply's height (`ChoicesBlockView`'s rows).
    @ScaledMetric(relativeTo: .subheadline) private var rowHeight: CGFloat = 44

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
        case .choices(let lines):
            // The shape the replies will take (`ChoicesBlock.stacks`), from
            // the lines so far: a label only gains words, so chips can turn
            // into rows while the fence streams but never when it closes.
            let choices = ChoicesBlock.parse(lines.joined(separator: "\n")) ?? []
            if ChoicesBlock.stacks(choices) {
                VStack(spacing: 8) {
                    ForEach(choices.indices, id: \.self) { _ in
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(OS1VisualStyle.chipFill)
                            .frame(height: rowHeight)
                    }
                }
            } else {
                HStack(spacing: 8) {
                    ForEach([96, 72, 88], id: \.self) { width in
                        Capsule().fill(OS1VisualStyle.chipFill).frame(width: CGFloat(width), height: chipHeight)
                    }
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
