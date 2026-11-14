import Foundation

/// Something the supervisor raised for its owner (server:
/// supervisor-inbox.ts). `needs-you` items wait for an answer; `fyi` ones
/// go into the daily digest. Decoded tolerantly: a field the server adds
/// or drops never loses the item, and an item without an id or a title is
/// skipped by `SupervisorItemList`.
public struct SupervisorItem: Decodable, Sendable, Identifiable, Equatable {
    public let id: String
    /// `needs-you` or `fyi`.
    public let kind: String
    public let title: String
    /// Markdown; may hold the fenced blocks of docs/blocks.md.
    public let body: String
    /// Numbered choices; the first is the recommended one.
    public let options: [String]
    public let project: String?
    /// Who raised it, e.g. `lead:betterbahn` or `supervisor`.
    public let source: String?
    /// `down` when something is fully down; otherwise `normal` or nil.
    public let urgency: String?
    /// `open`, `answered`, `dismissed` or `expired`.
    public let state: String
    /// Milliseconds since the epoch.
    public let createdAt: Double?
    /// The item's revision as this copy shows it (its `updatedAt`). An
    /// answer names it, so an approval binds to exactly what was shown;
    /// nil from a server that sends neither.
    public let revision: Int64?
    /// What approving runs, from the server's record of the proposal,
    /// never from the body.
    public let act: SupervisorItemAct?

    public var needsYou: Bool { kind == "needs-you" }
    public var isOpen: Bool { state == "open" }
    public var created: Date? { createdAt.map { Date(timeIntervalSince1970: $0 / 1000) } }

    /// This card as shown: the item at this revision. A re-raised item
    /// (same id, new revision) is a new card.
    public var cardKey: String { "\(id)@\(revision.map(String.init) ?? "")" }

    /// The body without the server's own lines for the steps when the
    /// steps section is drawn (`act` with steps): exactly the ending the
    /// server names, else the whole body.
    public var shownBody: String {
        guard let act, !act.steps.isEmpty,
              let suffix = act.bodySuffix, !suffix.isEmpty
        else { return body }
        let tail = Array(suffix.utf8)
        guard body.utf8.count > tail.count, body.utf8.suffix(tail.count).elementsEqual(tail)
        else { return body }
        return String(decoding: body.utf8.dropLast(tail.count), as: UTF8.self)
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, title, body, options, project, source, urgency, state, createdAt
        case updatedAt, revision, act
    }

    public init(
        id: String, kind: String, title: String, body: String = "", options: [String] = [],
        project: String? = nil, source: String? = nil, urgency: String? = nil,
        state: String = "open", createdAt: Double? = nil, revision: Int64? = nil,
        act: SupervisorItemAct? = nil
    ) {
        self.id = id; self.kind = kind; self.title = title; self.body = body
        self.options = options; self.project = project; self.source = source
        self.urgency = urgency; self.state = state; self.createdAt = createdAt
        self.revision = revision; self.act = act
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "fyi"
        body = ((try? c.decodeIfPresent(String.self, forKey: .body)) ?? nil) ?? ""
        options = (((try? c.decodeIfPresent([String?].self, forKey: .options)) ?? nil) ?? [])
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        project = (try? c.decodeIfPresent(String.self, forKey: .project)) ?? nil
        source = (try? c.decodeIfPresent(String.self, forKey: .source)) ?? nil
        urgency = (try? c.decodeIfPresent(String.self, forKey: .urgency)) ?? nil
        state = ((try? c.decodeIfPresent(String.self, forKey: .state)) ?? nil) ?? "open"
        createdAt = (try? c.decodeIfPresent(Double.self, forKey: .createdAt)) ?? nil
        let revision = ((try? c.decodeIfPresent(Double.self, forKey: .revision)) ?? nil)
            ?? ((try? c.decodeIfPresent(Double.self, forKey: .updatedAt)) ?? nil)
        self.revision = revision.flatMap { $0 >= 0 && $0 == $0.rounded() ? Int64(exactly: $0) : nil }
        act = (try? c.decodeIfPresent(SupervisorItemAct.self, forKey: .act)) ?? nil
    }
}

