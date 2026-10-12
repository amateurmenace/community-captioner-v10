// Central place for repo + release download links so they only need
// updating here when a new release ships.
export const GITHUB_REPO_URL = 'https://github.com/amateurmenace/community-captioner-v10';
export const GITHUB_CLONE_URL = `${GITHUB_REPO_URL}.git`;
export const RELEASES_URL = `${GITHUB_REPO_URL}/releases/latest`;

// Direct download links to the newest build for each platform.
// Both live on the "Community Captioner v10.1" release (tag v10.1); the app
// inside is version 6.4.0, so the asset names keep 6.4.0.
// Mac: signed .app with the bundled DeckLink addon.
// Windows: .exe built on Windows with the DeckLink addon bundled.
export const MAC_DOWNLOAD_URL = `${GITHUB_REPO_URL}/releases/download/v10.1/Community-Captioner-6.4.0-mac-arm64.zip`;
export const WINDOWS_DOWNLOAD_URL = `${GITHUB_REPO_URL}/releases/download/v10.1/Community-Captioner-6.4.0-windows-x64.zip`;
