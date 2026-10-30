// react-native-gesture-handler is only an optional peer of expo-router (JS stack / drawer).
// We use the native stack, and its Android codegen build exceeds Windows' 260-char path limit,
// so keep it out of the native build.
module.exports = {
  dependencies: {
    "react-native-gesture-handler": { platforms: { android: null } },
  },
};
