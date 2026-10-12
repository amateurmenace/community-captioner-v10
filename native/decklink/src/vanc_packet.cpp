#include "vanc_packet.h"
#include <cstring>
#include <cstdlib>

CaptionAncillaryPacket::CaptionAncillaryPacket(const uint8_t* cdpData, size_t cdpSize)
    : m_data(cdpData, cdpData + cdpSize)
    , m_refCount(1)
{
}

CaptionAncillaryPacket::~CaptionAncillaryPacket() {}

HRESULT CaptionAncillaryPacket::QueryInterface(REFIID iid, void** ppv) {
    if (!ppv) return E_INVALIDARG;

    if (memcmp(&iid, &IID_IDeckLinkAncillaryPacket, sizeof(REFIID)) == 0) {
        *ppv = static_cast<IDeckLinkAncillaryPacket*>(this);
        AddRef();
        return S_OK;
    }

    // Also support IUnknown
#ifdef _WIN32
    if (memcmp(&iid, &IID_IUnknown, sizeof(REFIID)) == 0) {
        *ppv = static_cast<IDeckLinkAncillaryPacket*>(this);
        AddRef();
        return S_OK;
    }
#else
    CFUUIDBytes iunknown = CFUUIDGetUUIDBytes(IUnknownUUID);
    if (memcmp(&iid, &iunknown, sizeof(REFIID)) == 0) {
        *ppv = static_cast<IDeckLinkAncillaryPacket*>(this);
        AddRef();
        return S_OK;
    }
#endif

    *ppv = nullptr;
    return E_NOINTERFACE;
}

ULONG CaptionAncillaryPacket::AddRef() {
    return ++m_refCount;
}

ULONG CaptionAncillaryPacket::Release() {
    ULONG count = --m_refCount;
    if (count == 0) {
        delete this;
    }
    return count;
}

HRESULT CaptionAncillaryPacket::GetBytes(BMDAncillaryPacketFormat format, const void** data, uint32_t* size) {
    if (!data || !size) return E_INVALIDARG;

    if (format != bmdAncillaryPacketFormatUInt8) {
        return E_INVALIDARG;
    }

    *data = m_data.data();
    *size = static_cast<uint32_t>(m_data.size());
    return S_OK;
}

uint8_t CaptionAncillaryPacket::GetDID() {
    return 0x61; // SMPTE 334 CEA-708
}

uint8_t CaptionAncillaryPacket::GetSDID() {
    return 0x01; // Caption Distribution Packet
}

// VANC line for the caption packet. 0 = Auto: the DeckLink driver picks the line
// (9 for 1080 formats). The Blackmagic Web Presenter 4K drops about half of the
// packets it finds on line 9 and far fewer on later lines, so the line is selectable
// (setCaptionLine from JavaScript, or CC_VANC_LINE in the environment).
static int g_captionLine = -1;

void SetCaptionLine(int line) {
    g_captionLine = (line < 0 || line > 41) ? 0 : line;
}

int GetCaptionLine() {
    if (g_captionLine < 0) {
        const char* env = getenv("CC_VANC_LINE");
        SetCaptionLine(env ? atoi(env) : 0);
    }
    return g_captionLine;
}

uint32_t CaptionAncillaryPacket::GetLineNumber() {
    return (uint32_t)GetCaptionLine();
}

uint8_t CaptionAncillaryPacket::GetDataStreamIndex() {
    return 0;
}

#ifdef _WIN32
BMDAncillaryDataSpace CaptionAncillaryPacket::GetDataSpace() {
    // CEA-708 CDP packets are carried in the vertical ancillary data space.
    return bmdAncillaryDataSpaceVANC;
}
#endif