/// What approving a lead's item runs, as the server recorded it
/// (server: leads/item-acts.ts): each step in fixed copy, what the
/// approval waits for, when it expires and where it stands.
public struct SupervisorItemAct: Decodable, Sendable, Equatable {
    /// Each step in the server's fixed copy. A worker's step continues
    /// with its prompt on the following lines, fenced.
    public let steps: [String]
    /// "PR #556 in acme/app is merged"; nil when it runs at once.
    public let runsWhen: String?
    /// Milliseconds since the epoch.
    public let expiresAt: Double?
    /// `proposed`, then the approval's `waiting`, `ready`, `applying`,
    /// `applied`, `failed` or `partial`.
    public let state: String
    /// The state in the server's words once approved: "Ready to apply".
    /// Blob shows only open items, so it never draws this; decoded for
    /// clients that show approved ones.
    public let stateLine: String?
    /// The server's lines the body ends with, for `shownBody`.
    public let bodySuffix: String?

    public var expires: Date? { expiresAt.map { Date(timeIntervalSince1970: $0 / 1000) } }

    private enum CodingKeys: String, CodingKey {
        case steps, runsWhen, expiresAt, state, stateLine, bodySuffix
    }

    public init(
        steps: [String], runsWhen: String? = nil, expiresAt: Double? = nil,
        state: String = "proposed", stateLine: String? = nil, bodySuffix: String? = nil
    ) {
        self.steps = steps; self.runsWhen = runsWhen; self.expiresAt = expiresAt
        self.state = state; self.stateLine = stateLine; self.bodySuffix = bodySuffix
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        steps = (((try? c.decodeIfPresent([String?].self, forKey: .steps)) ?? nil) ?? [])
            .compactMap { $0 }
            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        runsWhen = (try? c.decodeIfPresent(String.self, forKey: .runsWhen)) ?? nil
        expiresAt = (try? c.decodeIfPresent(Double.self, forKey: .expiresAt)) ?? nil
        state = ((try? c.decodeIfPresent(String.self, forKey: .state)) ?? nil) ?? "proposed"
        stateLine = (try? c.decodeIfPresent(String.self, forKey: .stateLine)) ?? nil
        bodySuffix = (try? c.decodeIfPresent(String.self, forKey: .bodySuffix)) ?? nil
    }
}

public struct SupervisorItemList: Decodable, Sendable {
    public let items: [SupervisorItem]

    private enum CodingKeys: String, CodingKey { case items }
    private struct Lossy: Decodable {
        let item: SupervisorItem?
        init(from decoder: Decoder) throws { item = try? SupervisorItem(from: decoder) }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = (((try? c.decodeIfPresent([Lossy].self, forKey: .items)) ?? nil) ?? [])
            .compactMap(\.item)
    }
}

/// The morning brief (server: supervisor-brief.ts): what the supervisor
/// says when its owner opens Blob, the decisions it picked (at most
/// three, each with the item as the items route returns it), what it
/// handled, and how much can wait. Decoded tolerantly like the items.
public struct SupervisorBriefResponse: Decodable, Sendable, Equatable {
    /// `ready`, `preparing` or `none`.
    public let state: String
    public let brief: SupervisorBrief?
    /// Open needs-you items raised after the brief, newest first.
    public let newSince: [String]
    /// When the running brief turn started, ms.
    public let preparingSince: Double?
    /// When the owner may ask for a fresh brief, ms.
    public let refreshAt: Double?
    /// The quiet line that opens the brief again once it was seen or put
    /// away, in the server's copy ("This morning: 2 decisions waiting",
    /// "Today\u{2019}s brief"). Nil when there is none or on older servers.
    public let reopenLine: String?

    private enum CodingKeys: String, CodingKey { case state, brief, newSince, preparingSince, refreshAt, reopen }
    private struct Ids: Decodable { let itemIds: [String]? }
    /// `reopen` is `{ line }` (or null); a bare string is taken too.
    private struct Reopen: Decodable {
        let line: String?
        private enum Keys: String, CodingKey { case line }
        init(from decoder: Decoder) throws {
            if let line = try? decoder.singleValueContainer().decode(String.self) {
                self.line = line
            } else {
                line = (try? decoder.container(keyedBy: Keys.self).decodeIfPresent(String.self, forKey: .line)) ?? nil
            }
        }
    }

