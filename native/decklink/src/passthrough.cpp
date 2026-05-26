#include "passthrough.h"
#include "vanc_packet.h"
#include <cstring>
#include <cstdio>

PassthroughHandler::PassthroughHandler()
    : m_inputDeckLink(nullptr)
    , m_outputDeckLink(nullptr)
    , m_input(nullptr)
    , m_output(nullptr)
    , m_width(1920)
    , m_height(1080)
    , m_rowBytes(1920 * 2)
    , m_currentMode((BMDDisplayMode)0)
    , m_frameDuration(0)
    , m_timeScale(0)
    , m_playbackStarted(false)
    , m_outputFrameCount(0)
    , m_prerollCount(0)
    , m_nextWriteIdx(0)
    , m_nextCompletedIdx(0)
    , m_running(false)
    , m_framesOutput(0)
    , m_droppedFrames(0)
    , m_refCount(1)
{
}

PassthroughHandler::~PassthroughHandler() {
    Stop();
}

void PassthroughHandler::AllocateFramePool() {
    for (int i = 0; i < kFrameCount; i++) m_frames[i] = nullptr;
    if (!m_output) return;
    for (int i = 0; i < kFrameCount; i++) {
        m_output->CreateVideoFrame(m_width, m_height, m_rowBytes,
                                    bmdFormat8BitYUV, bmdFrameFlagDefault, &m_frames[i]);
    }
    m_nextWriteIdx = 0;
    m_nextCompletedIdx = kFrameCount; // all frames available
}

void PassthroughHandler::ReleaseFramePool() {
    for (int i = 0; i < kFrameCount; i++) {
        if (m_frames[i]) { m_frames[i]->Release(); m_frames[i] = nullptr; }
    }
}

static IDeckLink* GetDeviceByIndex(uint32_t index) {
    IDeckLinkIterator* iterator = CreateDeckLinkIterator();
    if (!iterator) return nullptr;

    IDeckLink* deckLink = nullptr;
    uint32_t idx = 0;
    while (iterator->Next(&deckLink) == S_OK) {
        if (idx == index) { iterator->Release(); return deckLink; }
        deckLink->Release();
        deckLink = nullptr;
        idx++;
    }
    iterator->Release();
    return nullptr;
}

