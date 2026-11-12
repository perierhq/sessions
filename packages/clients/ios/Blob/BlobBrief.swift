import Foundation
import Observation

/// The morning brief (server: supervisor-brief.ts), in place of a queue of
/// cards. Once a day the supervisor goes through its owner's open items,
/// closes what is stale, does what it may, and picks at most three
/// decisions. Opening Blob with an unseen brief, Blob says it and shows
/// those decisions on one page, with one quiet line for what it handled and
/// what can wait. Answering or dismissing them all leaves Blob idle.
///
/// Later in the day, items raised after a brief the owner has seen come up
/// once as "one new thing since this morning". A `blob://item/<id>` link
/// shows that one item the same way.
///
/// Answers still go through the item API with the item's revision, so an
/// approval binds to exactly what was on screen.
@MainActor
@Observable
final class BlobBrief {
    typealias Item = OS1API.SupervisorItem

    /// What the server says about the brief.
    enum Phase: Equatable { case none, preparing, ready }

    /// What Blob holds on the page: the brief, or what came in after it.
    struct Page: Equatable {
        enum Kind: Equatable { case brief, newSince, linked }
        let kind: Kind
        /// Changes when another brief or set of items takes the page.
        let key: String
        /// What Blob says when the page comes up.
        let say: String
        /// The decisions, the recommended option first in each.
        var decisions: [Item]
        /// What the brief handled, one line each.
        let handled: [String]
        /// Open needs-you items the brief left for later.
        let later: Int
        /// The brief's day, for marking it seen.
        let day: String?
        /// The new items' ids, so they are offered once.
        let offered: [String]
    }

    private(set) var phase: Phase = .none
    /// The page, while Blob holds one. Nil is idle.
    private(set) var page: Page?
    /// Open items the latest brief left for later; "What can wait?" is only
    /// offered when there are some.
    private(set) var laterWaiting = 0
    /// The latest brief is written and the owner hasn't seen it.
    private(set) var unseen = false
    /// When the running brief turn started, for its one spoken line.
    private(set) var preparingSince: Double?
    /// An answer on its way, so the options can't be sent twice.
    private(set) var sending: String?
    /// What Blob says about a decision after an answer, in its place, by
    /// item id. Each goes after a moment on its own.
    private(set) var notes: [String: String] = [:]
    private var noteTasks: [String: Task<Void, Never>] = [:]
    /// Answers sent from here, for the success haptic.
    private(set) var answered = 0

    /// The one task that reads the brief: the poll loop while Blob is in
    /// front, or a single read. A newer read replaces it.
    private var pollTask: Task<Void, Never>?
    private var polling = false
    /// Counts reads; only the newest one's answer is applied.
    private var generation = 0

    static let log = BlobLog(category: "brief")

    /// Answered or dismissed here and maybe not yet gone on the server.
    private var closed: Set<String> = []
    /// Briefs (`key`) put away here, so a poll before the server's seen mark
    /// lands doesn't bring one back.
    private var putAway: Set<String> = []
    /// Pages and preparing runs Blob has said, so each is said once.
    private var spoken: Set<String> = []
    /// Items whose revision changed while Blob showed them, so their new
    /// card holds its options for a moment (`BlobDecisionView`).
    private var revised: Set<String> = []

    /// New items already offered, across launches.
    private static let offeredKey = "blob.brief.offered"
    private var offered: Set<String> {
        get {
            #if DEBUG
            if Self.demo != nil { return demoOffered }
            #endif
            return Set(UserDefaults.standard.stringArray(forKey: Self.offeredKey) ?? [])
        }
        set {
            #if DEBUG
            if Self.demo != nil { demoOffered = newValue; return }
            #endif
            UserDefaults.standard.set(Array(newValue.suffix(200)), forKey: Self.offeredKey)
        }
    }
    /// The demo offers its new item on every launch.
    private var demoOffered: Set<String> = []

    /// Decisions on the page still open here.
    var open: [Item] { page?.decisions.filter { !closed.contains($0.id) } ?? [] }

    /// For the Mac menu bar: "Brief ready", "2 decisions", or nil.
    var menuLine: String? {
        if let page, !open.isEmpty {
            if page.kind == .brief { return open.count == 1 ? "1 decision" : "\(open.count) decisions" }
            return open.count == 1 ? "1 new thing" : "\(open.count) new things"
        }
        return unseen || page?.kind == .brief ? "Brief ready" : nil
    }

