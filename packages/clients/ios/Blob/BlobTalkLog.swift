import Foundation
import os

/// A log category for talking to Blob: each line goes to the unified log
/// (Console, `log stream`) and to `BlobTalkFile` on the device, so a turn
/// that went wrong can be read back later from a phone that wasn't
/// attached. Lines carry ids, counts, reasons and times only, never what was
/// said, the same privacy as `BlobMetrics`.
struct BlobLog: @unchecked Sendable {
    private let logger: Logger
    private let category: String

    init(category: String) {
        logger = Logger(subsystem: "pl.sessions.blob", category: category)
        self.category = category
    }

    func info(_ message: String) {
        logger.info("\(message, privacy: .public)")
        BlobTalkFile.append("\(category) \(message)")
    }

    func error(_ message: String) {
        logger.error("\(message, privacy: .public)")
        BlobTalkFile.append("\(category) error \(message)")
    }
}

/// `Library/Caches/blob-talk.log`: the newest Blob talk log lines, at most
/// about 200 KB. Written on its own queue, never on the main thread. Copy
/// it off a phone with `xcrun devicectl device copy from` (see the README).
enum BlobTalkFile {
    static let maxBytes = 200 * 1024
    /// What is kept when the file passes `maxBytes`: the newest lines.
    static let keptBytes = 150 * 1024

    private static let queue = DispatchQueue(label: "pl.sessions.blob.talk-log", qos: .utility)

    static var url: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return caches.appendingPathComponent("blob-talk.log")
    }

    static func append(_ line: String) {
        let stamp = Date().formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        let data = Data("\(stamp) \(line)\n".utf8)
        queue.async { write(data) }
    }

    private static func write(_ data: Data) {
        let url = url
        let manager = FileManager.default
        if !manager.fileExists(atPath: url.path) {
            try? manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            manager.createFile(atPath: url.path, contents: nil)
        }
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        let size = (try? handle.seekToEnd()) ?? 0
        try? handle.write(contentsOf: data)
        try? handle.close()
        if Int(size) + data.count > maxBytes { trim(url) }
    }

    /// Keeps the newest `keptBytes`, from the first whole line.
    private static func trim(_ url: URL) {
        guard let all = try? Data(contentsOf: url), all.count > keptBytes else { return }
        var tail = all.suffix(keptBytes)
        if let newline = tail.firstIndex(of: UInt8(ascii: "\n")) { tail = tail[tail.index(after: newline)...] }
        try? Data(tail).write(to: url, options: .atomic)
    }
}
