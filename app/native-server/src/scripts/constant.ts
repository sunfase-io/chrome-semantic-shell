export const COMMAND_NAME = 'chrome-shell-bridge';
// Extension IDs allowed to connect to the native host:
// - upstream store build
// - dev build loaded unpacked from dist-extension (stable ID via CHROME_EXTENSION_KEY)
export const EXTENSION_IDS = [
  'hbdgbgagpkpjffpklnamcljpakneikee',
  'hnhimbinihlfejljamlgfniplabkaamk',
];
export const HOST_NAME = 'com.chromesemanticshell.nativehost';
export const DESCRIPTION = 'Native host for Chrome Semantic Shell';
