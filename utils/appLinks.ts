// Central place for repo + release download links so they only need
// updating here when a new release ships.
export const GITHUB_REPO_URL = 'https://github.com/amateurmenace/community-captioner-v10';
export const GITHUB_CLONE_URL = `${GITHUB_REPO_URL}.git`;
export const RELEASES_URL = `${GITHUB_REPO_URL}/releases/latest`;

// Direct download links to the newest build for each platform.
// Releases are tagged by product version (v10.x); asset names carry the app
// version from package.json. Both assets live on the "Community Captioner v10.1" release.
// Mac: app 6.11.1 — notarized, bundled DeckLink addon with NDI → SDI (NDI runtime bundled), local-only mode, local prerecorded transcription, in-app guide.
// Windows: app 6.11.1 — built and tested on Windows with the DeckLink addon bundled, including
//          NDI → SDI passthrough (needs NDI Tools / the NDI Runtime); local AI on CPU or NVIDIA.
export const MAC_DOWNLOAD_URL = `${GITHUB_REPO_URL}/releases/download/v10.1/Community-Captioner-6.11.1-mac-arm64.zip`;
export const WINDOWS_DOWNLOAD_URL = `${GITHUB_REPO_URL}/releases/download/v10.1/Community-Captioner-6.11.1-windows-x64.zip`;
