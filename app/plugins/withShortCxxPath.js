// Windows MAX_PATH (260) breaks the native codegen build of react-native-gesture-handler
// when CMake stages under android/app/.cxx. On Windows, stage it under a short root instead.
const { withAppBuildGradle } = require("expo/config-plugins");

const MARKER = "// saics: short cxx staging path";

module.exports = function withShortCxxPath(config) {
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
};
