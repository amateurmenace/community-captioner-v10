# Caption Integration — NDI to SDI Bridge

## What This Document Is
WebSocket protocol spec and integration guide for sending live captions from a caption
source application to the NDI-to-SDI Bridge. The bridge embeds captions as broadcast-standard
CEA-708 closed captions in the SDI output via VANC ancillary data (SMPTE 334).

## How It Works (End to End)
```
Caption App (you) ──WebSocket JSON──→ NDI-to-SDI Bridge
                                        ├── Cea608Encoder: text → CC byte pairs
                                        ├── Cea708CdpBuilder: CC pairs → CDP packet
                                        └── VANC embedding → DeckLink SDI output
                                              ↓
                                        Broadcast equipment decodes CEA-708
```

## WebSocket Protocol

### Connection
The bridge acts as a **WebSocket client**. It connects to a URL provided by the user in the UI.
Your caption app must run a **WebSocket server** that the bridge connects to.

- **Transport:** `ws://` or `wss://`
- **The bridge sends:** Nothing (receive-only client)
- **Your app sends:** JSON text messages (one per caption event)

### Message Format

Each WebSocket text message should be a JSON object:

```json
{
  "text": "The caption text to display",
  "isFinal": false,
  "clear": false
}
```

#### Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `text` | string | Yes* | `""` | The caption text to embed. ASCII printable characters only (0x20–0x7F). Non-ASCII characters are replaced with `?`. |
| `isFinal` | boolean | No | `false` | When `true`, triggers a carriage return — the current line is finalized and text rolls up. Send this when a sentence/phrase is complete. |
| `clear` | boolean | No | `false` | When `true`, clears the caption display (Erase Displayed Memory). Use to blank out captions entirely. |

*`text` is required unless `clear` is `true`.

#### Plain Text Fallback
If a message is not valid JSON, the bridge treats the entire message as plain text with
`isFinal: true`. This allows simple testing by sending raw strings.

### Examples

**Partial caption (still being spoken):**
```json
{"text": "The weather today is", "isFinal": false}
```

**Final caption (sentence complete, rolls up):**
```json
{"text": "The weather today is sunny.", "isFinal": true}
```

**Clear the display:**
```json
{"clear": true}
```

**Clear then show new text:**
```json
{"text": "Breaking news", "isFinal": false, "clear": true}
```

## Caption Behavior on SDI Output

### Display Mode
Captions use **CEA-608 Roll-Up 2** mode:
- Two visible rows at the bottom of the screen (row 15)
- When `isFinal` is sent, current text rolls up one line
- New text appears on the bottom row
- This is the standard mode for live/real-time captioning

### Character Throughput
CEA-608 embeds **2 characters per video frame** (field 1 only):
- At 29.97 fps → ~60 characters/second
- At 59.94 fps → ~60 characters/second (same — one CC pair per frame)
- At 25 fps → ~50 characters/second

Typical live captioning runs at 150–200 words/minute (~15 chars/sec), well within
the 50–60 chars/sec capacity. Characters are queued and drained at frame rate.

**If you send text faster than the encoder can drain it**, characters queue up
(capped at ~20 messages). Very fast bursts may cause a slight delay in display.

### Character Set
- Printable ASCII only: space (0x20) through tilde (0x7E)
- Characters outside this range are replaced with `?`
- No Unicode, no emoji, no accented characters via standard encoding
- CEA-608 special characters (e.g., musical note, accented letters) are NOT
  currently mapped — only basic ASCII is supported

## Recommended Integration Patterns

### Pattern 1: Live Speech-to-Text (Streaming)
Send partial results as they come, then finalize:

```
→ {"text": "Good",          "isFinal": false}   // partial
→ {"text": "Good morning",  "isFinal": false}   // updated partial
→ {"text": "Good morning everyone", "isFinal": true}  // final → rolls up
```

**Important:** Each `text` message replaces the current line content in the encoder
queue. For CEA-608 roll-up mode, the bridge does NOT erase-and-rewrite partials — it
appends all text it receives to the character queue. So for streaming speech-to-text:

**Option A — Send only new characters (recommended):**
```
→ {"text": "Good ",           "isFinal": false}
→ {"text": "morning ",        "isFinal": false}
→ {"text": "everyone",        "isFinal": true}
```
Each message contains only the NEW text since the last message.

