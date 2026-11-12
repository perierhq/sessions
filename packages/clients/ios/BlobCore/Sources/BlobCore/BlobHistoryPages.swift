import Foundation

/// One page of Blob's history across supervisor sessions, the current one
/// and those before each rotation (server: supervisor-history.ts, `GET
/// /api/supervisor/history?before=<cursor>`). Decoded tolerantly: an
/// exchange without an id or what was said is skipped.
public struct SupervisorHistoryPage: Decodable, Sendable, Equatable {
    public struct Exchange: Decodable, Sendable, Equatable {
        /// The owner's first message in it.
        public let id: String
        public let sessionId: String
        public let said: String
        /// Every owner row joined into `said`, `id` first. Nil from servers
        /// that predate it.
        public let saidIds: [String]?
        public let reply: String?
        /// ms.
        public let at: Double?

        private enum CodingKeys: String, CodingKey { case id, sessionId, said, saidIds, reply, at }

        public init(
            id: String, sessionId: String = "", said: String, saidIds: [String]? = nil,
            reply: String? = nil, at: Double? = nil
        ) {
            self.id = id; self.sessionId = sessionId; self.said = said
            self.saidIds = saidIds; self.reply = reply; self.at = at
        }

        /// Shown across two panes when any owner row joined into it was,
        /// as `BlobExchange.exchanges(in:)` decides for the live transcript.
        public func split(shownBeside: Set<String>) -> Bool {
            (saidIds ?? [id]).contains { shownBeside.contains($0) }
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            said = try c.decode(String.self, forKey: .said)
            sessionId = ((try? c.decodeIfPresent(String.self, forKey: .sessionId)) ?? nil) ?? ""
            saidIds = ((try? c.decodeIfPresent([String].self, forKey: .saidIds)) ?? nil).flatMap { $0.isEmpty ? nil : $0 }
            reply = (try? c.decodeIfPresent(String.self, forKey: .reply)) ?? nil
            at = (try? c.decodeIfPresent(Double.self, forKey: .at)) ?? nil
        }
    }

    /// Oldest first.
    public let exchanges: [Exchange]
    /// For the page before this one; nil at the start of history.
    public let before: String?

    private enum CodingKeys: String, CodingKey { case exchanges, before }
    private struct Lossy: Decodable {
        let exchange: Exchange?
        init(from decoder: Decoder) throws { exchange = try? Exchange(from: decoder) }
    }

    public init(exchanges: [Exchange], before: String?) {
        self.exchanges = exchanges
        self.before = before
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        exchanges = (((try? c.decodeIfPresent([Lossy].self, forKey: .exchanges)) ?? nil) ?? [])
            .compactMap(\.exchange)
        before = ((try? c.decodeIfPresent(String.self, forKey: .before)) ?? nil).flatMap { $0.isEmpty ? nil : $0 }
    }
}

/// The history pages read so far, oldest first. Each read is the page
/// before the ones held, so it goes above them; an exchange already held
/// (pages can overlap while the supervisor is talking) is kept once, where
/// it was first read.
public struct BlobHistoryPages: Sendable, Equatable {
    public private(set) var exchanges: [SupervisorHistoryPage.Exchange] = []
    /// The next page's cursor; nil before the first page and at the start.
    public private(set) var cursor: String?
    /// The server said there is nothing before the oldest page.
    public private(set) var ended = false

    public init() {}

    public var isEmpty: Bool { exchanges.isEmpty }

    /// Takes the page read with `cursor`: above what is held, without
    /// duplicates, and its own cursor is the next one.
    public mutating func add(_ page: SupervisorHistoryPage) {
        var known = Set(exchanges.map(\.id))
        let older = page.exchanges.filter { known.insert($0.id).inserted }
        exchanges = older + exchanges
        cursor = page.before
        ended = page.before == nil
    }

    /// What history draws above the live transcript's exchanges: the pages,
    /// without those the live transcript holds (`live`), since it draws
    /// them. `shownBeside`: messages whose exchange was shown across two
    /// panes.
    public func past(excluding live: Set<String>, shownBeside: Set<String>) -> [BlobExchange] {
        exchanges.filter { !live.contains($0.id) }.map { BlobExchange(past: $0, shownBeside: shownBeside) }
    }
}

extension BlobExchange {
    /// An exchange from a server history page, which groups it the same
    /// way as `exchanges(in:)`; split when any of its rows was shown
    /// across two panes.
    public init(past: SupervisorHistoryPage.Exchange, shownBeside: Set<String>) {
        self.init(
            id: past.id,
            said: past.said,
            reply: past.reply,
            date: past.at.map { Date(timeIntervalSince1970: $0 / 1000) },
            split: past.split(shownBeside: shownBeside)
        )
    }
}
