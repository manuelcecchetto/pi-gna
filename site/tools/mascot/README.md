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
to 255, zeroes the color of transparent pixels and trims to the drawing. It warns when the drawing touches the edge of the source:
the generator cut something off there, and trimming would hide it. That is how the hero's wave lines shipped
half-cut on the features page; they were removed from `hero-full` (the faceless `hero-base` never had them). Check results with
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

The app icon (`resources/icon.svg`, see docs/DESIGN.md, Brand) reuses this pipeline: an icon-style peek pose
(prompted for very thick outlines, three fills, the head about 75% of the height, eyes at the middle, only two
finger strokes) came back from `gpt-image-2.5-sunburst` with `peek.webp` and `hero-full.webp` as references, then
went through `clean.py`. Full-figure poses do not survive icon sizes: by 32 px only the face and its colors read.

The DMG window background (`build/dmg-art.webp`) came the same way, at 1088x768 with a layout guide as the first
reference: flat boxes over the two Finder icon slots and their labels (kept empty), the space between them (the
arrow) and a bottom band (the lettered "Drag pi-gna into Applications"), with "never draw the boxes" in the prompt.
A first round of busy, many-Pigna scenes ignored the empty zones; capping it at 2 to 4 Pignas, asking for calm
negative space and measuring each slot's luminance spread (about 1 when it is empty) fixed that. Check the
lettering's spelling and its legibility at 1x.

Rejected along the way: a detective pose whose chin hand grew extra fingers and stray lines (regenerated with the
magnifier held out and "avoid: hand on chin, extra fingers").