bool PassthroughHandler::Start(uint32_t inputDeviceIndex, uint32_t outputDeviceIndex,
                                BMDDisplayMode displayMode) {
    if (m_running) return false;

    // Open input device
    m_inputDeckLink = GetDeviceByIndex(inputDeviceIndex);
    if (!m_inputDeckLink) {
        fprintf(stderr, "[Passthrough] Input device %u not found\n", inputDeviceIndex);
        return false;
    }

    if (m_inputDeckLink->QueryInterface(IID_IDeckLinkInput, (void**)&m_input) != S_OK) {
        fprintf(stderr, "[Passthrough] Input device has no input interface\n");
        Stop();
        return false;
    }

    // Open output device (may be same physical card, different sub-device)
    m_outputDeckLink = GetDeviceByIndex(outputDeviceIndex);
    if (!m_outputDeckLink) {
        fprintf(stderr, "[Passthrough] Output device %u not found\n", outputDeviceIndex);
        Stop();
        return false;
    }

    if (m_outputDeckLink->QueryInterface(IID_IDeckLinkOutput, (void**)&m_output) != S_OK) {
        fprintf(stderr, "[Passthrough] Output device has no output interface\n");
        Stop();
        return false;
    }

    // Get display mode dimensions AND the frame rate (needed for scheduled playback).
    IDeckLinkDisplayModeIterator* modeIter = nullptr;
    m_output->GetDisplayModeIterator(&modeIter);
    if (modeIter) {
        IDeckLinkDisplayMode* modeObj = nullptr;
        while (modeIter->Next(&modeObj) == S_OK) {
            if (modeObj->GetDisplayMode() == displayMode) {
                m_width = modeObj->GetWidth();
                m_height = modeObj->GetHeight();
                m_rowBytes = m_width * 2; // UYVY
                modeObj->GetFrameRate(&m_frameDuration, &m_timeScale);
                modeObj->Release();
                break;
            }
            modeObj->Release();
        }
        modeIter->Release();
    }
    if (m_frameDuration == 0 || m_timeScale == 0) {
        // Sensible default: 29.97p
        m_frameDuration = 1001;
        m_timeScale = 30000;
    }

    // Enable output with VANC
    HRESULT hr = m_output->EnableVideoOutput(displayMode, bmdVideoOutputVANC);
    if (hr != S_OK) {
        fprintf(stderr, "[Passthrough] EnableVideoOutput failed: 0x%08X\n", (unsigned)hr);
        Stop();
        return false;
    }

    // Enable audio output. DeckLink scheduled video playback REQUIRES paired
    // audio enablement on this card family — without it the device's
    // playback clock doesn't advance past the initial buffer drain (we saw
    // playback stall at ~35 frames every time). We schedule silent samples
    // alongside each video frame just to keep the clock progressing.
    hr = m_output->EnableAudioOutput(bmdAudioSampleRate48kHz,
                                      bmdAudioSampleType16bitInteger,
                                      2,
                                      bmdAudioOutputStreamTimestamped);
    if (hr != S_OK) {
        fprintf(stderr, "[Passthrough] EnableAudioOutput failed: 0x%08X\n", (unsigned)hr);
        Stop();
        return false;
    }
    hr = m_output->BeginAudioPreroll();
    if (hr != S_OK) {
        fprintf(stderr, "[Passthrough] BeginAudioPreroll failed: 0x%08X\n", (unsigned)hr);
        Stop();
        return false;
    }

    // Set up scheduled playback. DisplayVideoFrameSync (the old approach) is
    // documented as non-realtime — for continuous passthrough it rejected
    // ~85% of frames because the output device's clock isn't synchronized
    // with our calls. Scheduled playback queues frames against the device
    // clock and the device picks them up at the correct rate.
    m_output->SetScheduledFrameCompletionCallback(this);

    // Enable input with format detection
    m_input->SetCallback(this);
    hr = m_input->EnableVideoInput(displayMode, bmdFormat8BitYUV,
                                    bmdVideoInputEnableFormatDetection);
    if (hr != S_OK) {
        fprintf(stderr, "[Passthrough] EnableVideoInput failed: 0x%08X\n", (unsigned)hr);
        Stop();
        return false;
    }

    // Enable audio input matching our output config (48k / 16-bit / 2ch) so
    // VideoInputFrameArrived gets a paired audioPacket we can pass through.
    hr = m_input->EnableAudioInput(bmdAudioSampleRate48kHz,
                                    bmdAudioSampleType16bitInteger,
                                    2);
    if (hr != S_OK) {
        // Not fatal — we still play silent audio on the output if the
        // input audio enable fails. Just log it.
        fprintf(stderr, "[Passthrough] EnableAudioInput failed: 0x%08X (continuing with silence)\n", (unsigned)hr);
    }

    hr = m_input->StartStreams();
    if (hr != S_OK) {
        fprintf(stderr, "[Passthrough] StartStreams failed: 0x%08X\n", (unsigned)hr);
        Stop();
        return false;
    }

    m_currentMode = displayMode;  // seed so spurious format-change events at startup are no-ops
    m_playbackStarted = false;
    m_prerollCount = 0;
    m_outputFrameCount = 0;

    // Pre-allocate a small pool of output frames to recycle. Allocating a new
    // frame on every input callback hit a device-side limit at ~35 distinct
    // refs in flight, after which all subsequent ScheduleVideoFrame calls
    // failed and playback froze.
    AllocateFramePool();

    m_running = true;
    m_framesOutput = 0;
    m_droppedFrames = 0;
    fprintf(stderr, "[Passthrough] Started: in=%u out=%u %dx%d (%lld/%lld fps via scheduled playback)\n",
            inputDeviceIndex, outputDeviceIndex, m_width, m_height,
            (long long)m_timeScale, (long long)m_frameDuration);
    return true;
}

void PassthroughHandler::Stop() {
    m_running = false;

    if (m_input) {
        m_input->StopStreams();
        m_input->DisableAudioInput();
        m_input->DisableVideoInput();
        m_input->SetCallback(nullptr);
        m_input->Release();
        m_input = nullptr;
    }
    if (m_output) {
        if (m_playbackStarted) {
            m_output->StopScheduledPlayback(0, nullptr, 0);
            m_playbackStarted = false;
        }
        m_output->SetScheduledFrameCompletionCallback(nullptr);
        m_output->DisableAudioOutput();
        m_output->DisableVideoOutput();
        ReleaseFramePool();
        m_output->Release();
        m_output = nullptr;
    }
    if (m_inputDeckLink) { m_inputDeckLink->Release(); m_inputDeckLink = nullptr; }
    if (m_outputDeckLink) { m_outputDeckLink->Release(); m_outputDeckLink = nullptr; }
}

