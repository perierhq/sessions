import CoreGraphics

/// What Blob tells the server about the space a reply will get, sent as
/// `surface` with every message (`OS1API.deliverPromptBody`). The server turns
/// it into a hint for the supervisor turn (blob-surface.ts, adrs/blob-views.md).
@MainActor
enum BlobSurfaceReport {
    private static var base: [String: Any] = ["app": "blob", "panes": 1, "width": "compact"]
    /// The board's camera (BlobCore `BoardViewportReport`): what the board
    /// shows now, the fold and the strip, and the closed camera on a
    /// foldable, so Blob places what matters where it is seen.
    static var viewport: [String: Any]?

    static var current: [String: Any]? {
        var out = base
        if let viewport { out["viewport"] = viewport }
        return out
    }

    /// `panes` is what the home draws (`BlobPanes`): one on a phone, a closed
    /// Duo or the open Duo upright, two beside a vertical fold. Width is
    /// regular from 600 pt, as on the open Duo in either orientation.
    static func update(size: CGSize, panes: Int) {
        let wide = size.width >= 600
        base = ["app": "blob", "panes": panes, "width": wide ? "regular" : "compact"]
    }
}
