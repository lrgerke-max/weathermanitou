# Brand assets

## `ymca-logo.svg`

The dashboard header loads `assets/ymca-logo.svg`. It is the official
full-colour blue/purple mark, converted from the association's
`ymca_blu_rgb_r.eps` (Adobe Illustrator, RGB, with the registered mark) as
supplied from the Brand Resource Center.

The conversion was EPS → PDF → SVG:

```bash
gs -dNOPAUSE -dBATCH -dEPSCrop -sDEVICE=pdfwrite \
   -dColorConversionStrategy=/LeaveColorUnchanged \
   -sOutputFile=logo.pdf ymca_blu_rgb_r.eps
pdftocairo -svg logo.pdf assets/ymca-logo.svg
```

`pdftocairo` matters here: it keeps the gradients as real vector
`radialGradient` elements. Converting by way of a rasteriser bakes them into
embedded bitmaps that pixelate as the logo scales up on a 1440p screen.

The artwork itself is untouched — same paths, same colours, same registered
mark, 288 × 220.11 pt as it came. Nothing was redrawn, recoloured or retyped,
which matters because the Y logo is a registered trademark and the Brand
Graphics Guide forbids recreating, retyping, restyling, recolouring, rotating,
stretching, outlining, enclosing or locking it up with other words (p11–12).
Format conversion is not alteration; redrawing would be.

**Do not** substitute artwork extracted from the Brand Graphics Guide PDF —
p49 says explicitly that it "should not be extracted from this PDF file".
Always start from a file supplied by the Brand Resource Center.

If the file is ever removed the header shows a red dashed "Y logo missing"
marker instead. That is deliberate. A silently blank header looks like a design
decision; a marker does not, and nobody hangs a screen in the camp office with
an obvious red box on it by accident.

`tools/build-single.mjs` looks for `.svg` first, then `.png`, and inlines
whichever it finds as a data URI so the offline build carries its own branding.

### Which version to use

This build places the logo on a **white** band, which is what the full-colour
version requires — it "may only appear on a white background" (p11). The brand
bar therefore stays white in both light and dark themes.

If you would rather the header follow the dark theme, you need the **knockout
(white)** version of the logo instead, and it must sit on a background dark
enough to keep it legible (p11). Swap the file and set the `.brandbar`
background in `css/dashboard.css`; nothing else needs to change.

### Clear space

Clear space is enforced in CSS, not by eye, from two variables in
`css/dashboard.css`:

```css
--logo-clear: 1;      /* minimum clear space, in multiples of the height of "the" */
--logo-name-gap: 1;   /* gap between the logo and "YMCA Camp Manitou-Lin" */
```

`--logo-clear: 1` is the minimum the guide requires on all sides (p13). Do not
go below it.

`--logo-name-gap` ships at `1` at the camp's request, because the doubled gap
looked wrong with the name set directly beneath the mark. The guide asks for
**2** here — double clear space between the logo and a branch or association
name, so the branch is not confused with the national Y (p13). Set it back to
`2` if a brand review asks. That is the one place this build knowingly departs
from the standard.

Minimum logo height is 0.25 inch (p13). At the sizes this layout uses on a
1080p or 1440p screen, that is not a constraint you can hit by accident.

## Before this goes public

`index.html` is served by GitHub Pages, which is a public website. Page 32:

> If the application is intended for use beyond a YMCA's immediate service
> area, email theYbrand@ymca.net prior to website launch with a description of
> intended usage.

A screen on the wall of the camp office plainly is not that. A public URL
plausibly is. Worth an email before this is linked anywhere outside camp.
