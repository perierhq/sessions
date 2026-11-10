import Foundation

/// Who to credit for a user turn in a transcript, and whether their words came
/// back through Slack.
///
/// A right-aligned bubble says "a person wrote this"; it does not say WHICH
/// person, and in a shared instance that is most of the question. Two things
/// decide it:
///
/// - An explicit `sender`, set server-side when a teammate steers into someone
///   else's session or answers a question routed to them.
/// - Otherwise the session's `owner`. The owner's own prompts carry no sender
///   at all, so without this fallback a teammate's whole session reads as if
///   you had written it — which is what the native app did until 2026-08.
///
/// Nobody is credited for the viewer's own words: the alignment already says
/// that, and a label naming you is noise.
enum MessageAttribution {
    struct Credit: Equatable {
        let name: String
        /// A reply relayed from Slack, which the UI marks more warmly than an
        /// in-app steer.
        let viaSlack: Bool
        /// Blob, the supervisor: a bot, credited as itself, never a person.
        var isBot: Bool { MessageAttribution.isBlob(name) }
    }

    /// Blob's name as the server sends it (session-actors.ts BLOB_ACTOR).
    static let blobName = "Blob"

    static func isBlob(_ name: String) -> Bool {
        name.trimmingCharacters(in: .whitespaces)
            .caseInsensitiveCompare(blobName) == .orderedSame
    }

    /// `viewerName` is the display name the app knows itself by, `viewerLogin`
    /// the GitHub login — a device whose token was pasted rather than signed
    /// in has only the second.
    static func credit(
        sender: String?,
        senderVia: String?,
        owner: String?,
        viewerName: String,
        viewerLogin: String
    ) -> Credit? {
        let author = author(sender: sender, owner: owner)
        guard let author else { return nil }
        // Blob is never the viewer, whatever their name starts with.
        if isBlob(author) { return Credit(name: author, viaSlack: false) }
        if isViewer(author, viewerName: viewerName, viewerLogin: viewerLogin) {
            return nil
        }
        return Credit(name: author, viaSlack: senderVia == "slack")
    }

    /// The author of a person's turn. An explicit steer or routed reply wins;
    /// otherwise the session owner wrote the ordinary prompt.
    static func author(sender: String?, owner: String?) -> String? {
        (sender?.isEmpty == false ? sender : nil)
            ?? (owner?.isEmpty == false ? owner : nil)
    }

    static func isViewerMessage(
        sender: String?,
        owner: String?,
        viewerName: String,
        viewerLogin: String
    ) -> Bool {
        guard let author = author(sender: sender, owner: owner) else { return false }
        if isBlob(author) { return false }
        return isViewer(author, viewerName: viewerName, viewerLogin: viewerLogin)
    }

    static func isViewer(
        _ name: String,
        viewerName: String,
        viewerLogin: String
    ) -> Bool {
        looselyMatches(name, viewerName) || looselyMatches(name, viewerLogin)
    }

    /// Names arrive in several shapes for one person — a display name
    /// ("Michiel Westerbeek"), the first name the server prefixes onto a steer
    /// ("Michiel"), a GitHub login ("kentdebruin"). The web's `isMe` settles
    /// it with a prefix compare in either direction; this matches it so the
    /// two clients credit the same turns to the same people.
    private static func looselyMatches(_ name: String, _ me: String) -> Bool {
        let a = name.lowercased()
        let b = me.lowercased()
        // "ios" is ServerConfig's placeholder for "nobody has said who this
        // is", not a person — matching on it would unlabel a teammate whose
        // name merely starts the same way.
        guard !b.isEmpty, b != "ios" else { return false }
        return a == b || a.hasPrefix(b) || b.hasPrefix(a)
    }
}
