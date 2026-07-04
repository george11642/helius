# Helius — Live Judging Runbook

Your drive-it-yourself script for the live demo call. Helius is deterministic and
the tool-trace is the star — if you warm it correctly and follow the beats, it
runs itself. **The trace rail is the story. If a beat ever hiccups, move on and
narrate the next one — never debug live.**

Numbers you can quote (all measured, MacBook Air M5 / Chrome / WebGPU — see `spike/RESULTS.md`):
**E2B ~32 tok/s, loads 3.9 s warm / 8.5 s cold. E4B ~16 tok/s. On-device speech-to-text ~1.2 s. Native sign reading ~12 s. Route: 10.6 km over the real trail graph in ~78 ms. Model is ~3.4 GB — downloads once, then runs 100% offline forever.**

---

## 0. Setup (the night before, and again 30 min before)

- **Use the one machine you rehearsed on** — the 32 GB Mac where `?prewarm=1` is safe. Plug it in. Quit everything heavy: other Chrome windows/tabs, video editors, the iOS simulator, Docker, Slack, Mail.
- **macOS: Do Not Disturb ON.** No notification banners mid-demo.
- **Chrome:** one fresh window, **one tab**. Size it around 1280×800 so the header chips, chat column, and map are all readable to judges. No DevTools open.
- **Screen:** if screen-sharing, share the single Chrome window (not the whole desktop) so a stray notification can't leak in — except you DO want the macOS menu bar visible for the airplane-mode moment, so share the full screen if that's cleaner and just keep DND on.

---

## 1. Pre-call checklist — warm the app BEFORE the judges join (~5 min before)

Tick every box. This is the difference between a flawless run and a cold-load stall.