void PassthroughHandler::PushCDP(const uint8_t* data, size_t size) {
    std::lock_guard<std::mutex> lock(m_cdpMutex);
    // Cap queue at ~60 CDPs (~2s @ 30fps) so JS bursts can't unbound memory.
    if (m_cdpQueue.size() < 60) {
        m_cdpQueue.push(std::vector<uint8_t>(data, data + size));
    }
}

HRESULT PassthroughHandler::VideoInputFrameArrived(IDeckLinkVideoInputFrame* videoFrame,
                                                    IDeckLinkAudioInputPacket* audioPacket) {
    if (!videoFrame || !m_running || !m_output) return S_OK;

    // Grab the next slot from the pre-allocated frame pool. If all frames
    // are still in flight (device hasn't completed any yet), drop this input.
    uint64_t writeIdx = m_nextWriteIdx.load();
    uint64_t completedIdx = m_nextCompletedIdx.load();
    if (writeIdx >= completedIdx) {
        // All pool frames are currently scheduled — wait for one to complete.
        m_droppedFrames++;
        return S_OK;
    }
    IDeckLinkMutableVideoFrame* outFrame = m_frames[writeIdx % kFrameCount];
    if (!outFrame) {
        m_droppedFrames++;
        return S_OK;
    }
    HRESULT hr = S_OK;

    // Copy pixel data from input to output. On Windows the buffer access is
    // gated by IDeckLinkVideoBuffer::StartAccess/EndAccess (handled by
    // VideoFrameAccess); on macOS it's a direct GetBytes.
    {
        VideoFrameAccess inAccess(videoFrame, bmdBufferAccessRead);
        VideoFrameAccess outAccess(outFrame, bmdBufferAccessWrite);
        if (inAccess.data && outAccess.data) {
            memcpy(outAccess.data, inAccess.data, m_height * m_rowBytes);
        }
    }

    // Attach VANC caption data — consume exactly one CDP per output frame.
    // Since we reuse frames in the pool, also detach any caption packet that
    // was left attached from the previous time we used this slot.
    {
        std::lock_guard<std::mutex> lock(m_cdpMutex);
        IDeckLinkVideoFrameAncillaryPackets* packets = nullptr;
        if (outFrame->QueryInterface(IID_IDeckLinkVideoFrameAncillaryPackets,
                                      (void**)&packets) == S_OK) {
            IDeckLinkAncillaryPacket* prev = nullptr;
            if (packets->GetFirstPacketByID(0x61, 0x01, &prev) == S_OK && prev) {
                packets->DetachPacket(prev);
                prev->Release();
            }
            if (!m_cdpQueue.empty()) {
                auto& cdp = m_cdpQueue.front();
                CaptionAncillaryPacket* pkt = new CaptionAncillaryPacket(
                    cdp.data(), cdp.size());
                packets->AttachPacket(pkt);
                pkt->Release();
                m_cdpQueue.pop();
            }
            packets->Release();
        }
    }

    // Schedule against our own monotonic counter rather than the input's
    // stream time — same pattern that already works for standalone output.
    BMDTimeValue scheduleTime = m_outputFrameCount * m_frameDuration;

    hr = m_output->ScheduleVideoFrame(outFrame, scheduleTime, m_frameDuration, m_timeScale);
    if (hr == S_OK) {
        m_framesOutput++;
        m_outputFrameCount++;
        m_nextWriteIdx++;
    } else {
        m_droppedFrames++;
    }

    // Pass input audio through if we got an audio packet; otherwise schedule
    // silence to keep the playback clock advancing.
    {
        BMDTimeValue audioTime = scheduleTime;
        uint32_t written = 0;
        if (audioPacket) {
            void* audioData = nullptr;
            audioPacket->GetBytes(&audioData);
            uint32_t sampleFrameCount = audioPacket->GetSampleFrameCount();
            if (audioData && sampleFrameCount > 0) {
                m_output->ScheduleAudioSamples(audioData, sampleFrameCount,
                                                audioTime, m_timeScale, &written);
            }
        }
        if (written == 0) {
            // Fall back to silence for this frame.
            const uint32_t samplesPerFrame = (uint32_t)((48000ULL * m_frameDuration) / m_timeScale);
            const uint32_t samples = samplesPerFrame > 0 ? samplesPerFrame : 1602;
            static int16_t silentBuf[2 * 1602 + 16] = {0};
            m_output->ScheduleAudioSamples(silentBuf, samples,
                                            audioTime, m_timeScale, &written);
        }
    }

    if (!m_playbackStarted) {
        m_prerollCount++;
        if (m_prerollCount >= 3) {
            m_output->EndAudioPreroll();
            HRESULT shr = m_output->StartScheduledPlayback(0, m_timeScale, 1.0);
            if (shr != S_OK) {
                fprintf(stderr, "[Passthrough] StartScheduledPlayback failed: 0x%08X\n", (unsigned)shr);
            }
            m_playbackStarted = true;
        }
    }

    // Do NOT Release outFrame — it's owned by the pool and we keep our ref
    // for the duration of Start..Stop. The device adds its own ref via
    // ScheduleVideoFrame and releases it on completion, but our pool ref
    // keeps the frame alive across cycles.
    return S_OK;
}

