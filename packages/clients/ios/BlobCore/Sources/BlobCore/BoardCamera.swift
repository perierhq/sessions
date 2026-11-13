import Foundation

/// The space a device gives the board: the surface's size, its safe-area
/// insets, and the fold's band when there is one. Board (0, 0) is the
/// top-left of the content area, inside the leading and top insets, on
/// every device; the trailing inset (the Duo's 84 pt strip, the open
/// Duo's rail) is chrome, never board.
public struct BoardViewport: Sendable, Equatable {
    public var size: BoardSize
    public var top: Double
    public var leading: Double
    public var trailing: Double
    /// The fold's band in surface points, on an open foldable.
    public var fold: ClosedRange<Double>?

    public init(size: BoardSize, top: Double = 0, leading: Double = 0, trailing: Double = 0,
                fold: ClosedRange<Double>? = nil) {
        self.size = size; self.top = top; self.leading = leading; self.trailing = trailing; self.fold = fold
    }

    /// The closed Duo's outer display: 466 × 678, the 84 pt strip on the
    /// trailing edge. The board shows x 0–382.
    public static let duoClosed = BoardViewport(size: BoardSize(466, 678), trailing: 84)
    /// The open Duo's inner display in landscape: 951 × 669, the fold at
    /// x 455.5–495.5, the rail at 867–951.
    public static let duoOpen = BoardViewport(size: BoardSize(951, 669), trailing: 84, fold: 455.5...495.5)
    /// The fold's band at the home camera, in board points: text stays off it.
    public static let homeHinge: ClosedRange<Double> = 455.5...495.5

    /// Where board (0, 0) sits on the surface at the home camera.
    public var contentOrigin: BoardPoint { BoardPoint(leading, top) }

    /// The part of the surface the board shows through.
    public var content: BoardRect {
        BoardRect(x: leading, y: top, w: max(0, size.w - leading - trailing), h: max(0, size.h - top))
    }

    /// The trailing chrome, in surface points, when there is any.
    public var strip: ClosedRange<Double>? {
        trailing > 0 ? (size.w - trailing)...size.w : nil
    }
}

/// A camera on the board: the board point at the content area's top-left,
/// and the zoom. Gestures move the camera, never the board. A resize (the
/// Duo opening or closing, a window growing) keeps the camera, so the
/// leading screen shows the same board at the same points.
public struct BoardCamera: Sendable, Equatable {
    public var origin: BoardPoint
    public var zoom: Double

    public static let minZoom = 0.25
    public static let maxZoom = 2.0
    /// The home camera: board (0, 0) at the top-left, 100%.
    public static let home = BoardCamera(origin: BoardPoint(0, 0), zoom: 1)

    public init(origin: BoardPoint, zoom: Double) {
        self.origin = origin
        self.zoom = min(Self.maxZoom, max(Self.minZoom, zoom))
    }

    /// A board point on the surface.
    public func toView(_ p: BoardPoint, in viewport: BoardViewport) -> BoardPoint {
        viewport.contentOrigin + (p - origin) * zoom
    }

    /// A surface point on the board.
    public func toBoard(_ p: BoardPoint, in viewport: BoardViewport) -> BoardPoint {
        origin + (p - viewport.contentOrigin) * (1 / zoom)
    }

    public func toView(_ r: BoardRect, in viewport: BoardViewport) -> BoardRect {
        let p = toView(BoardPoint(r.x, r.y), in: viewport)
        return BoardRect(x: p.x, y: p.y, w: r.w * zoom, h: r.h * zoom)
    }

    /// The board the camera shows, the trailing chrome left out.
    public func visible(in viewport: BoardViewport) -> BoardRect {
        let c = viewport.content
        return BoardRect(x: origin.x, y: origin.y, w: c.w / zoom, h: c.h / zoom)
    }

    /// The fold's band in board points under this camera, if there is one.
    public func hinge(in viewport: BoardViewport) -> ClosedRange<Double>? {
        guard let fold = viewport.fold else { return nil }
        let a = toBoard(BoardPoint(fold.lowerBound, 0), in: viewport).x
        let b = toBoard(BoardPoint(fold.upperBound, 0), in: viewport).x
        return a...b
    }

    /// Moved by a drag of `translation` surface points.
    public func panned(by translation: BoardPoint) -> BoardCamera {
        BoardCamera(origin: origin - translation * (1 / zoom), zoom: zoom)
    }

    /// Zoomed by `factor`, the board point under `anchor` (a surface
    /// point) staying where it is.
    public func zoomed(by factor: Double, anchor: BoardPoint, in viewport: BoardViewport) -> BoardCamera {
        let pinned = toBoard(anchor, in: viewport)
        let zoom = min(Self.maxZoom, max(Self.minZoom, zoom * factor))
        let origin = pinned - (anchor - viewport.contentOrigin) * (1 / zoom)
        return BoardCamera(origin: origin, zoom: zoom)
    }

