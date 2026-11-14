import Foundation

/// The rules of the morning brief (server: supervisor-brief.ts), without the
/// network, the clock or the timers: which page Blob holds, which of its
/// decisions are still open, what a fresh read of the brief or the items
/// does to it, and when it goes. `BlobBrief` in the app owns one, does the
/// reads and the answers, and reports what happened here.
///
/// The page Blob holds is the brief, the items raised after a seen brief
/// ("one new thing since this morning"), or one item a `blob://item/<id>`
/// link named. Each decision closes on its own: answered or dismissed here,
/// it leaves `open` at once, and its note (what Blob says in its place)
/// stays until `noteExpired`. A page whose decisions were all there was goes
/// once they are closed and their notes have gone.
public struct BlobBriefState: Sendable {
    public typealias Item = SupervisorItem

    /// What the server says about the brief.
    public enum Phase: Equatable, Sendable {
        case none, preparing, ready

        /// The response's `state`; anything unknown is `none`.
        public init(state: String) {
            self = switch state {
            case "preparing": .preparing
            case "ready": .ready
            default: .none
            }
        }

        /// When to read again: every minute, or every 10 seconds while the
        /// brief is being written. The socket's ready event usually comes
        /// first. (`refreshAt` is when the owner may ask for a fresh brief,
        /// not a poll time.)
        public var pollDelay: Duration {
            self == .preparing ? .seconds(10) : .seconds(60)
        }
    }

    /// What Blob holds on the page: the brief, or what came in after it.
    public struct Page: Equatable, Sendable {
        public enum Kind: Equatable, Sendable { case brief, newSince, linked }
        public let kind: Kind
        /// Changes when another brief or set of items takes the page.
        public let key: String
        /// What Blob says when the page comes up.
        public let say: String
        /// The decisions, the recommended option first in each.
        public var decisions: [Item]
        /// What the brief handled, one line each.
        public let handled: [String]
        /// Open needs-you items the brief left for later.
        public let later: Int
        /// The brief's day, for marking it seen.
        public let day: String?
        /// The new items' ids, so they are offered once.
        public let offered: [String]
        /// Items raised after the brief that reopening it put under its
        /// own decisions (`reopen`), kept when the brief is read again.
        public var since: Set<String>
        /// The board revision that shows the brief (`SupervisorBrief`).
        public var boardRevision: Int?

        public init(
            kind: Kind, key: String, say: String, decisions: [Item], handled: [String] = [],
            later: Int = 0, day: String? = nil, offered: [String] = [], since: Set<String> = [],
            boardRevision: Int? = nil
        ) {
            self.kind = kind; self.key = key; self.say = say; self.decisions = decisions
            self.handled = handled; self.later = later; self.day = day; self.offered = offered
            self.since = since; self.boardRevision = boardRevision
        }

        /// Whether Blob shows this page on `board` instead of its decision
        /// cards: a brief the supervisor drew (it names a board revision, or
        /// the board changed on `today`, the owner's local day), on a board
        /// that holds anything. An empty board, or any other page, keeps the
        /// cards. The spoken line plays either way.
        public func drawn(on board: BoardSnapshot?, today: String, calendar: Calendar = .current) -> Bool {
            guard kind == .brief, let board, !board.isEmpty else { return false }
            if boardRevision != nil { return true }
            guard board.updatedAt > 0 else { return false }
            return BlobBriefState.day(of: Date(timeIntervalSince1970: board.updatedAt / 1000), in: calendar) == today
        }
    }

    /// What the app reads next after `apply`.
    public enum FollowUp: Equatable, Sendable {
        case none
        /// The held page isn't the brief's: read the items again and pass
        /// them to `reread`.
        case reread(Page)
        /// The held page is a reopened brief with items raised since, which
        /// the brief doesn't carry: read the items again and pass them to
        /// `reread` with `only: page.since`, so one answered elsewhere goes.
        case rereadSince(Page)
        /// A seen brief and new item ids not offered yet: read the open
        /// needs-you items and pass them to `offerNew`.
        case offerNew(ids: [String], briefDay: String)
    }

