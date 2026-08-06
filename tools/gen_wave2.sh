#!/bin/bash
# Wave 2: download wave-1 results, then image_to_3d for karts (8k polys) and props (3k).
# Kart drivers are seated: no pose_mode (it would straighten them). No rigging.
cd "$(dirname "$0")/.." || exit 1
mkdir -p design/concepts assets

TOKEN="flat cel-shaded cartoon, chibi proportions, bold dark outlines, yellow skin, bright primaries, suburban pastels, sunny"

url_of() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); d=d[0] if isinstance(d,list) else d; print(d.get('result_url') or '')" "design/jobs/$1.json"; }

# textures + audio straight into assets/
for id in tex_road tex_grass tex_dirt; do
  u=$(url_of $id); [ -n "$u" ] && curl -sL "$u" -o "assets/$id.png" && echo "saved assets/$id.png"
done
for id in sfx_engine sfx_drift sfx_boost sfx_countdown sfx_finish music_loop; do
  u=$(url_of $id)
  [ -z "$u" ] && continue
  ext="${u##*.}"; ext="${ext%%\?*}"
  curl -sL "$u" -o "assets/$id.$ext" && echo "saved assets/$id.$ext"
done

# concept images for 3D
for id in kart_red kart_blue kart_green kart_yellow prop_donut prop_tree prop_house; do
  u=$(url_of concept_$id); [ -n "$u" ] && curl -sL "$u" -o "design/concepts/$id.png" && echo "saved design/concepts/$id.png"
done

gen3d() { # id polycount
  local id="$1" pc="$2"
  [ -f "design/concepts/$id.png" ] || { echo "no concept for $id"; return; }
  grep -q '"result_url"' "design/jobs/3d_$id.json" 2>/dev/null && { echo "skip: 3d_$id"; return; }
  for attempt in 1 2; do
    higgsfield generate create image_to_3d \
      --image "design/concepts/$id.png" \
      --should_texture true \
      --texture_prompt "$TOKEN" \
      --should_remesh true \
      --topology triangle \
      --target_polycount "$pc" \
      --enable_pbr false \
      --enable_rigging false \
      --enable_animation false \
      --wait --json > "design/jobs/3d_$id.json" 2>&1
    grep -q '"result_url"' "design/jobs/3d_$id.json" && { echo "done: 3d_$id"; return; }
    echo "retrying 3d_$id"; sleep 10
  done
  echo "FAILED: 3d_$id"
}

lane_a() { gen3d kart_red 8000; gen3d kart_green 8000; gen3d prop_tree 3000; }
lane_b() { gen3d kart_blue 8000; gen3d kart_yellow 8000; gen3d prop_house 3000; }
lane_c() { gen3d prop_donut 3000; }
lane_a & lane_b & lane_c &
wait
echo "WAVE2 3D DONE"
for id in kart_red kart_blue kart_green kart_yellow prop_donut prop_tree prop_house; do
  u=$(url_of 3d_$id)
  if [ -n "$u" ]; then
    curl -sL "$u" -o "assets/$id.glb" && echo "saved assets/$id.glb ($(stat -f %z assets/$id.glb) bytes)"
  else
    echo "no glb for $id"
  fi
done
