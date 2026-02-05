# Community Captioner (v6.1)

**An Open Source AI Captioning Platform for Community Media**

Community Captioner is a live transcription tool designed for local government meetings, public access TV stations, and community organizations. It bridges the gap between expensive hardware encoders and accessible, accurate subtitles by leveraging modern AI (Google Gemini) and local privacy-focused models (Whisper/Ollama).

---

## 🚀 Quick Start Guide

Follow these steps to get running in under 5 minutes.

### 1. Prerequisites
*   **Node.js (v18+)**: [Download Here](https://nodejs.org/)
*   **Google Gemini API Key**: [Get it here](https://aistudio.google.com/app/apikey) (Required for Cloud Mode).

### 2. Installation
Open your terminal/command prompt in the project folder:

```bash
# 1. Install dependencies
npm install
```

### 3. Build & Launch (Important!)
The application consists of a **Frontend** (React) and a **Relay Server** (Node.js). To allow other devices (like your phone or OBS machine) to see the captions, you **MUST** build the frontend first.

```bash
# 1. Build the static web files
npm run build

# 2. Start the application
npm start
```

### 4. Accessing the App
Once started, you will see two URLs in your terminal:

*   **Dev Interface**: `http://localhost:5173`
    *   *Use this on your main computer to control the captioning.*
*   **Network/OBS URL**: `http://192.168.1.X:8080?view=output`
    *   *Use this URL in OBS Browser Sources or on other devices on the same Wi-Fi.*

---

## 🖥️ Deployment Modes

When you launch the app, you will be presented with two choices:

### 1. Run in Browser (Web App)
*   **Best for**: Quick testing, streaming from a laptop, high-accuracy cloud transcription.
*   **How to run**: Just follow the Quick Start above.
*   **Features**: access to WebSpeech API (free, decent accuracy) and Cloud Mode (Gemini, high accuracy).

### 2. Desktop App (Electron)
*   **Best for**: Permanent installations, offline use, maximum privacy.
*   **How to build**:
    ```bash
    # Generates a Windows Installer (.exe) in the dist_electron folder
    npm run dist
    ```
    *Note: macOS/Linux builds require running this command on those respective operating systems.*

---

## 🎙️ Captioning Engines

### Cloud Mode (Recommended)
*   **Engine**: Google Gemini 1.5 Flash / Gemini 2.0 Flash Live
*   **Latency**: Low (<1s)
*   **Accuracy**: Extremely High (98%+)
*   **Cost**: Uses your Google Cloud API Key. Free tier available, then pay-per-usage.
*   **Setup**: Enter your API Key in `Settings > Cloud Access`.

### Local Mode (Privacy First)
*   **Engine**: Whisper.cpp (Speech) + Ollama (Context)
*   **Latency**: Low to Medium (Hardware dependent)
*   **Accuracy**: High (95%)
*   **Cost**: Free (Runs on your GPU/CPU).
*   **Setup**: 
    1. Click "Connect Local AI" on the dashboard.
    2. Follow the wizard to install `Ollama` and the Python `server.py` script.
    3. Run the Python script to bridge the audio to the web app.

### Balanced Mode
*   **Engine**: Web Speech API (Chrome/Edge built-in)
*   **Latency**: Instant
*   **Accuracy**: Good (90%)
*   **Cost**: Free.
*   **Note**: Only works in Chrome/Edge browsers, not in the Desktop App.

---

## 🛠️ Key Features

### Audience Relay (Mobile View)
Stream real-time text to attendees' phones without needing internet hosting.
1. Start captioning.
2. Click the **QR Code** icon in the top bar.
3. Have users scan the code. They will connect to your local computer (port 8080) to view the stream.
*Note: Devices must be on the same Wi-Fi network.*

### Context Engine
Teach the AI about your town.
*   **Manual**: Add "Smythe" -> "Smith" rules.
*   **AI Scraper**: Enter a municipality name (e.g., "Cambridge, MA") and the system will scrape public agendas to learn names of councilors and streets automatically.

### Highlight Studio
Clip social media moments live.
1. During a meeting, click **"Clip"** next to a great quote in the Transcript view.
2. Go to **Highlight Studio**.
3. Click **Generate Reel**.
4. The app uses FFmpeg (in-browser) to slice the video file and export a vertical (9:16) clip ready for TikTok/Reels.

---

## ⚠️ Troubleshooting

**"Frontend build not found" on port 8080**
*   The Relay Server cannot find the `dist` folder.
*   **Fix**: Stop the server and run `npm run build`, then `npm start`.

**OBS Overlay is white/opaque**
*   The browser source background isn't clearing.
*   **Fix**: In OBS Browser Source properties, add this to "Custom CSS":
    ```css
    body { background-color: transparent !important; margin: 0px auto; overflow: hidden; }
    ```

**Mobile phone cannot connect**
*   Your computer's firewall might be blocking Node.js.
*   **Fix**: Allow `node` through Windows Defender Firewall on Private Networks.
*   Ensure the phone is not on a "Guest" network that isolates clients.

---

## License
Open Source (CC BY-NC-SA 4.0)
Designed by Stephen Walter + AI for the weirdmachine.org community project.
