// Windows MAX_PATH (260) breaks React Native's native codegen builds. On Windows:
// - stage CMake output under a short root instead of android/app/.cxx;
// - point AGP at SDK CMake 3.31.6, whose ninja 1.12 is long-path aware
//   (also needs LongPathsEnabled=1 in the registry, set once by the owner).
const fs = require("fs");
const path = require("path");
const { withAppBuildGradle, withDangerousMod } = require("expo/config-plugins");

const MARKER = "// saics: short cxx staging path";
const CMAKE = "3.31.6";

function withStaging(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.contents.includes(MARKER)) return cfg;
    cfg.modResults.contents += `
${MARKER}
if (System.getProperty("os.name").toLowerCase().contains("windows")) {
    android.externalNativeBuild.cmake.buildStagingDirectory = file("C:/sx/cxx")
}
`;
    return cfg;
  });
}

function withCmakeDir(config) {
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
      if (process.platform !== "win32" || !sdk) return cfg;
      const cmake = path.join(sdk, "cmake", CMAKE);
      if (!fs.existsSync(cmake)) return cfg;
      const file = path.join(cfg.modRequest.platformProjectRoot, "local.properties");
      const lines = fs.existsSync(file)
        ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("cmake.dir="))
        : [];
      lines.push(`cmake.dir=${cmake.replace(/\\/g, "/")}`);
      fs.writeFileSync(file, lines.join("\n") + "\n");
      return cfg;
    },
  ]);
}

module.exports = function withShortCxxPath(config) {
  return withCmakeDir(withStaging(config));
};
