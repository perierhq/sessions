import Foundation

/// Where the diagram renderer's page lives.
///
/// mermaid ships in the app: `Resources/mermaid/` holds the library's prebuilt
/// browser bundle and the `host.html` that drives it, both copied into the
/// bundle by both targets. Shipping it rather than fetching it means diagrams
/// draw offline, on the first launch, against any server — at the cost of
/// 5.5MB of app and a copy to refresh when mermaid is upgraded (see the README
/// next to the resource).
enum MermaidHostPage {
    /// The local page to load, or nil if the resource is missing — in which
    /// case every fence stays plain code, which is the same thing the web does
    /// with source it can't draw.
    static let url: URL? = Bundle.main.url(
        forResource: "host",
        withExtension: "html"
    )

    /// What the web view needs read access to: the page and the bundle beside
    /// it, so `<script src="mermaid.min.js">` resolves.
    static var readAccess: URL? { url?.deletingLastPathComponent() }
}
