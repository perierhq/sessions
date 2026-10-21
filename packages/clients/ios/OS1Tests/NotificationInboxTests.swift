import XCTest
import UserNotifications
@testable import OS1

/// The server inbox on this device: tolerant decoding, live frames versus
/// silent refreshes, account switching, read/done marks and deep links.
@MainActor
final class NotificationInboxTests: XCTestCase {
    private let acme = InboxScope(server: "https://acme.example.test", user: "Ada")
    private let other = InboxScope(server: "https://other.example.test", user: "Grace")

    private func thread(
        _ id: String = "session:os-1",
        kind: String = "mention",
        updatedAt: Double = 1_000,
        unread: Bool = true,
        done: Bool = false,
        url: String = "/session/os-1"
    ) -> InboxThread {
        let parts = id.split(separator: ":", maxSplits: 1).map(String.init)
        return InboxThread(
            id: id,
            subject: .init(type: parts[0], id: parts[1], title: "Fix login", context: "acme/app"),
            kind: kind,
            reason: "Grace mentioned you",
            body: "Can you look?",
            actor: "Grace",
            url: url,
            updatedAt: updatedAt,
            unread: unread,
            done: done
        )
    }

    /// A store wired to an in-memory server.
    private final class Harness {
        var scope: InboxScope
        var payloads: [InboxScope: InboxPayload] = [:]
        var marks: [(InboxScope, InboxMark)] = []
        var savedAlerts: [(InboxScope, [InboxAlerts.Group: Bool])] = []
        var failMarks = false
        var banners: [InboxThread] = []
        var replaced: [InboxThread] = []
        var withdrawn: [String] = []
        var active = false
        var badge: [Int] = []

        init(scope: InboxScope) { self.scope = scope }
    }

    private struct Refused: Error {}

    private func makeStore(_ h: Harness) -> NotificationInboxStore {
        NotificationInboxStore(
            backend: .init(
                load: { scope in h.payloads[scope] ?? InboxPayload(threads: []) },
                mark: { scope, mark in
                    h.marks.append((scope, mark))
                    if h.failMarks { throw Refused() }
                },
                saveAlerts: { scope, patch in
                    h.savedAlerts.append((scope, patch))
                    var alerts = h.payloads[scope]?.alerts ?? .defaults
                    for (group, on) in patch { alerts[group] = on }
                    return alerts
                }
            ),
            scope: { h.scope },
            present: { thread, _ in h.banners.append(thread) },
            replaceBanner: { thread, _ in h.replaced.append(thread) },
            withdraw: { h.withdrawn += $0 },
            isActive: { h.active },
            syncBadge: { h.badge.append($0) }
        )
    }

    private func settle() async {
        for _ in 0..<50 { await Task.yield() }
    }

    // MARK: - Decoding

