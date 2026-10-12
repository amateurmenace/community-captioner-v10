// Single source of truth for caption translation languages.
// Keep in sync with SUPPORTED_LANGUAGES in server/translation-service.js.
export interface CaptionLanguage {
    code: string;
    /** English name (used in Gemini prompts) */
    name: string;
    /** Native name (shown to audiences) */
    native: string;
    flag: string;
}

export const LANGUAGES: CaptionLanguage[] = [
    { code: 'en', name: 'English',              native: 'English',     flag: '🇺🇸' },
    { code: 'es', name: 'Spanish',              native: 'Español',     flag: '🇪🇸' },
    { code: 'zh', name: 'Chinese (Simplified)', native: '中文',         flag: '🇨🇳' },
    { code: 'fr', name: 'French',               native: 'Français',    flag: '🇫🇷' },
    { code: 'pt', name: 'Portuguese',           native: 'Português',   flag: '🇧🇷' },
    { code: 'ht', name: 'Haitian Creole',       native: 'Kreyòl',      flag: '🇭🇹' },
    { code: 'ru', name: 'Russian',              native: 'Русский',     flag: '🇷🇺' },
    { code: 'ar', name: 'Arabic',               native: 'العربية',     flag: '🇸🇦' },
    { code: 'vi', name: 'Vietnamese',           native: 'Tiếng Việt',  flag: '🇻🇳' },
    { code: 'ko', name: 'Korean',               native: '한국어',       flag: '🇰🇷' },
    { code: 'ja', name: 'Japanese',             native: '日本語',       flag: '🇯🇵' },
    { code: 'de', name: 'German',               native: 'Deutsch',     flag: '🇩🇪' },
    { code: 'it', name: 'Italian',              native: 'Italiano',    flag: '🇮🇹' },
    { code: 'pl', name: 'Polish',               native: 'Polski',      flag: '🇵🇱' },
    { code: 'tl', name: 'Tagalog',              native: 'Tagalog',     flag: '🇵🇭' },
];

export const languageName = (code: string): string => LANGUAGES.find(l => l.code === code)?.name || code;