    /// How an answer or a dismissal failed.
    public enum Failure: Equatable, Sendable {
        /// 409 `changed`: the item was rewritten after it was read.
        case changed
        /// Closed somewhere else, or gone.
        case alreadyClosed
        case other

        public init(serverMessage: String?, httpStatus: Int?) {
            if serverMessage == "changed" {
                self = .changed
            } else if serverMessage == "already closed" || serverMessage == "not found"
                || httpStatus == 404 || httpStatus == 409 {
                self = .alreadyClosed
            } else {
                self = .other
            }
        }
    }

    public private(set) var phase: Phase = .none
    /// The page, while Blob holds one. Nil is idle.
    public private(set) var page: Page?
    /// Open items the latest brief left for later.
    public private(set) var laterWaiting = 0
    /// The latest brief is written and the owner hasn't seen it.
    public private(set) var unseen = false
    /// When the running brief turn started, for its one spoken line.
    public private(set) var preparingSince: Double?
    /// What Blob says in place of a decision, by item id.
    public private(set) var notes: [String: String] = [:]
    /// The quiet line on the idle home that opens the brief again, in the
    /// server's copy (`reopen`). Nil when there is none.
    public private(set) var reopenLine: String?
    /// The latest brief and the items raised since, for `reopen`.
    private var latest: SupervisorBrief?
    /// Open needs-you items raised after the latest brief, newest first.
    public private(set) var latestSince: [String] = []

    /// Answered or dismissed here and maybe not yet gone on the server.
    private var closed: Set<String> = []
    /// Briefs (`key`) put away here, so a read before the server's seen
    /// mark lands doesn't bring one back.
    private var putAway: Set<String> = []
    /// Pages and preparing runs Blob has said, so each is said once.
    private var spoken: Set<String> = []
    /// Items whose revision changed while Blob showed them.
    private var revised: Set<String> = []
    /// The page a linked item covered (a decision tapped on the board),
    /// back once the item is done or put away.
    private var behind: Page?

    public init() {}

    /// Decisions on the page still open here.
    public var open: [Item] { page?.decisions.filter { !closed.contains($0.id) } ?? [] }

    /// Nothing is put away or closed yet: the demo shows its brief again.
    public var untouched: Bool { putAway.isEmpty && closed.isEmpty }

    /// For the Mac menu bar: "Brief ready", "2 decisions", or nil.
    public var menuLine: String? {
        let open = open
        if let page, !open.isEmpty {
            if page.kind == .brief { return open.count == 1 ? "1 decision" : "\(open.count) decisions" }
            return open.count == 1 ? "1 new thing" : "\(open.count) new things"
        }
        return unseen || page?.kind == .brief ? "Brief ready" : nil
    }

    // MARK: Reads

    /// Takes a read of the brief. `offered`: new items already offered, so
    /// each comes up once. The page Blob holds keeps its decisions current:
    /// a rewritten item shows its new revision, one settled elsewhere goes.
    public mutating func apply(_ response: SupervisorBriefResponse, offered: Set<String>) -> FollowUp {
        phase = Phase(state: response.state)
        preparingSince = phase == .preparing ? response.preparingSince ?? 0 : nil
        let brief = response.brief
        laterWaiting = brief?.laterCount ?? 0
        reopenLine = response.reopenLine
        latest = brief
        latestSince = response.newSince
        unseen = phase == .ready && brief.map { $0.seenAt == nil && !putAway.contains($0.key) } ?? false

        if var held = page {
            if held.kind == .brief, let brief, brief.key == held.key {
                // What reopening put under the brief rides along: the
                // brief doesn't carry it, so those items are read again.
                let since = held.decisions.filter { held.since.contains($0.id) }
                let fresh = Self.decisions(brief) + since
                noteRevisions(fresh, against: held.decisions)
                held.decisions = fresh
                held.boardRevision = brief.boardRevision
                page = held
                settleIfDone()
                return !since.isEmpty && page?.key == held.key ? .rereadSince(held) : .none
            }
            // Another brief was written while this page was up, and not seen yet.
            if let brief, unseen, brief.key != held.key {
                behind = nil
                page = Self.page(for: brief)
                return .none
            }
            // What came in since, a linked item, or an earlier brief: the
            // brief doesn't carry these, so the items are read again.
            return .reread(held)
        }

        if phase == .ready, let brief, unseen {
            page = Self.page(for: brief)
            return .none
        }

        // A brief the owner has seen: what came in since, once.
        guard phase == .ready, let brief, brief.seenAt != nil || putAway.contains(brief.key) else { return .none }
        let fresh = response.newSince.filter { !offered.contains($0) && !closed.contains($0) }
        guard !fresh.isEmpty else { return .none }
        return .offerNew(ids: fresh, briefDay: brief.day)
    }

