# Mascot art pipeline

The 🤌 poses in `src/assets/mascot/` and the hero layers in `src/assets/hero/` were generated with
`gpt-image-2.5-sunburst` (OpenAI Images API, `background: transparent`, quality high, 1024² for poses, 1536² for the
hero), using the app's Setup poses (`src/renderer/src/assets/setup/pigna-{joy,cool,plug}.webp`) plus the first hero
as the character model sheet. Every prompt shared the same character block (yellow pinched-fingers hand, teardrop
head, black oval eyes with white highlights, pink cheeks, white cuff, orange-and-white striped socks, dark brown
shoes; thick black outlines, flat #FFDC5D with #EF9645 cel shading) and the same avoid list (text, cast shadow,
floor, white sticker border, extra limbs).

What came back needs cleaning before use, every time:

- A faint dark or colored glow (alpha below ~60) around the outline: invisible on black, a smudge on cream.
- Alpha that tops out around 250 instead of 255, so the whole character is very slightly see-through.

`clean.py in.png out.png` cuts alpha outside a 2 px band around the solid drawing (alpha >= 128), snaps alpha >= 240
to 255, zeroes the color of transparent pixels and trims to the drawing. Check results with
`sheet.py out.jpg FBF5EA files...` (contact sheet on the site's cream) and `zoom.py` (3x crops on coral and cream);
look at the edges, not the thumbnails. The sources are then stored as lossless WebP (`cwebp -lossless -z 9 -exact`).

The hero's face is layered so it can look at the cursor and blink: an edit of the hero with "remove only the eyes,
brows and mouth, keep everything else" came back pixel-aligned, `face.py` labels the differing regions and
`layers.py` cuts eyes, brows and mouth out of the original onto `hero-base` (the faceless edit) and writes their
boxes to `hero-layers.json`. It prints the recomposition error; it should stay under 1 on average.

Those bitmap layers are not shipped: `trace_face.py` traces them into SVG (fitted ellipses for eyes and highlights,
smoothed paths for brows, mouth and tongue) and prints `src/data/hero-face.json`, which `HeroMascot.astro` draws
over `hero-base` in colors sampled from the art. Vector stays sharp at any size, has no load-order flash, and lets the face
blink and squint into `^^` without more art. Rerun it if the hero layers change.

Rejected along the way: a detective pose whose chin hand grew extra fingers and stray lines (regenerated with the
magnifier held out and "avoid: hand on chin, extra fingers").
