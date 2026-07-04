import Foundation
import AVFoundation

/// Drives the rear camera torch (flashlight) to flash a Morse beacon. On a real
/// phone this is a genuinely useful night-signaling tool — far brighter and more
/// visible to searchers/aircraft than a laptop screen. On the simulator (no
/// torch hardware) it no-ops gracefully while still reporting state so the UI and
/// agent behave identically.
final class TorchController {
    static let shared = TorchController()

    private var loopTask: Task<Void, Never>?
    private(set) var isFlashing = false

    var hasTorch: Bool {
        AVCaptureDevice.default(for: .video)?.hasTorch ?? false
    }

    /// Begin flashing `message` (default SOS) on repeat until `stop()`.
    func start(message: String = "SOS", unitMs: Int = 200) {
        stop()
        isFlashing = true
        let timeline = Morse.timeline(message, unitMs: unitMs)
        guard hasTorch, !timeline.isEmpty else {
            // Simulator / no-torch device: state stays "flashing" for the UI's
            // screen-strobe fallback, but we don't touch hardware.
            return
        }
        loopTask = Task { [weak self] in
            while !Task.isCancelled {
                for step in timeline {
                    if Task.isCancelled { break }
                    self?.setTorch(step.on)
                    try? await Task.sleep(nanoseconds: UInt64(step.ms) * 1_000_000)
                }
                self?.setTorch(false)
                try? await Task.sleep(nanoseconds: 1_400_000_000) // gap between repeats
            }
            self?.setTorch(false)
        }
    }

    func stop() {
        loopTask?.cancel()
        loopTask = nil
        isFlashing = false
        setTorch(false)
    }

    private func setTorch(_ on: Bool) {
        guard let device = AVCaptureDevice.default(for: .video), device.hasTorch else { return }
        do {
            try device.lockForConfiguration()
            if on {
                try device.setTorchModeOn(level: 1.0)
            } else {
                device.torchMode = .off
            }
            device.unlockForConfiguration()
        } catch {
            // Ignore transient lock failures.
        }
    }
}
