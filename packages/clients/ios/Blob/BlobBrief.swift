import BlobCore
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
    typealias Phase = BlobBriefState.Phase
    typealias Page = BlobBriefState.Page

    /// The page, its decisions and the rules for both (BlobCore, where
    /// `swift test` covers them). This class reads, answers and times.
    private var state = BlobBriefState()

    var phase: Phase { state.phase }
    /// The page, while Blob holds one. Nil is idle.
    var page: Page? { state.page }
    /// Open items the latest brief left for later; "What can wait?" is only
    /// offered when there are some.
    var laterWaiting: Int { state.laterWaiting }
    /// The latest brief is written and the owner hasn't seen it.
    var unseen: Bool { state.unseen }
    /// The quiet line on the idle home that opens the brief again, in the
    /// server's copy (`reopen`): "This morning: 2 decisions waiting", or
    /// "Today\u{2019}s brief" when nothing waits. Nil when there is none.
    var reopenLine: String? { state.reopenLine }
    /// What Blob says about a decision after an answer, in its place, by
    /// item id. Each goes after a moment on its own.
    var notes: [String: String] { state.notes }
    /// Decisions on the page still open here.
    var open: [Item] { state.open }
    /// For the Mac menu bar: "Brief ready", "2 decisions", or nil.
    var menuLine: String? { state.menuLine }

    /// An answer on its way, so the options can't be sent twice.
    private(set) var sending: String?
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

    /// Blob came to the front: reads the brief, asking for a missing one,
    /// then again at each `Phase.pollDelay` until `stopPolling`.
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
                try? await Task.sleep(for: self.phase.pollDelay)
                guard !Task.isCancelled else { return }
                await self.refresh()
            }
        }
    }

    /// Reads the brief. `start`: Blob just came to the front, so a missing
    /// brief for today starts being prepared. Errors keep what is there: a
    /// blip offline should not make a waiting decision vanish. A read that
    /// a newer one overtook is dropped.
    func refresh(start: Bool = false) async {
        #if DEBUG
        if let demo = Self.demo {
            if page == nil, state.untouched { await apply(demo, generation: generation) }
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
        switch update({ $0.apply(response, offered: offered) }) {
        case .none:
            return
        case .reread(let held):
            await reread(held, only: nil, generation: mine)
        case .rereadSince(let held):
            await reread(held, only: held.since, generation: mine)
        case .offerNew(let ids, let briefDay):
            #if DEBUG
            let items: [Item]? = Self.demo != nil ? Self.demoNew : try? await OS1API.supervisorItems(kind: "needs-you")
            #else
            let items = try? await OS1API.supervisorItems(kind: "needs-you")
            #endif
            guard mine == generation, let items else { return }
            update { $0.offerNew(ids, items: items, briefDay: briefDay, today: Self.today) }
        }
    }

    /// Reads the items again for the page Blob holds (`BlobBriefState.reread`).
    private func reread(_ held: Page, only: Set<String>?, generation mine: Int) async {
        #if DEBUG
        if Self.demo != nil { return }
        #endif
        let limit = OS1API.supervisorItemsMax
        guard let items = try? await OS1API.supervisorItems(limit: limit), mine == generation else { return }
        update { $0.reread(held, items: items, limit: limit, only: only) }
    }

    /// Changes the state, then stops the timers of notes it took away.
    @discardableResult
    private func update<T>(_ change: (inout BlobBriefState) -> T) -> T {
        let result = change(&state)
        for id in noteTasks.keys where state.notes[id] == nil {
            noteTasks.removeValue(forKey: id)?.cancel()
        }
        return result
    }

    /// The owner's local day, as the server writes it.
    private static var today: String { BlobBriefState.day(of: .now) }

    /// The page is on screen: the brief is marked seen, new items offered.
    /// True the first time, so Blob says it once.
    func shown(_ page: Page) -> Bool {
        guard update({ $0.shown(page) }) else { return false }
        offered.formUnion(page.offered)
        if page.kind == .brief {
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
    func shouldSayPreparing() -> Bool { update { $0.shouldSayPreparing() } }

    /// The owner put the page away: Blob goes idle. What is still open
    /// stays open on the server, for when the owner asks.
    func dismiss() { update { $0.dismissPage() } }

    /// Opens the latest brief again from the idle home's line, with what
    /// was raised since under its own decisions. Not said again: it was
    /// said when it first came up. Done puts it away as before.
    func reopen() async {
        guard state.canReopen else { return }
        var items: [Item]?
        if !state.latestSince.isEmpty {
            #if DEBUG
            items = Self.demo != nil ? Self.demoNew : try? await OS1API.supervisorItems(kind: "needs-you")
            #else
            items = try? await OS1API.supervisorItems(kind: "needs-you")
            #endif
        }
        update { $0.reopen(items: items) }
    }

    /// Shows the item a `blob://item/<id>` link names, even one the brief
    /// left for later.
    func focus(id: String) async {
        if state.shows(id: id) { return }
        #if DEBUG
        if Self.demo != nil { return }
        #endif
        guard ServerConfig.shared.isConfigured,
              let fetched = try? await OS1API.supervisorItems(limit: OS1API.supervisorItemsMax),
              let item = fetched.first(where: { $0.id == id && $0.isOpen })
        else { return }
        update { $0.focus(item) }
    }

    /// Opens the decision view for an inbox item tapped on the board
    /// (`item:` ref): read fresh from the items API, so the answer names the
    /// revision on screen, and shown even when it is one of the brief's
    /// decisions, whose cards the board stands in for. The brief comes back
    /// once it is done. `.closed` when it isn't open any more, for the
    /// caller to show what the board knows instead; `.unavailable` when the
    /// items couldn't be read. Cancelled (a newer tap, or the home went),
    /// it shows nothing and returns `.unavailable`.
    func open(itemId id: String) async -> BlobBriefState.Lookup {
        let lookup: BlobBriefState.Lookup
        #if DEBUG
        if Self.demo != nil {
            lookup = BlobBriefState.lookup(id, in: Self.demoItems + Self.demoNew, limit: .max)
        } else {
            lookup = await Self.lookUp(id)
        }
        #else
        lookup = await Self.lookUp(id)
        #endif
        guard !Task.isCancelled else { return .unavailable }
        guard case .open(let item) = lookup else { return lookup }
        // A brief decision keeps the option the brief recommended first.
        let recommended = state.page?.decisions.first { $0.id == id }?.options.first
        update { $0.focus(BlobBriefState.recommending(recommended, in: item)) }
        return lookup
    }

    /// Reads the open items for `open(itemId:)`; a failed read is
    /// `.unavailable`, never `.closed`.
    private static func lookUp(_ id: String) async -> BlobBriefState.Lookup {
        guard ServerConfig.shared.isConfigured else { return .unavailable }
        let items = try? await OS1API.supervisorItems(limit: OS1API.supervisorItemsMax)
        return BlobBriefState.lookup(id, in: items, limit: OS1API.supervisorItemsMax)
    }

    func isRevised(_ item: Item) -> Bool { state.isRevised(item) }

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
            update { $0.close(item, saying: "Done. I\u{2019}ll pass it on.") }
            expireNote(of: item)
            answered += 1
        } catch {
            switch Self.failure(error) {
            case .changed:
                say("This changed. Have another look.", about: item)
                await refresh()
            case .alreadyClosed:
                update { $0.close(item, saying: "That one was already settled.") }
                expireNote(of: item)
            case .other:
                say("I couldn\u{2019}t send that. Try again in a moment.", about: item)
            }
        }
    }

    /// Closes the item on the server without an answer.
    func dismiss(_ item: Item) async {
        update { $0.dismissed(item) }
        #if DEBUG
        if Self.demo != nil { return }
        #endif
        do {
            try await OS1API.dismissSupervisorItem(id: item.id)
        } catch where Self.failure(error) != .alreadyClosed {
            update { $0.dismissFailed(item, saying: "I couldn\u{2019}t dismiss that. Try again in a moment.") }
            expireNote(of: item)
        } catch {}
    }

    /// What Blob says about one decision, in its place for a moment.
    private func say(_ line: String, about item: Item) {
        update { $0.say(line, about: item) }
        expireNote(of: item)
    }

    /// The decision's note goes after a moment, on its own, so answering
    /// another one quickly leaves this one be.
    private func expireNote(of item: Item) {
        let id = item.id
        noteTasks[id]?.cancel()
        noteTasks[id] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2.4))
            guard !Task.isCancelled, let self else { return }
            self.noteTasks[id] = nil
            self.update { $0.noteExpired(id) }
        }
    }

    /// What Blob says in place of the decision `id`, while it says it.
    func note(for id: String) -> String? { state.notes[id] }

    private static func failure(_ error: Error) -> BlobBriefState.Failure {
        switch error as? OS1API.APIError {
        case .server(let message): .init(serverMessage: message, httpStatus: nil)
        case .http(let code): .init(serverMessage: nil, httpStatus: code)
        default: .other
        }
    }
}

