import Foundation
import Observation

/// What the supervisor is waiting on you for: its open `needs-you` items
/// (server: supervisor-inbox.ts), one at a time on the home while Blob is
/// otherwise idle. `fyi` items never show here; they arrive in the daily
/// digest.
///
/// "Not now" only skips an item for this launch. Dismissing it for good is
/// a separate, deliberate action (the long-press menu).
@MainActor
@Observable
final class BlobDecisions {
    typealias Item = OS1API.SupervisorItem

    /// Open needs-you items, in the order Blob shows them.
    private(set) var items: [Item] = []
    /// Skipped with "Not now", until the app is next launched.
    private var skipped: Set<String> = []
    /// Answered or dismissed here and not yet gone from the server's list.
    private var closed: Set<String> = []
    /// An answer on its way, so the options can't be sent twice.
    private(set) var sending: String?
    /// What Blob says after an answer, briefly, before the next item.
    private(set) var said: String?
    private var saidTask: Task<Void, Never>?
    /// Answers sent from here, for the success haptic.
    private(set) var answered = 0
    /// Handled since the queue was last empty, so the count reads "2 of 3"
    /// after the first one rather than starting over.
    private var handledInRound = 0

    /// Opened from a `blob://item/<id>` link: shown first, even if it was
    /// skipped or is not a needs-you item.
    private var focused: Item?
    /// Items Blob has already read aloud, so each is read once.
    private var spoken: Set<String> = []

    /// The items still to show, first one current.
    var pending: [Item] {
        var list = items.filter { !skipped.contains($0.id) && !closed.contains($0.id) }
        if let focused, !closed.contains(focused.id) {
            list.removeAll { $0.id == focused.id }
            list.insert(focused, at: 0)
        }
        return list
    }
    var current: Item? { pending.first }
    /// The current item's place in this round, 1-based.
    var position: Int { handledInRound + 1 }
    var count: Int { handledInRound + pending.count }
    /// Open on the server and not answered here, skipped ones included.
    var waiting: Int { items.filter { !closed.contains($0.id) }.count }

    private func handled() {
        handledInRound += 1
        if pending.isEmpty { handledInRound = 0 }
    }

    /// Reads the open needs-you items. Errors keep what is already there:
    /// a blip offline should not make a waiting decision vanish.
    func refresh() async {
        #if DEBUG
        if Self.demoEnabled {
            if items.isEmpty, closed.isEmpty { items = Self.demo }
            return
        }
        #endif
        guard ServerConfig.shared.isConfigured,
              let fetched = try? await OS1API.supervisorItems(kind: "needs-you")
        else { return }
        let open = fetched.filter { $0.needsYou && $0.isOpen }
        items = Self.ordered(open)
        // A linked needs-you item that is no longer open was settled elsewhere.
        if let focused, focused.needsYou {
            self.focused = open.first { $0.id == focused.id }
        }
        // Closed here and now gone there: nothing left to hide.
        closed.formIntersection(open.map(\.id))
        if pending.isEmpty { handledInRound = 0 }
    }

    /// Something fully down first, then the longest waiting.
    static func ordered(_ items: [Item]) -> [Item] {
        items.sorted { a, b in
            let ad = a.urgency == "down", bd = b.urgency == "down"
            if ad != bd { return ad }
            return (a.createdAt ?? 0) < (b.createdAt ?? 0)
        }
    }

    func skip(_ item: Item) {
        skipped.insert(item.id)
        if focused?.id == item.id { focused = nil }
        handled()
    }

    /// Shows the item a `blob://item/<id>` link names as the current
    /// decision, even after "Not now". The list endpoint is the only read,
    /// so it looks among the open items of any kind.
    func focus(id: String) async {
        skipped.remove(id)
        if let item = items.first(where: { $0.id == id }) {
            focused = item
            return
        }
        #if DEBUG
        if Self.demoEnabled { return }
        #endif
        guard ServerConfig.shared.isConfigured,
              let fetched = try? await OS1API.supervisorItems(),
              let item = fetched.first(where: { $0.id == id && $0.isOpen })
        else {
            say("That one is already settled.")
            return
        }
        closed.remove(id)
        focused = item
    }

    /// True the first time an item comes up, so Blob reads it once.
    func shouldSpeak(_ item: Item) -> Bool {
        spoken.insert(item.id).inserted
    }

    /// Sends the answer. Success, or the item already closed elsewhere,
    /// moves on; any other failure keeps it on screen with a reason.
    func answer(_ item: Item, with option: String) async {
        guard sending == nil else { return }
        sending = item.id
        defer { sending = nil }
        do {
            #if DEBUG
            if Self.demoEnabled {
                try await Task.sleep(for: .milliseconds(400))
            } else {
                try await OS1API.answerSupervisorItem(id: item.id, answer: option)
            }
            #else
            try await OS1API.answerSupervisorItem(id: item.id, answer: option)
            #endif
            closed.insert(item.id)
            handled()
            answered += 1
            say("Done. I\u{2019}ll pass it on.")
        } catch {
            if Self.alreadyClosed(error) {
                closed.insert(item.id)
                handled()
                say("That one was already settled.")
            } else {
                say("I couldn\u{2019}t send that. Try again in a moment.")
            }
        }
    }

    /// Closes the item on the server without an answer.
    func dismiss(_ item: Item) async {
        closed.insert(item.id)
        handled()
        #if DEBUG
        if Self.demoEnabled { return }
        #endif
        do {
            try await OS1API.dismissSupervisorItem(id: item.id)
        } catch where !Self.alreadyClosed(error) {
            closed.remove(item.id)
            handledInRound = max(0, handledInRound - 1)
            say("I couldn\u{2019}t dismiss that. Try again in a moment.")
        } catch {}
    }

    private func say(_ line: String) {
        saidTask?.cancel()
        said = line
        saidTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2.4))
            guard !Task.isCancelled else { return }
            self?.said = nil
        }
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
extension BlobDecisions {
    /// Two canned decisions for screenshots without a server:
    /// `BLOB_DEMO_DECISIONS=1`.
    static var demoEnabled: Bool { ProcessInfo.processInfo.environment["BLOB_DEMO_DECISIONS"] != nil }

    static let demo: [Item] = {
        let now = Date.now.timeIntervalSince1970 * 1000
        return [
            Item(
                id: "demo-signal",
                kind: "needs-you",
                title: "Status page check: alert after 8 failures in a row?",
                body: """
                The Status page check fired 6 times this week, each time for a single slow response from the rail API. None were real outages.

                ```table
                Threshold,Alerts this week,Real outages
                3 in a row (now),6,0
                8 in a row,0,0
                ```
                """,
                options: ["Raise to 8 failures in a row", "Keep it as is"],
                project: "betterbahn",
                source: "lead:betterbahn",
                createdAt: now - 12 * 60 * 1000
            ),
            Item(
                id: "demo-provider",
                kind: "needs-you",
                title: "Rail API is an outside provider",
                body: "Its errors are not ours to fix. Marked as a provider, they count as its outages instead of opening incidents here.",
                options: ["Mark it as a provider", "Not now"],
                project: "betterbahn",
                source: "lead:betterbahn",
                createdAt: now - 2 * 3600 * 1000
            ),
        ]
    }()
}
#endif