    public init(
        state: String, brief: SupervisorBrief?, newSince: [String] = [], preparingSince: Double? = nil,
        refreshAt: Double? = nil, reopenLine: String? = nil
    ) {
        self.state = state; self.brief = brief; self.newSince = newSince
        self.preparingSince = preparingSince; self.refreshAt = refreshAt
        self.reopenLine = reopenLine
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = ((try? c.decodeIfPresent(String.self, forKey: .state)) ?? nil) ?? "none"
        brief = (try? c.decodeIfPresent(SupervisorBrief.self, forKey: .brief)) ?? nil
        newSince = (((try? c.decodeIfPresent(Ids.self, forKey: .newSince)) ?? nil)?.itemIds) ?? []
        preparingSince = (try? c.decodeIfPresent(Double.self, forKey: .preparingSince)) ?? nil
        refreshAt = (try? c.decodeIfPresent(Double.self, forKey: .refreshAt)) ?? nil
        reopenLine = (((try? c.decodeIfPresent(Reopen.self, forKey: .reopen)) ?? nil)?.line)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .flatMap { $0.isEmpty ? nil : $0 }
    }
}

public struct SupervisorBrief: Decodable, Sendable, Equatable {
    /// The owner's local day it was written for, `YYYY-MM-DD`.
    public let day: String
    /// When it was written, ms.
    public let asOf: Double
    /// What Blob says, written for the ear.
    public let say: String
    /// When the owner saw it, ms; nil while unseen.
    public let seenAt: Double?
    /// What it closed or did, one line each.
    public let handled: [String]
    /// Still open decisions, most important first.
    public let decisions: [Decision]
    /// Open needs-you items it left for later.
    public let laterCount: Int
    /// The board revision that shows the brief; nil when the turn drew
    /// nothing (or from an older server), and Blob shows the decision cards.
    public let boardRevision: Int?

    public struct Decision: Decodable, Sendable, Equatable {
        public let item: SupervisorItem
        /// One of the item's options.
        public let recommended: String?

        public init(item: SupervisorItem, recommended: String?) {
            self.item = item
            self.recommended = recommended
        }
    }

    /// The brief as one card: its unique write.
    public var key: String { "\(day)@\(Int64(asOf))" }

    private enum CodingKeys: String, CodingKey { case day, asOf, say, seenAt, handled, decisions, later, boardRevision }
    private struct Line: Decodable { let line: String? }
    private struct Later: Decodable { let count: Int? }
    private struct LossyDecision: Decodable {
        let decision: Decision?
        private enum Keys: String, CodingKey { case item, recommended }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            guard let item = try? c.decode(SupervisorItem.self, forKey: .item) else { decision = nil; return }
            decision = Decision(item: item, recommended: (try? c.decodeIfPresent(String.self, forKey: .recommended)) ?? nil)
        }
    }

    public init(
        day: String, asOf: Double, say: String, seenAt: Double? = nil, handled: [String] = [],
        decisions: [Decision] = [], laterCount: Int = 0, boardRevision: Int? = nil
    ) {
        self.day = day; self.asOf = asOf; self.say = say; self.seenAt = seenAt
        self.handled = handled; self.decisions = decisions; self.laterCount = laterCount
        self.boardRevision = boardRevision
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        day = ((try? c.decodeIfPresent(String.self, forKey: .day)) ?? nil) ?? ""
        asOf = ((try? c.decodeIfPresent(Double.self, forKey: .asOf)) ?? nil) ?? 0
        say = ((try? c.decodeIfPresent(String.self, forKey: .say)) ?? nil) ?? ""
        seenAt = (try? c.decodeIfPresent(Double.self, forKey: .seenAt)) ?? nil
        handled = (((try? c.decodeIfPresent([Line].self, forKey: .handled)) ?? nil) ?? [])
            .compactMap { $0.line?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        decisions = (((try? c.decodeIfPresent([LossyDecision].self, forKey: .decisions)) ?? nil) ?? [])
            .compactMap(\.decision)
        laterCount = max(0, (((try? c.decodeIfPresent(Later.self, forKey: .later)) ?? nil)?.count) ?? 0)
        // A whole revision of at least 1; anything else is no board.
        let revision = (try? c.decodeIfPresent(Double.self, forKey: .boardRevision)) ?? nil
        boardRevision = revision.flatMap { $0 >= 1 && $0 == $0.rounded() && $0 < 1e15 ? Int($0) : nil }
    }
}
