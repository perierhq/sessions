import BlobCore
import Foundation
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// The words you say that a speech model can't know: project names, repos,
/// teammates' first names, Pat and Blob, PR. The server builds the list
/// (`GET /api/blob/glossary`, blob-glossary.ts); it is kept on the device and
/// refreshed at most hourly, when you start talking.
///
/// It goes two places. Apple's transcriber gets it as contextual strings
/// (`BlobListener`): Apple says only `DictationTranscriber` uses them for
/// now, so the `SpeechTranscriber` captions may ignore them, while the
/// `Dictation` fallback's `SFSpeechRecognizer` does use them. And the final
/// text, whoever wrote it, goes through `correct`, which swaps a near miss
/// for the word it missed ("Butter Band" for the BetterBahn project).
///
/// Parakeet gets no vocabulary: FluidAudio's boosting needs a second, 97.5 MB
/// English-only CTC encoder on top of a model that already takes tens of
/// seconds to load, and Fish's API takes no prompt or hotwords. Both rely on
/// `correct`.
enum BlobGlossary {
    static let log = BlobLog(category: "glossary")
    private static let termsKey = "blob.glossary.terms"
    private static let fetchedKey = "blob.glossary.fetchedAt"
    private static let serverKey = "blob.glossary.server"
    private static let refreshAfter: TimeInterval = 60 * 60

    /// The last list the signed-in server sent; empty until the first fetch,
    /// and for any other server or account than the one it came from.
    static var terms: [String] {
        guard let server = currentServer,
              UserDefaults.standard.string(forKey: serverKey) == server
        else { return [] }
        return UserDefaults.standard.stringArray(forKey: termsKey) ?? []
    }

    /// Drops the kept list. ServerConfig calls it on sign-out and when the
    /// server address changes, so one server's names never reach another.
    static func forget() {
        for key in [termsKey, fetchedKey, serverKey] {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    /// The account and address the list belongs to; nil when signed out.
    private static var currentServer: String? {
        let config = ServerConfig.shared
        guard config.isConfigured else { return nil }
        return config.activeId + " " + config.baseURLString
    }

    /// Fetches the list when the one kept is older than an hour or from
    /// another server. Never throws: a failed fetch keeps the old list.
    @MainActor
    static func refreshIfStale() {
        guard let server = currentServer, !refreshing else { return }
        let fetched = UserDefaults.standard.double(forKey: fetchedKey)
        let sameServer = UserDefaults.standard.string(forKey: serverKey) == server
        guard !sameServer || Date().timeIntervalSince1970 - fetched >= refreshAfter else { return }
        refreshing = true
        Task { @MainActor in
            defer { refreshing = false }
            guard let fresh = try? await OS1API.blobGlossary(),
                  currentServer == server // signed out or switched while it loaded
            else { return }
            UserDefaults.standard.set(Array(fresh.prefix(100)), forKey: termsKey)
            UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: fetchedKey)
            UserDefaults.standard.set(server, forKey: serverKey)
            log.info("refreshed terms=\(fresh.count)")
        }
    }

    @MainActor private static var refreshing = false

    typealias Correction = BlobGlossaryCorrector.Correction

    /// `text` with near misses of glossary terms replaced, with the system
    /// spell checker (`BlobGlossaryCorrector.correct` has the rules).
    @MainActor
    static func correct(_ text: String, glossary: [String]) -> Correction {
        BlobGlossaryCorrector.correct(text, glossary: glossary, isWord: isDictionaryWord)
    }

    /// Whether the system spell checker knows `word` in the current
    /// language: UITextChecker on iOS, NSSpellChecker on macOS.
    @MainActor
    static func isDictionaryWord(_ word: String) -> Bool {
        #if canImport(UIKit)
        let checker = UITextChecker()
        let range = NSRange(location: 0, length: (word as NSString).length)
        let misspelled = checker.rangeOfMisspelledWord(
            in: word, range: range, startingAt: 0, wrap: false, language: checkerLanguage
        )
        return misspelled.location == NSNotFound
        #elseif canImport(AppKit)
        let misspelled = NSSpellChecker.shared.checkSpelling(
            of: word, startingAt: 0, language: nil, wrap: false,
            inSpellDocumentWithTag: 0, wordCount: nil
        )
        return misspelled.location == NSNotFound
        #else
        return false
        #endif
    }

    #if canImport(UIKit)
    /// The checker language closest to the person's first preferred one
    /// ("en-GB" to en_GB, else any en_*), English when none fits.
    @MainActor
    private static var checkerLanguage: String {
        let available = UITextChecker.availableLanguages
        let preferred = (Locale.preferredLanguages.first ?? "en").replacingOccurrences(of: "-", with: "_")
        if available.contains(preferred) { return preferred }
        let language = String(preferred.prefix { $0 != "_" })
        return available.first { $0 == language || $0.hasPrefix(language + "_") }
            ?? available.first { $0.hasPrefix("en") } ?? "en_US"
    }
    #endif
}
