import Foundation

@main
struct DictationLocaleTests {
    static func main() {
        do {
            try run()
        } catch {
            FileHandle.standardError.write(Data("FAIL: \(error.localizedDescription)\n".utf8))
            exit(EXIT_FAILURE)
        }
    }

    private static func run() throws {
        try check("keeps an exact installed locale", requested: "en-US",
                  supported: ["en-GB", "en-US"], installed: ["en-GB", "en-US"], expected: "en-US")
        try check("accepts underscore separators", requested: "fr_FR",
                  supported: ["fr-FR"], installed: ["fr-FR"], expected: "fr-FR")
        try check("resolves an unsupported region within its language", requested: "en-FR",
                  supported: ["fr-FR", "en-US"], installed: ["fr-FR", "en-US"], expected: "en-US")
        try check("resolves a language without a region", requested: "en",
                  supported: ["en-US"], installed: ["en-US"], expected: "en-US")
        try check("skips online-only recognizers", requested: "en-FR",
                  supported: ["en-AU", "en-US"], installed: ["en-US"], expected: "en-US")
        try check("does not switch languages", requested: "de-DE",
                  supported: ["fr-FR", "en-US"], installed: ["fr-FR", "en-US"], expected: nil)
        try check("does not use an unavailable recognizer", requested: "en-FR",
                  supported: ["en-GB"], installed: [], expected: nil)
        try check("chooses the same fallback regardless of supported-locale ordering", requested: "en-FR",
                  supported: ["en-GB", "en-AU"], installed: ["en-GB", "en-AU"], expected: "en-AU")
        try check("accepts supported-locale underscore separators", requested: "fr-CA",
                  supported: ["fr_FR"], installed: ["fr-FR"], expected: "fr-FR")
        try check("uses only the advertised supported locales", requested: "en-FR",
                  supported: ["fr-FR"], installed: ["en-FR", "fr-FR"], expected: nil)
        try check("prefers the language's default region over unrelated regions", requested: "en-FR",
                  supported: ["en-ID", "en-US"], installed: ["en-ID", "en-US"], expected: "en-US")
        try check("keeps an installed regional preference ahead of the default", requested: "en-GB",
                  supported: ["en-US", "en-GB"], installed: ["en-US", "en-GB"], expected: "en-GB")
        print("PASS: 12 on-device dictation locale selection checks")
    }

    private static func check(
        _ name: String,
        requested: String,
        supported: [String],
        installed: Set<String>,
        expected: String?
    ) throws {
        let actual = selectDictationLocale(
            requested: requested,
            supported: supported,
            supportsOnDevice: installed.contains
        )
        guard actual == expected else {
            throw NSError(domain: "DictationLocaleTests", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "\(name): expected \(expected ?? "nil"), received \(actual ?? "nil")",
            ])
        }
    }
}