#if DEBUG
extension BlobBrief {
    /// A canned brief for screenshots without a server: `BLOB_DEMO_BRIEF=1`
    /// for an unseen brief with three decisions, `none` for one with
    /// nothing to decide, `preparing` while it is written, `new` for a seen
    /// brief and one new item since, `reopen` for a seen brief with two
    /// decisions waiting behind the idle home's line.
    static var demoEnabled: Bool { ProcessInfo.processInfo.environment["BLOB_DEMO_BRIEF"] != nil }

    static var demo: OS1API.SupervisorBriefResponse? {
        guard let mode = ProcessInfo.processInfo.environment["BLOB_DEMO_BRIEF"] else { return nil }
        let now = Date.now.timeIntervalSince1970 * 1000
        switch mode {
        case "preparing":
            return .init(state: "preparing", brief: nil, preparingSince: now - 20_000, refreshAt: now + 30 * 60_000)
        case "new":
            return .init(state: "ready", brief: demoBrief(seen: true, decisions: []), newSince: ["demo-new"])
        case "reopen":
            // Seen and put away, two decisions still waiting: the idle home's line.
            return .init(state: "ready", brief: demoBrief(seen: true, decisions: Array(demoItems.prefix(2))), reopenLine: "This morning: 2 decisions waiting")
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
