import BlobCore
import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// Blob's board, drawn: Blob's own marks sketchy in ink (Canvas paths,
/// seeded so redraws never wobble), real objects clean and tappable, text
/// in SF Pro in its type-scale role, notes in Blob's hand. One camera over
/// one board (`BlobBoard.camera`): pan with a finger, pinch to zoom from
/// 25% to 200%, Fit frames what the last reply changed, More pans to
/// content past the edge. Gestures move the camera, never the board.
///
/// Board (0, 0) is the top-left of the content area on every device; the
/// trailing inset (the closed Duo's 84 pt strip, the open Duo's rail) is
/// chrome and shows no board. Opening the Duo widens the camera, so the
/// leading screen stays exactly what the closed one showed.
///
/// Taps on refs are the home's (`BlobBoard.hit`), so Blob's own tap keeps
/// working over the board.
struct BlobCanvasView: View {
    let board: BlobBoard
    let snapshot: BoardSnapshot
    let viewport: BoardViewport
    /// VoiceOver activated a ref.
    var open: (BoardHitTest.Hit) -> Void
    /// Pulled down past the board's top and let go: history, as the page's
    /// pull does on the empty home.
    var pulledPastTop: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var scaledBody: Double = 17
    @State private var dragStart: BoardCamera?
    @State private var pinchStart: BoardCamera?
    @State private var armed = false

    /// How far past the top a pull must go before letting go shows history.
    private static let pullToReveal = 64.0

    /// Dynamic Type for the board: notes from 16 pt up to 22 (spec "Notes"),
    /// and board text by the same factor at most, since positions are
    /// fixed. Past the cap, VoiceOver and pinch carry the rest.
    static func noteSize(scaledBody: Double) -> Double {
        min(BlobHand.maxSize, max(BlobHand.baseSize, BlobHand.baseSize * scaledBody / 17))
    }

    private var noteSize: Double { Self.noteSize(scaledBody: scaledBody) }
    private var textScale: Double { noteSize / BlobHand.baseSize }
    private var dark: Bool { colorScheme == .dark }

    var body: some View {
        let drawn = board.layout(snapshot, noteSize: noteSize)
        TimelineView(.animation(paused: board.move == nil)) { timeline in
            let camera = board.camera(at: timeline.date)
            ZStack(alignment: .topLeading) {
                sketches(drawn, camera, front: false)
                elements(drawn, camera)
                sketches(drawn, camera, front: true)
            }
            .frame(width: viewport.size.w, height: viewport.size.h, alignment: .topLeading)
            .mask(alignment: .topLeading) {
                // The trailing strip is chrome: no board under it.
                Rectangle()
                    .frame(width: viewport.content.w, height: viewport.size.h)
                    .offset(x: viewport.leading)
            }
            .accessibilityHidden(true)
            .overlay(alignment: .topLeading) { readingOrder(drawn, camera) }
            .overlay(alignment: .topLeading) { controls(drawn, camera) }
            .overlay(alignment: .top) { pullHint(camera) }
        }
        .contentShape(Rectangle())
        .gesture(SimultaneousGesture(pan, pinch))
        .onAppear { BlobHand.register() }
    }

    // MARK: Gestures

