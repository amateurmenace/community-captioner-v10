// obs-setup.mjs — prepare and launch OBS Studio (Windows) as the control encoder, without
// touching the operator's own profile and scene collection.
//
//   node obs-setup.mjs write  [--device-hash H] [--device-name N] [--mode-id -1] [--rtmp rtmp://127.0.0.1:1935/live] [--key obs] [--bitrate 4500] [--fps 29.97]
//       writes profile  %APPDATA%\obs-studio\basic\profiles\CaptionControl\{basic.ini, service.json, streamEncoder.json}
//       and collection  %APPDATA%\obs-studio\basic\scenes\CaptionControl.json (one scene, one DeckLink input,
//       Decklink Captions tool bound to it, desktop/mic audio disabled), cloned from the "Untitled" files.
//   node obs-setup.mjs websocket-on    enable the obs-websocket server in plugin_config (backup kept)
//   node obs-setup.mjs websocket-off   restore the backup
//   node obs-setup.mjs launch --password PW
//       backs up user.ini, starts obs64.exe with --collection CaptionControl --profile CaptionControl
//       --websocket_password PW --disable-updater --disable-shutdown-check (cwd = bin\64bit)
//   node obs-setup.mjs restore         restore user.ini (current profile/collection) after OBS has exited
//   node obs-setup.mjs status          what exists
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const APP = join(process.env.APPDATA, 'obs-studio');
const NAME = 'CaptionControl';
const PROFILE = join(APP, 'basic', 'profiles', NAME);
const SCENES = join(APP, 'basic', 'scenes');
const WS_CFG = join(APP, 'plugin_config', 'obs-websocket', 'config.json');
const USER_INI = join(APP, 'user.ini');
const OBS_EXE = 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const cmd = args[0];

function writeProfile() {
    mkdirSync(PROFILE, { recursive: true });
    const base = readFileSync(join(APP, 'basic', 'profiles', 'Untitled', 'basic.ini'), 'utf8').replace(/^\uFEFF/, '');
    const fps = opt('--fps', '29.97');
    let ini = base
        .replace(/^Name=.*$/m, `Name=${NAME}`)
        .replace(/^Mode=.*$/m, 'Mode=Advanced')
        .replace(/^Encoder=.*$/m, 'Encoder=obs_x264')
        .replace(/^FPSType=.*$/m, 'FPSType=0')
        .replace(/^FPSCommon=.*$/m, `FPSCommon=${fps}`)
        .replace(/^BaseCX=.*$/m, 'BaseCX=1920').replace(/^BaseCY=.*$/m, 'BaseCY=1080')
        .replace(/^OutputCX=.*$/m, 'OutputCX=1920').replace(/^OutputCY=.*$/m, 'OutputCY=1080')
        .replace(/^ApplyServiceSettings=.*$/m, 'ApplyServiceSettings=false');
    writeFileSync(join(PROFILE, 'basic.ini'), '\uFEFF' + ini);
    writeFileSync(join(PROFILE, 'service.json'), JSON.stringify({ type: 'rtmp_custom', settings: { server: opt('--rtmp', 'rtmp://127.0.0.1:1935/live'), key: opt('--key', 'obs'), use_auth: false, bwtest: false } }, null, 1));
    writeFileSync(join(PROFILE, 'streamEncoder.json'), JSON.stringify({ bitrate: +opt('--bitrate', 4500), keyint_sec: 2, preset: 'veryfast', profile: 'high', rate_control: 'CBR', tune: 'zerolatency' }, null, 1));
    console.log(`profile ${NAME}: 1920x1080 @ ${fps}, x264 CBR ${opt('--bitrate', 4500)} kb/s → ${opt('--rtmp', 'rtmp://127.0.0.1:1935/live')}/${opt('--key', 'obs')}`);
}

