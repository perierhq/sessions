// swift-tools-version: 6.0
// Blob's pure logic: the brief's decoding and state rules, the glossary
// correction and history's exchanges. Foundation only, no UIKit or SwiftUI,
// so `swift test` here runs in seconds without a simulator or the app.
// The Blob and BlobMac targets depend on it (project.yml).
import PackageDescription

let package = Package(
    name: "BlobCore",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "BlobCore", targets: ["BlobCore"]),
    ],
    targets: [
        .target(name: "BlobCore"),
        .testTarget(name: "BlobCoreTests", dependencies: ["BlobCore"], exclude: ["Fixtures"]),
    ]
)
