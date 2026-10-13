# Blackmagic Web Presenter 4K: embedded CEA-608/708 captions reach the stream incomplete

Bug report with the evidence gathered on 12 and 13 October 2026 (Studio A, Brookline Interactive Group, Brookline MA).
Sent to Blackmagic support with the files listed at the end.

## Summary

The Web Presenter 4K (software 4.2.3, the latest offered by Blackmagic Streaming Setup 4.2.4) forwards only a fraction of the
closed-caption data that arrives on its SDI input into the H.264 stream it sends out. Every output frame carries an ATSC A/53
caption SEI, but 21–50 % of the frames (varying with time, in bursts) carry a null layout instead of the cc_data that was on the
SDI, the unit keeps only the first CEA-608 field-1 pair of each frame, and once in this testing its caption path stopped forwarding
anything at all until the stream was stopped and started. A second encoder on the same SDI (OBS Studio with a DeckLink input)
forwarded 100 % of the same data, so the SDI signal is not the cause.

## Setup

- Unit: Blackmagic Web Presenter 4K "Web Presenter Control Room", MAC 7C-2E-0D-A5-48-39, software 4.2.3. A second Web Presenter 4K
  on the same network showed the same behaviour on 12 October. Blackmagic Streaming Setup 4.2.4 (Windows) connected over USB shows
  "Software: Version 4.2.3" with no update offered.
- Input: 1920×1080p29.97 (also tested 1080i59.94 and 1080p30), fed from a DeckLink 8K Pro output (Desktop Video 16.3, Windows 10
  IoT Enterprise LTSC 2021) directly and through a Videohub 40×40 12G; no difference. Video format "Auto". Nothing else attached.
- Caption data on the SDI: a SMPTE 334-2 CDP on VANC line 9 of every frame (lines 9–20 also tested): 20 cc_data triplets (CEA-608
  field-1 pair, field-2 null, DTVCC packet or cc_valid = 0 padding), ccsvcinfo section, sequence counter, checksum, odd parity on
  every 608 byte, RP188 VITC/LTC. The unit's own monitor reports "Closed Captions CEA608" on the input.
- Output: YouTube RTMP, or "Custom URL H.264" to an ffmpeg receiver on the LAN (`ffmpeg -listen 1 -c copy`), Streaming High
  (also Medium and Low), RTMP and SRT, 1080p29.97 at about 5.4 Mb/s.

## Symptom

The H.264 stream carries an A/53 caption SEI on every frame, but only part of the frames carry the caption data that was on the SDI;
the rest carry a null layout. Losses come in bursts (median 1 frame, up to 16), are the same for CEA-608 pairs and DTVCC packets,
and do not depend on data rate or content. Viewers on YouTube see captions with characters, carriage returns and whole rows missing.

## Evidence 1 (12 October): the SDI is complete, the stream is not

A numbered test pattern makes every surviving pair identify the frame it was sent on: 15 rows of 16 unique CEA-608 pairs
(A0 A1 … Z9), each row preceded by RU2 RU2 CR CR, one pair per frame.

1. **The SDI input is complete.** A DeckLink input on the sending PC, fed from the same Videohub input, decoded the same seconds:
   1186 frames, a CDP on all 1186, all 240 pattern pairs in order.
2. **The unit's RTMP output of the same seconds is not.** Decoding the SEI of every frame: **120 of the 240 pairs survived (50 %)**.
   Survival map (one character per sent pair, `#` received on the expected frame, `.` lost):

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
   Surviving pairs arrive on the frame they were sent on (no queueing); position in the row and I/P frame type do not matter.
   A 90 s capture of live speech showed the same: 71 frames with data out of about 200 sent, no control codes at all.
3. **DTVCC is lost the same way.** 40 one-packet CEA-708 captions sent on consecutive frames: 16 arrived
   (`##.......#####......##.##.#.###.....#...`).
4. **Loss statistics** over 44 traces / 3,820 frames from that day: 21 % of frames lost overall, bursts of median length 1 frame
   (62 % of bursts are one frame, maximum 16); fitted as a two-state (Gilbert) process, P(lost | previous kept) = 0.14 and
   P(kept | previous lost) = 0.52. Later runs the same day lost 35 %, and 50 % the next morning: the rate varies with time, not load.
