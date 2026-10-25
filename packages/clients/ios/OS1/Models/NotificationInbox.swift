import Foundation

// Wire model of the server's notification inbox
// (src/server/notification-threads.ts, GET /api/notifications).
//
// One row per subject (a session, a pull request, a workspace, a reminder or
// an incident),
// with read and done state the server shares across every device. Decoding is
// deliberately tolerant: a field of the wrong type falls back to its default,
// a row without an id is dropped, and a kind this build does not know yet
// still shows, labelled by the reason text the server wrote for it.

/// The kinds the server records today. People notify people; agent activity
/// (questions, failed or finished runs) is not an inbox event. Incidents are
/// the exception: an incident you own notifies you as it changes, one row per
/// incident that later states update in place.
enum InboxKind: String, CaseIterable, Sendable {
    case reviewRequested = "review_requested"
    /// Asked only through a team the person is on (code owners, say).
    case teamReviewRequested = "team_review_requested"
    case reviewDone = "review_done"
    case mention
    /// A reply, resolve or assignment on a comment thread you are in.
    case comment
    case collaborator
    case reminder
    /// Something may go wrong soon, or fails on and off. Never "is down".
    case incidentHeadsUp = "incident_heads_up"
    case incidentOpened = "incident_opened"
    /// A decision only the owner can make.
    case incidentNeedsYou = "incident_needs_you"
    /// A verified fix deploys unless someone stops it.
    case incidentVeto = "incident_veto"
    case incidentRolledBack = "incident_rolled_back"
    case incidentResolved = "incident_resolved"
    /// Progress (deploying, watching, stopped): updates the row quietly.
    case incidentUpdate = "incident_update"

    /// The alert switch that governs this kind, as the server groups them
    /// (`notification-threads.ts`): comments ride with mentions.
    var alertGroup: InboxAlerts.Group {
        switch self {
        case .reviewRequested, .reviewDone: .reviews
        case .teamReviewRequested: .teamReviews
        case .mention, .comment: .mentions
        case .collaborator: .collaborators
        case .reminder: .reminders
        case .incidentHeadsUp, .incidentOpened, .incidentNeedsYou, .incidentVeto,
             .incidentRolledBack, .incidentResolved, .incidentUpdate: .incidents
        }
    }
}

struct InboxThread: Decodable, Equatable, Identifiable, Sendable {
    struct Subject: Equatable, Sendable {
        /// `session`, `pr`, `workspace`, `reminder` or `incident`, kept raw
        /// so a newer subject type still decodes.
        var type: String
        var id: String
        var title: String
        /// Repository or workspace label shown above the title.
        var context: String?
    }

    /// `<subject type>:<subject id>`. Stable for the life of the subject.
    let id: String
    var subject: Subject
    /// Raw on the wire; `knownKind` is nil for a kind newer than this build.
    var kind: String
    /// Why this is here, short: "Ada asked for your review".
    var reason: String
    var body: String
    var actor: String?
    /// In-app path to open, e.g. `/session/os-…`.
    var url: String
    /// Milliseconds since the epoch of the latest event.
    var updatedAt: Double
    var unread: Bool
    var done: Bool

    var knownKind: InboxKind? { InboxKind(rawValue: kind) }
    /// The comment thread this row opens, from `?thread=` on its link.
    var commentThreadId: String? { CommentThreads.threadId(inLink: url) }
    var updatedDate: Date { Date(timeIntervalSince1970: updatedAt / 1000) }

    init(
        id: String,
        subject: Subject,
        kind: String,
        reason: String,
        body: String = "",
        actor: String? = nil,
        url: String,
        updatedAt: Double,
        unread: Bool,
        done: Bool
    ) {
        self.id = id
        self.subject = subject
        self.kind = kind
        self.reason = reason
        self.body = body
        self.actor = actor
        self.url = url
        self.updatedAt = updatedAt
        self.unread = unread
        self.done = done
    }

    private enum CodingKeys: String, CodingKey {
        case id, subject, kind, reason, body, actor, url, updatedAt, unread, done
    }

    private enum SubjectKeys: String, CodingKey {
        case type, id, title, context
    }