    /// Brings the cards on `held` up to date from the open items: each takes
    /// its item's current revision in the same place, and one settled
    /// elsewhere goes. A page of new or linked items with none left goes.
    /// `limit`: the most the server lists; a full list may have left some
    /// open items out, so a missing one stays. `only` limits it to those
    /// cards (a reopened brief's items raised since); the others are kept.
    public mutating func reread(_ held: Page, items: [Item], limit: Int, only: Set<String>? = nil) {
        guard var current = page, current.key == held.key else { return }
        let complete = items.count < limit
        let fresh: [Item] = current.decisions.compactMap { shown in
            if let only, !only.contains(shown.id) { return shown }
            guard let item = items.first(where: { $0.id == shown.id }) else { return complete ? nil : shown }
            guard item.revision != shown.revision else { return shown }
            return current.kind == .brief ? Self.recommending(shown.options.first, in: item) : item
        }
        guard fresh != current.decisions else { return }
        if fresh.isEmpty, current.kind != .brief {
            notes = [:]
            leave()
            return
        }
        noteRevisions(fresh, against: current.decisions)
        current.decisions = fresh
        page = current
        settleIfDone()
    }

    /// Offers up to three of the new `ids` that are still open in `items`,
    /// unless a page came up meanwhile. `briefDay == today` says "since
    /// this morning".
    public mutating func offerNew(_ ids: [String], items: [Item], briefDay: String, today: String) {
        guard page == nil else { return }
        let picked = ids.compactMap { id in items.first { $0.id == id && $0.isOpen } }.prefix(3)
        guard !picked.isEmpty else { return }
        let since = briefDay == today ? "since this morning" : "since your last brief"
        page = Page(
            kind: .newSince,
            key: "new:" + picked.map(\.id).joined(separator: ","),
            say: picked.count == 1 ? "One new thing \(since)." : "\(picked.count) new things \(since).",
            decisions: Array(picked),
            offered: ids
        )
    }

    // MARK: The page

    /// The page is on screen. True the first time, so Blob says it once.
    public mutating func shown(_ page: Page) -> Bool {
        guard spoken.insert(page.key).inserted else { return false }
        if page.kind == .brief { unseen = false }
        return true
    }

    /// True once per brief turn, for "Putting your brief together."
    public mutating func shouldSayPreparing() -> Bool {
        guard let preparingSince else { return false }
        return spoken.insert("preparing@\(preparingSince)").inserted
    }

    /// The owner put the page away: Blob goes idle.
    public mutating func dismissPage() {
        guard let page else { return }
        if page.kind == .brief { putAway.insert(page.key) }
        notes = [:]
        leave()
    }

    /// Whether the idle home can open the latest brief again.
    public var canReopen: Bool { page == nil && latest != nil }

    /// Opens the latest brief again, with the items raised since that are
    /// still open in `items` (the open needs-you items; nil when they
    /// couldn't be read) under its own decisions. Not said again unless it
    /// is still unseen; put away, it stays put away until now.
    public mutating func reopen(items: [Item]?) {
        guard page == nil, let brief = latest else { return }
        var reopened = Self.page(for: brief)
        let shown = Set(reopened.decisions.map(\.id))
        let since = latestSince.compactMap { id in
            items?.first { $0.id == id && $0.isOpen && !shown.contains(id) && !closed.contains(id) }
        }
        reopened.decisions += since
        reopened.since = Set(since.map(\.id))
        putAway.remove(brief.key)
        if !unseen { spoken.insert(reopened.key) }
        page = reopened
    }

