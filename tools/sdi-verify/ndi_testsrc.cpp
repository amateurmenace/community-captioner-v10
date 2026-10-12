// ndi_testsrc — an NDI source with a known picture and known audio, for testing NDI → SDI.
//
//   video  1920x1080 UYVY at 29.97p: 75% colour bars (top two thirds, the values
//          decklink_probe checks) and a 128x128 white box moving across the bottom third
//   audio  stereo float, 1 kHz on the left and 440 Hz on the right, at `levelDb`
//          relative to NDI reference level (float 1.0 = +4 dBu). At the default 0 dB the
//          app's NDI → SDI path should put both tones at -20 dBFS on the SDI output.
//
// Usage: ndi_testsrc [seconds=120] [audioRate=48000] [name="CC Test Source"] [levelDb=0]
#define _USE_MATH_DEFINES
#include <Processing.NDI.Lib.h>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

static const int W = 1920, H = 1080;

// Keep in sync with decklink_probe.cpp: 75% bars, BT.709 video range (Y, Cb, Cr)
static const uint8_t BARS[8][3] = {
    {180, 128, 128}, {168,  44, 136}, {145, 147,  44}, {133,  63,  52},
    { 63, 193, 204}, { 51, 109, 212}, { 28, 212, 120}, { 16, 128, 128},
};

int main(int argc, char** argv) {
    int seconds = argc > 1 ? atoi(argv[1]) : 120;
    int rate = argc > 2 ? atoi(argv[2]) : 48000;
    std::string name = argc > 3 ? argv[3] : "CC Test Source";
    double levelDb = argc > 4 ? atof(argv[4]) : 0.0;
    double amp = pow(10.0, levelDb / 20.0);

    if (!NDIlib_initialize()) { fprintf(stderr, "NDI could not be initialised (no NDI runtime, or the CPU lacks SSE4.2)\n"); return 1; }
    NDIlib_send_create_t sc;
    sc.p_ndi_name = name.c_str();
    sc.clock_video = true;   // NDIlib_send_send_video_v2 paces us at 29.97
    sc.clock_audio = false;
    NDIlib_send_instance_t send = NDIlib_send_create(&sc);
    if (!send) { fprintf(stderr, "could not create the NDI sender\n"); return 1; }

    const int fpsN = 30000, fpsD = 1001;
    const long total = (long)seconds * fpsN / fpsD;
    std::vector<uint8_t> frame((size_t)W * H * 2);
    std::vector<float> audio;
    double phaseL = 0, phaseR = 0;
    long long samplesSent = 0;
    printf("Sending '%s' for %d s: 1920x1080 UYVY 75%% bars + moving box @29.97p, %d Hz stereo (L 1 kHz, R 440 Hz) at %.1f dB re NDI reference\n",
           name.c_str(), seconds, rate, levelDb);
    fflush(stdout);

    for (long f = 0; f < total; f++) {
        int boxX = (int)((f * 16) % (W - 128));
        for (int y = 0; y < H; y++) {
            uint8_t* row = frame.data() + (size_t)y * W * 2;
            for (int x = 0; x < W; x += 2) {
                uint8_t Y = 16, Cb = 128, Cr = 128;
                if (y < H * 2 / 3) { const uint8_t* b = BARS[(x * 8) / W]; Y = b[0]; Cb = b[1]; Cr = b[2]; }
                else if (x >= boxX && x < boxX + 128 && y >= H * 2 / 3 + 100 && y < H * 2 / 3 + 228) Y = 235;
                row[x * 2 + 0] = Cb; row[x * 2 + 1] = Y; row[x * 2 + 2] = Cr; row[x * 2 + 3] = Y;
            }
        }
        NDIlib_video_frame_v2_t vf;
        vf.xres = W; vf.yres = H;
        vf.FourCC = NDIlib_FourCC_video_type_UYVY;
        vf.frame_rate_N = fpsN; vf.frame_rate_D = fpsD;
        vf.picture_aspect_ratio = 16.0f / 9.0f;
        vf.frame_format_type = NDIlib_frame_format_type_progressive;
        vf.p_data = frame.data();
        vf.line_stride_in_bytes = W * 2;

        // Exactly `rate` samples per second over the long run (1601/1602 per frame at 48 kHz)
        long long target = (long long)((double)(f + 1) * rate * fpsD / fpsN);
        int n = (int)(target - samplesSent);
        samplesSent = target;
        audio.assign((size_t)n * 2, 0.0f);
        for (int i = 0; i < n; i++) {
            audio[i] = (float)(amp * sin(phaseL));      // channel 0 (planar)
            audio[n + i] = (float)(amp * sin(phaseR));  // channel 1
            phaseL += 2 * M_PI * 1000.0 / rate;
            phaseR += 2 * M_PI * 440.0 / rate;
        }
        NDIlib_audio_frame_v2_t af;
        af.sample_rate = rate; af.no_channels = 2; af.no_samples = n;
        af.p_data = audio.data();
        af.channel_stride_in_bytes = n * (int)sizeof(float);

        NDIlib_send_send_audio_v2(send, &af);
        NDIlib_send_send_video_v2(send, &vf);
        if (f % 300 == 0) { printf("frame %ld, %d receiver(s) connected\n", f, NDIlib_send_get_no_connections(send, 0)); fflush(stdout); }
    }
    NDIlib_send_destroy(send);
    NDIlib_destroy();
    printf("done\n");
    return 0;
}