    /// Back inside the board after a gesture: the origin never left of or
    /// above board (0, 0).
    public var settled: BoardCamera {
        BoardCamera(origin: BoardPoint(max(0, origin.x), max(0, origin.y)), zoom: zoom)
    }

    /// A camera that frames `rect` with `padding` around it, at most 100%
    /// so text never grows past its size, at least `minZoom`. Top-left
    /// aligned, so what changed reads from its start; never left of or
    /// above the board's origin.
    public static func fitting(_ rect: BoardRect, in viewport: BoardViewport, padding: Double = 24) -> BoardCamera {
        let c = viewport.content
        let zx = c.w / max(1, rect.w + 2 * padding)
        let zy = c.h / max(1, rect.h + 2 * padding)
        let zoom = min(1, max(minZoom, min(zx, zy)))
        let origin = BoardPoint(max(0, rect.x - padding), max(0, rect.y - padding))
        return BoardCamera(origin: origin, zoom: zoom)
    }

    /// Part way from `self` to `target`, for a camera move the app animates
    /// itself (`t` 0 to 1, eased by the caller). Zoom interpolates in log
    /// space so a zoom feels even.
    public func interpolated(to target: BoardCamera, t: Double) -> BoardCamera {
        let t = min(1, max(0, t))
        let zoom = exp(log(self.zoom) + (log(target.zoom) - log(self.zoom)) * t)
        let origin = self.origin + (target.origin - self.origin) * t
        return BoardCamera(origin: origin, zoom: zoom)
    }

    /// Which sides of the camera hide board content, for the More control.
    public func offCamera(_ bounds: BoardRect?, in viewport: BoardViewport) -> (leading: Bool, trailing: Bool) {
        guard let bounds else { return (false, false) }
        let v = visible(in: viewport)
        return (bounds.minX < v.minX - 1, bounds.maxX > v.maxX + 1)
    }

    /// The camera after More on the trailing side: the next content past
    /// the visible edge comes in at the leading edge, a margin before it.
    /// `starts`: where each element begins on the board.
    public func revealingTrailing(starts: [Double], in viewport: BoardViewport, margin: Double = 24) -> BoardCamera {
        let v = visible(in: viewport)
        let next = starts.filter { $0 >= v.maxX - margin }.min() ?? (v.maxX - margin)
        return BoardCamera(origin: BoardPoint(max(0, next - margin), origin.y), zoom: zoom)
    }

    /// Back toward the start after More on the leading side.
    public func revealingLeading(in viewport: BoardViewport) -> BoardCamera {
        let v = visible(in: viewport)
        return BoardCamera(origin: BoardPoint(max(0, origin.x - v.w), origin.y), zoom: zoom)
    }
}

/// What the app tells the server about its camera with each prompt
/// (`surface.viewport`, server: blob-surface.ts `parseBoardViewport`):
/// camera points, the board point at its top-left, the zoom, the fold and
/// the trailing strip in camera points, and the closed camera's size on
/// a foldable.
public struct BoardViewportReport: Sendable, Equatable {
    public var w: Double
    public var h: Double
    public var origin: BoardPoint
    public var zoom: Double
    public var hinge: ClosedRange<Double>?
    public var strip: ClosedRange<Double>?
    public var closed: BoardSize?

    public init(viewport: BoardViewport, camera: BoardCamera) {
        // Camera points start at board (0, 0)'s place: the leading inset
        // is not camera.
        let width = viewport.size.w - viewport.leading
        w = width
        h = viewport.size.h - viewport.top
        origin = camera.origin
        zoom = camera.zoom
        hinge = viewport.fold.map { ($0.lowerBound - viewport.leading)...($0.upperBound - viewport.leading) }
        strip = viewport.trailing > 0 ? (width - viewport.trailing)...width : nil
        closed = viewport.fold != nil ? BoardSize(382, 678) : nil
    }

    /// The JSON the server reads.
    public var json: [String: Any] {
        func round(_ n: Double) -> Double { (n * 2).rounded() / 2 }
        var out: [String: Any] = [
            "w": round(w), "h": round(h),
            "origin": [round(origin.x), round(origin.y)],
            "zoom": (zoom * 100).rounded() / 100,
        ]
        if let hinge { out["hinge"] = [round(hinge.lowerBound), round(hinge.upperBound)] }
        if let strip { out["strip"] = [round(strip.lowerBound), round(strip.upperBound)] }
        if let closed { out["closed"] = ["w": closed.w, "h": closed.h] }
        return out
    }
}
