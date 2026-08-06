#!/bin/bash
# Wave 3: item assets. 3 lanes max (concurrent submits hit a billing race).
# lane_a: donut concept -> 3D. lane_b: turbo concept -> 3D. lane_c: 3 icons + 4 sfx.
cd "$(dirname "$0")/.." || exit 1
mkdir -p design/jobs design/concepts assets

F="flat cel-shaded cartoon in the style of a classic American prime-time animated sitcom, chibi proportions with oversized heads and stubby bodies, bold clean dark outlines, rounded simple shapes, characters in warm yellow skin tones with bright saturated primary-color outfits, environment in cheerful suburban pastels with green lawns and cream sidewalks, hazards and boost elements marked in hot pink glow, sunny daytime ambient light, high contrast between game elements and backgrounds, clean readable silhouettes, three-quarter isometric view"
TOKEN="flat cel-shaded cartoon, chibi proportions, bold dark outlines, yellow skin, bright primaries, suburban pastels, sunny"
CS=", on a pure flat white background, no shadow, no ground plane, nothing cropped at the edges"
ICON_SUFFIX=", on a solid uniform bright green #00FF00 background, no shadows cast on the background, no ground plane, nothing cropped at the edges"

run() { # id model args...
  local id="$1"; shift
  grep -q '"result_url"' "design/jobs/$id.json" 2>/dev/null && { echo "skip: $id"; return; }
  for attempt in 1 2; do
    higgsfield generate create "$@" --wait --json > "design/jobs/$id.json" 2>&1
    grep -q '"result_url"' "design/jobs/$id.json" && { echo "done: $id"; return; }
    echo "retry: $id"; sleep 10
  done
  echo "FAILED: $id"
}

url_of() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); d=d[0] if isinstance(d,list) else d; print(d.get('result_url') or '')" "design/jobs/$1.json"; }

gen3d_chain() { # id polycount prompt
  local id="$1" pc="$2" prompt="$3"
  run "concept_$id" nano_banana_2 --prompt "$prompt" --aspect_ratio 1:1 --resolution 1k
  local u=$(url_of "concept_$id")
  [ -z "$u" ] && return
  curl -sL "$u" -o "design/concepts/$id.png"
  grep -q '"result_url"' "design/jobs/3d_$id.json" 2>/dev/null && { echo "skip: 3d_$id"; return; }
  for attempt in 1 2; do
    higgsfield generate create image_to_3d --image "design/concepts/$id.png" \
      --should_texture true --texture_prompt "$TOKEN" \
      --should_remesh true --topology triangle --target_polycount "$pc" \
      --enable_pbr false --enable_rigging false --enable_animation false \
      --wait --json > "design/jobs/3d_$id.json" 2>&1
    grep -q '"result_url"' "design/jobs/3d_$id.json" && { echo "done: 3d_$id"; return; }
    echo "retry: 3d_$id"; sleep 10
  done
  echo "FAILED: 3d_$id"
}

lane_a() {
  gen3d_chain item_donut 1500 "concept art of a single pink frosted donut with rainbow sprinkles, donut only, no plate, no text, single object, full body visible, centered, smooth rounded blobby geometry, $F$CS"
}
lane_b() {
  gen3d_chain item_turbo 1500 "concept art of a rounded blue metal turbo canister with a yellow lightning bolt painted on the side, canister only, no text, single object, full body visible, centered, smooth rounded blobby geometry, $F$CS"
}
lane_c() {
  run icon_donut nano_banana_2 --prompt "game UI element: pink frosted donut with rainbow sprinkles icon, single element, centered, $F$ICON_SUFFIX" --aspect_ratio 1:1 --resolution 1k
  run icon_shake nano_banana_2 --prompt "game UI element: tall pink strawberry milkshake cup with a striped straw icon, single element, centered, $F$ICON_SUFFIX" --aspect_ratio 1:1 --resolution 1k
  run icon_turbo nano_banana_2 --prompt "game UI element: rounded blue turbo canister with yellow lightning bolt icon, single element, centered, $F$ICON_SUFFIX" --aspect_ratio 1:1 --resolution 1k
  run sfx_item_pickup seed_audio --prompt "single short bright arcade pickup chime, two rising notes, isolated, no music, no voice" --format mp3 --sample_rate 44100
  run sfx_item_throw seed_audio --prompt "single short cartoon throw whoosh with a soft pop at the end, isolated, no music, no voice" --format mp3 --sample_rate 44100
  run sfx_spin seed_audio --prompt "single comedic cartoon slip and spin sound, springy boing with a splat, isolated, no music, no voice" --format mp3 --sample_rate 44100
  run sfx_final_lap seed_audio --prompt "short urgent race final lap jingle, four fast rising bell notes, isolated, no music, no voice" --format mp3 --sample_rate 44100
}

lane_a & lane_b & lane_c &
wait
echo "WAVE3 DONE"

for id in item_donut item_turbo; do
  u=$(url_of 3d_$id); [ -n "$u" ] && curl -sL "$u" -o "assets/$id.glb" && echo "saved assets/$id.glb"
done
for id in sfx_item_pickup sfx_item_throw sfx_spin sfx_final_lap; do
  u=$(url_of $id); [ -n "$u" ] && curl -sL "$u" -o "assets/$id.mp3" && echo "saved assets/$id.mp3"
done
for id in icon_donut icon_shake icon_turbo; do
  u=$(url_of $id); [ -n "$u" ] && curl -sL "$u" -o "design/concepts/$id.png" && echo "saved design/concepts/$id.png (key-out pending)"
done
