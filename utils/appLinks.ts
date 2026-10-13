// Central place for repo + release download links so they only need
// updating here when a new release ships.
export const GITHUB_REPO_URL = 'https://github.com/amateurmenace/community-captioner-v10';
export const GITHUB_CLONE_URL = `${GITHUB_REPO_URL}.git`;
export const RELEASES_URL = `${GITHUB_REPO_URL}/releases/latest`;

// Direct download links to the newest build for each platform.
// Releases are tagged by product version (v10.x); asset names carry the app
// version from package.json. Both assets live on the "Community Captioner v10.1" release.
// Mac: app 6.13.3 — notarized, bundled DeckLink addon with NDI → SDI (NDI runtime bundled), the same CEA-608/708 encoders,
//      transport presets (one-frame CEA-708 captions by default) and YouTube caption-ingestion POST as the Windows build;
//      local-only mode, local prerecorded transcription, in-app guide.
//          NDI → SDI passthrough (needs NDI Tools / the NDI Runtime) with audio from any PC input,
//          CEA-608 rows that roll, CEA-708 with the self-positioned continuous redraw (the default transport since 6.13.1)
//          that survives the Web Presenter's frame loss, a working YouTube caption-ingestion POST; local AI on CPU or NVIDIA.
export const MAC_DOWNLOAD_URL = `${GITHUB_REPO_URL}/releases/download/v10.1/Community-Captioner-6.13.3-mac-arm64.zip`;
// Windows: app 6.13.4 — built and tested on Windows with the DeckLink addon bundled, including
//          NDI → SDI passthrough (needs NDI Tools / the NDI Runtime) with audio from any PC input,
//          CEA-608 rows that roll, CEA-708 with the self-positioned continuous redraw (the default transport since 6.13.1)
//          that survives the Web Presenter's frame loss, a working YouTube caption-ingestion POST; local AI on CPU or NVIDIA.
export const WINDOWS_DOWNLOAD_URL = `${GITHUB_REPO_URL}/releases/download/v10.1/Community-Captioner-6.13.4-windows-x64.zip`;