    func testPayloadDropsUnreadableRowsAndKeepsNewerKinds() throws {
        let json = #"""
        {"threads":[
          {"id":"session:os-1","subject":{"type":"session","id":"os-1","title":"Fix login","context":"acme/app"},
           "kind":"review_requested","reason":"Ada asked for your review","body":"","url":"/session/os-1",
           "updatedAt":1760000000000,"unread":true,"done":false,"extra":{"nested":1}},
          {"subject":{"type":"pr","id":"x"}},
          {"id":"pr:acme/app#main","kind":"some_future_kind","reason":"Something new","url":"/pr/acme%2Fapp/main",
           "updatedAt":"not a number","unread":"yes"},
          42
        ],"unread":1,"alerts":{"reviews":false,"teamReviews":false,"mentions":"maybe"}}
        """#
        let payload = try JSONDecoder().decode(InboxPayload.self, from: Data(json.utf8))
        XCTAssertEqual(payload.threads.map(\.id), ["session:os-1", "pr:x", "pr:acme/app#main"])
        XCTAssertEqual(payload.threads[0].knownKind, .reviewRequested)
        XCTAssertEqual(payload.threads[0].subject.context, "acme/app")
        // A subject-only row recovers its id from the subject.
        XCTAssertEqual(payload.threads[1].subject.type, "pr")
        // A newer kind still shows; bad field types fall back to defaults.
        let future = payload.threads[2]
        XCTAssertNil(future.knownKind)
        XCTAssertEqual(future.subject.type, "pr")
        XCTAssertEqual(future.subject.id, "acme/app#main")
        XCTAssertEqual(future.updatedAt, 0)
        XCTAssertFalse(future.unread)
        XCTAssertFalse(payload.alerts.reviews)
        XCTAssertFalse(payload.alerts.teamReviews)
        XCTAssertTrue(payload.alerts.mentions)
        XCTAssertTrue(payload.alerts.reminders)
    }

    func testEmptyOrMalformedPayloadDecodesToAnEmptyInbox() throws {
        let payload = try JSONDecoder().decode(InboxPayload.self, from: Data(#"{"threads":null}"#.utf8))
        XCTAssertEqual(payload.threads, [])
        XCTAssertEqual(payload.alerts, .defaults)
    }

    func testSocketFramesDecodeToInboxEvents() {
        let frame = #"""
        {"type":"notification","user":"Ada","alert":true,"notification":{"id":"session:os-1",
         "subject":{"type":"session","id":"os-1","title":"Fix login"},"kind":"mention","reason":"Grace mentioned you",
         "body":"","url":"/session/os-1","updatedAt":5,"unread":true,"done":false}}
        """#
        guard case .notification(let user, let thread, let alert, _) = ServerEvent.parse(Data(frame.utf8)) else {
            return XCTFail("expected a notification event")
        }
        XCTAssertEqual(user, "Ada")
        XCTAssertEqual(thread?.id, "session:os-1")
        XCTAssertTrue(alert)

        // A row this build cannot read still arrives, as a refresh.
        let unreadable = #"{"type":"notification","user":"Ada","notification":{"kind":"mention"}}"#
        guard case .notification(_, let missing, let quiet, _) = ServerEvent.parse(Data(unreadable.utf8)) else {
            return XCTFail("expected a notification event")
        }
        XCTAssertNil(missing)
        XCTAssertFalse(quiet)

        guard case .notificationsChanged(let changed) = ServerEvent.parse(
            Data(#"{"type":"notifications_changed","user":"Ada"}"#.utf8)
        ) else { return XCTFail("expected notifications_changed") }
        XCTAssertEqual(changed, "Ada")
    }

    // MARK: - Filters and marks

    func testFiltersMatchTheWebInbox() {
        let rows = [
            thread("session:a", updatedAt: 1, unread: true),
            thread("session:b", updatedAt: 3, unread: false),
            thread("session:c", updatedAt: 2, unread: false, done: true),
        ]
        XCTAssertEqual(InboxModel.filter(rows, .unread).map(\.id), ["session:a"])
        XCTAssertEqual(InboxModel.filter(rows, .all).map(\.id), ["session:b", "session:a"])
        XCTAssertEqual(InboxModel.filter(rows, .done).map(\.id), ["session:c"])
        XCTAssertEqual(InboxModel.unreadCount(rows), 1)
        // Done implies read, like the server.
        let done = InboxModel.apply(InboxMark(ids: ["session:a"], done: true), to: rows)
        XCTAssertEqual(done[0].done, true)
        XCTAssertEqual(done[0].unread, false)
    }

    func testMarksAreOptimisticAndSentToTheServer() async {
        let h = Harness(scope: acme)
        h.payloads[acme] = InboxPayload(threads: [thread("session:a"), thread("session:b", updatedAt: 2)])
        let store = makeStore(h)
        await store.hydrate()
        XCTAssertEqual(store.unreadCount, 2)
        XCTAssertEqual(h.badge.last, 2)

        store.mark(["session:a"], unread: false)
        XCTAssertEqual(store.unreadCount, 1)
        XCTAssertEqual(h.withdrawn, ["session:a"], "a read row takes its banner down")
        store.mark(["session:b"], done: true)
        XCTAssertEqual(store.rows(.done).map(\.id), ["session:b"])
        store.mark(["session:b"], done: false)
        store.mark(["session:a"], unread: true)
        store.markAllRead()
        XCTAssertEqual(store.unreadCount, 0)
        XCTAssertEqual(h.badge.last, 0)
        await settle()

        XCTAssertEqual(h.marks.map(\.1), [
            InboxMark(ids: ["session:a"], unread: false),
            InboxMark(ids: ["session:b"], done: true),
            InboxMark(ids: ["session:b"], done: false),
            InboxMark(ids: ["session:a"], unread: true),
            InboxMark(all: true, unread: false),
        ])
        XCTAssertTrue(h.marks.allSatisfy { $0.0 == acme })
        XCTAssertEqual(InboxMark(all: true, unread: false).body["all"] as? Bool, true)
        XCTAssertNil(InboxMark(all: true, unread: false).body["ids"])
    }

    func testARefusedMarkRereadsTheServer() async {
        let h = Harness(scope: acme)
        h.payloads[acme] = InboxPayload(threads: [thread("session:a")])
        let store = makeStore(h)
        await store.hydrate()
        h.failMarks = true
        store.mark(["session:a"], unread: false)
        XCTAssertEqual(store.unreadCount, 0)
        await settle()
        XCTAssertEqual(store.unreadCount, 1, "the server's state wins after a failure")
    }

    func testAChangeFromAnotherDeviceIsReadAgainSilently() async {
        let h = Harness(scope: acme)
        h.payloads[acme] = InboxPayload(threads: [thread("session:a")])
        let store = makeStore(h)
        await store.hydrate()
        h.payloads[acme] = InboxPayload(threads: [thread("session:a", unread: false)])
        store.receiveChanged(user: "ADA ")
        await settle()
        XCTAssertEqual(store.unreadCount, 0)
        XCTAssertEqual(h.withdrawn, ["session:a"])
        XCTAssertTrue(h.banners.isEmpty)
    }

    // MARK: - Banners

    func testOnlyALiveAlertingFrameRaisesABannerAndOnlyOnce() async {
        let h = Harness(scope: acme)
        h.payloads[acme] = InboxPayload(threads: [thread("session:old")])
        let store = makeStore(h)
        await store.hydrate()
        XCTAssertTrue(h.banners.isEmpty, "loading the inbox never alerts")

        let news = thread("session:os-2", updatedAt: 2_000)
        store.receive(user: "ada", thread: news, alert: true)
        store.receive(user: "ada", thread: news, alert: true)
        XCTAssertEqual(h.banners.map(\.id), ["session:os-2"], "a duplicate frame is not news")
        XCTAssertEqual(store.rows(.unread).first?.id, "session:os-2")

        store.receive(user: "ada", thread: thread("session:os-3", updatedAt: 3_000), alert: false)
        XCTAssertEqual(h.banners.count, 1, "the server said this kind is switched off")
        XCTAssertEqual(store.unreadCount, 3, "it still lands in the inbox")

        store.receive(user: "grace", thread: thread("session:os-4"), alert: true)
        XCTAssertNil(store.threads.first { $0.id == "session:os-4" }, "another person's frame")

        // Reconnecting re-reads and must not replay anything.
        await store.hydrate()
        XCTAssertEqual(h.banners.count, 1)
    }

    func testNewsAboutTheSessionOnScreenIsReadWithoutABanner() async {
        let h = Harness(scope: acme)
        let store = makeStore(h)
        await store.hydrate()
        h.active = true
        store.viewing("os-1")
        store.receive(user: "Ada", thread: thread("session:os-1", updatedAt: 9), alert: true)
        XCTAssertTrue(h.banners.isEmpty)
        XCTAssertEqual(store.unreadCount, 0)
        await settle()
        XCTAssertEqual(h.marks.map(\.1), [InboxMark(ids: ["session:os-1"], unread: false)])

        // In the background the same news stays unread and alerts.
        store.stopViewing("os-1")
        h.active = false
        store.receive(user: "Ada", thread: thread("session:os-1", updatedAt: 10), alert: true)
        XCTAssertEqual(h.banners.count, 1)
    }

    func testDeviceChoicesGateTheBanner() {
        let defaults = UserDefaults(suiteName: "NotificationInboxTests")!
        defaults.removePersistentDomain(forName: "NotificationInboxTests")
        XCTAssertFalse(NativeNotifications.allowsBanner(defaults: defaults, active: false))
        defaults.set(true, forKey: NativeNotifications.bannersKey)
        XCTAssertTrue(NativeNotifications.allowsBanner(defaults: defaults, active: false))
        XCTAssertFalse(NativeNotifications.allowsBanner(defaults: defaults, active: true))
        defaults.set("always", forKey: NativeNotifications.whenKey)
        XCTAssertTrue(NativeNotifications.allowsBanner(defaults: defaults, active: true))
        defaults.set("never", forKey: NativeNotifications.whenKey)
        XCTAssertFalse(NativeNotifications.allowsBanner(defaults: defaults, active: false))
    }

    func testRetiredEventSwitchesAreRemoved() {
        let defaults = UserDefaults(suiteName: "NotificationInboxTestsRetired")!
        defaults.set(true, forKey: "os1.notifications.runComplete")
        defaults.set(true, forKey: "os1.notifications.needsInput")
        defaults.set(true, forKey: NativeNotifications.bannersKey)
        NativeNotifications.retireLegacyPreferences(defaults)
        XCTAssertNil(defaults.object(forKey: "os1.notifications.runComplete"))
        XCTAssertNil(defaults.object(forKey: "os1.notifications.needsInput"))
        XCTAssertTrue(defaults.bool(forKey: NativeNotifications.bannersKey), "device choices stay")
    }

    /// A finished run and a new question used to post local banners from
    /// the session socket. Neither is an inbox event any more.
    func testRunsAndQuestionsPostNoBanners() {
        let savedDeliver = NativeNotifications.deliver
        let savedActive = NativeNotifications.isAppActive
        let defaults = UserDefaults.standard
        let savedBanners = defaults.object(forKey: NativeNotifications.bannersKey)
        let savedWhen = defaults.object(forKey: NativeNotifications.whenKey)
        var delivered: [UNNotificationRequest] = []
        NativeNotifications.deliver = { delivered.append($0) }
        NativeNotifications.isAppActive = { false }
        defaults.set(true, forKey: NativeNotifications.bannersKey)
        defaults.set("always", forKey: NativeNotifications.whenKey)
        defer {
            NativeNotifications.deliver = savedDeliver
            NativeNotifications.isAppActive = savedActive
            defaults.set(savedBanners, forKey: NativeNotifications.bannersKey)
            defaults.set(savedWhen, forKey: NativeNotifications.whenKey)
        }

        let viewModel = SessionViewModel(session: Session(id: "bks-1"))
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: true))
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: false))
        viewModel.handle(.askQuestion(
            sessionId: "bks-1",
            question: AskQuestion(id: "q-1", questions: [])
        ))
        XCTAssertTrue(delivered.isEmpty)

        // The inbox path still delivers, tagged by row for replacement.
        NativeNotifications.present(thread("session:os-9"), scope: acme)
        XCTAssertEqual(delivered.map(\.identifier), ["os-notification-session:os-9"])
        XCTAssertEqual(delivered.first?.content.title, "Grace mentioned you")
        XCTAssertEqual(delivered.first?.content.body, "Fix login: Can you look?")
        let target = NotificationTap.target(from: delivered[0].content.userInfo)
        // The link rides along, so a cold launch can still focus a comment.
        XCTAssertEqual(target, NotificationTap.Target(threadId: "session:os-9", scope: acme, url: "/session/os-1"))
    }

    // MARK: - Accounts

    func testSwitchingAccountsClearsTheInboxAndIgnoresLateAnswers() async {
        let h = Harness(scope: acme)
        h.payloads[acme] = InboxPayload(
            threads: [thread("session:a")],
            alerts: { var a = InboxAlerts.defaults; a.reviews = false; return a }()
        )
        h.payloads[other] = InboxPayload(threads: [thread("session:z"), thread("session:y")])
        let store = makeStore(h)
        await store.hydrate()
        XCTAssertEqual(store.threads.map(\.id), ["session:a"])
        XCTAssertFalse(store.alerts.reviews)

        h.scope = other
        // A frame for the old account after the switch is not this inbox's.
        store.receive(user: "Ada", thread: thread("session:late"), alert: true)
        XCTAssertTrue(store.threads.isEmpty)
        XCTAssertTrue(h.banners.isEmpty)
        XCTAssertEqual(h.badge.last, 0, "the old account's count leaves the icon")
        XCTAssertTrue(store.alerts.reviews, "alert settings are per account")

        await store.hydrate()
        XCTAssertEqual(Set(store.threads.map(\.id)), ["session:z", "session:y"])
        XCTAssertEqual(h.badge.last, 2)

        // A banner raised for the first account opens nothing in this one.
        store.openTapped(.init(threadId: "session:a", scope: acme))
        XCTAssertNil(store.openRequest)
    }

    func testAlertSettingsSaveToTheAccountAndRollBack() async throws {
        let h = Harness(scope: acme)
        let store = makeStore(h)
        await store.hydrate()
        try await store.setAlert(.mentions, false)
        XCTAssertFalse(store.alerts.mentions)
        XCTAssertEqual(h.savedAlerts.first?.0, acme)
        XCTAssertEqual(h.savedAlerts.first?.1, [.mentions: false])

        let failing = NotificationInboxStore(
            backend: .init(
                load: { _ in InboxPayload(threads: []) },
                mark: { _, _ in },
                saveAlerts: { _, _ in throw Refused() }
            ),
            scope: { h.scope },
            present: { _, _ in },
            withdraw: { _ in },
            isActive: { false },
            syncBadge: { _ in }
        )
        await failing.hydrate()
        do {
            try await failing.setAlert(.reminders, false)
            XCTFail("expected the save to throw")
        } catch {}
        XCTAssertTrue(failing.alerts.reminders)
    }

    // MARK: - Deep links

    func testDestinationsFollowTheWebRoutes() {
        XCTAssertEqual(InboxDestination.resolve(thread(url: "/session/os-7")), .session("os-7"))
        XCTAssertEqual(InboxDestination.route("/workspace/ws-1/session/os-8"), .session("os-8"))
        XCTAssertEqual(InboxDestination.route("/workspace/ws-1"), .workspace("ws-1"))
        XCTAssertEqual(InboxDestination.route("/workspace/ws-1/review?x=1"), .workspace("ws-1"))
        XCTAssertEqual(
            InboxDestination.route("/pr/acme%2Fapp/feature%2Flogin"),
            .pullRequest(repo: "acme/app", branch: "feature/login")
        )
        XCTAssertEqual(
            InboxDestination.route("https://acme.example.test/pr/app/fix/login"),
            .pullRequest(repo: "app", branch: "fix/login")
        )
        XCTAssertEqual(InboxDestination.resolve(thread("reminder:t-1", kind: "reminder", url: "/")), .tasks)
        XCTAssertEqual(InboxDestination.resolve(thread("workspace:ws-2", url: "")), .workspace("ws-2"))
        XCTAssertEqual(InboxDestination.resolve(thread("pr:x", url: "/settings")), .web("/settings"))
    }

    func testOpeningARowReadsItAndHandsOverItsDestination() async {
        let h = Harness(scope: acme)
        h.payloads[acme] = InboxPayload(threads: [thread("session:os-1")])
        let store = makeStore(h)
        await store.hydrate()
        store.open(store.threads[0])
        XCTAssertEqual(store.unreadCount, 0)
        XCTAssertEqual(store.takeOpenRequest()?.destination, .session("os-1"))
        XCTAssertNil(store.takeOpenRequest(), "consumed once")

        // A banner tapped before its row loaded still routes by its id.
        store.openTapped(.init(threadId: "workspace:ws-3", scope: acme))
        XCTAssertEqual(store.openRequest?.destination, .workspace("ws-3"))
    }

    // MARK: - Incidents

    func testIncidentKindsDecodeAndAlertUnderIncidents() throws {
        for raw in ["incident_heads_up", "incident_opened", "incident_needs_you", "incident_veto",
                    "incident_rolled_back", "incident_resolved", "incident_update"] {
            XCTAssertEqual(InboxKind(rawValue: raw)?.alertGroup, .incidents, raw)
        }
        let alerts = try JSONDecoder().decode(InboxAlerts.self, from: Data(#"{"reviews":true}"#.utf8))
        XCTAssertTrue(alerts.incidents, "an older server without the switch reads as on")
        let off = try JSONDecoder().decode(InboxAlerts.self, from: Data(#"{"incidents":false}"#.utf8))
        XCTAssertFalse(off.incidents)
    }

    func testIncidentBannerLeadsWithTheProject() {
        let t = InboxThread(id: "incident:inc-1", subject: .init(type: "incident", id: "inc-1", title: "Search", context: "acme"),
                            kind: "incident_veto", reason: "Search is down",
                            body: "The fix is verified and deploys at 12:37 unless you stop it",
                            url: "/incidents/inc-1", updatedAt: 1, unread: true, done: false)
        XCTAssertEqual(t.bannerBody, "acme · The fix is verified and deploys at 12:37 unless you stop it")
        XCTAssertEqual(InboxDestination.resolve(t), .web("/incidents/inc-1"))
        XCTAssertEqual(thread().bannerBody, "Fix login: Can you look?", "other rows keep their text")
    }

    func testIncidentSettingsRowMatchesTheWeb() {
        let row = NotificationsSettingsView.alertRows.last
        XCTAssertEqual(row?.group, .incidents)
        XCTAssertEqual(row?.title, "Incidents")
        XCTAssertEqual(
            row?.detail,
            "An incident you own opens, needs you, is about to deploy, rolls back or is fixed. At night only what can't wait"
        )
        XCTAssertEqual(Set(NotificationsSettingsView.alertRows.map(\.group)), Set(InboxAlerts.Group.allCases))
    }

    func testAReplaceFrameUpdatesQuietlyAndNeverRaisesABanner() async {
        let h = Harness(scope: acme)
        let store = makeStore(h)
        await store.hydrate()
        store.receive(user: "ada", thread: thread("incident:inc-1", updatedAt: 2_000), alert: false, replace: true)
        XCTAssertTrue(h.banners.isEmpty)
        XCTAssertEqual(h.replaced.map(\.id), ["incident:inc-1"])
        store.receive(user: "ada", thread: thread("incident:inc-1", updatedAt: 2_000), alert: false, replace: true)
        XCTAssertEqual(h.replaced.count, 1, "a duplicate frame is not news")
    }

    func testReplaceFramesDecode() {
        let frame = #"{"type":"notification","user":"Ada","alert":false,"replace":true,"notification":{"id":"incident:inc-1","subject":{"type":"incident","id":"inc-1","title":"Search"},"kind":"incident_update","reason":"Search is down","body":"Deploying the fix now","url":"/incidents/inc-1","updatedAt":5,"unread":false,"done":false}}"#
        guard case .notification(_, let thread, let alert, let replace) = ServerEvent.parse(Data(frame.utf8)) else {
            return XCTFail("expected a notification event")
        }
        XCTAssertEqual(thread?.knownKind, .incidentUpdate)
        XCTAssertFalse(alert)
        XCTAssertTrue(replace)
    }
}
