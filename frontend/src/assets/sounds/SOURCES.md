# Interface sound effects

UI sounds hosted by the Frutiger Aero Archive, served from its `/sounds/`
directory and used by the archive's own local music player.

| Local file | Original resource | Used for |
| --- | --- | --- |
| click.mp3 | https://frutigeraeroarchive.org/sounds/media_controls.mp3 | Shared button/link feedback, discrete setting changes, and quiet successful copy confirmation |
| open.mp3 | https://frutigeraeroarchive.org/sounds/aquarium_restore_down.mp3 | A window opening |
| close.mp3 | https://frutigeraeroarchive.org/sounds/aquarium_close.mp3 | A window closing or minimizing |
| done.mp3 | https://frutigeraeroarchive.org/sounds/download.mp3 | Confirmations: login, register, link, unlink |
| ambience.mp3 | https://frutigeraeroarchive.org/sounds/tropical_beach.mp3 | "Tropical Beach (ambience)" track in the music player |

Each MP3 is the original file, byte-for-byte as served. UI sounds are on by
default and can be turned off in Settings → Sound; they play quietly under
the page and never carry information the visible state does not.

Playback uses per-recording gain: click 16%, open 9%, close 7%, copy 10%
(the short click recording), and completion 10%. These are playback gains,
not perceived loudness measurements. Only one UI effect plays at a time.
Delegated activation covers native mouse/touch/keyboard button and link clicks;
selects and checkboxes sound once on change. Typing, focus, dragging, and
continuous seek/volume sliders are silent. Copy sounds only after clipboard
success. The Sound setting synchronizes both playback and controls across tabs,
and turning it off immediately stops the current effect.
