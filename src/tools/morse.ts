// Deterministic Morse-code timing generator for the strobe beacon. Pure and
// unit-tested (tests/morse.test.ts). Standard proportions: dot = 1 unit,
// dash = 3 units, intra-character gap = 1 unit, inter-character gap = 3 units,
// word gap = 7 units.

const MORSE: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....',
  I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.',
  Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
  Y: '-.--', Z: '--..',
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-',
  '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
};

export interface MorseStep {
  on: boolean;
  ms: number;
}

/** Human-readable Morse for a message, e.g. "SOS" -> "... --- ...". */
export function toMorse(message: string): string {
  return message
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word
        .split('')
        .map((ch) => MORSE[ch] ?? '')
        .filter(Boolean)
        .join(' '),
    )
    .join(' / ');
}

/**
 * On/off timing pattern for the strobe, in milliseconds. Always starts with an
 * `on` step. `unitMs` is the dot length (default 200ms — readable by eye).
 */
export function morseTiming(message: string, unitMs = 200): MorseStep[] {
  const steps: MorseStep[] = [];
  const words = message.toUpperCase().split(/\s+/).filter(Boolean);

  words.forEach((word, wi) => {
    const chars = word.split('').filter((ch) => MORSE[ch]);
    chars.forEach((ch, ci) => {
      const symbols = MORSE[ch].split('');
      symbols.forEach((sym, si) => {
        steps.push({ on: true, ms: sym === '-' ? unitMs * 3 : unitMs });
        // intra-character gap after every symbol except the last
        if (si < symbols.length - 1) steps.push({ on: false, ms: unitMs });
      });
      // inter-character gap after every char except the last in the word
      if (ci < chars.length - 1) steps.push({ on: false, ms: unitMs * 3 });
    });
    // word gap between words
    if (wi < words.length - 1) steps.push({ on: false, ms: unitMs * 7 });
  });

  return steps;
}

/** Total duration of one pass of the pattern, in milliseconds. */
export function morseDurationMs(steps: MorseStep[]): number {
  return steps.reduce((acc, s) => acc + s.ms, 0);
}
