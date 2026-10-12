// Central place for repo + release download links so they only need
// updating here when a new release ships.
export const GITHUB_REPO_URL = 'https://github.com/amateurmenace/community-captioner-v10';
export const GITHUB_CLONE_URL = `${GITHUB_REPO_URL}.git`;
export const RELEASES_URL = `${GITHUB_REPO_URL}/releases/latest`;

// Direct download links to the newest build for each platform.
// Releases are tagged by product version (v10.x); asset names carry the app
// version from package.json. Both assets live on the "Community Captioner v10.1" release.
// Mac: app 6.7.0 — notarized, bundled DeckLink addon, fully local AI brain, fast Whisper interims, machine stats.
// Windows: app 6.4.0 — built on Windows with the DeckLink addon bundled
//          (rebuild on a Windows machine to pick up 6.7.0, see WINDOWS-HANDOFF.md).
export const MAC_DOWNLOAD_URL = `${GITHUB_REPO_URL}/releases/download/v10.1/Community-Captioner-6.7.0-mac-arm64.zip`;
export const WINDOWS_DOWNLOAD_URL = `${GITHUB_REPO_URL}/releases/download/v10.1/Community-Captioner-6.4.0-windows-x64.zip`;