    struct MissingID: Error {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func string(_ key: CodingKeys) -> String? {
            (try? c.decodeIfPresent(String.self, forKey: key)) ?? nil
        }
        var subject = Subject(type: "", id: "", title: "", context: nil)
        if let s = try? c.nestedContainer(keyedBy: SubjectKeys.self, forKey: .subject) {
            subject.type = ((try? s.decodeIfPresent(String.self, forKey: .type)) ?? nil) ?? ""
            subject.id = ((try? s.decodeIfPresent(String.self, forKey: .id)) ?? nil) ?? ""
            subject.title = ((try? s.decodeIfPresent(String.self, forKey: .title)) ?? nil) ?? ""
            let context = (try? s.decodeIfPresent(String.self, forKey: .context)) ?? nil
            subject.context = context?.isEmpty == false ? context : nil
        }
        // The id is `type:id`; either half can stand in for the other.
        var id = string(.id) ?? ""
        if id.isEmpty, !subject.type.isEmpty, !subject.id.isEmpty {
            id = "\(subject.type):\(subject.id)"
        }
        guard !id.isEmpty else { throw MissingID() }
        if subject.type.isEmpty || subject.id.isEmpty,
           let colon = id.firstIndex(of: ":") {
            if subject.type.isEmpty { subject.type = String(id[..<colon]) }
            if subject.id.isEmpty { subject.id = String(id[id.index(after: colon)...]) }
        }
        self.id = id
        self.subject = subject
        kind = string(.kind) ?? ""
        reason = string(.reason) ?? ""
        body = string(.body) ?? ""
        let actor = string(.actor)
        self.actor = actor?.isEmpty == false ? actor : nil
        url = string(.url) ?? ""
        updatedAt = ((try? c.decodeIfPresent(Double.self, forKey: .updatedAt)) ?? nil) ?? 0
        unread = ((try? c.decodeIfPresent(Bool.self, forKey: .unread)) ?? nil) ?? false
        done = ((try? c.decodeIfPresent(Bool.self, forKey: .done)) ?? nil) ?? false
    }

    /// The banner body, the way the server words its own push: an incident
    /// or a support row leads with the project ("acme · Deploying the fix
    /// now", "acme · Open Sessions to read it and send"), where a support
    /// row's body is fixed copy and its title the subject ("A support reply
    /// is ready"), never a customer's words; every other row is the
    /// subject, then the detail.
    var bannerBody: String {
        if subject.type == "incident" || subject.type == "support" {
            return [subject.context ?? "", body].filter { !$0.isEmpty }.joined(separator: " · ")
        }
        return [subject.title, body].filter { !$0.isEmpty }.joined(separator: ": ")
    }
}

/// Which kinds also raise a banner and a sound. Saved on the server per
/// person, so the choice follows them to every device. Everything still
/// lands in the inbox either way.
struct InboxAlerts: Equatable, Sendable, Decodable {
    var reviews = true
    var teamReviews = true
    var mentions = true
    var collaborators = true
    var reminders = true
    var incidents = true

    static let defaults = InboxAlerts()

    enum Group: String, CaseIterable, Sendable {
        case reviews, teamReviews, mentions, collaborators, reminders, incidents
    }

    subscript(group: Group) -> Bool {
        get {
            switch group {
            case .reviews: reviews
            case .teamReviews: teamReviews
            case .mentions: mentions
            case .collaborators: collaborators
            case .reminders: reminders
            case .incidents: incidents
            }
        }
        set {
            switch group {
            case .reviews: reviews = newValue
            case .teamReviews: teamReviews = newValue
            case .mentions: mentions = newValue
            case .collaborators: collaborators = newValue
            case .reminders: reminders = newValue
            case .incidents: incidents = newValue
            }
        }
    }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Group.CodingKeys.self)
        func flag(_ key: Group.CodingKeys) -> Bool {
            ((try? c.decodeIfPresent(Bool.self, forKey: key)) ?? nil) ?? true
        }
        reviews = flag(.reviews)
        teamReviews = flag(.teamReviews)
        mentions = flag(.mentions)
        collaborators = flag(.collaborators)
        reminders = flag(.reminders)
        incidents = flag(.incidents)
    }
}

extension InboxAlerts.Group {
    enum CodingKeys: String, CodingKey {
        case reviews, teamReviews, mentions, collaborators, reminders, incidents
    }
}

/// `GET /api/notifications`. A row this build cannot read is dropped rather
/// than failing the whole inbox.
struct InboxPayload: Decodable, Equatable, Sendable {
    var threads: [InboxThread]
    var alerts: InboxAlerts

