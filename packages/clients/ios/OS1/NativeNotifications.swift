import Foundation
import UserNotifications
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// This device's side of notifications: whether banners show here, their
/// sound, when they may interrupt, and the app icon badge. What happened and
/// what is read or done belongs to the server inbox (`NotificationInboxStore`);
/// nothing in this file decides that something is news.
///
/// A banner is only ever raised for a live `notification` frame the server
/// marked as alerting, so a reconnect, a relaunch or an account switch cannot
/// replay one. The app watches no session runs or questions for alerts.
@MainActor
enum NativeNotifications {
    nonisolated static let bannersKey = "os1.notifications.pushAlerts"
    nonisolated static let soundKey = "os1.notifications.completionSound"
    nonisolated static let whenKey = "os1.notifications.whenToNotify"
    nonisolated static let badgeEnabledKey = "os1.notifications.unreadBadge"
    nonisolated private static let badgeCountKey = "os1.notifications.unreadBadgeCount"

    /// Event switches from before the server inbox. Agent activity no longer
    /// notifies anyone, and which people events alert is an account setting.
    nonisolated static let retiredKeys = [
        "os1.notifications.needsInput",
        "os1.notifications.runComplete",
    ]

    /// Seams for tests: where a banner goes, and whether the app is in front.
    static var deliver: (UNNotificationRequest) -> Void = { request in
        UNUserNotificationCenter.current().add(request)
    }
    static var withdraw: ([String]) -> Void = { identifiers in
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: identifiers)
    }
    static var isAppActive: () -> Bool = { applicationIsActive }

    static func requestAuthorization() async -> Bool {
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .badge, .sound]
        )) == true
        refreshBadge()
        return granted
    }

    static func requestBadgeAuthorization() async -> Bool {
        #if canImport(UIKit)
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(
            options: [.badge]
        )) == true
        refreshBadge()
        return granted
        #else
        // The Dock tile needs no permission.
        refreshBadge()
        return true
        #endif
    }

    static func retireLegacyPreferences(_ defaults: UserDefaults = .standard) {
        for key in retiredKeys { defaults.removeObject(forKey: key) }
    }

    /// Keep the Home Screen and Dock icon on the inbox's unread count, the
    /// same number the bell shows. The badge has its own device-local switch,
    /// so it can stay on without banners or sounds.
    static func syncBadgeCount(_ count: Int) {
        let defaults = UserDefaults.standard
        let next = max(0, count)
        guard defaults.object(forKey: badgeCountKey) as? Int != next else { return }
        defaults.set(next, forKey: badgeCountKey)
        refreshBadge()
    }

    static func refreshBadge() {
        let defaults = UserDefaults.standard
        let count = defaults.bool(forKey: badgeEnabledKey)
            ? defaults.integer(forKey: badgeCountKey)
            : 0
        #if canImport(UIKit)
        Task {
            try? await UNUserNotificationCenter.current().setBadgeCount(count)
        }
        #else
        NSApp?.dockTile.badgeLabel = count > 0 ? "\(count)" : nil
        #endif
    }

    /// One OS notification per inbox row, the same tag the server uses for
    /// Web Push: a newer event on a row replaces its banner instead of
    /// stacking, and reading the row takes it away.
    static func identifier(for threadId: String) -> String {
        "os-notification-\(threadId)"
    }

    /// Whether this device shows a banner right now, from its own choices.
    static func allowsBanner(
        defaults: UserDefaults = .standard,
        active: Bool
    ) -> Bool {
        guard defaults.bool(forKey: bannersKey) else { return false }
        switch defaults.string(forKey: whenKey) ?? "background" {
        case "never": return false
        case "always": return true
        default: return !active
        }
    }

    /// Show a banner for an inbox row the server said should alert.
    static func present(_ thread: InboxThread, scope: InboxScope) {
        let defaults = UserDefaults.standard
        guard allowsBanner(defaults: defaults, active: isAppActive()) else { return }
        let content = UNMutableNotificationContent()
        content.title = thread.reason.isEmpty ? thread.subject.title : thread.reason
        content.body = thread.reason.isEmpty ? thread.body : thread.bannerBody
        content.threadIdentifier = thread.id
        content.userInfo = NotificationTap.userInfo(thread: thread, scope: scope)
        if defaults.string(forKey: soundKey) != "none" {
            content.sound = .default
        }
        deliver(UNNotificationRequest(
            identifier: identifier(for: thread.id),
            content: content,
            trigger: nil
        ))
    }

    /// Update a banner still on screen with a row's newer text, quietly: no
    /// sound and a passive interruption. With no banner for the row
    /// delivered, nothing happens; a replace never raises a new one.
    static func replaceIfDelivered(_ thread: InboxThread, scope: InboxScope) {
        let id = identifier(for: thread.id)
        let content = UNMutableNotificationContent()
        content.title = thread.reason.isEmpty ? thread.subject.title : thread.reason
        content.body = thread.reason.isEmpty ? thread.body : thread.bannerBody
        content.threadIdentifier = thread.id
        content.userInfo = NotificationTap.userInfo(thread: thread, scope: scope)
        content.interruptionLevel = .passive
        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        Task { @MainActor in
            guard await isDelivered(id) else { return }
            deliver(request)
        }
    }

    /// Seam for tests: whether a banner with this identifier is on screen.
    static var isDelivered: (String) async -> Bool = { identifier in
        await UNUserNotificationCenter.current().deliveredNotifications()
            .contains { $0.request.identifier == identifier }
    }

    /// Take banners down once their rows are read or done, here or elsewhere.
    static func withdraw(threadIds: [String]) {
        guard !threadIds.isEmpty else { return }
        withdraw(threadIds.map(identifier(for:)))
    }

    private static var applicationIsActive: Bool {
        #if canImport(UIKit)
        UIApplication.shared.applicationState == .active
        #else
        NSApp?.isActive ?? false
        #endif
    }
}

/// What a banner carries so a tap can open its row, and the delegate that
/// routes the tap. The account travels with it: a banner tapped after an
/// account switch must not open, or mark, a row in the wrong inbox.
enum NotificationTap {
    static func userInfo(thread: InboxThread, scope: InboxScope) -> [String: String] {
        var info = [
            "threadId": thread.id,
            "server": scope.server,
            "user": scope.user,
        ]
        // The row's link, so a cold launch from the banner can still focus
        // the comment thread it names before the inbox has loaded.
        if !thread.url.isEmpty { info["url"] = thread.url }
        return info
    }

    struct Target: Equatable, Sendable {
        let threadId: String
        let scope: InboxScope
        var url: String? = nil
    }

    static func target(from userInfo: [AnyHashable: Any]) -> Target? {
        guard let threadId = userInfo["threadId"] as? String,
              let server = userInfo["server"] as? String,
              let user = userInfo["user"] as? String
        else { return nil }
        return Target(
            threadId: threadId,
            scope: InboxScope(server: server, user: user),
            url: userInfo["url"] as? String
        )
    }
}

final class NotificationTapRouter: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    static let shared = NotificationTapRouter()

    @MainActor
    static func install() {
        UNUserNotificationCenter.current().delegate = shared
    }

    // The app only posts while it decided a banner is wanted (see
    // `NativeNotifications.allowsBanner`), so a foreground banner is one the
    // person asked for with "Always".
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let target = NotificationTap.target(
                from: response.notification.request.content.userInfo
              )
        else { return }
        await MainActor.run {
            NotificationInboxStore.shared.openTapped(target)
        }
    }
}
