import Foundation

/// Minimal International Morse encoder + timing, matching the web app's morse
/// tool (unit-based: dot = 1 unit, dash = 3, intra-char gap = 1, letter gap = 3,
/// word gap = 7). Used by the torch beacon.
enum Morse {
    private static let table: [Character: String] = [
        "A": ".-", "B": "-...", "C": "-.-.", "D": "-..", "E": ".", "F": "..-.",
        "G": "--.", "H": "....", "I": "..", "J": ".---", "K": "-.-", "L": ".-..",
        "M": "--", "N": "-.", "O": "---", "P": ".--.", "Q": "--.-", "R": ".-.",
        "S": "...", "T": "-", "U": "..-", "V": "...-", "W": ".--", "X": "-..-",
        "Y": "-.--", "Z": "--..",
        "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-",
        "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----.",
    ]

    /// Dot/dash string for a message, letters separated by spaces, words by " / ".
    static func encode(_ message: String) -> String {
        message.uppercased().split(separator: " ").map { word in
            word.compactMap { table[$0] }.joined(separator: " ")
        }.joined(separator: " / ")
    }

    /// A flat on/off timeline: each step is (on: torch state, ms: duration).
    static func timeline(_ message: String, unitMs: Int = 200) -> [(on: Bool, ms: Int)] {
        var steps: [(Bool, Int)] = []
        let words = message.uppercased().split(separator: " ").map(String.init)
        for (wi, word) in words.enumerated() {
            let letters = word.compactMap { table[$0] }
            for (li, code) in letters.enumerated() {
                for (si, sym) in code.enumerated() {
                    steps.append((true, sym == "-" ? unitMs * 3 : unitMs)) // dot/dash ON
                    if si < code.count - 1 { steps.append((false, unitMs)) } // intra-char gap
                }
                if li < letters.count - 1 { steps.append((false, unitMs * 3)) } // letter gap
            }
            if wi < words.count - 1 { steps.append((false, unitMs * 7)) } // word gap
        }
        return steps
    }

    static func totalMs(_ message: String, unitMs: Int = 200) -> Int {
        timeline(message, unitMs: unitMs).reduce(0) { $0 + $1.ms }
    }
}
