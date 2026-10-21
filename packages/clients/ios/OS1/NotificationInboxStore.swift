import Foundation
import Observation

/// Whose inbox: one per server and person, whatever case the name arrives in.
struct InboxScope: Equatable, Hashable, Sendable {
    let server: String
    let user: String

    init(server: String, user: String) {
        self.server = server
        self.user = user.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    @MainActor
    static func current() -> InboxScope {
        let config = ServerConfig.shared
        return InboxScope(server: config.baseURLString, user: config.userName)
    }
}

/// The server notification inbox, on this device. The server owns it
/// (src/server/notifications.ts): one row per session, pull request,
/// workspace, reminder or incident, with read and done state shared by every
/// device.
///
/// Hydrated with the other account stores, on account switch and after each
/// socket reconnect, and updated live from the app-wide socket. A banner only
/// ever comes from a live `notification` frame (`receive`), so a refresh,
/// a relaunch or switching accounts never replays one.
@Observable
@MainActor
final class NotificationInboxStore {
    static let shared = NotificationInboxStore()

    /// The server round-trips, swappable so tests run without one. Each call
    /// gets the scope it was made for; the default resolves the connection
    /// when the call starts, not when it lands.
    struct Backend {
        var load: (InboxScope) async throws -> InboxPayload
        var mark: (InboxScope, InboxMark) async throws -> Void
        var saveAlerts: (InboxScope, [InboxAlerts.Group: Bool]) async throws -> InboxAlerts

        @MainActor
        static var live: Backend {
            Backend(
                load: { scope in
                    try await SettingsAPI.notifications(user: scope.user)
                },
                mark: { scope, mark in
                    let connection = SettingsAPI.Connection.current()
                    try await SettingsAPI.markNotifications(
                        user: scope.user, mark: mark, connection: connection
                    )
                },
                saveAlerts: { scope, patch in
                    try await SettingsAPI.saveNotificationAlerts(user: scope.user, patch: patch)
                }
            )
        }
    }

    private(set) var threads: [InboxThread] = []
    private(set) var alerts = InboxAlerts.defaults
    private(set) var hasLoaded = false
    private(set) var viewingSessionId: String?
    /// A row someone tapped (in the inbox or on a banner), for the sessions
    /// list to route. Consumed once.
    private(set) var openRequest: OpenRequest?

    struct OpenRequest: Identifiable, Equatable {
        let id = UUID()
        let destination: InboxDestination
        let url: String
    }

    private let backend: Backend
    private let scopeProvider: () -> InboxScope
    private let presentBanner: (InboxThread, InboxScope) -> Void
    private let replaceBanner: (InboxThread, InboxScope) -> Void
    private let withdrawBanners: ([String]) -> Void
    private let isActive: () -> Bool
    private let syncBadge: (Int) -> Void
    private var scope: InboxScope?
    /// Bumped by every local or live change, so a load that started before
    /// one cannot land over it.
    private var revision = 0
    private var loading: Task<Void, Never>?

    init(
        backend: Backend? = nil,
        scope: (() -> InboxScope)? = nil,
        present: ((InboxThread, InboxScope) -> Void)? = nil,
        replaceBanner: ((InboxThread, InboxScope) -> Void)? = nil,
        withdraw: (([String]) -> Void)? = nil,
        isActive: (() -> Bool)? = nil,
        syncBadge: ((Int) -> Void)? = nil
    ) {
        self.backend = backend ?? .live
        scopeProvider = scope ?? { InboxScope.current() }
        presentBanner = present ?? { NativeNotifications.present($0, scope: $1) }
        self.replaceBanner = replaceBanner ?? { NativeNotifications.replaceIfDelivered($0, scope: $1) }
        withdrawBanners = withdraw ?? { NativeNotifications.withdraw(threadIds: $0) }
        self.isActive = isActive ?? { NativeNotifications.isAppActive() }
        self.syncBadge = syncBadge ?? { NativeNotifications.syncBadgeCount($0) }
    }

    var unreadCount: Int { InboxModel.unreadCount(threads) }

    func rows(_ filter: InboxFilter) -> [InboxThread] {
        InboxModel.filter(threads, filter)
    }

    // MARK: - Loading

    /// Read the inbox from the server. Silent: it never raises a banner.
    func hydrate() async {
        let requestScope = scopeProvider()
        resetIfScopeChanged(requestScope)
        guard !requestScope.user.isEmpty, !requestScope.server.isEmpty else { return }
        if let loading {
            await loading.value
            return
        }
        let task = Task { await self.load(requestScope) }
        loading = task
        await task.value
        if loading == task { loading = nil }
    }

    private func load(_ requestScope: InboxScope) async {
        let requestRevision = revision
        guard let payload = try? await backend.load(requestScope) else { return }
        guard scopeProvider() == requestScope, scope == requestScope else { return }
        alerts = payload.alerts
        // A mark or live row since the request left is newer than this
        // answer; the server's change frame brings the next read.
        if revision == requestRevision {
            let gone = threads.filter { old in
                old.unread && !old.done
                    && !payload.threads.contains { $0.id == old.id && $0.unread && !$0.done }
            }
            threads = payload.threads
            if !gone.isEmpty { withdrawBanners(gone.map(\.id)) }
        }
        hasLoaded = true
        publishBadge()
        readViewedSession()
    }

    /// The socket reconnected, or the server said the inbox changed.
    func refresh() {
        Task { await hydrate() }
    }

