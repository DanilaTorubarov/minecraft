# Interface artwork

The active wallpaper is [asadal-stock-18.webp](asadal-stock-18.webp), converted from
`asadal_stock_18.jpg` supplied by the user, for the Light theme. Dark uses
[night-park.webp](night-park.webp), also supplied by the user, so the night scene
is the image as given rather than a dimmed daylight scene. Both wallpapers are
decorative and do not depict the actual server world.

- [Original Asadal image](https://frutigeraeroarchive.org/images/wallpapers/asadal_stock/asadal_stock_18.jpg)
- [Archive wallpaper catalog](https://frutigeraeroarchive.org/wallpapers)
- [Source, processing, and rights sidecar](asadal-stock-18.webp.json)
- [Night scene processing and rights sidecar](night-park.webp.json)

The supplied Asadal image was resized to 2400px wide and encoded as WebP at quality 88.
The archive labels Asadal images for archival/personal use; commercial licensing
is available from Asadal or Pixta. Attribution is not a license.

`night-park.webp` arrived as a 3840×2160 PNG and was processed the same way
(resized to 2400px wide, WebP quality 88). Its content is unmodified, and Dark
applies only a light `brightness(.94) saturate(.95)`. The live-wallpaper shader
swaps textures with the theme and leaves the night art free of the daylight
scene's dimming, because the image is already dark.

The previous generated `aero-landscape.webp` / `aero-night.webp` and their prompt
sidecars were removed from project assets, and the Dark theme does not reuse
those names: its night scene is the user-supplied `night-park.webp` described
above. Original generated outputs remain in the imagegen folder outside the
repository and are not loaded by this interface.

Open Sans is self-hosted in `fonts/open-sans.ttf`; its SIL Open Font License is in
`fonts/open-sans-LICENSE.txt`. The former Minecraft font, dirt, and wood files remain
as unused historical assets.

## Icons and cursors

The site uses the user-selected original Vista icon artwork and archive-linked
Green (Aero) cursor files. No icons or cursors are generated. Source URLs, original
frame extraction, cursor hotspots, and rights information are recorded in
[icons/SOURCES.md](icons/SOURCES.md) and [cursors/SOURCES.md](cursors/SOURCES.md).