    /// Blob came to the front: reads the brief, asking for a missing one,
    /// then again at each `pollDelay` until `stopPolling`.
    func startPolling() {
        polling = true
        restart(start: true)
    }

    /// Blob went to the background: no more reads.
    func stopPolling() {
        polling = false
        pollTask?.cancel()
        pollTask = nil
    }

    /// The socket said a brief was written: reads now, in place of the
    /// read in flight, and the next poll counts from here.
    func kick() { restart(start: false) }

    private func restart(start: Bool) {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            await self?.refresh(start: start)
            while !Task.isCancelled, let self, self.polling {
                try? await Task.sleep(for: self.pollDelay)
                guard !Task.isCancelled else { return }
                await self.refresh()
            }
        }
    }

    /// When to read again: every minute, or every 10 seconds while the
    /// brief is being written. The socket's ready event usually comes first.
    /// (`refreshAt` is when the owner may ask for a fresh brief, not a poll
    /// time.)
    private var pollDelay: Duration {
        phase == .preparing ? .seconds(10) : .seconds(60)
    }

    /// Reads the brief. `start`: Blob just came to the front, so a missing
    /// brief for today starts being prepared. Errors keep what is there: a
    /// blip offline should not make a waiting decision vanish. A read that
    /// a newer one overtook is dropped.
    func refresh(start: Bool = false) async {
        #if DEBUG
        if let demo = Self.demo {
            if page == nil, putAway.isEmpty, closed.isEmpty { await apply(demo, generation: generation) }
            return
        }
        #endif
        generation += 1
        let mine = generation
        guard ServerConfig.shared.isConfigured,
              let response = try? await OS1API.supervisorBrief(start: start),
              mine == generation, !Task.isCancelled
        else { return }
        await apply(response, generation: mine)
    }

    private func apply(_ response: OS1API.SupervisorBriefResponse, generation mine: Int) async {
        phase = switch response.state {
        case "preparing": .preparing
        case "ready": .ready
        default: .none
        }
        preparingSince = phase == .preparing ? response.preparingSince ?? 0 : nil
        let brief = response.brief
        laterWaiting = brief?.laterCount ?? 0
        unseen = phase == .ready && brief.map { $0.seenAt == nil && !putAway.contains($0.key) } ?? false

        // The page Blob holds keeps its decisions current: a rewritten item
        // shows its new revision, one settled elsewhere goes.
        if var held = page {
            if held.kind == .brief, let brief, brief.key == held.key {
                let fresh = Self.decisions(brief)
                noteRevisions(fresh, against: held.decisions)
                held.decisions = fresh
                page = held
                settleIfDone()
                return
            }
            // Another brief was written while this page was up, and not seen yet.
            if let brief, unseen, brief.key != held.key {
                page = Self.page(for: brief)
                return
            }
            // What came in since, a linked item, or an earlier brief: the
            // brief doesn't carry these, so the items are read again.
            await reread(held, generation: mine)
            return
        }

        if phase == .ready, let brief, unseen {
            page = Self.page(for: brief)
            return
        }

        // A brief the owner has seen: what came in since, once.
        guard phase == .ready, let brief, brief.seenAt != nil || putAway.contains(brief.key) else { return }
        let fresh = response.newSince.filter { !offered.contains($0) && !closed.contains($0) }
        guard !fresh.isEmpty else { return }
        #if DEBUG
        let items: [Item]? = Self.demo != nil ? Self.demoNew : try? await OS1API.supervisorItems(kind: "needs-you")
        #else
        let items = try? await OS1API.supervisorItems(kind: "needs-you")
        #endif
        guard mine == generation, page == nil, let items else { return }
        let picked = fresh.compactMap { id in items.first { $0.id == id && $0.isOpen } }.prefix(3)
        guard !picked.isEmpty else { return }
        let today = Self.today == brief.day
        let since = today ? "since this morning" : "since your last brief"
        page = Page(
            kind: .newSince,
            key: "new:" + picked.map(\.id).joined(separator: ","),
            say: picked.count == 1 ? "One new thing \(since)." : "\(picked.count) new things \(since).",
            decisions: Array(picked),
            handled: [],
            later: 0,
            day: nil,
            offered: fresh
        )
    }

    /// Brings the cards on a page the brief doesn't carry up to date: each
    /// takes its item's current revision in the same place, and one settled
    /// elsewhere goes. A page of new or linked items with none left goes.
    private func reread(_ held: Page, generation mine: Int) async {
        #if DEBUG
        if Self.demo != nil { return }
        #endif
        let limit = OS1API.supervisorItemsMax
        guard let items = try? await OS1API.supervisorItems(limit: limit),
              mine == generation, var current = page, current.key == held.key
        else { return }
        // A full list may have left some open items out.
        let complete = items.count < limit
        let fresh: [Item] = current.decisions.compactMap { shown in
            guard let item = items.first(where: { $0.id == shown.id }) else { return complete ? nil : shown }
            guard item.revision != shown.revision else { return shown }
            return current.kind == .brief ? Self.recommending(shown.options.first, in: item) : item
        }
        guard fresh != current.decisions else { return }
        if fresh.isEmpty, current.kind != .brief {
            withNoteCleared { self.page = nil }
            return
        }
        noteRevisions(fresh, against: current.decisions)
        current.decisions = fresh
        page = current
        settleIfDone()
    }

    private static func page(for brief: OS1API.SupervisorBrief) -> Page {
        Page(
            kind: .brief,
            key: brief.key,
            say: brief.say,
            decisions: decisions(brief),
            handled: brief.handled,
            later: brief.laterCount,
            day: brief.day,
            offered: []
        )
    }

    /// The brief's decisions, each with its recommended option first.
    private static func decisions(_ brief: OS1API.SupervisorBrief) -> [Item] {
        brief.decisions.filter { $0.item.isOpen }.map { recommending($0.recommended, in: $0.item) }
    }

    /// The item with `option` moved to the front, where the decision view
    /// puts the recommended one.
    static func recommending(_ option: String?, in item: Item) -> Item {
        guard let option, let index = item.options.firstIndex(of: option), index > 0 else { return item }
        var options = item.options
        options.insert(options.remove(at: index), at: 0)
        return Item(
            id: item.id, kind: item.kind, title: item.title, body: item.body, options: options,
            project: item.project, source: item.source, urgency: item.urgency, state: item.state,
            createdAt: item.createdAt, revision: item.revision, act: item.act
        )
    }

    /// The owner's local day, as the server writes it.
    private static var today: String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: .now)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// The page is on screen: the brief is marked seen, new items offered.
    /// True the first time, so Blob says it once.
    func shown(_ page: Page) -> Bool {
        guard spoken.insert(page.key).inserted else { return false }
        offered.formUnion(page.offered)
        if page.kind == .brief {
            unseen = false
            #if DEBUG
            if Self.demo != nil { return true }
            #endif
            guard let day = page.day, !day.isEmpty else {
                Self.log.error("seen skipped: brief \(page.key) has no day")
                return true
            }
            Task {
                do {
                    try await OS1API.markSupervisorBriefSeen(day: day)
                } catch {
                    Self.log.error("seen failed for \(day): \(error)")
                }
            }
        }
        return true
    }

    /// True once per brief turn, for "Putting your brief together."
    func shouldSayPreparing() -> Bool {
        guard let preparingSince else { return false }
        return spoken.insert("preparing@\(preparingSince)").inserted
    }

    /// The owner put the page away: Blob goes idle. What is still open
    /// stays open on the server, for when the owner asks.
    func dismiss() {
        guard let page else { return }
        if page.kind == .brief { putAway.insert(page.key) }
        withNoteCleared { self.page = nil }
    }

    /// Shows the item a `blob://item/<id>` link names, even one the brief
    /// left for later.
    func focus(id: String) async {
        if let item = page?.decisions.first(where: { $0.id == id }), !closed.contains(item.id) { return }
        #if DEBUG
        if Self.demo != nil { return }
        #endif
        guard ServerConfig.shared.isConfigured,
              let fetched = try? await OS1API.supervisorItems(limit: OS1API.supervisorItemsMax),
              let item = fetched.first(where: { $0.id == id && $0.isOpen })
        else { return }
        closed.remove(id)
        page = Page(kind: .linked, key: "item:\(item.cardKey)", say: "", decisions: [item], handled: [], later: 0, day: nil, offered: [])
    }

    func isRevised(_ item: Item) -> Bool { revised.contains(item.id) }

    private func noteRevisions(_ fresh: [Item], against known: [Item]) {
        for item in fresh where known.contains(where: { $0.id == item.id && $0.revision != item.revision }) {
            revised.insert(item.id)
        }
    }

    /// Sends the answer with the revision of the item as it is shown. An
    /// item rewritten since it was read stays open on the server: Blob says
    /// so and shows the new card. Any other failure keeps it with a reason.
    func answer(_ item: Item, with option: String) async {
        guard sending == nil else { return }
        sending = item.id
        defer { sending = nil }
        do {
            #if DEBUG
            if Self.demo != nil {
                try await Task.sleep(for: .milliseconds(400))
            } else {
                try await OS1API.answerSupervisorItem(id: item.id, answer: option, revision: item.revision)
            }
            #else
            try await OS1API.answerSupervisorItem(id: item.id, answer: option, revision: item.revision)
            #endif
            close(item, saying: "Done. I\u{2019}ll pass it on.")
            answered += 1
        } catch {
            if Self.changed(error) {
                say("This changed. Have another look.", about: item)
                await refresh()
            } else if Self.alreadyClosed(error) {
                close(item, saying: "That one was already settled.")
            } else {
                say("I couldn\u{2019}t send that. Try again in a moment.", about: item)
            }
        }
    }

    /// Closes the item on the server without an answer.
    func dismiss(_ item: Item) async {
        closed.insert(item.id)
        settleIfDone()
        #if DEBUG
        if Self.demo != nil { return }
        #endif
        do {
            try await OS1API.dismissSupervisorItem(id: item.id)
        } catch where !Self.alreadyClosed(error) {
            closed.remove(item.id)
            say("I couldn\u{2019}t dismiss that. Try again in a moment.", about: item)
        } catch {}
    }

    /// The decision is done: it closes now, and its note stands in its
    /// place for a moment. With none left, Blob goes idle.
    private func close(_ item: Item, saying line: String) {
        closed.insert(item.id)
        say(line, about: item)
    }

    /// What Blob says about one decision, in its place for a moment. Each
    /// decision's note goes on its own, so answering another one quickly
    /// leaves this one be.
    private func say(_ line: String, about item: Item) {
        let id = item.id
        noteTasks[id]?.cancel()
        notes[id] = line
        noteTasks[id] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2.4))
            guard !Task.isCancelled, let self else { return }
            self.notes[id] = nil
            self.noteTasks[id] = nil
            self.settleIfDone()
        }
    }

    /// What Blob says in place of the decision `id`, while it says it.
    func note(for id: String) -> String? { notes[id] }

    /// A page whose decisions were all there was goes once they are done. A
    /// brief with nothing to decide stays until the owner puts it away.
    private func settleIfDone() {
        guard let page, !page.decisions.isEmpty, open.isEmpty, notes.isEmpty else { return }
        if page.kind == .brief { putAway.insert(page.key) }
        self.page = nil
    }

    private func withNoteCleared(_ change: () -> Void) {
        noteTasks.values.forEach { $0.cancel() }
        noteTasks = [:]
        notes = [:]
        change()
    }

    /// The item was rewritten after it was read (409 `changed`).
    private static func changed(_ error: Error) -> Bool {
        if case .server("changed")? = error as? OS1API.APIError { return true }
        return false
    }

    private static func alreadyClosed(_ error: Error) -> Bool {
        switch error as? OS1API.APIError {
        case .server(let message): message == "already closed" || message == "not found"
        case .http(let code): code == 404 || code == 409
        default: false
        }
    }
}

