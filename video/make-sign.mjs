// Renders the French trail sign fixture (video/sign.png) used by the read_sign
// beat (S6), via system Chrome for crisp typography. scenes.mjs feeds a video
// made from this PNG to Chrome as a fake camera device.
// Run: node make-sign.mjs   (needs `playwright` + system Google Chrome)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'sign.png');

// A realistic Chamonix-area trail sign: directions + a black-ice warning
// ("verglas fréquent"). The model should read it verbatim, translate the
// French, and give one grounded action line.
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0}
  .sign{width:1280px;height:960px;box-sizing:border-box;
    background:linear-gradient(160deg,#1d3b2a,#12241a);
    display:flex;flex-direction:column;justify-content:center;gap:34px;
    padding:70px 84px;font-family:'Helvetica Neue',Arial,sans-serif;color:#f2f5ef;
    border:14px solid #d8b45a;border-radius:18px}
  .row{display:flex;align-items:center;gap:26px;font-size:66px;font-weight:700;letter-spacing:.5px}
  .arrow{font-size:74px;color:#d8b45a}
  .min{font-size:44px;font-weight:500;color:#bfcbb6}
  .warn{margin-top:20px;background:#c8902a;color:#1a1206;border-radius:12px;
    padding:22px 30px;font-size:52px;font-weight:800;display:flex;align-items:center;gap:20px}
  .sub{font-size:40px;font-weight:500;color:#e7d9b4}
</style></head><body>
  <div class="sign">
    <div class="row"><span class="arrow">&#8594;</span> LAC BLANC <span class="min">45 min</span></div>
    <div class="row"><span class="arrow">&#8592;</span> LA FL&Eacute;G&Egrave;RE <span class="min">1 h 30</span></div>
    <div class="warn">&#9888; VERGLAS FR&Eacute;QUENT</div>
    <div class="sub">Sentier glissant &mdash; prudence</div>
  </div>
</body></html>`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, deviceScaleFactor: 2 });
await page.setContent(HTML, { waitUntil: 'load' });
await page.locator('.sign').screenshot({ path: OUT });
await browser.close();
console.log('wrote', OUT);
