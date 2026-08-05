# Brand assets

## `ymca-logo.svg` — required, not included

The dashboard header loads `assets/ymca-logo.svg`. That file is **not** in this
repository and cannot be generated.

The Y logo is a registered trademark. The Brand Graphics Guide is explicit that
it may not be recreated, retyped, restyled, recoloured, rotated, stretched,
outlined, enclosed in a shape, or locked up with other words (p11–12), and that
artwork "should not be extracted from this PDF file" (p49). So it has to be the
official file.

**Download it from the Brand Resource Center** and commit it here:

```
assets/ymca-logo.svg      full-colour version (preferred)
```

A `.png` also works — `tools/build-single.mjs` looks for `.svg` first, then
`.png`, and inlines whichever it finds as a data URI so the offline build
carries its own branding.

Until the file exists the header shows a red dashed "Y logo missing" marker.
That is deliberate. A silently blank header looks like a design decision; a
marker does not, and nobody hangs a screen in the camp office with an obvious
red box on it by accident.

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
