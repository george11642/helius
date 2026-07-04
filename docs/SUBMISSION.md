# Submission — RAISE Summit Hackathon 2026

Draft copy for the submission form. Numbers are verified (see `spike/RESULTS.md`);
the team lead refines wording at video/submit time. **Do not submit on George's
behalf** — this is the prefilled draft he reviews and submits himself.

---

## Form fields

**Project name:** Helius

**Track:** Google DeepMind — Statement Five (Edge / On-Device Gemma)

**One-liner:**
> The AI that works when nothing else does — a fully offline, on-device voice agent that runs Gemma 4 in your browser and chains real local tools to get a lost hiker home before dark.

**Description (~150 words):**
> Helius is an offline-first, installable web app that runs **Gemma 4 entirely on the device** — no cloud, no signal, no account, no data leaving the phone. When a hiker loses signal, they just talk to it: Gemma transcribes the request on-device, then **chains real, deterministic local tools** — GPS locate, offline A\* trail routing, sunset/pace math, native trail-sign reading, and a Morse strobe beacon — and speaks back the one thing to do now, with the route drawn on a fully offline vector map. The agentic reasoning is *visible*: a live tool-trace shows Gemma orchestrating each step. It's deliberately **non-medical** and refuses medical prompts by design. Everything runs client-side on WebGPU; the model and map stream once, then it works in airplane mode forever. Two model tiers (E2B/E4B) hot-swap for battery/quality elasticity. This is Gemma as a genuinely useful offline agent — private by construction, reliable exactly when the network isn't.

**How it fits the track:**
> Statement Five asks for the best application **running Gemma locally for offline, privacy-first inference**. Helius runs Gemma 4 (E2B/E4B, q4f16) 100% in-browser on WebGPU — inference, native audio-in transcription, and native vision sign-reading all happen on-device, and the whole app functions with the network physically off. Privacy is structural, not a policy: audio, camera frames, and location never leave the device because there is no server to send them to. Gemma isn't a chatbot bolted on — it's the agent that orchestrates deterministic local tools, which is exactly the on-device, offline, privacy-first use case the track is about.

**Built at the event:**
> 100% built within the hackathon window. The repository was born at the moment the window opened — first commit *"Helius is born"* at **03:30:49 MDT, July 4, 2026** — and every line (runtime spike, engine, agent loop, tools, offline map, routing graph, region packs) was written in-window. The commit history is the build log.

**Links:**
- Repository: https://github.com/george11642/helius
- Demo video (≤60s): _[YouTube unlisted — TBD]_
- Live app (judge URL): _[Cloudflare Pages — TBD]_

---

## 60-second video shot list

Matches the locked demo beat sequence. One continuous device-in-hand feel;
airplane mode visible as often as possible. The spoken answer is Gemma's **real**
tool-grounded output — the line below is illustrative, not scripted.

| Time | On screen | Audio / VO | On-screen text |
| --- | --- | --- | --- |
| 0:00–0:05 | Phone, control center open, **Airplane Mode toggled ON** (✈︎ in status bar). Helius app already open behind it. | ambient wind; a beat of silence | "No signal. No cloud. No problem." |
| 0:05–0:12 | Close control center → Helius. Hiker taps the mic. | Hiker (real voice): *"I'm off the trail and I don't know where I am. Get me back to the trailhead before sunset."* | — |
| 0:12–0:16 | Transcript appears as it's recognized **on-device**; ✈︎ still visible. | soft UI tick | "Transcribed on-device · Gemma 4" |
| 0:16–0:30 | **Tool-trace rail** lights up step by step: `locate → sun_clock → route_back → pace_eta → safety_plan → morse_beacon`. Each chip shows its real summary. | subtle per-step ticks; light underscore | "Gemma is orchestrating real local tools" |
| 0:30–0:40 | Camera pushes to the **map**: the route **draws** from the hiker's fix to the trailhead over the offline Sandia basemap + terrain contours. | route-draw whoosh | "Offline vector map · A\* over OpenStreetMap trails" |
| 0:40–0:47 | Helius **speaks** the answer; the key numbers highlight on screen (daylight left, distance/ETA, the one action). | Helius (on-device TTS), e.g. *"You have about an hour of light. It's 3.9 km back — head down the ridge trail now."* | "Spoken by an on-device voice" |
| 0:47–0:54 | Quick cut: point the camera at a **French trail sign**; Helius reads it verbatim, translates, gives one action line. | Helius: reads + translates the sign | "Native vision — reads & translates a sign, offline" |
| 0:54–0:58 | Morse **strobe beacon** flashing SOS in the dark; ✈︎ still in the status bar. | slow Morse blink SFX | "Findable after dark — Morse strobe beacon" |
| 0:58–1:00 | Wordmark: **Helius** — *the AI that works when nothing else does.* Small footer: *non-medical · runs 100% on-device.* | resolve | "Gemma 4 · 100% on-device · built at RAISE 2026" |

**Cutaway B-roll to have ready:** the tier chip flipping E2B↔E4B (elasticity beat); the offline badge; installing the PWA to the home screen; a close-up of the tool-trace chips with real numbers.

**Hard rules for the cut:** keep airplane mode visible; never show a medical use; say "offline navigation, signaling, and procedural field tools," never "medical" or "image analyzer"; every number spoken/shown must be the app's real output.
