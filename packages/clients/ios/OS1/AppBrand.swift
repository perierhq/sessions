/// The product's own branding, as the app shows it to a person.
///
/// The one place the app reads the product name from, so rebranding a fork is
/// a single edit rather than a hunt through view code. The web UI's
/// equivalent is `src/frontend/lib/brand.ts`, which hydrates from the server's
/// `branding.productName`. The app has no such bootstrap yet, so this is a
/// build-time constant; if one is added later, hydrate from it and keep the
/// value below as the fallback.
///
/// Not to be confused with `Brand` in `Views/BrandLogos.swift`, which is the
/// marks and colors of THIRD-PARTY services on the Connections screen.
///
/// The Home Screen, Dock and app menu labels do NOT come from here. Those are
/// `INFOPLIST_KEY_CFBundleDisplayName` and `PRODUCT_NAME` in `project.yml`, and
/// have to be kept in step with `appName` below by hand.
enum AppBrand {
    /// The full wordmark, as it appears in prose the app shows a person, and on
    /// the App Store record.
    static let productName = "Open Session"

    /// The app's label, as the SYSTEM shows it: Home Screen, Dock, app menu,
    /// Spotlight, Siri, Shortcuts, and the Settings and privacy screens that
    /// list installed apps.
    ///
    /// Use this, not `productName`, whenever a sentence points a person at a
    /// place outside the app ("turn it on for OS in Settings"): what they will
    /// be reading there is this label. Prose about the product itself keeps the
    /// full name.
    ///
    /// The Blob app compiles this same code with the `BLOB` condition (see
    /// project.yml) and carries its own label.
    #if BLOB
    static let appName = "Blob"
    #else
    static let appName = "OS"
    #endif
}
