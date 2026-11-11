import SwiftUI

/// Two panes on a wide surface, side by side across a vertical fold: the
/// open Duo's inner display in landscape, or a wide iPad or Mac window.
/// What is on the page decides what each pane holds (`BlobColumns`,
/// `BlobRoom`): the conversation takes the leading pane, the current
/// reply's visual blocks the trailing one, and Blob the largest space
/// left. No text is drawn in `fold`.
struct BlobPanes: Equatable {
    /// The division region, margins included, in the home's full-bleed space.
    var fold: CGRect
    var width: CGFloat
    /// The device's own fold (the open Duo), not just the gap this app keeps
    /// between two panes on a wide flat surface. No text or control may
    /// cross it; Blob's face may sit on it only when nothing is shown.
    var physical: Bool

    /// The trailing pane's width: what is left after the fold.
    var trailingWidth: CGFloat { width - fold.maxX }

    /// The parts of `area` that nothing on the page holds: all of it with
    /// nothing taken, otherwise the pane that is still free, if any.
    /// Across the fold counts as free only when both panes are, so Blob
    /// may sit on the fold but never beside content that reaches it.
    func free(in area: CGRect, leadingTaken: Bool, trailingTaken: Bool) -> [CGRect] {
        if !leadingTaken && !trailingTaken { return [area] }
        var free: [CGRect] = []
        if !leadingTaken {
            free.append(CGRect(x: area.minX, y: area.minY, width: max(0, fold.minX - area.minX), height: area.height))
        }
        if !trailingTaken {
            free.append(CGRect(x: fold.maxX, y: area.minY, width: max(0, area.maxX - fold.maxX), height: area.height))
        }
        return free
    }

    /// Where Blob goes in `area` (`BlobRoom.find` over `free`). With nothing
    /// taken, Blob is in the middle of the whole surface, the system strip
    /// included, so it looks centred on the screen even with the open Duo's
    /// rail on one side; it may sit on the fold then.
    func room(in area: CGRect, leadingTaken: Bool, trailingTaken: Bool) -> BlobRoom? {
        guard var room = BlobRoom.find(in: free(in: area, leadingTaken: leadingTaken, trailingTaken: trailingTaken))
        else { return nil }
        if !leadingTaken && !trailingTaken {
            let half = room.size / 2 + BlobRoom.margin
            room.center.x = min(max(width / 2, area.minX + half), area.maxX - half)
        }
        return room
    }

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
                return BlobPanes(fold: vertical, width: size.width, physical: true)
            }
            if !folds.isEmpty { return nil }
        }
        #endif
        guard size.width >= 820 else { return nil }
        return BlobPanes(
            fold: CGRect(x: size.width / 2 - 20, y: 0, width: 40, height: size.height),
            width: size.width,
            physical: demoFold
        )
    }

    #if DEBUG
    /// `BLOB_DEMO_FOLD=1`: the middle band acts as a physical fold, to
    /// check the open Duo's layout on an iPad or a Mac window.
    private static let demoFold = ProcessInfo.processInfo.environment["BLOB_DEMO_FOLD"] != nil
    #else
    private static let demoFold = false
    #endif
}

/// Where Blob goes on a wide surface: the middle of the largest region the
/// page leaves free (`BlobPanes.free`), as large as fits with a margin, up
/// to its talking size. With nothing free that fits, it rests in its slot
/// (`region` nil), in the page's bottom margin.
struct BlobRoom: Equatable {
    var center: CGPoint
    var size: CGFloat
    /// The region Blob sits in; its thought stays inside it.
    var region: CGRect

    static let margin: CGFloat = 24
    static let largest: CGFloat = 132
    /// Smaller than this, Blob would be squeezed into a gap; it rests in
    /// its slot instead.
    static let smallest: CGFloat = 88

    /// The largest region that fits Blob, or nil.
    static func find(in free: [CGRect]) -> BlobRoom? {
        free
            .map { region in (region, min(largest, region.width - 2 * margin, region.height - 2 * margin)) }
            .filter { $0.1 >= smallest }
            .max { $0.0.width * $0.0.height < $1.0.width * $1.0.height }
            .map { region, size in BlobRoom(center: CGPoint(x: region.midX, y: region.midY), size: size, region: region) }
    }
}

/// Where the page's columns go, in the home's full-bleed space. With two
/// panes the conversation is in `leading` and a reply's visual blocks (or a
/// decision beside it) in `trailing`; Blob takes whatever is left
/// (`BlobRoom`). An exchange shown with its visuals beside it is marked
/// (`BlobExchange.split`), and history lays it out the same way again, so
/// nothing the agent showed is re-flowed later; one shown alone is
/// `centered` there. A surface too narrow for two panes draws every
/// exchange inline in `centered`.
///
/// Centered is the middle of the surface, except beside a physical fold:
/// there it is the leading pane's column, so no line of text ever sits
/// across the fold, flat or half open. Otherwise it is as wide as the
/// leading pane's column, so the move between them (history opening and
/// closing) never re-wraps the text.
struct BlobColumns: Equatable {
    struct Span: Equatable {
        var x: CGFloat
        var width: CGFloat
        var midX: CGFloat { x + width / 2 }
    }

