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

    struct Correction: Equatable {
        var text: String
        /// How many places changed.
        var fixes: Int
    }

    /// `text` with near misses of glossary terms replaced. Conservative on
    /// purpose; a wrong fix is worse than a missed one:
    ///
    /// - Nothing inside a URL, path, file name, email or handle (a token
    ///   with "/", ".", "@" in it) or between backticks changes.
    /// - Only a capitalized span changes, the way the transcribers write a
    ///   name they don't know: one to three words joined by spaces or
    ///   hyphens, every word capitalized, with a capital on a word that
    ///   doesn't start a sentence.
    /// - The span must sound like the term (`phonetic` keys at most one
    ///   apart, none for short words, same first sound) and be spelled close
    ///   to it (`allowedEdits`; a single word at most one change, two from
    ///   nine letters). A span that is already a term stays; a plural of
    ///   one is not a near miss. A single word changes only with five
    ///   letters or more and when the spell checker doesn't know it in the
    ///   current language, so "Mac" never becomes Max nor "Git" Kit. A one-word name heard as two capitalized
    ///   words ("Better Bahn") is joined; a lowercase id (`frontend`) never
    ///   is.
    /// - Only a term with a capital in it (a name) is what something
    ///   changes into, so lowercase ids (`frontend`, `web-app`) and common
    ///   words in the glossary ("merge", "lead") never are.
    /// - Two terms equally close: nothing changes.
    /// - "piers", "peers" and "pier" become PRs or PR only next to a PR
    ///   word: a number after them ("piers #12"; a bare number only after
    ///   the plural, so "Pier 39" stays), an action before them ("open
    ///   piers", "merged pier") or a passive one after ("piers were
    ///   opened").
    /// - A lowercase word becomes a name ("have mice check" to "have Mike
    ///   check") only between an asking word (have, ask, tell, hey, thanks,
    ///   ping) and a verb a name takes there (check, review, fix...), for a
    ///   name of four letters or more, sounding the same and one letter
    ///   off. So "have pet hair" and "have tea." stay.
    @MainActor
    static func correct(_ text: String, glossary: [String]) -> Correction {
        correct(text, glossary: glossary, isWord: isDictionaryWord)
    }

    /// `correct` with the spell check passed in: `isWord` is true for a
    /// word the current language has.
    static func correct(_ text: String, glossary: [String], isWord: (String) -> Bool) -> Correction {
        let terms = glossary.compactMap(Term.init)
        guard !terms.isEmpty else { return Correction(text: text, fixes: 0) }
        let known = Set(terms.map(\.key))
        let knownPhrases = Set(terms.filter(\.multiword).map(\.key))
        let words = Self.words(in: text)
        var out = ""
        var cursor = text.startIndex
        var fixes = 0
        var i = 0
        while i < words.count {
            guard !words[i].protected else { i += 1; continue }
            let spans = stride(from: min(3, words.count - i), through: 1, by: -1)
                .map { Array(words[i..<(i + $0)]) }
                .filter { Self.joined($0, in: text) && !$0.contains(where: \.protected) }
            // Already a term, as written: keep it whole. Words that spell a
            // one-word term ("Better Bahn") are joined below instead.
            if let exact = spans.first(where: {
                ($0.count == 1 ? known : knownPhrases).contains(Self.key($0.map(\.core).joined()))
            }) {
                i += exact.count
                continue
            }
            // The closest near miss over every span length here; the longer
            // span when two are as close.
            var best: (span: [Word], term: Term, edits: Int)?
            for span in spans {
                guard let found = Self.match(span, in: text, terms: terms, known: known, isWord: isWord),
                      best.map({ found.edits < $0.edits }) ?? true
                else { continue }
                best = (span, found.term, found.edits)
            }
            if let best {
                let last = best.span[best.span.count - 1]
                out += text[cursor..<best.span[0].range.lowerBound]
                out += best.term.text + last.possessive
                cursor = last.range.upperBound
                fixes += 1
                i += best.span.count
                continue
            }
            if let fix = Self.prFix(words, at: i, in: text, terms: terms)
                ?? Self.nameFix(words, at: i, in: text, terms: terms) {
                out += text[cursor..<words[i].range.lowerBound]
                out += fix
                cursor = words[i].range.upperBound
                fixes += 1
            }
            i += 1
        }
        out += text[cursor...]
        return Correction(text: out, fixes: fixes)
    }

    // MARK: - Matching

    struct Term {
        let text: String
        /// Letters and digits, lowercased.
        let key: String
        let sound: String
        let capitalized: Bool
        let multiword: Bool

        init?(_ raw: String) {
            let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            let key = BlobGlossary.key(text)
            guard key.count >= 2 else { return nil }
            self.text = text
            self.key = key
            sound = BlobGlossary.phonetic(key)
            capitalized = text.contains(where: \.isUppercase)
            multiword = text.contains(" ")
        }
    }

    struct Word {
        let range: Range<String.Index>
        /// The word without a trailing possessive.
        let core: String
        /// "'s" when the word had one, put back after a replacement.
        let possessive: String
        /// Part of a URL, path, file name, email or code: never changed.
        var protected = false
    }

    private static func words(in text: String) -> [Word] {
        var words: [Word] = []
        var index = text.startIndex
        while index < text.endIndex {
            guard text[index].isLetter || text[index].isNumber else {
                index = text.index(after: index); continue
            }
            var end = index
            while end < text.endIndex {
                let c = text[end]
                if c.isLetter || c.isNumber {
                    end = text.index(after: end)
                } else if c == "'" || c == "\u{2019}",
                          text.index(after: end) < text.endIndex,
                          text[text.index(after: end)].isLetter {
                    end = text.index(after: end)
                } else { break }
            }
            let raw = String(text[index..<end])
            var core = raw, possessive = ""
            for suffix in ["'s", "\u{2019}s"] where raw.lowercased().hasSuffix(suffix) && raw.count > 2 {
                core = String(raw.dropLast(2))
                possessive = String(raw.suffix(2))
            }
            words.append(Word(range: index..<end, core: core, possessive: possessive))
            index = end
        }
        let shielded = protectedRanges(in: text)
        for k in words.indices where shielded.contains(where: { $0.overlaps(words[k].range) }) {
            words[k].protected = true
        }
        return words
    }

    /// Text no fix may touch: what sits between backticks (to the end when
    /// one is left open), and every space-separated token with "/", "@" or
    /// "." inside it ("://" included); a sentence's closing punctuation
    /// doesn't count, so "have tea." is still words.
    private static func protectedRanges(in text: String) -> [Range<String.Index>] {
        var ranges: [Range<String.Index>] = []
        var open: String.Index?
        for index in text.indices where text[index] == "`" {
            if let start = open {
                ranges.append(start..<text.index(after: index))
                open = nil
            } else {
                open = index
            }
        }
        if let open { ranges.append(open..<text.endIndex) }
        var start: String.Index?
        for index in text.indices + [text.endIndex] {
            let space = index == text.endIndex || text[index].isWhitespace
            if !space {
                if start == nil { start = index }
                continue
            }
            guard let from = start else { continue }
            start = nil
            let token = text[from..<index]
            let core = token.reversed().drop(while: { ".,!?;:)]}\"'\u{201D}\u{2019}\u{2026}".contains($0) })
            if core.contains(where: { $0 == "/" || $0 == "@" || $0 == "." }) {
                ranges.append(from..<index)
            }
        }
        return ranges
    }

    /// The words follow each other with one space or hyphen between them,
    /// and only the last may carry a possessive.
    private static func joined(_ span: [Word], in text: String) -> Bool {
        for (a, b) in zip(span, span.dropFirst()) {
            guard a.possessive.isEmpty else { return false }
            let gap = text[a.range.upperBound..<b.range.lowerBound]
            guard gap == " " || gap == "-" else { return false }
        }
        return true
    }

    private static func sentenceStart(_ word: Word, in text: String) -> Bool {
        let before = text[..<word.range.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
        guard let last = before.last else { return true }
        return ".!?:\n\"\u{201C}".contains(last)
    }

    private static func match(
        _ span: [Word], in text: String, terms: [Term], known: Set<String>, isWord: (String) -> Bool
    ) -> (term: Term, edits: Int)? {
        // A capital the transcriber chose: not the one every sentence starts with.
        let capitals = span.filter { $0.core.first?.isUppercase == true && !sentenceStart($0, in: text) }
        guard !capitals.isEmpty else { return nil }
        // Every word of a longer span capitalized: "Betterbahm now" is one
        // word and "now", not a name.
        if span.count > 1, span.contains(where: { $0.core.first?.isUppercase != true }) { return nil }
        let spanKey = key(span.map(\.core).joined(separator: " "))
        // A one-word name heard as words: "Better Bahn" is BetterBahn. Never
        // a lowercase id: "Front End" stays, not `frontend`.
        if span.count > 1,
           let whole = terms.first(where: { !$0.multiword && $0.capitalized && $0.key == spanKey }) {
            return (whole, 0)
        }
        guard spanKey.count >= 3, !known.contains(spanKey) else { return nil }
        // One word: five letters or more, and not one the language has
        // ("Mac" stays, not Max; "Butter" stays).
        if span.count == 1 {
            guard span[0].core.filter(\.isLetter).count >= 5, !isWord(span[0].core) else { return nil }
        }
        // Each word on its own already a term: it was heard right.
        if span.count > 1, span.contains(where: { known.contains(key($0.core)) }) { return nil }
        let spanSound = phonetic(spanKey)
        var best: (term: Term, edits: Int)?
        var tied = false
        for term in terms {
            guard term.capitalized, span.count > 1 || !term.multiword else { continue }
            guard spanKey.first.map(firstSound) == term.key.first.map(firstSound) else { continue }
            // A plural is the same word, not a near miss.
            guard spanKey != term.key + "s", term.key != spanKey + "s" else { continue }
            let longest = max(spanKey.count, term.key.count)
            let edits = distance(spanKey, term.key)
            let allowed = span.count == 1 ? min(allowedEdits(longest), longest >= 9 ? 2 : 1) : allowedEdits(longest)
            guard edits > 0, edits <= allowed else { continue }
            let soundGap = distance(spanSound, term.sound)
            guard soundGap <= (longest < 5 ? 0 : 1) else { continue }
            if longest < 5 { guard spanKey.count == term.key.count else { continue } }
            if let current = best {
                if edits < current.edits { best = (term, edits); tied = false }
                else if edits == current.edits, current.term.key != term.key { tied = true }
            } else {
                best = (term, edits)
            }
        }
        return tied ? nil : best
    }

    /// Spelling changes a near miss may need: one for a short word, three
    /// for a long one, never more than three in ten letters.
    static func allowedEdits(_ length: Int) -> Int {
        switch length {
        case ..<3: 0
        case 3...5: 1
        case 6...8: 2
        default: min(3, length * 3 / 10)
        }
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

    // MARK: - PRs

    private static let prSounds: [String: String] = ["piers": "PRs", "peers": "PRs", "pier": "PR"]
    /// Words that make "piers" right before it mean PRs. Quantities ("two
    /// peers"), "review" ("review peers") and "close" ("close peers") are
    /// English with peers too.
    private static let prActions: Set<String> = [
        "open", "opened", "opening", "merge", "merged", "merging", "approve", "approved",
        "closed", "land", "landed", "ship", "shipped", "draft", "stale", "failing",
        "pending",
    ]
    /// "piers were opened": a form of be or get, then one of these.
    private static let prAuxiliaries: Set<String> = ["is", "are", "was", "were", "got", "get", "been"]
    private static let prPassives: Set<String> = [
        "opened", "merged", "closed", "approved", "landed", "shipped", "reverted",
    ]

    private static func prFix(_ words: [Word], at i: Int, in text: String, terms: [Term]) -> String? {
        let word = words[i]
        guard !word.protected, word.possessive.isEmpty, let target = prSounds[word.core.lowercased()],
              terms.contains(where: { $0.text == target })
        else { return nil }
        // A number right after: "piers #12", "piers 12", "piers number 12".
        // A bare number after the singular is a real pier ("Pier 39").
        let after = text[word.range.upperBound...].drop { $0 == " " }
        let numbered = after.first == "#"
            || (target == "PRs" && (after.first?.isNumber == true
                || after.lowercased().hasPrefix("number ")))
        // An action right before, joined by a space: "open piers".
        let acted = i > 0 && spaced(words[i - 1], word, in: text)
            && prActions.contains(words[i - 1].core.lowercased())
        // A passive after: "piers were opened".
        let passive = i + 2 < words.count
            && spaced(word, words[i + 1], in: text) && spaced(words[i + 1], words[i + 2], in: text)
            && prAuxiliaries.contains(words[i + 1].core.lowercased())
            && prPassives.contains(words[i + 2].core.lowercased())
        return numbered || acted || passive ? target : nil
    }

    // MARK: - Names said lowercase

    /// Words that put a name right after them: "have Pat", "ask Ada".
    private static let askingWords: Set<String> = ["have", "ask", "tell", "hey", "thanks", "ping"]
    /// Verbs a name is followed by in "have Mike check it".
    private static let nameFollowers: Set<String> = [
        "check", "look", "merge", "handle", "review", "fix", "do", "take", "find", "know",
    ]

    private static func nameFix(_ words: [Word], at i: Int, in text: String, terms: [Term]) -> String? {
        guard i > 0 else { return nil }
        let word = words[i], previous = words[i - 1]
        guard !word.protected, word.core.first?.isLowercase == true, spaced(previous, word, in: text),
              askingWords.contains(previous.core.lowercased()),
              i + 1 < words.count, !words[i + 1].protected, spaced(word, words[i + 1], in: text),
              nameFollowers.contains(words[i + 1].core.lowercased())
        else { return nil }
        let spoken = key(word.core)
        guard spoken.count >= 4 else { return nil }
        let sound = phonetic(spoken)
        let names = terms.filter {
            $0.capitalized && !$0.multiword && $0.text.first?.isUppercase == true
                && $0.key.count == spoken.count && $0.key != spoken
                && $0.key.first == spoken.first && $0.sound == sound
                && distance($0.key, spoken) == 1
        }
        // Two names as close: leave it.
        guard names.count == 1, let name = names.first else { return nil }
        return name.text + word.possessive
    }

    /// One space between the two words.
    private static func spaced(_ a: Word, _ b: Word, in text: String) -> Bool {
        text[a.range.upperBound..<b.range.lowerBound] == " "
    }

    // MARK: - Strings

    static func key(_ text: String) -> String {
        String(text.lowercased().filter { $0.isLetter || $0.isNumber })
    }

    /// A rough sound key: each consonant's Soundex group, vowels and
    /// h/w/y dropped, repeats collapsed. "betterbahn" and "butter band"
    /// both start 1-3-6-1-5.
    static func phonetic(_ key: String) -> String {
        var out = ""
        var last: Character?
        for c in key {
            let group = soundGroup(c)
            if let group, group != last { out.append(group) }
            if c != "h" && c != "w" { last = group }
        }
        return out
    }

    private static func soundGroup(_ c: Character) -> Character? {
        switch c {
        case "b", "f", "p", "v": "1"
        case "c", "g", "j", "k", "q", "s", "x", "z": "2"
        case "d", "t": "3"
        case "l": "4"
        case "m", "n": "5"
        case "r": "6"
        case let d where d.isNumber: d
        default: nil
        }
    }

    /// The first letter's sound: its consonant group, or the vowel itself.
    private static func firstSound(_ c: Character) -> Character { soundGroup(c) ?? c }

    /// Levenshtein distance.
    static func distance(_ a: String, _ b: String) -> Int {
        let a = Array(a), b = Array(b)
        guard !a.isEmpty else { return b.count }
        guard !b.isEmpty else { return a.count }
        var previous = Array(0...b.count)
        var current = [Int](repeating: 0, count: b.count + 1)
        for i in 1...a.count {
            current[0] = i
            for j in 1...b.count {
                current[j] = min(
                    previous[j] + 1, current[j - 1] + 1,
                    previous[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1)
                )
            }
            swap(&previous, &current)
        }
        return previous[b.count]
    }
}
