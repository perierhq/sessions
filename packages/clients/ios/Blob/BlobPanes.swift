import SwiftUI

/// Two panes on a wide surface, side by side across a vertical fold: the
/// open Duo's inner display in landscape, or a wide iPad or Mac window. The
/// conversation takes the leading pane and the current reply's visual blocks
/// the trailing one; nothing is drawn in `fold`.
struct BlobPanes: Equatable {
    /// The division region, margins included, in the home's full-bleed space.
    var fold: CGRect
    var width: CGFloat

    /// Width left over after the leading pane.
    var trailingWidth: CGFloat { width - fold.minX }

    /// The panes for a full-bleed proxy, or nil for one column. The Duo
    /// reports its fold as a division region (iOS 27.1); a fold across the
    /// screen (the inner display upright) keeps one column, since scrolling
    /// content may cross it. Without a fold, a surface wide enough for two
    /// readable columns splits at its middle with the same 40 pt band.
    @MainActor
    static func layout(in proxy: GeometryProxy) -> BlobPanes? {
        let size = proxy.size
        #if os(iOS)
        if #available(iOS 27.1, *) {
            let folds = proxy.reservedRegions(kind: .division, options: .includeInactive).map(\.frame)
            if let vertical = folds.first(where: { $0.height > $0.width }) {
                return BlobPanes(fold: vertical, width: size.width)
            }
            if !folds.isEmpty { return nil }
        }
        #endif
        guard size.width >= 820 else { return nil }
        return BlobPanes(fold: CGRect(x: size.width / 2 - 20, y: 0, width: 40, height: size.height), width: size.width)
    }
}

/// A reply split for two panes: the conversation (Say line, prose, quick
/// replies, plain code) and its visual blocks (metrics, tables, charts,
/// slides, images and the rest of the block catalog), in order. The agent
/// writes one reply either way; the split happens here, with the same
/// parsers `MarkdownBody` uses, so each part draws exactly as it would inline.
struct BlobReplySplit: Equatable {
    var conversation: String
    var visuals: [String]

    init(_ markdown: String) {
        var prose: [String] = []
        var visuals: [String] = []
        for segment in MarkdownFenceSegmenter.split(markdown, claims: TranscriptRichBlocks.claimedLangs.contains) {
            switch segment {
            case .fence(let lang, let source, let raw):
                // Quick replies answer the conversation, so they stay with it.
                if lang != "choices", TranscriptRichBlocks.block(lang: lang, source: source) != nil {
                    visuals.append(raw)
                } else {
                    prose.append(raw)
                }
            case .markdown(let text):
                for piece in MarkdownTableSegmenter.split(text) {
                    switch piece {
                    case .table(let table): visuals.append(table.markdownSource())
                    case .markdown(let plain): Self.liftFigures(plain, prose: &prose, visuals: &visuals)
                    }
                }
            }
        }
        conversation = prose.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        self.visuals = visuals
    }

    /// An image on a paragraph of its own is a visual; one inside a sentence
    /// stays in the prose.
    private static func liftFigures(_ text: String, prose: inout [String], visuals: inout [String]) {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        var kept: [Substring] = []
        for (index, line) in lines.enumerated() {
            let alone = (index == 0 || lines[index - 1].allSatisfy(\.isWhitespace))
                && (index == lines.count - 1 || lines[index + 1].allSatisfy(\.isWhitespace))
            if alone, PlacedMedia.figure(fromParagraphLine: line) != nil {
                visuals.append(String(line))
            } else {
                kept.append(line)
            }
        }
        prose.append(kept.joined(separator: "\n"))
    }
}

/// The trailing pane: the current reply's visual blocks, top-aligned, with
/// its own scroll. Without any, whatever else is waiting on you (`side`),
/// or nothing at all.
struct BlobSidePane<Side: View>: View {
    let visuals: [String]
    let margins: EdgeInsets
    @ViewBuilder let side: () -> Side

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if visuals.isEmpty {
                    side()
                } else {
                    ForEach(Array(visuals.enumerated()), id: \.offset) { _, block in
                        MarkdownBody(block)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .frame(maxWidth: 560, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(margins)
        }
        .defaultScrollAnchor(.top)
        .scrollBounceBehavior(.basedOnSize)
        .scrollIndicators(.hidden)
    }
}
