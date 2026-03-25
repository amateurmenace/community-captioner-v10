#include "output_handler.h"
#include "vanc_packet.h"
#include <cstring>
#include <cstdio>

OutputHandler::OutputHandler()
    : m_deckLink(nullptr)
    , m_output(nullptr)
    , m_frameA(nullptr)
    , m_frameB(nullptr)
    , m_useFrameA(true)
    , m_width(1920)
    , m_height(1080)
    , m_frameDuration(1001)
    , m_timeScale(30000)
    , m_totalFrames(0)
    , m_running(false)
    , m_framesOutput(0)
    , m_droppedFrames(0)
    , m_refCount(1)
{
}

OutputHandler::~OutputHandler() {
    Stop();
}

bool OutputHandler::Start(uint32_t deviceIndex, BMDDisplayMode displayMode) {
    if (m_running) return false;

    // Find the device by index
    IDeckLinkIterator* iterator = CreateDeckLinkIteratorInstance();
    if (!iterator) {
        fprintf(stderr, "[DeckLink] No driver installed\n");
        return false;
    }

    IDeckLink* deckLink = nullptr;
    uint32_t idx = 0;
    while (iterator->Next(&deckLink) == S_OK) {
        if (idx == deviceIndex) break;
        deckLink->Release();
        deckLink = nullptr;
        idx++;
    }
    iterator->Release();

    if (!deckLink) {
        fprintf(stderr, "[DeckLink] Device index %u not found\n", deviceIndex);
        return false;
    }

    m_deckLink = deckLink;

    // Get output interface
    if (deckLink->QueryInterface(IID_IDeckLinkOutput, (void**)&m_output) != S_OK) {
        fprintf(stderr, "[DeckLink] Device does not support output\n");
        m_deckLink->Release();
        m_deckLink = nullptr;
        return false;
    }

    // Get display mode info
    IDeckLinkDisplayModeIterator* modeIter = nullptr;
    m_output->GetDisplayModeIterator(&modeIter);
    IDeckLinkDisplayMode* modeObj = nullptr;
    bool modeFound = false;

    if (modeIter) {
        while (modeIter->Next(&modeObj) == S_OK) {
            if (modeObj->GetDisplayMode() == displayMode) {
                m_width = modeObj->GetWidth();
                m_height = modeObj->GetHeight();
                modeObj->GetFrameRate(&m_frameDuration, &m_timeScale);
                modeFound = true;
                modeObj->Release();
                break;
            }
            modeObj->Release();
        }
        modeIter->Release();
    }

    if (!modeFound) {
        fprintf(stderr, "[DeckLink] Display mode not found, using defaults\n");
    }

    // Enable video output with VANC support
    HRESULT hr = m_output->EnableVideoOutput(displayMode, bmdVideoOutputVANC);
    if (hr != S_OK) {
        fprintf(stderr, "[DeckLink] EnableVideoOutput failed: 0x%08X\n", (unsigned)hr);
        m_output->Release();
        m_output = nullptr;
        m_deckLink->Release();
        m_deckLink = nullptr;
        return false;
    }

    // Create double-buffered black frames
    int32_t rowBytes = m_width * 2; // UYVY = 2 bytes per pixel
    m_output->CreateVideoFrame(m_width, m_height, rowBytes,
                                bmdFormat8BitYUV, bmdFrameFlagDefault, &m_frameA);
    m_output->CreateVideoFrame(m_width, m_height, rowBytes,
                                bmdFormat8BitYUV, bmdFrameFlagDefault, &m_frameB);

    if (!m_frameA || !m_frameB) {
        fprintf(stderr, "[DeckLink] Failed to create video frames\n");
        Stop();
        return false;
    }

    // Fill frames with black (UYVY black = 0x10 for Y, 0x80 for U/V)
    void* bufA = nullptr;
    void* bufB = nullptr;
    m_frameA->GetBytes(&bufA);
    m_frameB->GetBytes(&bufB);
    if (bufA) {
        uint8_t* p = (uint8_t*)bufA;
        for (int32_t i = 0; i < m_height * rowBytes; i += 4) {
            p[i]     = 0x80; // Cb
            p[i + 1] = 0x10; // Y0
            p[i + 2] = 0x80; // Cr
            p[i + 3] = 0x10; // Y1
        }
    }
    if (bufB) {
        memcpy(bufB, bufA, m_height * rowBytes);
    }

    // Set callback and start scheduled playback
    m_output->SetScheduledFrameCompletionCallback(this);

    m_running = true;
    m_framesOutput = 0;
    m_droppedFrames = 0;
    m_totalFrames = 0;

    // Pre-roll: schedule first few frames
    for (int i = 0; i < 3; i++) {
        ScheduleNextFrame();
    }

    m_output->StartScheduledPlayback(0, m_timeScale, 1.0);
    fprintf(stderr, "[DeckLink] Output started: %dx%d @ %.2ffps\n",
            m_width, m_height, (double)m_timeScale / (double)m_frameDuration);

    return true;
}