5. **Nothing on the SDI side changes it**: 1080p29.97 / 1080i59.94 / 1080p30, VANC lines 9 to 20, RP188 on or off, one pair every
   1 / 2 / 3 / 4 frames, repeated pairs, direct cable or Videohub, either unit.
6. **The unit re-packs every CDP to 20 triplets** (cc_count 24 and 25 came out as 20 plus a 2-byte fragment) and **a 31-triplet CDP
   wedges its caption reader**: every SEI then carries cc_count 0 until the stream is stopped and started; dropping the SDI does
   not clear it.
7. **YouTube renders what it receives**: with the stream set to Embedded 608/708, its caption track shows the fragments.

## Evidence 2 (13 October): a second encoder on the same SDI forwards everything

1. **Control encoder.** OBS Studio 32.1.1 on the sending PC took the same SDI through a DeckLink input (a loopback of the output
   that feeds the Web Presenter), with its Decklink Captions tool forwarding the VANC captions into x264's A/53 SEI, and streamed to
   the same ffmpeg receiver. The numbered pattern arrived **240 of 240 pairs with all 60 control codes**. In the same hour the Web
   Presenter forwarded **153 of 240 (36 % lost)** and 26 of the 60 control pairs.
2. **The unit keeps only the first CEA-608 field-1 pair of each frame.** CDPs carrying 2, 4, 8 and 19 valid field-1 pairs per frame
   (standard 20-triplet layout, extra pairs in place of the DTVCC padding) each came out with at most one pair per frame.
3. **Output settings do not change it**: Streaming Medium 130/240, Streaming Low 142/240, SRT instead of RTMP 123/240, the ccsvcinfo
   section only in every 5th CDP 142/240 (the baseline that hour was 153/240).
4. **The unit's own timecode is continuous.** The stream carries a pic_timing SEI with timecode on every frame; over 1,500 frames
   every step was +1 (except the two drop-frame skips), so no video frames are dropped: only the caption data is.
5. **A complete outage.** One 5-minute stream (9,143 frames) carried cc_count 0 on every frame, nothing forwarded, while the SDI
   carried the same captions as before (verified on the loopback); stopping and starting the stream from the unit's REST API
   restored forwarding. It began after a USB session with Blackmagic Streaming Setup 4.2.4; sending the one-frame CDP layouts
   while streaming or idle, and dropping the SDI while idle, did not reproduce it.

## Questions for Blackmagic

- What is the caption path between the SDI VANC reader and the H.264 SEI writer in 4.2.3, and why does it skip blocks of frames?
- Why does the unit keep only the first field-1 pair of a frame and re-pack the CDP to 20 triplets, and why does a 31-triplet CDP
  stop forwarding until the stream is restarted?
- Is there a software version, input format or setting where every frame's cc_data is forwarded unchanged?

## Workaround in use

Captions are delivered to YouTube through its caption-ingestion POST URL (bypassing the encoder) or, when they must be embedded,
as one-frame CEA-708 captions repeated six times, which survive the loss but cap throughput at about 23 characters per frame.
Embedded captions stay on the SDI for in-room decoders.

## Files (available on request; the captures are 26–175 MB)

- `snap5-cc.csv` — the per-frame caption-SEI decode of the 12 October pattern run; `loop-pattern.txt` — the DeckLink loopback decode
  of the same seconds; `pattern-1080i.log` — what was sent and when; `wp-pattern-window.ts` — the unit's RTMP output for that run.
- `obs-cap1.csv` — the per-frame decode of the OBS control run (240/240); `wp-v423b.csv` — the Web Presenter run of the same hour
  (153/240); `wp-wedge-N19.csv` — 19 field-1 pairs per CDP sent, one per frame received; `wp-v423a.csv` — the stream with cc_count 0
  on every frame.
- The scripts that produced them (`sei-cc.mjs`, `wp-pattern.mjs`, `pattern-analyze.mjs`) are in the open-source Community Captioner
  repository, `tools/sdi-verify/captions/`.
