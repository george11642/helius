import Foundation
import Vision
import CoreGraphics

/// On-device OCR for trail signs using the Vision framework (VNRecognizeTextRequest,
/// accurate mode). The recognized text is handed to Gemma, which translates it
/// (if needed) and turns it into one actionable instruction — the `read_sign`
/// tool. No network, no cloud OCR.
enum SignReader {
    /// Runs OCR on a CGImage and returns the recognized lines joined by newlines.
    static func recognizeText(in image: CGImage) -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        // Trail signs are commonly multilingual; give Vision a few hints.
        request.recognitionLanguages = ["en-US", "fr-FR", "es-ES", "de-DE"]

        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return ""
        }
        guard let observations = request.results else { return "" }
        return observations
            .compactMap { $0.topCandidates(1).first?.string }
            .joined(separator: "\n")
    }
}