    init(threads: [InboxThread], alerts: InboxAlerts = .defaults) {
        self.threads = threads
        self.alerts = alerts
    }

    private enum CodingKeys: String, CodingKey { case threads, alerts }

    private struct Lossy: Decodable {
        let thread: InboxThread?
        init(from decoder: Decoder) throws {
            thread = try? InboxThread(from: decoder)
        }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        threads = (((try? c.decodeIfPresent([Lossy].self, forKey: .threads)) ?? nil) ?? [])
            .compactMap(\.thread)
        alerts = ((try? c.decodeIfPresent(InboxAlerts.self, forKey: .alerts)) ?? nil) ?? .defaults
    }
}

/// A read, unread, done or not-done change. `ids` empty with `all` touches
/// every row. Mirrors `POST /api/notifications/mark`.
struct InboxMark: Equatable, Sendable {
    var ids: [String] = []
    var all = false
    var unread: Bool?
    var done: Bool?

    var body: [String: Any] {
        var body: [String: Any] = all ? ["all": true] : ["ids": ids]
        if let unread { body["unread"] = unread }
        if let done { body["done"] = done }
        return body
    }
}

enum InboxFilter: String, CaseIterable, Sendable {
    case unread, all, done

    var title: String {
        switch self {
        case .unread: "Unread"
        case .all: "All"
        case .done: "Done"
        }
    }
}

enum InboxModel {
    /// The rows a filter shows, newest first. Done rows only show under Done.
    static func filter(_ threads: [InboxThread], _ filter: InboxFilter) -> [InboxThread] {
        threads
            .filter { thread in
                switch filter {
                case .done: thread.done
                case .all: !thread.done
                case .unread: !thread.done && thread.unread
                }
            }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    static func unreadCount(_ threads: [InboxThread]) -> Int {
        threads.lazy.filter { $0.unread && !$0.done }.count
    }

    /// The same rule the server applies: done implies read.
    static func apply(_ mark: InboxMark, to threads: [InboxThread]) -> [InboxThread] {
        let ids = Set(mark.ids)
        return threads.map { thread in
            guard mark.all || ids.contains(thread.id) else { return thread }
            var next = thread
            if let unread = mark.unread { next.unread = unread }
            if let done = mark.done {
                next.done = done
                if done { next.unread = false }
            }
            return next
        }
    }
}

/// Where a row leads, worked out from its in-app URL. The web routes the
/// same paths (src/frontend/lib/app-route.ts).
enum InboxDestination: Equatable, Sendable {
    case session(String)
    case workspace(String)
    case pullRequest(repo: String, branch: String)
    /// A Desk reminder: your task list.
    case tasks
    /// Anything else opens on the web, at this path on the server.
    case web(String)

    static func resolve(_ thread: InboxThread) -> InboxDestination {
        if thread.subject.type == "reminder" { return .tasks }
        if let routed = route(thread.url) { return routed }
        switch thread.subject.type {
        case "session" where !thread.subject.id.isEmpty:
            return .session(thread.subject.id)
        case "workspace" where !thread.subject.id.isEmpty:
            return .workspace(thread.subject.id)
        default:
            return .web(thread.url.isEmpty ? "/" : thread.url)
        }
    }

    /// Parse an in-app path (or a full URL on the server) into a place.
    static func route(_ url: String) -> InboxDestination? {
        let path: String
        // Segments are split while still encoded, so a repo id carrying an
        // encoded slash stays one segment.
        if let parsed = URLComponents(string: url), parsed.scheme != nil {
            path = parsed.percentEncodedPath
        } else {
            path = String(url.prefix { $0 != "?" && $0 != "#" })
        }
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
            .map { String($0).removingPercentEncoding ?? String($0) }
        switch parts.first {
        case "session" where parts.count >= 2:
            return .session(parts[1])
        case "workspace" where parts.count >= 4 && parts[2] == "session":
            return .session(parts[3])
        case "workspace" where parts.count >= 2:
            return .workspace(parts[1])
        case "pr" where parts.count >= 3:
            // The server encodes the branch as one segment; an older link
            // may have left its slashes bare.
            return .pullRequest(repo: parts[1], branch: parts[2...].joined(separator: "/"))
        default:
            return nil
        }
    }
}
