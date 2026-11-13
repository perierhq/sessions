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
/// Everything drawn is derived once per revision (`BlobBoard.scene`: the
/// layout, the sketches as paths, the words, the reading order) and laid
/// out in board points; the camera is a transform over it. A pan or a
/// pinch frame rebuilds nothing: the ink strokes cached paths under the
/// camera's transform, and the words and the reading order are moved and
/// scaled as a whole.
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
    private var dark: Bool { colorScheme == .dark }
    private var camera: BlobBoardCamera { board.camera }

    var body: some View {
        let scene = board.scene(snapshot, noteSize: noteSize)
        TimelineView(.animation(paused: camera.move == nil)) { timeline in
            let now = camera.at(timeline.date)
            let origin = now.toView(BoardPoint(0, 0), in: viewport)
            ZStack(alignment: .topLeading) {
                ink(scene, now, front: false)
                BoardWordsLayer(scene: scene, noteSize: noteSize, dark: dark)
                    .equatable()
                    .scaleEffect(now.zoom, anchor: .topLeading)
                    .offset(x: origin.x, y: origin.y)
                ink(scene, now, front: true)
            }
            .frame(width: viewport.size.w, height: viewport.size.h, alignment: .topLeading)
            .mask(alignment: .topLeading) {
                // The trailing strip is chrome: no board under it.
                Rectangle()
                    .frame(width: viewport.content.w, height: viewport.size.h)
                    .offset(x: viewport.leading)
            }
            .accessibilityHidden(true)
            .overlay(alignment: .topLeading) {
                BoardReadingLayer(scene: scene, viewport: viewport, open: open, focused: reveal)
                    .equatable()
                    .scaleEffect(now.zoom, anchor: .topLeading)
                    .offset(x: origin.x, y: origin.y)
            }
            .overlay(alignment: .topLeading) { controls(scene, now) }
            .overlay(alignment: .top) { pullHint(now) }
        }
        .contentShape(Rectangle())
        .gesture(SimultaneousGesture(pan, pinch))
    }

    // MARK: Gestures

    private var pan: some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                guard pinchStart == nil else { return }
                let start = dragStart ?? camera.at(.now)
                if dragStart == nil { dragStart = start }
                var next = start.panned(by: BoardPoint(value.translation.width, value.translation.height))
                // Past the board's edge the camera resists, like a scroll.
                if next.origin.y < 0 { next.origin.y /= 2 }
                if next.origin.x < 0 { next.origin.x /= 2 }
                camera.take(next)
                let pulled = -next.origin.y * next.zoom > Self.pullToReveal
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
                let start = pinchStart ?? camera.at(.now)
                if pinchStart == nil { pinchStart = start }
                camera.take(start.zoomed(
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

    /// Back inside the board after a gesture, and where it ended goes to
    /// the server.
    private func settle() {
        let settled = camera.resting.settled
        if settled != camera.resting {
            camera.go(to: settled, animated: !reduceMotion)
        } else {
            camera.report()
        }
    }

    /// VoiceOver moved to an element: off camera, the camera goes to it.
    private func reveal(_ id: String) {
        guard let spot = board.scene(snapshot, noteSize: noteSize).core.reading.first(where: { $0.line.id == id }),
              let next = camera.at(.now).revealing(spot.frame, in: viewport)
        else { return }
        camera.go(to: next, animated: !reduceMotion)
    }

    // MARK: Ink

    /// Blob's marks and the clean shapes of refs, behind the text (`front`
    /// false) or over it (z ≥ 1, like a circle drawn around a card). The
    /// paths are the scene's, in board points; only the transform changes
    /// with the camera.
    private func ink(_ scene: BlobBoardScene, _ camera: BoardCamera, front: Bool) -> some View {
        let visible = camera.visible(in: viewport).insetBy(-120)
        let origin = camera.toView(BoardPoint(0, 0), in: viewport)
        let dark = dark
        let ink = BoardColor.color(.ink, dark: dark)
        let quiet = BoardColor.color(.quiet, dark: dark)
        let edge = BoardColor.color(.ink2, dark: dark).opacity(0.5)
        return Canvas { context, _ in
            context.transform = CGAffineTransform(a: camera.zoom, b: 0, c: 0, d: camera.zoom, tx: origin.x, ty: origin.y)
            let stroke = StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round)
            for mark in scene.core.marks where mark.front == front {
                let el = mark.item.element
                if let frame = mark.item.frame, !frame.intersects(visible) { continue }
                if case .shape(let box, let kind, _) = el.content {
                    if el.ref != nil {
                        // A shape bound to a real object: crisp, quiet fill,
                        // radius 12, a dot in the object's status colour.
                        let path = BoardColor.cleanPath(box, kind: kind)
                        context.fill(path, with: .color(quiet))
                        context.stroke(path, with: .color(edge), lineWidth: 1)
                        let tone = scene.ref(el.ref).map { $0.ok ? $0.statusTone : .ink2 } ?? .ink2
                        context.fill(Path(ellipseIn: CGRect(x: box.x + 12, y: box.y + 12, width: 8, height: 8)),
                                     with: .color(BoardColor.color(tone, dark: dark)))
                        continue
                    }
                    if let fill = el.style.fill, kind != .line {
                        let tint = fill == .quiet ? quiet : BoardColor.color(fill, dark: dark).opacity(0.12)
                        context.fill(BoardColor.cleanPath(box, kind: kind), with: .color(tint))
                    }
                }
                guard let path = scene.paths[mark.id] else { continue }
                // Sketches and notes' leaders are ink, always.
                context.stroke(path, with: .color(ink), style: stroke)
            }
        }
        .allowsHitTesting(false)
    }

    // MARK: Controls

    /// Fit (frames what the last reply changed; again, back to the origin)
    /// and More (pans to content past an edge). In the Duo's strip where
    /// there is one, as on the designs; otherwise at the trailing edge.
    @ViewBuilder
    private func controls(_ scene: BlobBoardScene, _ now: BoardCamera) -> some View {
        let strip = viewport.trailing >= 60
        let x = strip ? viewport.size.w - viewport.trailing + 36 : viewport.size.w - viewport.trailing - 38
        let fitY = strip ? (viewport.fold == nil ? 178 : 114) : viewport.top + 30
        let sides = now.offCamera(scene.core.bounds, in: viewport)
        ZStack(alignment: .topLeading) {
            roundButton(camera.fitted ? "Back to start" : "Fit what changed", symbol: "dot.viewfinder") {
                board.fit(in: viewport, noteSize: noteSize, animated: !reduceMotion)
            }
            .position(x: x, y: fitY)
            if sides.trailing {
                moreButton(symbol: "chevron.right") {
                    camera.go(to: now.revealingTrailing(starts: scene.core.starts, in: viewport), animated: !reduceMotion)
                }
                .position(x: x, y: strip ? viewport.size.h * 0.47 : viewport.size.h / 2)
            }
            if sides.leading {
                moreButton(symbol: "chevron.left") {
                    camera.go(to: now.revealingLeading(in: viewport), animated: !reduceMotion)
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
                .foregroundStyle(BoardColor.color(.ink, dark: dark))
                .frame(width: 44, height: 44)
                .background(Circle().fill(BoardColor.color(.quiet, dark: dark)))
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
                .foregroundStyle(BoardColor.color(.ink2, dark: dark))
                .accessibilityHidden(true)
        }
        .transition(.opacity)
    }

    /// Over the gap a pull opens above the board: letting go shows what
    /// came before.
    @ViewBuilder
    private func pullHint(_ now: BoardCamera) -> some View {
        let pull = -now.origin.y * now.zoom
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

/// The board's colours and clean shapes, shared by the ink and the words.
enum BoardColor {
    static func color(_ token: BoardToken, dark: Bool) -> Color {
        let (rgb, alpha) = token.rgba(dark: dark)
        return Color(
            .sRGB,
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255,
            opacity: alpha
        )
    }

    static func cleanPath(_ box: BoardRect, kind: BoardShapeKind) -> Path {
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
}

/// Text, ref cards, images, frame titles, notes and arrow labels, each at
/// its place in board points. Built once per scene: the canvas scales and
/// moves the whole layer with the camera, and `Equatable` keeps SwiftUI
/// from rebuilding it on a pan or pinch frame.
private struct BoardWordsLayer: View, Equatable {
    let scene: BlobBoardScene
    let noteSize: Double
    let dark: Bool

    static func == (a: Self, b: Self) -> Bool {
        a.scene === b.scene && a.noteSize == b.noteSize && a.dark == b.dark
    }

    private var textScale: Double { noteSize / BlobHand.baseSize }

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(scene.core.words, id: \.element.id) { item in
                element(item)
            }
        }
        .allowsHitTesting(false)
    }

    private func color(_ token: BoardToken) -> Color { BoardColor.color(token, dark: dark) }

    @ViewBuilder
    private func element(_ item: BoardLayout.Item) -> some View {
        let el = item.element
        switch el.content {
        case .text(_, _, _, _, let role, let text, let sub, let status):
            if let r = item.frame {
                Group {
                    if el.ref != nil {
                        refCard(el, text: text, sub: sub, status: status, height: r.h)
                    } else {
                        plainText(el, role: role, text: text, sub: sub, status: status)
                    }
                }
                .frame(width: r.w, alignment: .topLeading)
                .offset(x: r.x, y: r.y)
            }
        case .frame(_, let title?):
            if let r = item.frame {
                Text(title)
                    .font(font(.meta))
                    .foregroundStyle(color(.ink2))
                    .lineLimit(1)
                    .frame(width: r.w, alignment: .leading)
                    .offset(x: r.x, y: r.y)
            }
        case .image(_, let src, let fit, _):
            if let r = item.frame {
                BoardImageTile(src: src, fit: fit, quiet: color(.quiet))
                    .frame(width: r.w, height: r.h)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .offset(x: r.x, y: r.y)
            }
        case .note(_, let text, _):
            if let r = item.frame {
                Text(text)
                    .font(.custom(BlobHand.fontName, fixedSize: noteSize))
                    .foregroundStyle(color(.ink))
                    .lineLimit(2)
                    .frame(width: r.w, height: r.h, alignment: .topLeading)
                    .rotationEffect(.degrees(Sketch.noteTilt(id: el.id)))
                    .offset(x: r.x, y: r.y)
            }
        case .arrow(_, _, _, let label?):
            if let route = scene.core.layout.arrows[el.id] {
                let mid = route.middle
                Text(label)
                    .font(font(.meta))
                    .foregroundStyle(color(.ink2))
                    .multilineTextAlignment(.center)
                    .frame(width: 120)
                    .offset(x: mid.x - 60, y: mid.y - 18)
            }
        default:
            EmptyView()
        }
    }

    private func font(_ role: BoardTextRole) -> Font {
        .system(size: role.size * textScale, weight: role.semibold ? .semibold : .regular)
    }

    /// A plain text element. `style.color` colours the main line, or the
    /// supporting line of an item title, which is how the design marks the
    /// one thing that needs the owner ("Only you can").
    private func plainText(_ el: BoardElement, role: BoardTextRole, text: String?, sub: String?, status: String?) -> some View {
        let colored = el.style.color
        let subTakesColor = role == .title && sub != nil
        let mainColor = color((subTakesColor ? nil : colored) ?? role.defaultToken)
        let subColor = color((subTakesColor ? colored : nil) ?? .ink2)
        let tail = [status, sub].compactMap { $0 }.joined(separator: " · ")
        return VStack(alignment: .leading, spacing: 2) {
            if let text {
                Text(text)
                    .font(font(role))
                    .foregroundStyle(mainColor)
            }
            if !tail.isEmpty {
                Text(tail)
                    .font(font(.supporting))
                    .foregroundStyle(subColor)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    /// A real object: clean, quiet fill, radius 12, a dot in its status
    /// colour, its live title and status. One that no longer resolves
    /// keeps its words in secondary ink with "not found".
    private func refCard(_ el: BoardElement, text: String?, sub: String?, status: String?, height: Double) -> some View {
        let ref = scene.ref(el.ref) ?? .missing
        let found = ref.ok
        let locator = el.ref.flatMap { r in r.firstIndex(of: ":").map { String(r[r.index(after: $0)...]) } } ?? ""
        let title = text.map { BoardLiveText.fill($0, ref) }.flatMap { $0.isEmpty ? nil : $0 }
            ?? (found ? ref.title : locator)
        let statusLine = status.map { BoardLiveText.fill($0, ref) } ?? (found ? ref.status : "not found")
        let tone = found ? ref.statusTone : .ink2
        let subLine = sub.map { BoardLiveText.fill($0, ref) } ?? ""
        let statusText = Text(statusLine).foregroundStyle(color(tone))
        let line = subLine.isEmpty ? statusText : Text("\(statusText) \u{00B7} \(subLine)")
        return HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(color(tone))
                .frame(width: 8, height: 8)
                .padding(.top, 5 * textScale)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(font(.title))
                    .foregroundStyle(color(found ? .ink : .ink2))
                line
                    .font(font(.supporting))
                    .foregroundStyle(color(.ink2))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.leading, 12)
        .padding(.trailing, 14)
        .padding(.vertical, 10)
        .frame(minHeight: height, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(color(.quiet)))
    }
}

/// VoiceOver: one element per line of the board's reading order (BlobCore
/// `BoardReading`, the same words as the text fallback), over the element
/// it reads, in board points. Built once per scene; the canvas moves and
/// scales it with the camera. Only refs carry an action (they open);
/// focusing an element off camera brings the camera to it (`focused`).
private struct BoardReadingLayer: View, Equatable {
    let scene: BlobBoardScene
    /// Compared so `focused` never acts on a stale surface.
    let viewport: BoardViewport
    var open: (BoardHitTest.Hit) -> Void
    var focused: (String) -> Void
    @AccessibilityFocusState private var focus: String?

    static func == (a: Self, b: Self) -> Bool { a.scene === b.scene && a.viewport == b.viewport }

    var body: some View {
        let spots = scene.core.reading
        ZStack(alignment: .topLeading) {
            ForEach(Array(spots.enumerated()), id: \.element.line.id) { index, spot in
                let line = spot.line
                Color.clear
                    .frame(width: max(1, spot.frame.w), height: max(1, spot.frame.h))
                    .offset(x: spot.frame.x, y: spot.frame.y)
                    .accessibilityElement()
                    .accessibilityLabel(line.text)
                    .accessibilityAddTraits(line.heading ? .isHeader : line.ref != nil ? .isButton : [])
                    .accessibilitySortPriority(Double(spots.count - index))
                    .accessibilityFocused($focus, equals: line.id)
                    .modifier(OpensRef(ref: line.ref) { ref in open(BoardHitTest.Hit(id: line.id, ref: ref)) })
            }
        }
        .allowsHitTesting(false)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Board")
        .onChange(of: focus) { _, id in
            if let id { focused(id) }
        }
    }
}

/// The activation action, on refs only: other lines read and do nothing.
private struct OpensRef: ViewModifier {
    let ref: String?
    let open: (String) -> Void

    func body(content: Content) -> some View {
        if let ref {
            content.accessibilityAction { open(ref) }
        } else {
            content
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
        let layout = scene(snapshot, noteSize: BlobCanvasView.noteSize(scaledBody: scaledBody)).core.layout
        let now = camera.at(.now)
        let point = now.toBoard(BoardPoint(location.x, location.y), in: viewport)
        return BoardHitTest.ref(at: point, in: layout, slop: 4 / now.zoom)
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