    var centered: Span
    /// Nil on a surface with one column.
    var leading: Span?
    var trailing: Span?

    /// The widest a line of reading text runs.
    static let readable: CGFloat = 600

    init(width: CGFloat, insets: EdgeInsets, panes: BlobPanes?) {
        let lo = insets.leading + 24
        let hi = width - insets.trailing - 24
        func reading(_ from: CGFloat, _ to: CGFloat) -> Span {
            let room = max(0, to - from)
            let column = min(Self.readable, room)
            return Span(x: from + (room - column) / 2, width: column)
        }
        guard let panes else {
            centered = reading(lo, hi)
            return
        }
        let leading = reading(lo, panes.fold.minX)
        self.leading = leading
        trailing = Span(x: panes.fold.maxX, width: max(0, min(560, hi - panes.fold.maxX)))
        // As wide as the leading pane's column, so moving between the two
        // only changes where the column is, never how its text wraps.
        centered = panes.physical
            ? leading
            : Span(x: (lo + hi - leading.width) / 2, width: leading.width)
    }
}

extension View {
    /// Puts the view in one of the page's columns, full-bleed space.
    func blobColumn(_ span: BlobColumns.Span) -> some View {
        frame(width: span.width, alignment: .leading)
            .padding(.leading, span.x)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Puts the view in a column it moves between, such as the
    /// conversation going from the leading pane to centered as history
    /// opens. The columns it
    /// moves between have one width (`BlobColumns`), so only its position
    /// animates and its text never re-wraps on the way. A change of width
    /// is the surface resizing: then nothing animates, so the column keeps
    /// up with the window instead of trailing it.
    func blobColumn(_ span: BlobColumns.Span, moving animation: Animation?) -> some View {
        frame(width: span.width, alignment: .leading)
            .offset(x: span.x)
            .transaction(value: span.width) { $0.animation = nil }
            .animation(animation, value: span.x)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One exchange shown across two panes: its conversation in the leading
/// column and its visual blocks in the trailing one, both from the top,
/// then anything else that was beside it (a waiting decision).
/// The current reply's visuals use `BlobSidePane` instead, with a scroll
/// of their own; history and the current exchange while history is open
/// use this, so they scroll with the page.
struct BlobSplitRow<Conversation: View, Beside: View>: View {
    let columns: BlobColumns
    let visuals: [String]
    let conversation: () -> Conversation
    let beside: () -> Beside

    init(
        columns: BlobColumns,
        visuals: [String],
        @ViewBuilder conversation: @escaping () -> Conversation,
        @ViewBuilder beside: @escaping () -> Beside = { EmptyView() }
    ) {
        self.columns = columns
        self.visuals = visuals
        self.conversation = conversation
        self.beside = beside
    }

    var body: some View {
        if let leading = columns.leading, let trailing = columns.trailing {
            ZStack(alignment: .topLeading) {
                conversation().blobColumn(leading)
                VStack(alignment: .leading, spacing: 20) {
                    ForEach(Array(visuals.enumerated()), id: \.offset) { _, block in
                        MarkdownBody(block)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    beside()
                }
                .blobColumn(trailing)
            }
        } else {
            conversation().blobColumn(columns.centered)
        }
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
                // Quick replies answer the conversation, so they stay with it,
                // and so does the spoken script, which opens it.
                if lang != "choices", lang != "say", TranscriptRichBlocks.block(lang: lang, source: source) != nil {
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
/// or nothing at all. When the spoken words point at a block here (`focus`,
/// its cue anchor on the block's first line), the pane scrolls to it and it
/// pulses.
struct BlobSidePane<Side: View>: View {
    let visuals: [String]
    var focus: BlobTextTalk.Focus?
    let margins: EdgeInsets
    @ViewBuilder let side: () -> Side

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let ids = visuals.map(Self.anchorIds)
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if visuals.isEmpty {
                        side()
                    } else {
                        ForEach(Array(visuals.enumerated()), id: \.offset) { index, block in
                            MarkdownBody(block)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .cuePulse(focus.flatMap { ids[index].contains($0.id) ? $0.tick : nil })
                                .id(Self.visualId(index))
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
            .onChange(of: focus) { _, focus in
                guard let focus, let index = ids.firstIndex(where: { $0.contains(focus.id) }) else { return }
                if reduceMotion {
                    proxy.scrollTo(Self.visualId(index), anchor: .center)
                } else {
                    withAnimation(.smooth(duration: 0.45)) { proxy.scrollTo(Self.visualId(index), anchor: .center) }
                }
            }
        }
    }

    static func visualId(_ index: Int) -> String { "blob-visual-\(index)" }

    /// A block's anchors: on a fence's opening line or a figure's line.
    static func anchorIds(_ block: String) -> [String] {
        CueMarkers.anchorIds(inLine: String(block.prefix { $0 != "\n" }))
    }
}
