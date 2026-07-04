// Offline sunset/sunrise math (NOAA solar-position approximation).
// Deterministic, no network, no deps. Good to ~1 minute — plenty for field use.

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;

const toJulian = (date: Date) => date.valueOf() / DAY_MS - 0.5 + J1970;
const fromJulian = (j: number) => new Date((j + 0.5 - J1970) * DAY_MS);
const toDays = (date: Date) => toJulian(date) - J2000;

const solarMeanAnomaly = (d: number) => RAD * (357.5291 + 0.98560028 * d);
const eclipticLongitude = (M: number) => {
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const P = RAD * 102.9372;
  return M + C + P + Math.PI;
};
const declination = (L: number) => Math.asin(Math.sin(L) * Math.sin(RAD * 23.4397));

const julianCycle = (d: number, lw: number) => Math.round(d - 0.0009 - lw / (2 * Math.PI));
const approxTransit = (Ht: number, lw: number, n: number) => 0.0009 + (Ht + lw) / (2 * Math.PI) + n;
const solarTransitJ = (ds: number, M: number, L: number) =>
  J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
// cos is clamped to [-1,1]: at polar day/night the raw value leaves the acos
// domain and would yield NaN → Invalid Date → sun_clock throws on toISOString.
// Clamping degrades gracefully (sunset pinned to solar noon/midnight extremes).
const hourAngle = (h: number, phi: number, dec: number) =>
  Math.acos(Math.max(-1, Math.min(1, (Math.sin(h) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)))));

export interface SunTimes {
  sunrise: Date;
  sunset: Date;
  civilDuskEnd: Date; // last usable light
}

export function sunTimes(date: Date, lat: number, lon: number): SunTimes {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const d = toDays(date);
  const n = julianCycle(d, lw);
  const M = solarMeanAnomaly(approxTransit(0, lw, n));
  const L = eclipticLongitude(M);
  const dec = declination(L);

  const timeAt = (angleDeg: number, rising: boolean) => {
    const w = hourAngle(RAD * angleDeg, phi, dec);
    const a = approxTransit(rising ? -w : w, lw, n);
    return fromJulian(solarTransitJ(a, M, L));
  };

  return {
    sunrise: timeAt(-0.833, true),
    sunset: timeAt(-0.833, false),
    civilDuskEnd: timeAt(-6, false),
  };
}

export function daylightLeft(now: Date, lat: number, lon: number) {
  const t = sunTimes(now, lat, lon);
  const minutes = Math.max(0, Math.round((t.sunset.getTime() - now.getTime()) / 60000));
  const duskMinutes = Math.max(0, Math.round((t.civilDuskEnd.getTime() - now.getTime()) / 60000));
  return { ...t, minutesToSunset: minutes, minutesToDark: duskMinutes };
}