**Option B — Send complete text with clear:**
```
→ {"text": "Good",            "isFinal": false, "clear": true}
→ {"text": "Good morning",    "isFinal": false, "clear": true}
→ {"text": "Good morning everyone", "isFinal": true}
```
This clears display first, then rewrites. May cause visible flicker.

### Pattern 2: Pre-Written Captions (Scripted)
Send complete lines with `isFinal: true`:

```
→ {"text": "Welcome to the show.",     "isFinal": true}
  ... pause ...
→ {"text": "Our first guest today is", "isFinal": true}
  ... pause ...
→ {"text": "the mayor of Springfield.", "isFinal": true}
```

### Pattern 3: Manual Captioner (Operator Types Lines)
Send each line as the operator hits Enter:

```
→ {"text": "THE PRESIDENT SPOKE TODAY", "isFinal": true}
→ {"text": "ABOUT THE NEW POLICY.",     "isFinal": true}
```

## Testing Without the Full SDI Pipeline

### Quick Test with a WebSocket Server
Run a minimal WebSocket server (e.g., Python):

```python
import asyncio
import websockets
import json

async def caption_server(websocket):
    # Send a test caption every 3 seconds
    lines = [
        "This is a test caption.",
        "CEA-708 captions on SDI.",
        "Hello from the caption server.",
    ]
    for line in lines:
        await websocket.send(json.dumps({
            "text": line,
            "isFinal": True
        }))
        await asyncio.sleep(3)

async def main():
    async with websockets.serve(caption_server, "0.0.0.0", 8765):
        print("Caption server running on ws://0.0.0.0:8765")
        await asyncio.Future()

asyncio.run(main())
```

Then in the NDI-to-SDI Bridge UI, enter `ws://localhost:8765` in the caption URL field
and click the CC button.

### Verifying SDI Output
- Connect the DeckLink SDI output to a broadcast monitor with CC decoding
- Or use an SDI analyzer that can parse VANC line data (DID=0x61, SDID=0x01)
- The bridge logs `[DeckLink CC]` messages to stderr for debugging:
  ```
  [DeckLink CC] Caption VANC attached, CDP seq=0 cc1=0x14 cc2=0x25
  ```

## Technical Details (For Debugging)

### VANC Ancillary Data
- **DID:** 0x61 (97 decimal) — SMPTE 334 CEA-708
- **SDID:** 0x01 — Caption Distribution Packet
- **Line:** Auto (DeckLink SDK chooses appropriate VANC line)
- **Format:** UInt8 byte array containing the CDP

### CDP Packet Structure
```
Byte 0-1:  0x96 0x69         CDP identifier
Byte 2:    length             Total CDP length
Byte 3:    frame_rate | 0x04  Frame rate code + cc_data_present flag
Byte 4:    0xFF               Flags (caption_service_active)
Byte 5-6:  seq_hi seq_lo      Sequence counter (increments per frame)
Byte 7:    0x72               cc_data_section marker
Byte 8:    0xE0 | cc_count    cc_count with marker bits
Byte 9-11: 0xFC cc1 cc2       Field 1 CEA-608 data (the actual caption bytes)
Byte 12-14: 0xFD 0x80 0x80   Field 2 null
Byte 15+:  DTVCC null triplets (count depends on frame rate)
Last 4:    0x74 seq_hi seq_lo CRC   Footer
```

### CEA-608 Control Codes Used
| Code | Bytes | Description |
|------|-------|-------------|
| RU2 | 0x14 0x25 | Roll-Up 2 rows mode (sent at initialization) |
| PAC Row 15 | 0x14 0x70 | Position cursor at bottom row (sent at initialization) |
| CR | 0x14 0x2D | Carriage Return — rolls text up (sent on `isFinal: true`) |
| EDM | 0x14 0x2C | Erase Displayed Memory (sent on `clear: true`) |

All control codes are transmitted twice per CEA-608 spec (for error resilience).

### Per-Channel Independence
The NDI-to-SDI Bridge supports 4 independent channels (one per SDI output).
Each channel has its own:
- WebSocket connection (separate URL)
- Caption encoder state
- CDP sequence counter
- CC toggle button

You can run different caption sources on different SDI outputs simultaneously.
