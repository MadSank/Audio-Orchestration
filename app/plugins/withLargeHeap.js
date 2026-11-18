// The engine keeps up to four whole songs decoded (about 10.6 MB a minute each), and on Android
// a direct ByteBuffer counts against the Java heap. The normal 256 MB limit ran out with four
// songs loaded and the app crashed (owner, 2026-11-18); the large heap is 512 MB on the phone.
const { withAndroidManifest } = require("expo/config-plugins");

module.exports = function withLargeHeap(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (app) app.$["android:largeHeap"] = "true";
    return cfg;
  });
};
