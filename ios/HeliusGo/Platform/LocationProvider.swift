import Foundation
import CoreLocation
import Combine

/// Real GPS + compass heading via CoreLocation. This is the whole point of the
/// native app: `locate` returns a live fix on the device. When no real fix is
/// available yet (simulator, indoors, permission pending) callers fall back to a
/// simulated preset.
final class LocationProvider: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published private(set) var lastLocation: CLLocation?
    @Published private(set) var heading: CLHeading?
    @Published private(set) var authorization: CLAuthorizationStatus = .notDetermined
    /// True once we have received at least one real GPS fix.
    @Published private(set) var isLive = false

    private let manager = CLLocationManager()

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        authorization = manager.authorizationStatus
    }

    func start() {
        manager.requestWhenInUseAuthorization()
        manager.startUpdatingLocation()
        if CLLocationManager.headingAvailable() {
            manager.startUpdatingHeading()
        }
    }

    func stop() {
        manager.stopUpdatingLocation()
        manager.stopUpdatingHeading()
    }

    // MARK: CLLocationManagerDelegate (delivered on the main run loop)

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }
        lastLocation = loc
        isLive = true
    }

    func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        heading = newHeading
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        authorization = manager.authorizationStatus
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Non-fatal: keep the simulated fallback fix in play.
    }
}