HRESULT PassthroughHandler::ScheduledFrameCompleted(IDeckLinkVideoFrame* /*completedFrame*/,
                                                     BMDOutputFrameCompletionResult result) {
    // Frame from our pool is no longer in flight — bump the completion
    // counter so the input callback can reuse the slot.
    m_nextCompletedIdx++;
    if (result == bmdOutputFrameDropped || result == bmdOutputFrameDisplayedLate) {
        m_droppedFrames++;
    }
    return S_OK;
}

HRESULT PassthroughHandler::ScheduledPlaybackHasStopped() {
    return S_OK;
}

HRESULT PassthroughHandler::VideoInputFormatChanged(BMDVideoInputFormatChangedEvents events,
                                                     IDeckLinkDisplayMode* newDisplayMode,
                                                     BMDDetectedVideoInputFormatFlags flags) {
    if (!newDisplayMode || !m_input) return S_OK;

    BMDDisplayMode newMode = newDisplayMode->GetDisplayMode();
    // Skip spurious callbacks where the mode hasn't actually changed. Without
    // this guard, repeated identical "format change" notifications (DeckLink
    // fires these when the input source has noise/jitter) each triggered a
    // full Stop/Enable/Start of both input and output, losing ~200ms of
    // frames each time and producing visible flashing.
    if (newMode == m_currentMode) {
        return S_OK;
    }

    m_currentMode = newMode;
    m_width = newDisplayMode->GetWidth();
    m_height = newDisplayMode->GetHeight();
    m_rowBytes = m_width * 2;

    // Restart with new format
    m_input->StopStreams();
    m_input->EnableVideoInput(newMode, bmdFormat8BitYUV, bmdVideoInputEnableFormatDetection);

    if (m_output) {
        if (m_playbackStarted) {
            m_output->StopScheduledPlayback(0, nullptr, 0);
            m_playbackStarted = false;
        }
        m_prerollCount = 0;
        m_outputFrameCount = 0;
        m_output->DisableAudioOutput();
        m_output->DisableVideoOutput();
        m_output->EnableVideoOutput(newMode, bmdVideoOutputVANC);
        m_output->EnableAudioOutput(bmdAudioSampleRate48kHz,
                                     bmdAudioSampleType16bitInteger,
                                     2,
                                     bmdAudioOutputStreamTimestamped);
        m_output->BeginAudioPreroll();
        // Pick up the new frame rate so the new scheduled timeline matches.
        IDeckLinkDisplayModeIterator* iter = nullptr;
        m_output->GetDisplayModeIterator(&iter);
        if (iter) {
            IDeckLinkDisplayMode* dm = nullptr;
            while (iter->Next(&dm) == S_OK) {
                if (dm->GetDisplayMode() == newMode) {
                    dm->GetFrameRate(&m_frameDuration, &m_timeScale);
                    dm->Release();
                    break;
                }
                dm->Release();
            }
            iter->Release();
        }
    }

    m_input->StartStreams();
    fprintf(stderr, "[Passthrough] Format changed to %dx%d\n", m_width, m_height);
    return S_OK;
}

// IUnknown
HRESULT PassthroughHandler::QueryInterface(REFIID iid, void** ppv) {
    if (!ppv) return E_INVALIDARG;
    if (memcmp(&iid, &IID_IDeckLinkInputCallback, sizeof(REFIID)) == 0) {
        *ppv = static_cast<IDeckLinkInputCallback*>(this);
        AddRef();
        return S_OK;
    }
    if (memcmp(&iid, &IID_IDeckLinkVideoOutputCallback, sizeof(REFIID)) == 0) {
        *ppv = static_cast<IDeckLinkVideoOutputCallback*>(this);
        AddRef();
        return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
}

ULONG PassthroughHandler::AddRef() { return ++m_refCount; }
ULONG PassthroughHandler::Release() {
    ULONG count = --m_refCount;
    if (count == 0) delete this;
    return count;
}