    private var pan: some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                guard pinchStart == nil else { return }
                let start = dragStart ?? board.camera(at: .now)
                if dragStart == nil { dragStart = start }
                var camera = start.panned(by: BoardPoint(value.translation.width, value.translation.height))
                // Past the board's edge the camera resists, like a scroll.
                if camera.origin.y < 0 { camera.origin.y /= 2 }
                if camera.origin.x < 0 { camera.origin.x /= 2 }
                board.takeCamera(camera)
                let pulled = -camera.origin.y * camera.zoom > Self.pullToReveal
                if pulled != armed { armed = pulled }
            }
            .onEnded { _ in
                dragStart = nil
                if armed {
                    armed = false
                    pulledPastTop()
                }
                settle()
            }
    }

    private var pinch: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                let start = pinchStart ?? board.camera(at: .now)
                if pinchStart == nil { pinchStart = start }
                board.takeCamera(start.zoomed(
                    by: value.magnification,
                    anchor: BoardPoint(value.startLocation.x, value.startLocation.y),
                    in: viewport
                ))
            }
            .onEnded { _ in
                pinchStart = nil
                settle()
            }
    }

    /// Back inside the board after a gesture.
    private func settle() {
        let settled = board.camera.settled
        if settled != board.camera { board.go(to: settled, animated: !reduceMotion) }
    }

    // MARK: Drawing

    private func color(_ token: BoardToken) -> Color {
        let (rgb, alpha) = token.rgba(dark: dark)
        return Color(
            .sRGB,
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255,
            opacity: alpha
        )
    }

    /// Blob's marks and the clean shapes of refs, behind the text (`front`
    /// false) or over it (z ≥ 1, like a circle drawn around a card).
    private func sketches(_ drawn: BoardLayout, _ camera: BoardCamera, front: Bool) -> some View {
        let visible = camera.visible(in: viewport).insetBy(-120)
        let origin = camera.toView(BoardPoint(0, 0), in: viewport)
        let ink = color(.ink)
        let quiet = color(.quiet)
        return Canvas { context, _ in
            context.transform = CGAffineTransform(a: camera.zoom, b: 0, c: 0, d: camera.zoom, tx: origin.x, ty: origin.y)
            let stroke = StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round)
            for item in drawn.painted where (item.element.z >= 1) == front {
                let el = item.element
                if let frame = item.frame, !frame.intersects(visible) { continue }
                if case .shape(let box, let kind, _) = el.content {
                    if el.ref != nil {
                        cleanShape(&context, box: box, kind: kind, el: el, quiet: quiet)
                        continue
                    }
                    if let fill = el.style.fill, kind != .line {
                        let tint = fill == .quiet ? quiet : color(fill).opacity(0.12)
                        context.fill(cleanPath(box, kind: kind), with: .color(tint))
                    }
                }
                guard let path = Sketch.path(for: item, in: drawn) else { continue }
                // Sketches and notes' leaders are ink, always.
                context.stroke(Path(path), with: .color(ink), style: stroke)
            }
        }
        .allowsHitTesting(false)
    }

    private func cleanPath(_ box: BoardRect, kind: BoardShapeKind) -> Path {
        let rect = CGRect(x: box.x, y: box.y, width: box.w, height: box.h)
        switch kind {
        case .ellipse: return Path(ellipseIn: rect)
        case .diamond:
            var p = Path()
            p.move(to: CGPoint(x: rect.midX, y: rect.minY))
            p.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
            p.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
            p.addLine(to: CGPoint(x: rect.minX, y: rect.midY))
            p.closeSubpath()
            return p
        default: return Path(roundedRect: rect, cornerRadius: 12, style: .continuous)
        }
    }

    /// A shape bound to a real object: crisp, quiet fill, radius 12, a dot
    /// in the object's status colour.
    private func cleanShape(_ context: inout GraphicsContext, box: BoardRect, kind: BoardShapeKind, el: BoardElement, quiet: Color) {
        let path = cleanPath(box, kind: kind)
        context.fill(path, with: .color(quiet))
        context.stroke(path, with: .color(color(.ink2).opacity(0.5)), lineWidth: 1)
        let tone = snapshot.ref(el.ref).map { $0.ok ? $0.statusTone : .ink2 } ?? .ink2
        context.fill(Path(ellipseIn: CGRect(x: box.x + 12, y: box.y + 12, width: 8, height: 8)), with: .color(color(tone)))
    }

    /// Text, ref cards, images, frame titles, notes and arrow labels, each
    /// at its place under the camera.
    private func elements(_ drawn: BoardLayout, _ camera: BoardCamera) -> some View {
        let visible = camera.visible(in: viewport).insetBy(-120)
        let items = drawn.painted.filter { item in
            switch item.element.content {
            case .shape, .stroke: return false
            case .arrow(_, _, _, let label): return label != nil
            case .frame(_, let title): return title != nil && item.frame?.intersects(visible) == true
            default: return item.frame?.intersects(visible) == true
            }
        }
        return ZStack(alignment: .topLeading) {
            ForEach(items, id: \.element.id) { item in
                element(item, drawn, camera)
            }
        }
        .allowsHitTesting(false)
    }

    @ViewBuilder
    private func element(_ item: BoardLayout.Item, _ drawn: BoardLayout, _ camera: BoardCamera) -> some View {
        let z = camera.zoom
        let el = item.element
        switch el.content {
        case .text(_, _, _, _, let role, let text, let sub, let status):
            if let frame = item.frame {
                let r = camera.toView(frame, in: viewport)
                Group {
                    if el.ref != nil {
                        refCard(el, text: text, sub: sub, status: status, height: r.h, zoom: z)
                    } else {
                        plainText(el, role: role, text: text, sub: sub, status: status, zoom: z)
                    }
                }
                .frame(width: r.w, alignment: .topLeading)
                .offset(x: r.x, y: r.y)
            }
        case .frame(_, let title?):
            if let frame = item.frame {
                let r = camera.toView(frame, in: viewport)
                Text(title)
                    .font(font(.meta, zoom: z))
                    .foregroundStyle(color(.ink2))
                    .lineLimit(1)
                    .frame(width: r.w, alignment: .leading)
                    .offset(x: r.x, y: r.y)
            }
        case .image(_, let src, let fit, _):
            if let frame = item.frame {
                let r = camera.toView(frame, in: viewport)
                BoardImageTile(src: src, fit: fit, quiet: color(.quiet))
                    .frame(width: r.w, height: r.h)
                    .clipShape(RoundedRectangle(cornerRadius: 8 * z, style: .continuous))
                    .offset(x: r.x, y: r.y)
            }
        case .note(_, let text, _):
            if let frame = item.frame {
                let r = camera.toView(frame, in: viewport)
                Text(text)
                    .font(.custom(BlobHand.fontName, fixedSize: noteSize * z))
                    .foregroundStyle(color(.ink))
                    .lineLimit(2)
                    .frame(width: r.w, height: r.h, alignment: .topLeading)
                    .rotationEffect(.degrees(Sketch.noteTilt(id: el.id)))
                    .offset(x: r.x, y: r.y)
            }
        case .arrow(_, _, _, let label?):
            if let route = drawn.arrows[el.id] {
                let mid = camera.toView(route.middle, in: viewport)
                Text(label)
                    .font(font(.meta, zoom: z))
                    .foregroundStyle(color(.ink2))
                    .multilineTextAlignment(.center)
                    .frame(width: 120 * z)
                    .offset(x: mid.x - 60 * z, y: mid.y - 18 * z)
            }
        default:
            EmptyView()
        }
    }

    private func font(_ role: BoardTextRole, zoom: Double) -> Font {
        .system(size: role.size * zoom * textScale, weight: role.semibold ? .semibold : .regular)
    }

    /// A plain text element. `style.color` colours the main line, or the
    /// supporting line of an item title, which is how the design marks the
    /// one thing that needs the owner ("Only you can").
    private func plainText(_ el: BoardElement, role: BoardTextRole, text: String?, sub: String?, status: String?, zoom: Double) -> some View {
        let colored = el.style.color
        let subTakesColor = role == .title && sub != nil
        let mainColor = color((subTakesColor ? nil : colored) ?? role.defaultToken)
        let subColor = color((subTakesColor ? colored : nil) ?? .ink2)
        let tail = [status, sub].compactMap { $0 }.joined(separator: " · ")
        return VStack(alignment: .leading, spacing: 2 * zoom) {
            if let text {
                Text(text)
                    .font(font(role, zoom: zoom))
                    .foregroundStyle(mainColor)
            }
            if !tail.isEmpty {
                Text(tail)
                    .font(font(.supporting, zoom: zoom))
                    .foregroundStyle(subColor)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    /// A real object: clean, quiet fill, radius 12, a dot in its status
    /// colour, its live title and status. One that no longer resolves
    /// keeps its words in secondary ink with "not found".
    private func refCard(_ el: BoardElement, text: String?, sub: String?, status: String?, height: Double, zoom: Double) -> some View {
        let ref = snapshot.ref(el.ref) ?? .missing
        let found = ref.ok
        let locator = el.ref.flatMap { r in r.firstIndex(of: ":").map { String(r[r.index(after: $0)...]) } } ?? ""
        let title = text.map { BoardLiveText.fill($0, ref) }.flatMap { $0.isEmpty ? nil : $0 }
            ?? (found ? ref.title : locator)
        let statusLine = status.map { BoardLiveText.fill($0, ref) } ?? (found ? ref.status : "not found")
        let tone = found ? ref.statusTone : .ink2
        let subLine = sub.map { BoardLiveText.fill($0, ref) } ?? ""
        let statusText = Text(statusLine).foregroundStyle(color(tone))
        let line = subLine.isEmpty ? statusText : Text("\(statusText) \u{00B7} \(subLine)")
        return HStack(alignment: .top, spacing: 10 * zoom) {
            Circle()
                .fill(color(tone))
                .frame(width: 8 * zoom, height: 8 * zoom)
                .padding(.top, 5 * zoom * textScale)
            VStack(alignment: .leading, spacing: 2 * zoom) {
                Text(title)
                    .font(font(.title, zoom: zoom))
                    .foregroundStyle(color(found ? .ink : .ink2))
                line
                    .font(font(.supporting, zoom: zoom))
                    .foregroundStyle(color(.ink2))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.leading, 12 * zoom)
        .padding(.trailing, 14 * zoom)
        .padding(.vertical, 10 * zoom)
        .frame(minHeight: height, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12 * zoom, style: .continuous).fill(color(.quiet)))
    }

    // MARK: VoiceOver

    /// One element per line of the board's reading order (BlobCore
    /// `BoardReading`, the same words as the text fallback), over the
    /// element it reads. Refs open on activation.
    private func readingOrder(_ drawn: BoardLayout, _ camera: BoardCamera) -> some View {
        let lines = BoardReading.lines(snapshot, layout: drawn)
        return ZStack(alignment: .topLeading) {
            ForEach(Array(lines.enumerated()), id: \.element.id) { index, line in
                let frame = drawn.frame(line.id) ?? drawn.arrows[line.id]?.bounds ?? BoardRect(x: 0, y: 0, w: 1, h: 1)
                let r = camera.toView(frame, in: viewport)
                Color.clear
                    .frame(width: max(1, r.w), height: max(1, r.h))
                    .offset(x: r.x, y: r.y)
                    .accessibilityElement()
                    .accessibilityLabel(line.text)
                    .accessibilityAddTraits(line.heading ? .isHeader : line.ref != nil ? .isButton : [])
                    .accessibilitySortPriority(Double(lines.count - index))
                    .accessibilityAction {
                        if let ref = line.ref { open(BoardHitTest.Hit(id: line.id, ref: ref)) }
                    }
            }
        }
        .allowsHitTesting(false)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Board")
    }

    // MARK: Controls

    /// Fit (frames what the last reply changed; again, back to the origin)
    /// and More (pans to content past an edge). In the Duo's strip where
    /// there is one, as on the designs; otherwise at the trailing edge.
    @ViewBuilder
    private func controls(_ drawn: BoardLayout, _ camera: BoardCamera) -> some View {
        let strip = viewport.trailing >= 60
        let x = strip ? viewport.size.w - viewport.trailing + 36 : viewport.size.w - viewport.trailing - 38
        let fitY = strip ? (viewport.fold == nil ? 178 : 114) : viewport.top + 30
        let sides = camera.offCamera(drawn.bounds, in: viewport)
        ZStack(alignment: .topLeading) {
            roundButton(board.fitted ? "Back to start" : "Fit what changed", symbol: "dot.viewfinder") {
                board.fit(in: viewport, noteSize: noteSize, animated: !reduceMotion)
            }
            .position(x: x, y: fitY)
            if sides.trailing {
                moreButton(symbol: "chevron.right") {
                    let starts = drawn.items.compactMap { $0.frame?.minX }
                    board.go(to: camera.revealingTrailing(starts: starts, in: viewport), animated: !reduceMotion)
                }
                .position(x: x, y: strip ? viewport.size.h * 0.47 : viewport.size.h / 2)
            }
            if sides.leading {
                moreButton(symbol: "chevron.left") {
                    board.go(to: camera.revealingLeading(in: viewport), animated: !reduceMotion)
                }
                .position(x: viewport.leading + 38, y: viewport.size.h / 2)
            }
        }
        .frame(width: viewport.size.w, height: viewport.size.h, alignment: .topLeading)
    }

    private func roundButton(_ label: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(label, systemImage: symbol)
                .labelStyle(.iconOnly)
                .font(.system(size: 18, weight: .regular))
                .foregroundStyle(color(.ink))
                .frame(width: 44, height: 44)
                .background(Circle().fill(color(.quiet)))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        #if os(macOS)
        .help(label)
        #endif
    }

    private func moreButton(symbol: String, action: @escaping () -> Void) -> some View {
        VStack(spacing: 4) {
            roundButton("More", symbol: symbol, action: action)
            Text("More")
                .font(.caption2)
                .foregroundStyle(color(.ink2))
                .accessibilityHidden(true)
        }
        .transition(.opacity)
    }

    /// Over the gap a pull opens above the board: letting go shows what
    /// came before.
    @ViewBuilder
    private func pullHint(_ camera: BoardCamera) -> some View {
        let pull = -camera.origin.y * camera.zoom
        if dragStart != nil, pull > 12 {
            Text(armed ? "Release for earlier" : "Earlier")
                .font(.caption2)
                .foregroundStyle(OS1VisualStyle.textDim)
                .opacity(min(1, pull / Self.pullToReveal))
                .padding(.top, viewport.top + pull / 2 - 6)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }
}

extension BlobBoard {
    /// The real object under a tap at `location` (surface points) on the
    /// board as drawn now, or nil.
    func hit(at location: CGPoint, viewport: BoardViewport, scaledBody: Double) -> BoardHitTest.Hit? {
        guard let snapshot = shown else { return nil }
        let content = viewport.content
        guard location.x >= content.x, location.x <= content.maxX else { return nil }
        let layout = layout(snapshot, noteSize: BlobCanvasView.noteSize(scaledBody: scaledBody))
        let camera = camera(at: .now)
        let point = camera.toBoard(BoardPoint(location.x, location.y), in: viewport)
        return BoardHitTest.ref(at: point, in: layout, slop: 4 / camera.zoom)
    }
}

extension Path {
    /// A BlobCore sketch as a SwiftUI path, in board points.
    init(_ sketch: SketchPath) {
        self.init()
        for command in sketch.commands {
            switch command {
            case .move(let p): move(to: CGPoint(x: p.x, y: p.y))
            case .curve(let a, let b, let p):
                addCurve(to: CGPoint(x: p.x, y: p.y), control1: CGPoint(x: a.x, y: a.y), control2: CGPoint(x: b.x, y: b.y))
            }
        }
    }
}

/// A board image from this server's media routes, with radius 8 (the
/// caller clips). Quiet until it loads; an image that fails stays quiet.
private struct BoardImageTile: View {
    let src: String
    let fit: BoardImageFit
    let quiet: Color
    @State private var image: Image?

    var body: some View {
        ZStack {
            quiet
            if let image {
                image
                    .resizable()
                    .aspectRatio(contentMode: fit == .cover ? .fill : .fit)
            }
        }
        .task(id: src) {
            guard let data = try? await OS1API.boardImage(src: src) else { return }
            #if os(iOS)
            if let platform = UIImage(data: data) { image = Image(uiImage: platform) }
            #else
            if let platform = NSImage(data: data) { image = Image(nsImage: platform) }
            #endif
        }
    }
}

/// A ref's detail, for objects with no page of their own to open (an
/// incident, a customer thread): its live fields, read only.
struct BlobRefDetail: Identifiable, Equatable {
    var id: String { ref }
    var ref: String
    var info: BoardRefInfo
}

struct BlobRefSheet: View {
    let detail: BlobRefDetail
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent("Status") {
                        Text(detail.info.ok ? detail.info.status : "Not found")
                            .foregroundStyle(tone)
                    }
                    ForEach(fields, id: \.0) { name, value in
                        LabeledContent(name, value: value)
                    }
                } footer: {
                    Text(detail.ref)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                }
            }
            .navigationTitle(detail.info.ok ? detail.info.title : "Not found")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
            }
        }
    }

    private var tone: Color {
        let (rgb, alpha) = (detail.info.ok ? detail.info.statusTone : .ink2).rgba(dark: colorScheme == .dark)
        return Color(.sRGB, red: Double((rgb >> 16) & 0xFF) / 255, green: Double((rgb >> 8) & 0xFF) / 255,
                     blue: Double(rgb & 0xFF) / 255, opacity: alpha)
    }

    private var fields: [(String, String)] {
        let names = ["openFor": "Open for", "checks": "Checks", "number": "Number", "scope": "Scope"]
        var out = detail.info.fields.sorted { $0.key < $1.key }.map { (names[$0.key] ?? $0.key, $0.value) }
        if let updated = detail.info.updatedAt { out.append(("Updated", updated)) }
        return out
    }
}