    /// Whether `id` is an open decision on the page.
    public func shows(id: String) -> Bool {
        page?.decisions.contains { $0.id == id } == true && !closed.contains(id)
    }

    /// Shows the one item a link named, or a decision tapped on the board.
    /// The page it covers (the brief) comes back once the item is done.
    public mutating func focus(_ item: Item) {
        closed.remove(item.id)
        if let page, page.kind != .linked { behind = page }
        page = Page(kind: .linked, key: "item:\(item.cardKey)", say: "", decisions: [item])
    }

    public func isRevised(_ item: Item) -> Bool { revised.contains(item.id) }

    // MARK: Answers

    /// The decision is done: it closes now, and `line` stands in its place
    /// until `noteExpired`.
    public mutating func close(_ item: Item, saying line: String) {
        closed.insert(item.id)
        notes[item.id] = line
    }

    /// What Blob says in place of one decision, which stays open.
    public mutating func say(_ line: String, about item: Item) {
        notes[item.id] = line
    }

    /// Dismissed here: it closes at once, with no note.
    public mutating func dismissed(_ item: Item) {
        closed.insert(item.id)
        settleIfDone()
    }

    /// The dismissal didn't reach the server: the decision is back.
    public mutating func dismissFailed(_ item: Item, saying line: String) {
        closed.remove(item.id)
        notes[item.id] = line
    }

    /// A decision's note has gone; with no decision left, the page goes.
    public mutating func noteExpired(_ id: String) {
        notes[id] = nil
        settleIfDone()
    }

    // MARK: Rules

    private mutating func noteRevisions(_ fresh: [Item], against known: [Item]) {
        for item in fresh where known.contains(where: { $0.id == item.id && $0.revision != item.revision }) {
            revised.insert(item.id)
        }
    }

    /// A page whose decisions were all there was goes once they are done. A
    /// brief with nothing to decide stays until the owner puts it away.
    private mutating func settleIfDone() {
        guard let page, !page.decisions.isEmpty, open.isEmpty, notes.isEmpty else { return }
        if page.kind == .brief { putAway.insert(page.key) }
        leave()
    }

    /// The page goes: a linked item gives the page it covered back, which
    /// goes too when its decisions were all there was and are done.
    private mutating func leave() {
        let wasLinked = page?.kind == .linked
        page = wasLinked ? behind : nil
        behind = nil
        if wasLinked, page != nil { settleIfDone() }
    }

    public static func page(for brief: SupervisorBrief) -> Page {
        Page(
            kind: .brief,
            key: brief.key,
            say: brief.say,
            decisions: decisions(brief),
            handled: brief.handled,
            later: brief.laterCount,
            day: brief.day,
            boardRevision: brief.boardRevision
        )
    }

    /// The brief's open decisions, each with its recommended option first.
    public static func decisions(_ brief: SupervisorBrief) -> [Item] {
        brief.decisions.filter { $0.item.isOpen }.map { recommending($0.recommended, in: $0.item) }
    }

    /// The item with `option` moved to the front, where the decision view
    /// puts the recommended one.
    public static func recommending(_ option: String?, in item: Item) -> Item {
        guard let option, let index = item.options.firstIndex(of: option), index > 0 else { return item }
        var options = item.options
        options.insert(options.remove(at: index), at: 0)
        return Item(
            id: item.id, kind: item.kind, title: item.title, body: item.body, options: options,
            project: item.project, source: item.source, urgency: item.urgency, state: item.state,
            createdAt: item.createdAt, revision: item.revision, act: item.act
        )
    }

    /// `date`'s day in `calendar`, as the server writes a brief's day.
    public static func day(of date: Date, in calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
}
