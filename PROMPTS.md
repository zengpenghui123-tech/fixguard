# fixguard — Image generation prompts

Use these with Gemini / Midjourney / DALL-E / Flux to generate visual
assets for the launch. Each prompt targets a specific placement.

---

## 1. Hero banner (README / blog header, 16:9)

```
A minimalist technical illustration, 16:9 horizontal. Dark background
#0A0A0C. Three horizontal layers of thin code-like lines flowing left
to right across the frame in muted gray #333333. Five scattered segments
within the lines glow in teal #0D9488, each with a soft luminous halo —
these are "protected scars." Above one glowing segment, a minimalist
copper #CC7A52 cursor-arrow descends from the top of the frame and
pauses just above the teal halo, unable to touch the line. Clean
negative space around the pause moment. No text. Tongyi Minimal
aesthetic, editorial tech illustration. Flat vector, no 3D, no
gradients, no ornament.

Avoid: literal wounds, flesh, blood, shields, locks, chains, padlocks,
purple, green (except the specific teal), generic AI blue glow, cartoon
robots, faces, keyboards, typewriter effects, binary code, matrix rain.
```

---

## 2. Architecture diagram (blog / README, 3:2)

```
A minimalist vertical data flow diagram on dark background #0A0A0C.
Seven horizontal layers arranged top to bottom, connected by thin
directional arrows. Each layer has a label in small uppercase monospace
text on the left and 1-3 rounded rectangles inside.

Top layer "SOURCE": one teal #0D9488 outlined rectangle
Second layer "SCORING": two teal rectangles side by side with an arrow
Third layer "STATE": three copper #CC7A52 file-shaped rectangles with
  a dotted feedback arrow looping back up
Fourth layer "ENFORCEMENT": two teal rectangles
Fifth layer "BLOOD LOG": one wide copper rectangle with arrows from
  enforcement flowing down into it
Sixth layer "LEARNING": one teal rectangle with arrows to three copper
  output nodes labeled "weights" "patterns" "dreams"
Bottom: two small text labels "Claude Code" and "git commit" with
  dashed arrows pointing up to the enforcement layer

Style: thin 1.5px outlines, no fills, generous white space between
layers, monospace text, strictly orthogonal arrows, editorial technical
diagram. Like Stripe docs or Linear engineering blog illustrations.
Colors: only teal #0D9488, copper #CC7A52, and gray text on #0A0A0C.

Avoid: 3D, isometric, hand-drawn, cartoon, gradients, shadows, glow,
circuit board motifs, decorative elements, purple, green, neon.
```

---

## 3. "Before / After" social card (Twitter / LinkedIn, 1:1)

```
A square 1:1 illustration split vertically in the middle by a thin
white line. Dark background #0A0A0C on both sides.

Left side (labeled "WITHOUT" in tiny text at top): three horizontal
gray lines representing code. The middle line has a small red #CC3333
"X" mark where a segment was removed. A downward arrow leads to a
small broken-circle icon at the bottom.

Right side (labeled "WITH FIXGUARD" at top): same three gray lines,
but the middle line has a teal #0D9488 glowing segment intact. A
copper #CC7A52 cursor-arrow approaches from above but is stopped by
a thin teal arc. A small checkmark at the bottom.

Style: extremely minimal, flat vector, Tongyi Minimal aesthetic.
No text except the two tiny labels. Generous negative space. Clean
enough to read at thumbnail size.

Avoid: words, sentences, detailed code, realistic images, 3D,
gradients, purple, green, shields, chains.
```

---

## 4. Logo mark (favicon / avatar, 1:1)

```
A minimalist app icon, 1:1 square. Dark background #0A0A0C. Centered:
a single thin horizontal line in muted gray, with a short teal #0D9488
segment in the middle. Above and below the teal segment, two concentric
thin arcs curve protectively, like eyelids or brackets. The overall
shape suggests "a line of code being watched over." Must be recognizable
at 16x16 favicon size.

Style: flat vector, single accent color on dark, geometric logomark.
Think Vercel triangle, Supabase hexagon, Linear arc.

Avoid: text, letters, faces, eyes (too literal), medical cross, shield
shapes, padlocks, complex details, gradients, 3D.
```

---

## 5. "小白版" 故事图 (5-panel vertical storyboard, 9:16)

```
A 5-panel vertical storyboard, 9:16 portrait. Dark background #0A0A0C.
Clean flat vector, each panel separated by a thin teal horizontal line.
No text anywhere in the image.

Panel 1: A small human silhouette in teal #0D9488 sitting at a desk,
hunched over a laptop. A tiny lightbulb above their head.

Panel 2: Close-up of three horizontal code-lines. The middle line
glows teal with a small crescent "scar mark" above it.

Panel 3: A minimalist copper #CC7A52 robot arm approaches the three
lines from the right. A transparent teal arc appears between the hand
and the glowing line.

Panel 4: The robot stops. A small "!" in copper above its head.

Panel 5: The three lines are intact, middle still glowing. A small
teal checkmark in the corner. The robot walks away to the left.

Style: friendly, minimalist editorial illustration, storybook
progression. Generous white space. Only teal #0D9488 and copper
#CC7A52 on #0A0A0C. No text.

Avoid: text, code characters, keyboard details, faces with features,
cartoon style, 3D, gradients, purple, green, gold.
```

---

## Usage guide

| Asset | Where to use | Which prompt |
|---|---|---|
| README hero | GitHub repo top | #1 or #2 |
| Blog header | STORY.md / Medium / Substack | #1 |
| Architecture | README or blog mid-section | #2 |
| Twitter card | Launch tweet | #3 |
| Favicon / avatar | GitHub profile + npm | #4 |
| Non-technical explainer | Product page / pitch deck | #5 |

**Tips for Gemini:**
- Run each prompt 3-4 times, pick the cleanest result
- Text in generated images is unreliable — add labels in Figma/Canva after
- If Gemini adds unwanted elements (colored dots, toolbar chrome), add
  them to the "Avoid" list and rerun
- Aspect ratio: repeat the ratio 2-3 times in the prompt to enforce it
