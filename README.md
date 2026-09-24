# MYSTERIOUS WOODS — v1.0.0

A complete, playable 1–6 player co-op survival game built around the supplied pixel-art reference: chunky 16-bit silhouettes, dark navy outlines, rounded forest canopies, warm dirt paths, saturated river blues, cozy camp light, compact HUD hearts/bars, a minimap, and a bottom hotbar.

The game is intentionally dependency-free at runtime. It uses plain Node.js for the multiplayer server and HTML5 Canvas/WebAudio/WebRTC in the browser.

## Start it

### Windows
Double-click `start-windows.bat`.

### macOS / Linux
Run:

```bash
./start-mac-linux.sh
```

Then open **http://localhost:8080**.

Node.js 20 or newer is the only requirement.

## Multiplayer

1. One player chooses **HOST GROVE**.
2. The game shows a five-character grove code at the top-left.
3. Friends open the same hosted website, enter that code, and choose **JOIN**.
4. Up to six players share the same map, enemies, altar progress, resources, crafted structures, boss fight, and endgame.

For internet play, run the Node server on a public host that supports persistent WebSockets. Set the platform's `PORT` environment variable if required. HTTPS is strongly recommended and is required by browsers for microphone access outside localhost.

Proximity voice uses WebRTC with STUN. It works on many networks, but production deployments should add a TURN server for the most reliable voice connectivity behind strict NAT/firewalls.

## Controls

- `WASD` / arrow keys — move
- `Shift` — sprint (uses stamina)
- `E` — gather / interact / revive / altar / gate
- `Space` or left click — attack
- `Q` — use selected berries or bandage
- `1–5` — select hotbar slot
- `C` — crafting
- `M` — full map
- `Enter` — text chat
- `V` — proximity voice on/off
- `Esc` — pause/menu overlay (online world continues)

Touch controls appear automatically on phones/tablets.

## Complete game loop

- Explore an 80×80 procedurally seeded forest with dense woods, clearings, ruins, a winding river, bridge, paths, resources, and camp structures.
- Manage health, hunger, stamina, XP, and character levels.
- Gather wood, stone, berries, and herbs.
- Craft torches, bandages, spears, campfires, and shelters.
- Fight spiders, wolves, shadow creatures, and altar guardians.
- Campfires create safe light and slowly heal survivors at night.
- Shelters become personal respawn points.
- Find three Moon Altars. Each altar awakens guardians; defeat them, return to the altar, and claim its Moon Shard.
- Bring all three Moon Shards to the Old Gate.
- Survive the one-minute gate defense.
- Defeat the final boss, **The Hollow Stag**, and escape the forest.
- Players can revive knocked-down teammates before the automatic camp respawn.
- The world has day/dusk/night lighting, rain windows, ambient danger scaling, and procedural chiptune/forest sound effects.

## Art direction

The supplied reference is preserved at `docs/style-reference.png` so the visual target stays attached to the project. Gameplay graphics are original procedural pixel art drawn at a low logical resolution and scaled with nearest-neighbor filtering. That keeps the whole game visually consistent and easy to expand without introducing mismatched art assets.

See `docs/STYLE_GUIDE.md` for the palette and visual rules used in this build.

## Project layout

- `server.js` — multiplayer rooms, movement, survival stats, combat, enemy AI, crafting, resources, altars, boss/endgame, WebSocket signaling
- `public/index.html` — game shell and menus
- `public/game.js` — renderer, UI, input, audio, WebRTC proximity voice, minimap/full map, touch controls
- `public/style.css` — pixel UI styling and responsive layout
- `public/sw.js` / `public/manifest.json` — installable web-app support
- `docs/style-reference.png` — the supplied visual reference

## Version

**1.0.0**
