// Current position state. In the field this is fed by the Geolocation API; in
// the dev/demo build the UI's dev panel drives it via setSimulatedFix(). The
// `locate` tool and the sun/pace tools all read getFix().

export interface GpsFix {
  lat: number;
  lon: number;
  accuracyM: number;
  elevationM: number;
}

// Default: La Luz trail, upper switchbacks, Sandia Mountains (the demo scene).
let fix: GpsFix = { lat: 35.1983, lon: -106.4439, accuracyM: 14, elevationM: 2926 };

export function setSimulatedFix(next: Partial<GpsFix>): void {
  fix = { ...fix, ...next };
}

export function getFix(): GpsFix {
  return fix;
}
