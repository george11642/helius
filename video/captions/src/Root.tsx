import React from 'react';
import { Composition } from 'remotion';
import { Captions } from './Captions';

// A tiny stub alignment so `npx remotion render` (and the Studio preview) work
// with zero props — the real render passes ../alignment.json via --props.
const STUB = {
  characters: 'Helius works offline.'.split(''),
  character_start_times_seconds: 'Helius works offline.'.split('').map((_, i) => i * 0.18),
  character_end_times_seconds: 'Helius works offline.'.split('').map((_, i) => i * 0.18 + 0.16),
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="CaptionComp"
      component={Captions}
      durationInFrames={60 * 60}
      fps={60}
      width={1920}
      height={1080}
      defaultProps={{
        alignment: STUB,
        repoUrl: 'github.com/george11642/helius',
      }}
    />
  );
};
