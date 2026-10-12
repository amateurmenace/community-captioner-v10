# Blackmagic Web Presenter 4K: embedded CEA-608 captions reach YouTube incomplete

Draft bug report with the evidence gathered on 12 October 2026. Send to Blackmagic support with the three captures named at the end.

## Setup

- Web Presenter 4K, software 4.2.3, input 1920×1080p29.97 SDI, streaming 1080p29.97 at ~5.4 Mb/s to YouTube (RTMP).
- SDI source: Community Captioner (DeckLink 8K Pro output) carrying CEA-608 captions in a SMPTE 334-2 CDP on VANC line 9 of every frame: 20 cc_data triplets (field 1 pair, field 2 null, 18 × cc_valid=0 DTVCC padding), ccsvcinfo describing one line-21 service, correct checksum, sequence counter incrementing per frame. Odd parity on every 608 byte.
- The Web Presenter's monitoring screen reports "Closed Captions CEA608".

## Symptom

YouTube (stream set to Embedded 608/708) shows either nothing, or a single 32-character row that fills with fragments of the captions and then stops rolling. Example: for the caption "Emily Jacobson." YouTube rendered "ily Jacobson."; for "Race that issue raise that question and something a good one" it rendered "ce thaissue" and then, over the next minute, three isolated characters.

## Evidence

1. **The SDI input is complete.** The same SDI signal was looped into a DeckLink input on the sending PC and decoded with an independent reader (`decklink_probe` in this folder). Over a 40 s window every frame carried a CDP on line 9 and the decoded CEA-608 text matched the sender's log exactly, including the roll-up control codes (RU2, PAC, CR).

2. **The Web Presenter's own RTMP output is not.** The Web Presenter was pointed at an RTMP receiver on the LAN (`ffmpeg -listen 1 -i rtmp://0.0.0.0:1935/live/test -c copy wp-capture.ts`) for 90 s while the SDI input carried six captions (about 200 character pairs plus their control codes). In the capture:
   - 2698 video frames, 29.97 fps, no timestamp gaps, Main profile, I/P only;
   - an ATSC A/53 caption SEI (`GA94`, user_data_type 3, cc_count 20, process_cc_data 1) on **every** frame, with the sender's triplet layout reproduced exactly;
   - but only **71 frames carry a non-null field-1 pair, and 0 control-code pairs** are present. The surviving pairs cluster in the first ~8 frames of each burst of speech (frames 297–302, 304–308, then 312, 315, 322, 326; 1155, 1162, 1167–1169, 1178–1180; 1540, 1547–1554, 1560, 1566; 1899–1904 …) and thin out to roughly one in ten afterwards. All other frames carry the null pair `0x80 0x80`.
   - Decoding those 71 pairs gives "The word thas in the aitsn'rinthse so whnumberIta calculation its tWhatever…" for what left the sender as six complete captions.

3. **YouTube renders what it receives.** YouTube's live caption track (WebVTT segments of the `en` track) showed the same fragments growing into one 32-character row and then overwriting column 32, consistent with never receiving a carriage return.

So the loss is inside the Web Presenter, between reading the VANC packet and writing the SEI: it keeps a small burst of consecutive packets and then samples. The doubled control codes (sent on consecutive frames, as CEA-608 requires) never make it through.

## Questions for Blackmagic

- Is the VANC → SEI caption path rate-limited or buffered in 4.2.3, and does it depend on the input format (progressive 1080p29.97 here)?
- Is there a firmware version where embedded 608 pairs are forwarded on every frame?

## Workaround in use

Captions are delivered to YouTube through its caption-ingestion POST URL (bypassing the encoder), which the captioner supports; embedded captions stay on the SDI for in-room decoders.

## Files

`wp-capture.ts` (the Web Presenter's RTMP output, 90 s), `loop-during-rtmp.txt` (loopback decode of the same seconds with hex dumps of the packets), and the sender's relay log for the window. They are on the sending PC under the Claude session scratchpad (`…\scratchpad\onsite\rtmp\` and `…\onsite\`); copy them somewhere permanent before sending.
