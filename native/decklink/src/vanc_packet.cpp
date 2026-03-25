#include "vanc_packet.h"
#include <cstring>

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
    CFUUIDBytes iunknown = CFUUIDGetUUIDBytes(IUnknownUUID);
    if (memcmp(&iid, &iunknown, sizeof(REFIID)) == 0) {
        *ppv = static_cast<IDeckLinkAncillaryPacket*>(this);
        AddRef();
        return S_OK;
    }

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

uint32_t CaptionAncillaryPacket::GetLineNumber() {
    return 0; // Auto — DeckLink SDK chooses appropriate VANC line
}

uint8_t CaptionAncillaryPacket::GetDataStreamIndex() {
    return 0;
}
