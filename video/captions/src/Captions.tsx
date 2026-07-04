import React, { useMemo } from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';

// ElevenLabs /with-timestamps alignment shape (character-level).
export interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}
export interface CaptionProps {
  alignment: Alignment;
  repoUrl: string;
}

interface Word {
  text: string;
  start: number;
  end: number;
}

function wordsFromAlignment(al: Alignment): Word[] {
  const c = al?.characters ?? [];
  const s = al?.character_start_times_seconds ?? [];
  const e = al?.character_end_times_seconds ?? [];
  const out: Word[] = [];
  let cur: Word | null = null;
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (ch.trim() === '') {
      if (cur) {
        out.push(cur);
        cur = null;
      }
      continue;
    }
    if (!cur) cur = { text: '', start: s[i] ?? 0, end: e[i] ?? 0 };
    cur.text += ch;
    cur.end = e[i] ?? cur.end;
  }
  if (cur) out.push(cur);
  return out;
}

const ACCENT = '#ffb454';

export const Captions: React.FC<CaptionProps> = ({ alignment, repoUrl }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = frame / fps;

  const words = useMemo(() => wordsFromAlignment(alignment), [alignment]);
  const lines = useMemo(() => {
    const L: { words: Word[]; start: number; end: number }[] = [];
    const PER = 7;
    for (let i = 0; i < words.length; i += PER) {
      const w = words.slice(i, i + PER);
      if (w.length) L.push({ words: w, start: w[0].start, end: w[w.length - 1].end });
    }
    return L;
  }, [words]);

  // ---- title card: 0–2.2s ----
  const titleOpacity = interpolate(t, [0, 0.4, 1.7, 2.2], [0, 1, 1, 0], { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' });

  // ---- active caption line ----
  const activeLine = lines.find((l) => t >= l.start - 0.15 && t <= l.end + 0.35);

  // ---- end card: last 4s ----
  const endStart = durationInFrames / fps - 4;
  const endOpacity = interpolate(t, [endStart, endStart + 0.6], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ backgroundColor: 'transparent', fontFamily: "'Helvetica Neue', Arial, sans-serif" }}>
      {/* Title card */}
      {titleOpacity > 0.01 && (
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', opacity: titleOpacity }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 132, fontWeight: 800, letterSpacing: 4, color: '#fff', textShadow: '0 4px 40px rgba(0,0,0,.6)' }}>
              HELIUS <span style={{ color: ACCENT }}>☀</span>
            </div>
            <div style={{ fontSize: 40, fontWeight: 500, color: '#cdd6e0', marginTop: 8, textShadow: '0 2px 18px rgba(0,0,0,.7)' }}>
              the AI that works when nothing else does
            </div>
          </div>
        </AbsoluteFill>
      )}

      {/* Word-synced lower-third caption */}
      {activeLine && t < endStart && (
        <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 96 }}>
          <div
            style={{
              maxWidth: 1500, textAlign: 'center', lineHeight: 1.25,
              background: 'rgba(10,14,20,.62)', backdropFilter: 'blur(6px)',
              padding: '18px 34px', borderRadius: 16,
              fontSize: 52, fontWeight: 600, color: '#eef2f6', textShadow: '0 2px 10px rgba(0,0,0,.5)',
            }}
          >
            {activeLine.words.map((w, i) => {
              const on = t >= w.start && t <= w.end + 0.08;
              return (
                <span key={i} style={{ color: on ? ACCENT : '#eef2f6', transition: 'color .1s', marginRight: 12 }}>
                  {w.text}
                </span>
              );
            })}
          </div>
        </AbsoluteFill>
      )}

      {/* End card */}
      {endOpacity > 0.01 && (
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', opacity: endOpacity }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 120, fontWeight: 800, letterSpacing: 4, color: '#fff', textShadow: '0 4px 40px rgba(0,0,0,.6)' }}>
              HELIUS <span style={{ color: ACCENT }}>☀</span>
            </div>
            <div style={{ fontSize: 38, fontWeight: 600, color: ACCENT, marginTop: 14 }}>
              Gemma 4 · 100% on-device · built at RAISE 2026
            </div>
            <div style={{ fontSize: 32, fontWeight: 500, color: '#cdd6e0', marginTop: 10 }}>{repoUrl}</div>
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
