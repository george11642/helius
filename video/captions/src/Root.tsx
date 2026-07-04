import React from 'react';
import { Composition, type CalculateMetadataFunction } from 'remotion';
import { Captions, type CaptionProps } from './Captions';

// A tiny stub alignment so `npx remotion render` (and the Studio preview) work
// with zero props — the real render passes ../alignment.json via --props.
const STUB = {
  characters: 'Helius works offline.'.split(''),
  character_start_times_seconds: 'Helius works offline.'.split('').map((_, i) => i * 0.18),
  character_end_times_seconds: 'Helius works offline.'.split('').map((_, i) => i * 0.18 + 0.16),
};

// Force PNG frames (alpha-capable) at the composition level so a render can never
// silently fall back to opaque JPEG. The transparent overlay is produced by
// captions/render.sh (PNG sequence → QTRLE .mov) — Remotion's webm-alpha ENCODE
// is broken on this box (vp8/vp9, CLI flag and calculateMetadata all drop the
// alpha), so we deliberately do not rely on a video codec here.
const transparentDefaults: CalculateMetadataFunction<CaptionProps> = () => ({
  defaultVideoImageFormat: 'png',
});

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="CaptionComp"
      component={Captions}
      durationInFrames={60 * 60}
      fps={60}
      width={1920}
      height={1080}
      calculateMetadata={transparentDefaults}
      defaultProps={{
        alignment: STUB,
        repoUrl: 'github.com/george11642/helius',
      }}
    />
  );
};
