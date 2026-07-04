import './style.css';
import { renderShell } from './app/shell';

// TODO(agent, speech): once src/agent/ has a real loop, wire user input from
// the shell's chat/voice panel into it here, and stream responses back.
renderShell(document.getElementById('app')!);

// Registers the service worker vite-plugin-pwa generates (registerType:
// 'autoUpdate', injectRegister: null — see vite.config.ts for why this is a
// manual, not virtual-module, registration). Production only: there's no
// dist/sw.js in dev, and a dev-mode SW would just cache-fight the dev server.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js');
}