void OutputHandler::Stop() {
    if (m_output && m_running) {
        m_running = false;
        m_output->StopScheduledPlayback(0, nullptr, 0);
        m_output->SetScheduledFrameCompletionCallback(nullptr);
        m_output->DisableVideoOutput();
    }

    if (m_frameA) { m_frameA->Release(); m_frameA = nullptr; }
    if (m_frameB) { m_frameB->Release(); m_frameB = nullptr; }
    if (m_output) { m_output->Release(); m_output = nullptr; }
    if (m_deckLink) { m_deckLink->Release(); m_deckLink = nullptr; }
}

void OutputHandler::PushCDP(const uint8_t* data, size_t size) {
    std::lock_guard<std::mutex> lock(m_cdpMutex);
    m_currentCDP.assign(data, data + size);
}

void OutputHandler::ScheduleNextFrame() {
    if (!m_running || !m_output) return;

    IDeckLinkMutableVideoFrame* frame = m_useFrameA ? m_frameA : m_frameB;
    m_useFrameA = !m_useFrameA;

    // Attach VANC caption data if we have a CDP
    {
        std::lock_guard<std::mutex> lock(m_cdpMutex);
        if (!m_currentCDP.empty()) {
            IDeckLinkVideoFrameAncillaryPackets* packets = nullptr;
            if (frame->QueryInterface(IID_IDeckLinkVideoFrameAncillaryPackets,
                                       (void**)&packets) == S_OK) {
                CaptionAncillaryPacket* pkt = new CaptionAncillaryPacket(
                    m_currentCDP.data(), m_currentCDP.size());
                packets->AttachPacket(pkt);
                pkt->Release(); // AttachPacket adds its own ref
                packets->Release();
            }
        }
    }

    BMDTimeValue frameTime = m_totalFrames * m_frameDuration;
    m_output->ScheduleVideoFrame(frame, frameTime, m_frameDuration, m_timeScale);
    m_totalFrames++;
}

HRESULT OutputHandler::ScheduledFrameCompleted(IDeckLinkVideoFrame* completedFrame,
                                                BMDOutputFrameCompletionResult result) {
    if (!m_running) return S_OK;

    if (result == bmdOutputFrameCompleted) {
        m_framesOutput++;
    } else if (result == bmdOutputFrameDropped) {
        m_droppedFrames++;
    }

    // Schedule the next frame
    ScheduleNextFrame();

    return S_OK;
}

HRESULT OutputHandler::ScheduledPlaybackHasStopped() {
    m_running = false;
    return S_OK;
}

// IUnknown
HRESULT OutputHandler::QueryInterface(REFIID iid, void** ppv) {
    if (!ppv) return E_INVALIDARG;
    *ppv = nullptr;
    return E_NOINTERFACE;
}

ULONG OutputHandler::AddRef() { return ++m_refCount; }
ULONG OutputHandler::Release() {
    ULONG count = --m_refCount;
    if (count == 0) delete this;
    return count;
}