    private func resetIfScopeChanged(_ next: InboxScope) {
        guard scope != next else { return }
        let first = scope == nil
        scope = next
        guard !first else { return }
        threads = []
        alerts = .defaults
        hasLoaded = false
        viewingSessionId = nil
        openRequest = nil
        revision += 1
        loading?.cancel()
        loading = nil
        syncBadge(0)
    }

    // MARK: - Live frames

    /// The server recorded a new event for `user`. The only path to a banner.
    /// `replace` only updates a banner still on screen, quietly; it never
    /// raises one.
    func receive(user: String, thread: InboxThread?, alert: Bool, replace: Bool = false) {
        let current = scopeProvider()
        resetIfScopeChanged(current)
        guard InboxScope(server: current.server, user: user) == current else { return }
        guard let thread else {
            refresh()
            return
        }
        revision += 1
        // The same row with the same event is a duplicate delivery (two
        // sockets, a resent frame), not news.
        let replay = threads.contains(thread)
        threads = [thread] + threads.filter { $0.id != thread.id }
        if thread.subject.type == "session",
           thread.subject.id == viewingSessionId,
           isActive() {
            // Seen as it arrives: read on every device, no banner.
            mark([thread.id], unread: false)
            return
        }
        publishBadge()
        if alert, !replay, thread.unread, !thread.done {
            presentBanner(thread, current)
        } else if replace, !replay, !thread.done {
            replaceBanner(thread, current)
        }
    }

    func receiveChanged(user: String) {
        let current = scopeProvider()
        guard InboxScope(server: current.server, user: user) == current else { return }
        refresh()
    }

    // MARK: - Marking

    /// Change read or done state, optimistically, and tell the server. A
    /// failure re-reads the inbox rather than leaving this device wrong.
    func mark(_ ids: [String], unread: Bool? = nil, done: Bool? = nil) {
        apply(InboxMark(ids: ids, unread: unread, done: done))
    }

    func markAllRead() {
        let ids = threads.filter { $0.unread && !$0.done }.map(\.id)
        guard !ids.isEmpty else { return }
        apply(InboxMark(all: true, unread: false))
    }

    private func apply(_ mark: InboxMark) {
        let next = InboxModel.apply(mark, to: threads)
        guard next != threads else { return }
        let cleared = zip(threads, next).compactMap { old, new in
            old.unread && !old.done && !(new.unread && !new.done) ? new.id : nil
        }
        revision += 1
        threads = next
        publishBadge()
        withdrawBanners(cleared)
        let requestScope = scope ?? scopeProvider()
        let backend = backend
        Task {
            do {
                try await backend.mark(requestScope, mark)
            } catch {
                await self.hydrate()
            }
        }
    }

    // MARK: - Opening

    /// Open a row: mark it read and hand its destination to the router.
    func open(_ thread: InboxThread) {
        if thread.unread { mark([thread.id], unread: false) }
        let destination = InboxDestination.resolve(thread)
        // A comment link opens its session with that thread focused.
        if case .session(let sessionId) = destination {
            ThreadFocus.shared.note(link: thread.url, sessionId: sessionId)
        }
        openRequest = OpenRequest(destination: destination, url: thread.url)
    }

    /// A banner tap. Only for the inbox it was raised in.
    func openTapped(_ target: NotificationTap.Target) {
        guard target.scope == scopeProvider() else { return }
        if let thread = threads.first(where: { $0.id == target.threadId }) {
            open(thread)
            return
        }
        // The row has not loaded yet (a cold launch from the banner): its id
        // still names the subject.
        mark([target.threadId], unread: false)
        let parts = target.threadId.split(separator: ":", maxSplits: 1).map(String.init)
        let kind = parts.count == 2 ? parts[0] : ""
        let destination: InboxDestination
        if let url = target.url, let routed = InboxDestination.route(url) {
            destination = routed
            if case .session(let sessionId) = routed {
                ThreadFocus.shared.note(link: url, sessionId: sessionId)
            }
        } else if kind == "session" {
            destination = .session(parts[1])
        } else if kind == "workspace" {
            destination = .workspace(parts[1])
        } else if kind == "reminder" {
            destination = .tasks
        } else {
            destination = .web("/")
        }
        openRequest = OpenRequest(destination: destination, url: target.url ?? "/")
    }

    func takeOpenRequest() -> OpenRequest? {
        defer { openRequest = nil }
        return openRequest
    }

    // MARK: - The session on screen

    /// While a session is on screen and the app is in front, its row is read,
    /// including news that lands while you watch.
    func viewing(_ sessionId: String) {
        viewingSessionId = sessionId
        readViewedSession()
    }

    func stopViewing(_ sessionId: String) {
        if viewingSessionId == sessionId { viewingSessionId = nil }
    }

    private func readViewedSession() {
        guard let viewingSessionId, isActive() else { return }
        let id = "session:\(viewingSessionId)"
        if threads.contains(where: { $0.id == id && $0.unread }) {
            mark([id], unread: false)
        }
    }

    // MARK: - Alert settings

    /// Save which kinds alert, for this person on every device. Optimistic;
    /// rolls back and rethrows when the server refuses.
    func setAlert(_ group: InboxAlerts.Group, _ on: Bool) async throws {
        let previous = alerts
        alerts[group] = on
        revision += 1
        let requestScope = scope ?? scopeProvider()
        do {
            let saved = try await backend.saveAlerts(requestScope, [group: on])
            guard scope == requestScope else { return }
            alerts = saved
        } catch {
            if scope == requestScope { alerts = previous }
            throw error
        }
    }

    private func publishBadge() {
        guard hasLoaded else { return }
        syncBadge(unreadCount)
    }
}