function writeCollection() {
    const tpl = JSON.parse(readFileSync(join(SCENES, 'Untitled.json'), 'utf8'));
    const dlTpl = tpl.sources.find(s => s.id === 'decklink-input');
    const scTpl = tpl.sources.find(s => s.id === 'scene');
    if (!dlTpl || !scTpl) throw new Error('Untitled.json has no decklink-input / scene source to clone');
    const dlUuid = randomUUID(), scUuid = randomUUID();
    const inputName = 'DeckLink loopback', sceneName = 'Control';
    const decklink = { ...structuredClone(dlTpl), name: inputName, uuid: dlUuid, settings: {
        video_connection: 1, audio_connection: 1, mode_id: +opt('--mode-id', -1), mode_name: 'Auto',
        device_hash: opt('--device-hash', dlTpl.settings.device_hash), device_name: opt('--device-name', dlTpl.settings.device_name),
    } };
    const item = structuredClone(scTpl.settings.items[0]);
    Object.assign(item, { name: inputName, source_uuid: dlUuid, id: 1, visible: true, locked: false, rot: 0, pos: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, crop_left: 0, crop_top: 0, crop_right: 0, crop_bottom: 0, bounds_type: 0 });
    const scene = { ...structuredClone(scTpl), name: sceneName, uuid: scUuid, hotkeys: { 'OBSBasic.SelectScene': [], 'libobs.show_scene_item.1': [], 'libobs.hide_scene_item.1': [] }, settings: { id_counter: 1, custom_size: false, items: [item] } };
    const col = {
        ...structuredClone(tpl),
        name: NAME,
        DesktopAudioDevice1: { prev_ver: tpl.DesktopAudioDevice1?.prev_ver, name: 'Desktop Audio', uuid: randomUUID(), id: 'wasapi_output_capture', versioned_id: 'wasapi_output_capture', settings: { device_id: 'disabled' }, enabled: false, muted: true, mixers: 0 },
        AuxAudioDevice1: undefined,
        sources: [scene, decklink],
        groups: [],
        scene_order: [{ name: sceneName }],
        current_scene: sceneName, current_program_scene: sceneName,
        modules: { ...(tpl.modules || {}), decklink_captions: { source: inputName }, captions: { source: '', enabled: false, lang_id: 1033, provider: 'mssapi' } },
    };
    delete col.AuxAudioDevice1;
    writeFileSync(join(SCENES, `${NAME}.json`), JSON.stringify(col, null, 1));
    console.log(`collection ${NAME}: scene "${sceneName}" ← "${inputName}" (${decklink.settings.device_name} / ${decklink.settings.device_hash}, mode ${decklink.settings.mode_id}); Decklink Captions bound to it`);
}

function websocket(on) {
    const bak = WS_CFG + '.cc-backup';
    if (on) {
        if (!existsSync(bak)) copyFileSync(WS_CFG, bak);
        const cfg = JSON.parse(readFileSync(WS_CFG, 'utf8'));
        cfg.server_enabled = true; cfg.auth_required = true;
        writeFileSync(WS_CFG, JSON.stringify(cfg, null, 2));
        console.log(`obs-websocket enabled on port ${cfg.server_port} (backup ${bak}); pass the password with --websocket_password at launch`);
    } else {
        if (!existsSync(bak)) { console.log('no backup to restore'); return; }
        copyFileSync(bak, WS_CFG);
        console.log('obs-websocket config restored');
    }
}

function launch() {
    const pw = opt('--password', process.env.OBS_WS_PASSWORD || '');
    if (!pw) throw new Error('--password required');
    const bak = USER_INI + '.cc-backup';
    if (!existsSync(bak)) copyFileSync(USER_INI, bak);
    const child = spawn(OBS_EXE, ['--collection', NAME, '--profile', NAME, '--websocket_password', pw, '--disable-updater', '--disable-shutdown-check'],
        { cwd: 'C:\\Program Files\\obs-studio\\bin\\64bit', detached: true, stdio: 'ignore' });
    child.unref();
    console.log(`OBS started (pid ${child.pid}) with collection/profile ${NAME}; user.ini backed up to ${bak}`);
}

function restore() {
    const bak = USER_INI + '.cc-backup';
    if (!existsSync(bak)) { console.log('no user.ini backup'); return; }
    // OBS rewrites user.ini on exit with the last used profile/collection: put the operator's back
    const cur = readFileSync(USER_INI, 'utf8');
    const prev = readFileSync(bak, 'utf8');
    const pick = (ini, key) => (ini.match(new RegExp(`^${key}=.*$`, 'm')) || [''])[0];
    let out = cur;
    for (const k of ['Profile', 'ProfileDir', 'SceneCollection', 'SceneCollectionFile']) { const line = pick(prev, k); if (line) out = out.replace(new RegExp(`^${k}=.*$`, 'm'), line); }
    writeFileSync(USER_INI, out);
    console.log(`user.ini: current profile/collection restored to ${pick(prev, 'Profile')} / ${pick(prev, 'SceneCollection')}`);
}

switch (cmd) {
    case 'write': writeProfile(); writeCollection(); break;
    case 'websocket-on': websocket(true); break;
    case 'websocket-off': websocket(false); break;
    case 'launch': launch(); break;
    case 'restore': restore(); break;
    case 'status':
        console.log(`profile: ${existsSync(join(PROFILE, 'basic.ini'))}, collection: ${existsSync(join(SCENES, NAME + '.json'))}, websocket: ${JSON.stringify({ ...JSON.parse(readFileSync(WS_CFG, 'utf8')), server_password: '***' })}, obs64: ${existsSync(OBS_EXE)}`);
        break;
    default: console.error('usage: obs-setup.mjs write|websocket-on|websocket-off|launch --password PW|restore|status'); process.exit(1);
}
