#!/bin/bash
# Wave 1: all independent generation jobs in parallel.
# Textures + 3D concept images (nano_banana_2) + SFX (seed_audio) + music (sonilo_music).
cd "$(dirname "$0")/.." || exit 1
mkdir -p design/jobs

F="flat cel-shaded cartoon in the style of a classic American prime-time animated sitcom, chibi proportions with oversized heads and stubby bodies, bold clean dark outlines, rounded simple shapes, characters in warm yellow skin tones with bright saturated primary-color outfits, environment in cheerful suburban pastels with green lawns and cream sidewalks, hazards and boost elements marked in hot pink glow, sunny daytime ambient light, high contrast between game elements and backgrounds, clean readable silhouettes, three-quarter isometric view"

TILE_SUFFIX=", perfectly seamless edges that wrap horizontally and vertically, no border, no vignette, flat even lighting, no single focal object"
CONCEPT_SUFFIX=", on a pure flat white background, no shadow, no ground plane, nothing cropped at the edges"

img() { # id prompt
  higgsfield generate create nano_banana_2 --prompt "$2" --aspect_ratio 1:1 --resolution 1k --wait --json > "design/jobs/$1.json" 2>&1
  echo "done: $1 ($?)"
}
sfx() { # id prompt
  higgsfield generate create seed_audio --prompt "$2" --format mp3 --sample_rate 44100 --wait --json > "design/jobs/$1.json" 2>&1
  echo "done: $1 ($?)"
}

img tex_road   "seamless tileable game texture tile of cartoon asphalt road surface, uniform pattern density, $F$TILE_SUFFIX" &
img tex_grass  "seamless tileable game texture tile of cartoon lawn grass, uniform pattern density, $F$TILE_SUFFIX" &
img tex_dirt   "seamless tileable game texture tile of cartoon dirt path, uniform pattern density, $F$TILE_SUFFIX" &

img concept_kart_red    "concept art of a cheerful chibi boy racer with spiky hair sitting in a rounded red go-kart, single object, full body visible, centered, smooth rounded blobby geometry, $F$CONCEPT_SUFFIX" &
img concept_kart_blue   "concept art of a chibi girl racer with a high ponytail sitting in a rounded blue go-kart, single object, full body visible, centered, smooth rounded blobby geometry, $F$CONCEPT_SUFFIX" &
img concept_kart_green  "concept art of a grumpy chibi grandpa racer with a big white mustache sitting in a rounded green go-kart, single object, full body visible, centered, smooth rounded blobby geometry, $F$CONCEPT_SUFFIX" &
img concept_kart_yellow "concept art of a giggling chibi toddler racer with one curl of hair sitting in a rounded yellow go-kart, single object, full body visible, centered, smooth rounded blobby geometry, $F$CONCEPT_SUFFIX" &

img concept_prop_donut "concept art of a giant pink frosted donut shop sign on a metal pole, single object, full body visible, centered, smooth rounded blobby geometry, $F$CONCEPT_SUFFIX" &
img concept_prop_tree  "concept art of a round puffy cartoon tree with a short trunk, single object, full body visible, centered, smooth rounded blobby geometry, $F$CONCEPT_SUFFIX" &
img concept_prop_house "concept art of a small pastel pink suburban house with a triangular roof, single object, full body visible, centered, smooth rounded blobby geometry, $F$CONCEPT_SUFFIX" &

sfx sfx_engine    "small go-kart engine loop, steady buzzy toy motor hum, seamless loop, isolated, no music, no voice" &
sfx sfx_drift     "single short cartoon tire skid squeal on asphalt, isolated, no music, no voice" &
sfx sfx_boost     "single short cartoon whoosh zip speed burst, rising pitch, isolated, no music, no voice" &
sfx sfx_countdown "race start countdown: three identical short electronic beeps one second apart then one longer higher confirmation beep, isolated, no music, no voice" &
sfx sfx_finish    "short cheerful cartoon victory fanfare, bright brass and glockenspiel, two seconds, no vocals, no ambience" &

higgsfield generate create sonilo_music --prompt "upbeat cartoon surf-rock instrumental loop for a sunny go-kart racing game, twangy electric guitar, bouncy drums, hand claps, playful and driving, seamless loop, instrumental, no vocals" --duration 60 --wait --json > design/jobs/music_loop.json 2>&1 &
echo "music started"

wait
echo "ALL WAVE1 JOBS DONE"
grep -L '"url"' design/jobs/*.json 2>/dev/null && echo "(files above have no url = failed)" || echo "all jobs contain result urls"
