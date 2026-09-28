# TODO

- [x] Make the orb resizable
- [x] When the orb is resized to its maximum size, centre it on the screen in app window only
- [x] Make the transcript text size adjustable
- [x] Add a "Test my voice" option in Settings → Voice → Voice ID so after setting up, I can check it recognises my voice
- [x] In Settings, hide each label's description behind an info icon next to the label, and show the description when I hover over the icon
- [x] Give Voice ID a master override keyword that works anywhere, from any voice, and overrides any Voice ID that's already set up
- [x] Make the response cards that show on screen after a reply close by themselves after a few seconds
- [ ] Make Voice ID recognise my voice reliably — it's hit or miss and often says it couldn't tell it was me, even though I set it up with my own voice. Leads:
  - [x] Speech a window hears itself (not the Mac app's ear) never gets a voiceprint, so with Voice ID on it's always "unsure" → "I couldn't tell that was you" (`apps/daemon/src/server.ts:695`). Route that audio through Voice ID too, or say which ear is listening
  - [x] Setup takes only 6 short phrases in one sitting; ask for more and longer speech (aim for ~30–60 s in total), including a free-talk part, and at different distances/volumes (normal, quiet, a bit further from the mic)
  - [x] Make setup explicit: check each phrase before accepting it — loudness, background noise, clipping, length of actual speech, and pitch range — and show a live meter plus a per-phrase ✓ or "say it again because…" so setup only completes once it has every bit of data it needs
  - [x] End setup with a built-in check: a few new phrases that must come out as "you" (with the scores shown) before Voice ID is switched on; if they don't, keep collecting instead of finishing
  - [x] Thresholds are set from how alike the setup phrases are to their own average (`enrollFrom` in `apps/daemon/src/hearing/voiceid.ts`), which flatters them; set the bars leave-one-out, or from the end-of-setup check, so the "you" bar isn't too high for real turns
  - [x] Keep several voiceprints (e.g. per microphone, or a few clusters) instead of one average, and match against the closest
  - [x] Let "unsure" turns that I then confirm (via the talk shortcut) teach Voice ID, and offer "Improve my voice" to add phrases without redoing setup
  - [x] Log each turn's score, length and ear to daemon.log so misses can be diagnosed
- [x] Remove the "System 1" and "System 2" items from the dock. There's no need to show those two items on the dock
