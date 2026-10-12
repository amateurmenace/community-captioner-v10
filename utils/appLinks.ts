// Central place for repo + release download links so they only need
// updating here when a new release ships.
export const GITHUB_REPO_URL = 'https://github.com/amateurmenace/community-captioner-v10';
export const GITHUB_CLONE_URL = `${GITHUB_REPO_URL}.git`;
export const RELEASES_URL = `${GITHUB_REPO_URL}/releases/latest`;

// Direct download links to the newest build for each platform.
// Mac: v6.4.0 (Context Engine wizard rewrite, bundled DeckLink addon, signed .app).
// Windows: v6.3.2 (must be rebuilt on a Windows machine to pick up 6.4.0 changes).
export const MAC_DOWNLOAD_URL = `${GITHUB_REPO_URL}/releases/download/v6.4.0/Community-Captioner-6.4.0-mac-arm64.zip`;
export const WINDOWS_DOWNLOAD_URL = `${GITHUB_REPO_URL}/releases/download/v6.3.2/Community-Captioner-6.3.2-windows-x64.zip`;