#if DEBUG
extension BlobBrief {
    /// A canned brief for screenshots without a server: `BLOB_DEMO_BRIEF=1`
    /// for an unseen brief with three decisions, `none` for one with
    /// nothing to decide, `preparing` while it is written, `new` for a seen
    /// brief and one new item since.
    static var demoEnabled: Bool { ProcessInfo.processInfo.environment["BLOB_DEMO_BRIEF"] != nil }

    static var demo: OS1API.SupervisorBriefResponse? {
        guard let mode = ProcessInfo.processInfo.environment["BLOB_DEMO_BRIEF"] else { return nil }
        let now = Date.now.timeIntervalSince1970 * 1000
        switch mode {
        case "preparing":
            return .init(state: "preparing", brief: nil, preparingSince: now - 20_000, refreshAt: now + 30 * 60_000)
        case "new":
            return .init(state: "ready", brief: demoBrief(seen: true, decisions: []), newSince: ["demo-new"])
        case "none":
            return .init(state: "ready", brief: demoBrief(seen: false, decisions: []))
        default:
            return .init(state: "ready", brief: demoBrief(seen: false, decisions: demoItems))
        }
    }

    private static func demoBrief(seen: Bool, decisions: [Item]) -> OS1API.SupervisorBrief {
        let now = Date.now.timeIntervalSince1970 * 1000
        return OS1API.SupervisorBrief(
            day: today,
            asOf: now - 40 * 60_000,
            say: decisions.isEmpty
                ? "Quiet night. I closed four things that were already done, and nothing needs you this morning."
                : "Morning. Three things need you. The checkout fix is ready to merge once the session refactor lands, and two Status page alerts were noise from the rail API. I closed four that were already done.",
            seenAt: seen ? now - 30 * 60_000 : nil,
            handled: [
                "Closed \u{201C}the lead paused itself\u{201D}: it resumed at 06:10",
                "Merged three cards about release 1.19.0 into the checkout decision",
                "Closed the flaky test alert: the rerun passed",
                "Asked the acme lead to rebase PR #540",
            ],
            decisions: decisions.enumerated().map { index, item in
                .init(item: item, recommended: index == 1 ? item.options.first : nil)
            },
            laterCount: 3
        )
    }

