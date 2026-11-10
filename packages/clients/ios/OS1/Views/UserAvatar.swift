import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Small circular avatar: a person's GitHub picture, falling back to a tinted
/// initial for anyone the roster doesn't know (the agent persona, "Anonymous",
/// a teammate missing from the identity config) or when the image fails.
///
/// With no `person`, this is the device's signed-in user — the approximation
/// the composer uses when attributing prompts, since transcript entries carry
/// no per-message identity. Named viewers (the presence facepile) pass their
/// display name and resolve through `TeamDirectory`.
struct UserAvatar: View {
    /// Display name, as the server sends it. nil = whoever is signed in here.
    var person: String?
    /// Their GitHub login, when the caller already holds it. The roster does,
    /// and the directory this would otherwise resolve through is filled from
    /// /api/people, which an instance can leave empty — so without this the
    /// one screen that knows every login still draws initials.
    var login: String?
    var size: CGFloat = 26

    /// A first-party bot (Blob): drawn with its own picture and a "Bot"
    /// badge, never a GitHub face that shares its first name.
    private var isBot: Bool { TeamDirectory.shared.isBot(name) }

    private var resolvedLogin: String {
        if isBot { return "" }
        if let login, !login.isEmpty { return login }
        guard let person else { return ServerConfig.shared.githubLogin }
        return TeamDirectory.shared.githubLogin(for: person) ?? ""
    }

    /// A picture this person uploaded on the web, resolved against our server.
    /// It outranks the GitHub face because they chose it; the GitHub one is
    /// only ever a stand-in for a picture nobody set.
    private var uploadedURL: URL? {
        guard let path = TeamDirectory.shared.profileImage(for: name),
              !path.isEmpty,
              let base = ServerConfig.shared.baseURL
        else { return nil }
        return URL(string: base.absoluteString + path)
    }

    private var name: String { person ?? ServerConfig.shared.userName }

    var body: some View {
        Group {
            // Synchronous cache hit: recycled LazyVStack rows render the
            // image on their first frame instead of flashing the initial
            // (AsyncImage restarted the network load on every row rebuild,
            // and a cancelled load stuck on the fallback — the "sometimes
            // it shows" flakiness). Reading the observable cache in body
            // re-renders the row when a load lands.
            if let url = avatarURL,
               let image = AvatarImageCache.shared.images[url.absoluteString] {
                image.resizable().scaledToFill()
            } else {
                initialCircle
            }
        }
        .frame(width: size, height: size)
        // A squircle, not a circle: the web draws every avatar with the
        // `rounded-avatar` radius, which base.css gives a corner-shape (only
        // `rounded-full` is left circular). A superellipse at half the side is
        // that same shape. See `SquircleCapsule` for why SwiftUI's own
        // continuous corners collapse to a circle here and it has to be drawn.
        .clipShape(SquircleCapsule())
        .overlay(alignment: .bottomTrailing) {
            if isBot && size >= 24 { botBadge }
        }
        .accessibilityLabel(name.isEmpty ? "You" : isBot ? "\(name), bot" : name)
        // Keyed on the URL, not the login: a picture that is uploaded, replaced
        // or cleared changes the URL while the login stays put, and keying on
        // the login would leave the old face until the next launch.
        .task(id: avatarURL?.absoluteString ?? "") {
            if let url = avatarURL {
                await AvatarImageCache.shared.ensureLoaded(url)
            }
        }
    }

    private var avatarURL: URL? {
        if let uploadedURL { return uploadedURL }
        guard !resolvedLogin.isEmpty else { return nil }
        // GitHub serves any account's avatar at github.com/<login>.png; 3x the
        // point size keeps it crisp on retina displays.
        return URL(string: "https://github.com/\(resolvedLogin).png?size=\(Int(size * 3))")
    }

    /// The small label that keeps a bot from reading as a teammate.
    private var botBadge: some View {
        Text("Bot")
            .font(.system(size: max(7, size * 0.26), weight: .semibold))
            .foregroundStyle(OS1VisualStyle.text)
            .padding(.horizontal, 3)
            .background(Capsule().fill(.regularMaterial))
            .offset(x: size * 0.12, y: size * 0.08)
            .accessibilityHidden(true)
    }

    private var initialCircle: some View {
        ZStack {
            // The clip above already carries the shape; this fill matches it so
            // a fallback tile reads as the same silhouette while it is the only
            // thing drawn.
            SquircleCapsule().fill(fallbackColor.gradient)
            Text(initial)
                .font(.system(size: size * 0.45, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
        }
    }

    private var initial: String {
        let source = name.isEmpty ? resolvedLogin : name
        guard let first = source.trimmingCharacters(in: .whitespaces).first else {
            return "?"
        }
        return String(first).uppercased()
    }

    /// Stable per-name hue so the fallback doesn't shift between launches
    /// (Swift's hashValue is seeded per-process).
    private var fallbackColor: Color {
        let source = name.isEmpty ? resolvedLogin : name
        var hash: UInt32 = 2166136261
        for byte in source.utf8 {
            hash = (hash ^ UInt32(byte)) &* 16777619
        }
        let hue = Double(hash % 360) / 360
        return Color(hue: hue, saturation: 0.45, brightness: 0.75)
    }
}

/// Process-wide avatar image cache: each URL is fetched once and the decoded
/// image kept in memory, so every avatar after the first render is a
/// synchronous dictionary hit. Failures retry on a later request after a
/// cooldown (offline launch, GitHub hiccup) instead of sticking forever.
@MainActor
@Observable
final class AvatarImageCache {
    static let shared = AvatarImageCache()

    private(set) var images: [String: Image] = [:]
    private var inflight: Set<String> = []
    private var lastFailureAt: [String: Date] = [:]

    func ensureLoaded(_ url: URL) async {
        let key = url.absoluteString
        guard images[key] == nil, !inflight.contains(key) else { return }
        if let failed = lastFailureAt[key], Date().timeIntervalSince(failed) < 15 {
            return
        }
        inflight.insert(key)
        defer { inflight.remove(key) }
        // The HTTP cache still applies underneath, so a relaunch usually
        // repopulates without touching the network.
        //
        // An uploaded picture is served by OUR server, behind the same sign-in
        // gate as every other path, so it needs the bearer token. A GitHub
        // avatar is public and must NOT carry it: never send our token to a
        // host that is not ours.
        var request = ServerConfig.shared.isOwnURL(url)
            ? ServerConfig.shared.authorizedRequest(url)
            : URLRequest(url: url)
        request.cachePolicy = .returnCacheDataElseLoad
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse,
               !(200..<300).contains(http.statusCode) {
                lastFailureAt[key] = Date()
                return
            }
            #if os(macOS)
            guard let decoded = NSImage(data: data) else {
                lastFailureAt[key] = Date()
                return
            }
            images[key] = Image(nsImage: decoded)
            #else
            guard let decoded = UIImage(data: data) else {
                lastFailureAt[key] = Date()
                return
            }
            images[key] = Image(uiImage: decoded)
            #endif
            lastFailureAt[key] = nil
        } catch {
            lastFailureAt[key] = Date()
        }
    }
}
