import SwiftUI

/// A ```metrics fence as a grid of cards: the value big and tabular, the
/// label under it, the delta beside the value coloured by its direction.
/// The cards share the width in equal columns (`EqualColumnsLayout`), as
/// many as fit at `minCard`, which grows with the text size.
struct MetricsBlockView: View {
    let metrics: [Metric]

    @ScaledMetric(relativeTo: .title2) private var minCard: CGFloat = 104

    var body: some View {
        EqualColumnsLayout(minWidth: minCard, spacing: 8) {
            ForEach(Array(metrics.enumerated()), id: \.offset) { _, metric in
                card(metric)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Metrics")
    }

    private func card(_ metric: Metric) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            // The delta goes under the value when a narrow column has no
            // room for it beside, rather than breaking across lines.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    valueLine(metric)
                    deltaText(metric).padding(.leading, 2)
                }
                VStack(alignment: .leading, spacing: 1) {
                    valueLine(metric)
                    deltaText(metric)
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

/// Cards in equal columns that fill the width: as many columns as fit at
/// `minWidth`, and the rows balanced, so the cards wrap as 3, 2 + 2 or
/// 3 + 2 and never leave one wide card beside narrow ones. Every card in a
/// row gets the row's height.
struct EqualColumnsLayout: Layout {
    var minWidth: CGFloat
    var spacing: CGFloat

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
        let columns = Self.columns(count: count, width: width, minWidth: minWidth, spacing: spacing)
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