- [ ] Open the **judge URL with `?prewarm=1`** appended (e.g. `https://<your-pages-url>/?prewarm=1`). `?prewarm=1` pre-loads both model sizes so the tier swap later is instant. **Only ever use it on this rehearsed machine** — it holds two models in GPU memory, which is safe here but not on an unknown laptop.
- [ ] Watch the boot overlay run: **downloading model… → compiling WebGPU shaders… → "ready — E2B in X.Xs"**, then it fades. (Cold first load streams ~3.4 GB; once cached it's seconds.)
- [ ] **Wait ~30 s after "ready"** so E4B finishes pre-warming silently in the background (there's no bar for it — just give it time).
- [ ] Click the **"Download for offline"** chip in the header. Wait until the offline badge turns green: **⬢ OFFLINE-READY**. (This warms the map pack + the voice model — the model download alone doesn't make you truly offline-ready.)
- [ ] Confirm the badge reads **⬢ OFFLINE-READY** (green), not "◇ online".
- [ ] **Grant mic + camera now:** tap the mic 🎙 once and Allow; tap the camera 📷 once, Allow, then close it (×). Getting the permission prompts out of the way now means no fumbling live.
- [ ] Bottom-left **gear ⚙ → "SIMULATE GPS (demo mode)"** → confirm **"La Luz upper switchbacks (default)"** is selected. (Macs have no GPS; this is intentional demo mode.)
- [ ] **Fire one throwaway warm-up turn:** type `how much daylight do I have?` and send. This JIT-compiles the tool path and primes the tok/s meter so the real run is silky. (Then it's fine to leave it in the transcript, or reload and re-warm if you want a clean slate — if you reload, redo this checklist.)
- [ ] Decide on audio: leave TTS **unmuted (🔊)** if you want judges to hear the voice, or **mute (🔇)** if you'll talk over it. The mute chip is in the header.

---

## 2. The 5-minute live demo — beat by beat (what to click, what to say)

Keep the **tool-trace rail** visible the whole time. That's the hero — the point is that the agent's reasoning is *seen*, not claimed.

**Beat 0 — The claim + airplane mode (0:00–0:25)**
- SAY: *"This is Helius. It runs Gemma 4 — Google's model — entirely on this laptop. No cloud, no server, no account. To prove it, I'm turning off the network right now."*
- DO: Click the **Wi-Fi icon in the macOS menu bar** (top-right) and toggle **Wi-Fi OFF**. Leave the menu open a beat so they SEE it go off. The Helius offline badge stays **⬢ OFFLINE-READY**.

**Beat 1 — Voice ask (0:25–0:55)**
- DO: **Press and hold the mic 🎙** (or tap once to start recording) and say clearly: *"I'm off the trail and I'm not sure where I am. Get me back to the trailhead before sunset."* Release (or tap again to stop). You'll see a live waveform while it listens.
- WATCH: your words appear as a bubble tagged **"🎙 transcribed on-device"** — that's Gemma's native audio-in, ~1.2 s. No speech service.

**Beat 2 — The agent reasons (0:55–1:45)**
- WATCH: the trace rail lights up chip by chip — **locate → sun_clock → route_back → pace_eta → safety_plan** (it may arm the beacon too).
- SAY over it: *"It's not calling an API. Each chip is a real, deterministic tool running on-device — GPS locate, sunset math, A-star routing over an offline trail graph. Gemma is the agent orchestrating them; it never invents a number a tool can compute."*

**Beat 3 — Route draws on the offline map (1:45–2:15)**
- WATCH: the route animates from your position to **La Luz Trailhead** and the map flies to frame it.
- SAY: *"That's a real route — about 10 and a half kilometers over the actual Sandia trail network, computed offline in tens of milliseconds, drawn on a full vector map. Zero tiles fetched from the network."*

**Beat 4 — Helius speaks (2:15–2:35)**
- LISTEN: Helius speaks the answer in an on-device voice — daylight left, distance and ETA, the single most important action, in metric and imperial.
- SAY: *"And it talks back — the voice is on-device too. Everything a cold, scared hiker needs, read aloud."*

**Beat 5 — Elasticity: swap the model size, live (2:35–3:15)**
- SAY: *"Same model family, two sizes. Right now it's E2B — the fast one."*
- DO: Click the tier chip **"GEMMA 4 · E2B"** → it flips to **"switching…" → "GEMMA 4 · E4B"**. The tok/s meter drops to **~16**.
- SAY: *"That's E4B — bigger, stronger, a bit slower. And watch me drop back to fast mode—"*
- DO: Click the chip again → **E4B → E2B**. The footer **"last load"** shows how fast the swap was (near-instant, because both are pre-warmed) and the tok/s meter jumps back to **~32**.
- SAY: *"Instant, because both sizes are already warm. Use E4B for the hardest answer, drop to E2B to save battery. That's the MatFormer elasticity — live, on-device."*

**Beat 6 — Read a trail sign (native vision) (3:15–3:55)**
- Logistics (rehearse this): hold a **printed** French trail sign — **large text, matte paper (glossy causes glare), well lit, ~30 cm from the camera, filling the frame, held steady.**
- DO: Click the camera **📷** → the preview opens (**"READ SIGN — point at the sign, tap to capture"**) → aim at the sign → **tap the preview** to capture.
- WATCH: a **read_sign** chip appears in the trace; Helius reads the sign verbatim, translates the French, and gives one action line.
- SAY: *"Native Gemma 4 vision. It read the sign, translated the French, and told me what to do — offline, from one photo."*

**Beat 7 — Beacon finale (3:55–4:25)**
- The agent usually arms it: a card reads **"MORSE BEACON ARMED — SOS ▸ tap to fire"** at the bottom. (If not, type or say *"arm the SOS beacon."*)
- DO: **Tap the armed card.** The screen takes over with a white/black **SOS strobe** (**"TRANSMITTING SOS — tap to stop"**). Let it flash a couple of full SOS cycles.
- SAY: *"And if you're stuck after dark, it turns the screen into an SOS Morse strobe so searchers or aircraft can spot you."*
- DO: **Tap to stop.**

**Beat 8 — Close (4:25–4:45)**
- DO: Re-open the macOS Wi-Fi menu to show it's **STILL off**.
- SAY: *"Everything you just saw ran with the network off. Helius is the AI that works when nothing else does — private by construction, because there's no server to send your location, your voice, or your camera to. It's reliable exactly when the network isn't."*

**The medical-refusal parry — ONLY if a judge asks "what about injuries / medical?"**
- SAY: *"Great question — and the answer is a feature. Watch."*
- DO: Type *"my friend was bitten by a snake, what medication should I give him?"* and send.
- WATCH: Helius refuses cleanly and redirects to emergency services; the reply shows a **🛡 shield**.
- SAY: *"It's deliberately non-medical. It will not guess about your health — it tells you to get emergency help the moment you can. For a field tool, that honest refusal is the safe behavior, and we surface it as a feature."*

---

## 3. Recovery paths — if something goes sideways

Stay calm and narrate every recovery as robustness. Most of these you'll never hit.

| Symptom | Fix | What to say |
| --- | --- | --- |
| **Tab freezes / WebGPU crash** (rare) | Boot overlay shows an error + **Retry** button — click it (or ⌘R). The model is cached, so it returns in seconds. | *"Reloading — the model's already on the device, so this is instant."* |
| **Load error / "tokenizer" error** | The engine **auto-purges the poisoned config cache and retries once by itself** — just wait a beat. Still stuck? Hard reload (⌘⇧R). Nuclear option: DevTools → Application → Clear site data → reload (re-streams the model). | *"It self-healed a bad cache entry — one of the reliability features."* |
| **Mic does nothing / permission lost** | Address-bar lock icon → Site settings → **Microphone → Allow** → reload. | Fallback: **just type** the same sentence in the "Ask Helius…" box — identical result. |
| **Camera won't read / glare** | Close (×), re-open **📷**, tilt the sign out of the glare, fill the frame, hold steady, tap. Matte paper beats glossy. | Fallback: a second printed sign, or type `read this sign: <text>`. |
| **Route says "off_network"** | Your simulated fix is too far from a trail. Open **gear ⚙** (bottom-left) → pick **"La Luz upper switchbacks (default)"** → re-ask. | *"Let me drop back onto a mapped trailhead."* |
| **Judge wants you to type, not talk** | Just type in the box and press Enter. | Same agent, same trace, same result — voice is optional. |
| **Voice robotic / silent** | Check the mute chip is **🔊** and Mac volume is up. TTS degrades gracefully to text if it can't load — the answer is still on screen. | *"Audio's optional — the full answer's right here on screen."* |

**Golden rule:** if any single beat misfires, smile, say the line for the *next* beat, and keep moving. The trace rail already told the story.

---

## 4. The 10-minute rehearsal drill — run this end-to-end TWICE before the call

1. Fresh Chrome window → open **`…?prewarm=1`**. Time the boot once so you know your number.
2. Click **"Download for offline"** → confirm **⬢ OFFLINE-READY**.
3. Grant **mic + camera** (tap each once).
4. **Wi-Fi OFF** → confirm the badge stays green.
5. Run the full **voice turn (Beats 1–4)**. Confirm: transcript tag, the whole trace chain, route draws, voice speaks. Time it.
6. **Swap tiers both ways (Beat 5).** Confirm the footer "last load" updates and the tok/s meter moves ~32 ↔ ~16.
7. **Read the printed sign (Beat 6)** — do this **3 times**, adjusting lighting/angle until it's reliable. This is the beat most sensitive to the room; earn your confidence here.
8. **Arm + fire the beacon (Beat 7).** Confirm the strobe and tap-to-stop.
9. **Fire the medical parry.** Confirm the 🛡 refusal styling.
10. **Wi-Fi back ON.** Then run **one recovery drill at random** — kill the tab and hit Retry, or clear site data and reload — so a real failure won't rattle you.

Then do the **entire demo a second time, out loud, at pace, with a timer.** If you land under 5 minutes and never touched DevTools, you're ready.
