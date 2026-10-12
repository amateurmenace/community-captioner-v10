# Blackmagic Web Presenter 4K: embedded CEA-608/708 captions reach the stream incomplete

Bug report with the evidence gathered on 12 October 2026 (Studio A, Brookline Interactive Group).
Send to Blackmagic support with the captures named at the end.

## Setup

- Two Web Presenter 4K units, software 4.2.3, same result on both. Input 1920×1080p29.97 (also tested 1080i59.94 and 1080p30), streaming to YouTube / to a local RTMP receiver at ~5.4 Mb/s. Video format "Auto". Nothing else attached (no USB, no recording).
- SDI source: Community Captioner (DeckLink 8K Pro output) carrying a SMPTE 334-2 CDP on VANC line 9 of every frame: 20 cc_data triplets (CEA-608 field 1 pair, field 2 null, DTVCC packet or cc_valid=0 padding), ccsvcinfo, correct checksum, sequence counter incrementing per frame, odd parity on every 608 byte, RP188 VITC/LTC timecode on every frame. The Web Presenter's monitor reports "Closed Captions CEA608".
- Fed from a Videohub 40×40 12G and, in a second test, by a direct cable from the DeckLink — no difference.

## Symptom

The H.264 stream carries an ATSC A/53 caption SEI on every frame, but only about half of the frames carry the caption data that was on the SDI; the rest carry a null layout. The loss comes in blocks of 10–30 frames (whole rows of a caption vanish, whole rows pass), is the same for CEA-608 pairs and for DTVCC (708) packets, and does not depend on the data rate (one 608 pair per frame, per 2, per 3 or per 4 frames all lose about half) or on repeating pairs.

## Evidence (numbered test pattern)

1. **The SDI input is complete.** A DeckLink input on the sending PC, fed from the same Videohub input, decoded the same seconds: 1186 frames, a CDP on all 1186, and all 240 pairs of a numbered CEA-608 pattern (15 rows of 16 unique pairs `A0 A1 … Z9`, each row preceded by RU2 RU2 CR CR) decoded in order (`loop-pattern.txt`).

2. **The Web Presenter's RTMP output of the same seconds is not.** Decoding the SEI of every frame (`snap5-cc.csv`, columns: frame, I/P, cc_count, field-1 pair, text, DTVCC bytes): **120 of the 240 pattern pairs survived (50 %)**. Survival map (one character per sent pair, `#` received on the expected frame, `.` lost):

   ```
   row  0: ##..##....######      row  8: ###.#.....##....
   row  1: ###.#.####......      row  9: #.##############
   row  2: .##...##.###....      row 10: #........#######
   row  3: ..##....##......      row 11: ################
   row  4: #.#..#.#..#.##.#      row 12: ######.#.####.##
   row  5: #.....#......#..      row 13: #####.####.#.#.#
   row  6: #...####........      row 14: #...#.#..##.#...
   row  7: ................
   ```
   Surviving pairs arrive on the frame they were sent on (no queueing), position in the row does not matter, I/P frame type does not matter. An earlier 90 s capture of live speech showed the same thing: 71 frames with data out of ~200 sent, no control codes.

3. **DTVCC is lost the same way.** 40 one-packet CEA-708 captions sent on consecutive frames: 16 arrived (`##.......#####......##.##.#.###.....#...`).

4. **YouTube renders what it receives**: with the stream set to Embedded 608/708 its live caption track shows the fragments.

## Questions for Blackmagic

- What is the caption path between the SDI VANC reader and the H.264 SEI writer in 4.2.3, and why does it skip blocks of frames?
- Is there a firmware version, input format or setting where every frame's cc_data is forwarded?

## Workaround in use

Captions are delivered to YouTube through its caption-ingestion POST URL (bypassing the encoder), which the captioner supports; embedded captions stay on the SDI for in-room decoders.

## Files

`wp-pattern-window.ts` (the Web Presenter's RTMP output for the pattern test), `snap5-cc.csv` (its per-frame caption SEI decode), `loop-pattern.txt` (the DeckLink loopback decode of the same seconds), `pattern-1080i.log` (what was sent and when). The scripts that produced them are in the Claude session scratchpad (`sei-cc.mjs`, `wp-pattern.mjs`, `pattern-analyze.mjs`); copies of the files are in `Desktop\web-presenter-evidence\` on the sending PC.