    static let demoNew: [Item] = [
        Item(
            id: "demo-new",
            kind: "needs-you",
            title: "Rotate the Stripe webhook secret?",
            body: "The old secret shows up in a log line from last night. Rotating takes a minute and needs a redeploy of the webhook worker.",
            options: ["Rotate it now", "Not now"],
            project: "acme",
            source: "lead:acme",
            createdAt: Date.now.timeIntervalSince1970 * 1000 - 25 * 60_000
        ),
    ]

    static let demoItems: [Item] = {
        let now = Date.now.timeIntervalSince1970 * 1000
        let expires = now + 7 * 86_400_000
        // The server's own lines, as report.ts ends the body with them.
        let suffix = """


        Runs when: PR #556 in acme/app is merged

        Steps:
        1. Merge PR #533 in acme/app at abc1234, squashed
        2. Change the Status page check: alert after 8 failures in a row

        Expires: 17 November 2026, 12:00 UTC
        """
        return [
            Item(
                id: "demo-act",
                kind: "needs-you",
                title: "acme: Merge a verified fix",
                body: """
                The checkout fix in #533 passed on staging. It needs the session refactor in #556 first, so I\u{2019}d merge it right after that lands.
                """ + suffix,
                options: ["Approve", "Not now"],
                project: "acme",
                source: "lead:acme",
                createdAt: now - 4 * 3600 * 1000,
                revision: Int64(now - 4 * 3600 * 1000),
                act: .init(
                    steps: [
                        "Merge PR #533 in acme/app at abc1234, squashed",
                        "Change the Status page check: alert after 8 failures in a row",
                    ],
                    runsWhen: "PR #556 in acme/app is merged",
                    expiresAt: expires,
                    bodySuffix: suffix
                )
            ),
            Item(
                id: "demo-signal",
                kind: "needs-you",
                title: "Status page check: alert after 8 failures in a row?",
                body: "It fired 6 times this week, each for a single slow response from the rail API. None were real outages.",
                options: ["Raise to 8 failures in a row", "Keep it as is"],
                project: "betterbahn",
                source: "lead:betterbahn",
                createdAt: now - 12 * 3600 * 1000
            ),
            Item(
                id: "demo-provider",
                kind: "needs-you",
                title: "Rail API is an outside provider",
                body: "Its errors are not ours to fix. Marked as a provider, they count as its outages instead of opening incidents here.",
                options: ["Mark it as a provider", "Not now"],
                project: "betterbahn",
                source: "lead:betterbahn",
                createdAt: now - 26 * 3600 * 1000
            ),
        ]
    }()
}
#endif
