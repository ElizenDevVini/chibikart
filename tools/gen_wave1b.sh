#!/bin/bash
# Re-run wave-1 jobs that hit the concurrent-submission billing race.
# Three sequential lanes; each job retries once on not_enough_credits.
cd "$(dirname "$0")/.." || exit 1

F="flat cel-shaded cartoon in the style of a classic American prime-time animated sitcom, chibi proportions with oversized heads and stubby bodies, bold clean dark outlines, rounded simple shapes, characters in warm yellow skin tones with bright saturated primary-color outfits, environment in cheerful suburban pastels with green lawns and cream sidewalks, hazards and boost elements marked in hot pink glow, sunny daytime ambient light, high contrast between game elements and backgrounds, clean readable silhouettes, three-quarter isometric view"
TILE_SUFFIX=", perfectly seamless edges that wrap horizontally and vertically, no border, no vignette, flat even lighting, no single focal object"
CONCEPT_SUFFIX=", on a pure flat white background, no shadow, no ground plane, nothing cropped at the edges"

run() { # id model args...
  local id="$1"; shift
  if grep -q '"result_url"' "design/jobs/$id.json" 2>/dev/null; then echo "skip: $id"; return; fi
  for attempt in 1 2; do
    higgsfield generate create "$@" --wait --json > "design/jobs/$id.json" 2>&1
    if grep -q '"result_url"' "design/jobs/$id.json"; then echo "done: $id"; return; fi
    echo "retrying: $id (attempt $attempt failed)"
    sleep 10
  done
  echo "FAILED: $id"
}

lane_a() {
  run tex_road   nano_banana_2 --prompt "seamless tileable game texture tile of cartoon asphalt road surface, uniform pattern density, $F$TILE_SUFFIX" --aspect_ratio 1:1 --resolution 1k
  run tex_grass  nano_banana_2 --prompt "seamless tileable game texture tile of cartoon lawn grass, uniform pattern density, $F$TILE_SUFFIX" --aspect_ratio 1:1 --resolution 1k
  run tex_dirt   nano_banana_2 --prompt "seamless tileable game texture tile of cartoon dirt path, uniform pattern density, $F$TILE_SUFFIX" --aspect_ratio 1:1 --resolution 1k
  run concept_prop_donut nano_banana_2 --prompt "concept art of a giant pink frosted donut shop sign on a metal pole, single object, full body visible, centered, smooth rounded blobby geometry, $F$CONCEPT_SUFFIX" --aspect_ratio 1:1 --resolution 1k
  run concept_prop_tree  nano_banana_2 --prompt "concept art of a round puffy cartoon tree with a short trunk, single object, full body visible, centered, smooth rounded blobby geometry, $F$CONCEPT_SUFFIX" --aspect_ratio 1:1 --resolution 1k
  run concept_prop_house nano_banana_2 --prompt "concept art of a small pastel pink suburban house with a triangular roof, single object, full body visible, centered, smooth rounded blobby geometry, $F$CONCEPT_SUFFIX" --aspect_ratio 1:1 --resolution 1k
}
lane_b() {
  run concept_kart_red    nano_banana_2 --prompt "concept art of a cheerful chibi boy racer with spiky hair sitting in a rounded red go-kart, single object, full body visible, centered, smooth rounded blobby geometry, $F$CONCEPT_SUFFIX" --aspect_ratio 1:1 --resolution 1k
  run concept_kart_blue   nano_banana_2 --prompt "concept art of a chibi girl racer with a high ponytail sitting in a rounded blue go-kart, single object, full body visible, centered, smooth rounded blobby geometry, $F$CONCEPT_SUFFIX" --aspect_ratio 1:1 --resolution 1k
  run concept_kart_green  nano_banana_2 --prompt "concept art of a grumpy chibi grandpa racer with a big white mustache sitting in a rounded green go-kart, single object, full body visible, centered, smooth rounded blobby geometry, $F$CONCEPT_SUFFIX" --aspect_ratio 1:1 --resolution 1k
  run concept_kart_yellow nano_banana_2 --prompt "concept art of a giggling chibi toddler racer with one curl of hair sitting in a rounded yellow go-kart, single object, full body visible, centered, smooth rounded blobby geometry, $F$CONCEPT_SUFFIX" --aspect_ratio 1:1 --resolution 1k
}
lane_c() {
  run sfx_engine    seed_audio --prompt "small go-kart engine loop, steady buzzy toy motor hum, seamless loop, isolated, no music, no voice" --format mp3 --sample_rate 44100
  run sfx_drift     seed_audio --prompt "single short cartoon tire skid squeal on asphalt, isolated, no music, no voice" --format mp3 --sample_rate 44100
  run sfx_boost     seed_audio --prompt "single short cartoon whoosh zip speed burst, rising pitch, isolated, no music, no voice" --format mp3 --sample_rate 44100
  run sfx_finish    seed_audio --prompt "short cheerful cartoon victory fanfare, bright brass and glockenspiel, two seconds, no vocals, no ambience" --format mp3 --sample_rate 44100
  run music_loop    sonilo_music --prompt "upbeat cartoon surf-rock instrumental loop for a sunny go-kart racing game, twangy electric guitar, bouncy drums, hand claps, playful and driving, seamless loop, instrumental, no vocals" --duration 60
}

lane_a & lane_b & lane_c &
wait
echo "WAVE1B DONE"
for f in design/jobs/*.json; do
  grep -q '"result_url"' "$f" || echo "still failed: $f"
done
