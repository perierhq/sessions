import SwiftUI

/// A ```metrics fence as a grid of cards: the value big and tabular, the
/// label under it, the delta beside the value coloured by its direction.
/// The columns follow the web's rule (`styles/blocks/metrics.css`): as many
/// as fit at `minCard` (150, the web's minimum, grown with the text size),
/// and two on a phone. They share the width equally (`EqualColumnsLayout`).
struct MetricsBlockView: View {
    let metrics: [Metric]

    @ScaledMetric(relativeTo: .title2) private var minCard: CGFloat = 150
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.dynamicTypeSize) private var typeSize
    #endif
    /// Per card with a delta: the width its content has, and the width the
    /// value and delta need side by side.
    @State private var available: [Int: CGFloat] = [:]
    @State private var inline: [Int: CGFloat] = [:]

    /// The web's phone rule, two across. At the accessibility text sizes
    /// the cards fall back to `minCard`, so a value keeps its room.
    private var phoneColumns: Int? {
        #if os(iOS)
        sizeClass == .compact && !typeSize.isAccessibilitySize ? 2 : nil
        #else
        nil
        #endif
    }

    /// One placement for the whole block: if any card's delta doesn't fit
    /// beside its value, every card puts its delta under the value, so the
    /// figures stay on one line across the row.
    private var stackDeltas: Bool {
        metrics.indices.contains { index in
            guard metrics[index].delta != nil,
                  let need = inline[index], let room = available[index] else { return false }
            return need > room + 0.5
        }
    }

    var body: some View {
        let stacked = stackDeltas
        EqualColumnsLayout(minWidth: minCard, spacing: 8, fixedColumns: phoneColumns) {
            ForEach(Array(metrics.enumerated()), id: \.offset) { index, metric in
                card(metric, index: index, stacked: stacked)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Metrics")
    }

    private func card(_ metric: Metric, index: Int, stacked: Bool) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Group {
                if stacked {
                    VStack(alignment: .leading, spacing: 1) {
                        valueLine(metric)
                        deltaText(metric)
                    }
                } else {
                    inlineRow(metric)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { available[index] = $0 }
            .background(alignment: .topLeading) {
                // The side-by-side row at its own width, measured and never
                // shown, so the choice doesn't depend on the one on screen.
                if metric.delta != nil {
                    inlineRow(metric)
                        .fixedSize()
                        .hidden()
                        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { inline[index] = $0 }
                }
            }
            Text(metric.label)
                .font(.caption)
                .foregroundStyle(OS1VisualStyle.textDim)
                .lineLimit(2)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(OS1VisualStyle.markdownCodeWell, in: BlockChrome.shape)
        .overlay {
            BlockChrome.shape.stroke(OS1VisualStyle.border.opacity(0.6), lineWidth: 0.5)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(metric.label)
        .accessibilityValue(
            [metric.value, metric.unit, metric.delta].compactMap { $0 }.joined(separator: " ")
        )
    }

    private func inlineRow(_ metric: Metric) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            valueLine(metric)
            deltaText(metric).padding(.leading, 2)
        }
    }

    private func valueLine(_ metric: Metric) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(metric.value)
                .font(.system(.title2, design: .rounded).weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(OS1VisualStyle.text)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            if let unit = metric.unit {
                Text(unit)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .lineLimit(1)
            }
        }
    }

    @ViewBuilder
    private func deltaText(_ metric: Metric) -> some View {
        if let delta = metric.delta {
            Text(delta)
                .font(.caption.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(color(for: metric.trend))
                .lineLimit(1)
        }
    }

    private func color(for trend: Metric.Trend) -> Color {
        switch trend {
        case .up: OS1VisualStyle.greenInk
        case .down: OS1VisualStyle.redInk
        case .flat: OS1VisualStyle.textDim
        }
    }
}

/// Cards in equal columns that fill the width: `fixedColumns` when set,
/// otherwise as many as fit at `minWidth`, and the rows balanced, so the
/// cards wrap as 3, 2 + 2 or 3 + 2 and never leave one wide card beside
/// narrow ones. Every card in a
/// row gets the row's height.
struct EqualColumnsLayout: Layout {
    var minWidth: CGFloat
    var spacing: CGFloat
    var fixedColumns: Int? = nil

    /// The column count for `count` cards across `width`.
    static func columns(count: Int, width: CGFloat, minWidth: CGFloat, spacing: CGFloat) -> Int {
        guard count > 1 else { return 1 }
        let fit = max(1, Int((width + spacing) / (max(1, minWidth) + spacing)))
        if count <= fit { return count }
        let rows = (count + fit - 1) / fit
        return (count + rows - 1) / rows
    }

    private struct Grid {
        var columns: Int
        var columnWidth: CGFloat
        var rowHeights: [CGFloat]
        var width: CGFloat
    }

    private func grid(width proposed: CGFloat?, subviews: Subviews) -> Grid {
        let count = subviews.count
        let width: CGFloat
        if let proposed, proposed.isFinite {
            width = proposed
        } else {
            // No width offered: one row of cards at their own widths.
            let widest = subviews.map { $0.sizeThatFits(.unspecified).width }.max() ?? 0
            width = CGFloat(count) * max(widest, minWidth) + CGFloat(count - 1) * spacing
        }
        let columns = fixedColumns.map { max(1, $0) }
            ?? Self.columns(count: count, width: width, minWidth: minWidth, spacing: spacing)
        let columnWidth = max(0, (width - CGFloat(columns - 1) * spacing) / CGFloat(columns))
        let rowHeights = stride(from: 0, to: count, by: columns).map { start in
            subviews[start..<min(start + columns, count)]
                .map { $0.sizeThatFits(ProposedViewSize(width: columnWidth, height: nil)).height }
                .max() ?? 0
        }
        return Grid(columns: columns, columnWidth: columnWidth, rowHeights: rowHeights, width: width)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard !subviews.isEmpty else { return .zero }
        let grid = grid(width: proposal.width, subviews: subviews)
        let height = grid.rowHeights.reduce(0, +) + CGFloat(grid.rowHeights.count - 1) * spacing
        return CGSize(width: grid.width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard !subviews.isEmpty else { return }
        let grid = grid(width: bounds.width, subviews: subviews)
        var y = bounds.minY
        for (row, height) in grid.rowHeights.enumerated() {
            for column in 0..<grid.columns {
                let index = row * grid.columns + column
                guard index < subviews.count else { break }
                subviews[index].place(
                    at: CGPoint(x: bounds.minX + CGFloat(column) * (grid.columnWidth + spacing), y: y),
                    proposal: ProposedViewSize(width: grid.columnWidth, height: height)
                )
            }
            y += height + spacing
        }
    }
}
