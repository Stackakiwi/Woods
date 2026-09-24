# Mysterious Woods — Pixel Art Style Guide

## Core look

- Top-down / three-quarter outdoor adventure composition.
- Low-resolution pixel forms with no smoothing when scaled.
- Very dark navy / blue-gray outlines instead of pure black.
- Rounded, layered tree canopies made from clustered chunky pixels.
- Warm tan/orange paths contrasted against cool green woods and saturated blue water.
- Cozy orange/yellow light for camps, torches, and safe spaces.
- UI panels use near-black navy fill, cream borders, brown secondary borders, and chunky square corners.
- Character sprites use large readable hats/backpacks/tools rather than tiny high-detail anatomy.
- Enemies should remain readable by silhouette first, detail second.

## Palette sampled from the reference direction

| Use | Hex |
| --- | --- |
| Ink / deepest outline | `#0e1628` |
| Deep forest blue | `#0f2a42` |
| Pine teal | `#134750` |
| Forest mid green | `#2c6651` |
| Grass / moss | `#889543` |
| Light grass | `#8c9548` |
| River blue | `#2771b0` |
| River highlight | `#78b9d8` |
| Dirt path | `#d89c5b` |
| Warm cream | `#ddbb86` |
| Rust / wood | `#ac6e4f` |
| Deep wood | `#5d4148` |
| Health red | `#db4f4d` |
| Fire / quest gold | `#f6c34a` |

## Expansion rules

1. New world art should be drawn on the same 16 px logical tile scale.
2. Never use bilinear smoothing on sprites or tiles.
3. Keep a dark outline on characters, animals, structures, and interactable resources.
4. Limit each small sprite to a handful of shades per material.
5. Reserve bright yellow, cream, cyan, and red for focal points, pickups, UI, fire, eyes, or danger.
6. Night lighting should deepen the existing colors instead of replacing them with gray.
7. New UI must use the same cream + navy + brown framed construction.
8. Avoid glossy gradients on pixel objects; soft gradients are only acceptable for lighting overlays.
