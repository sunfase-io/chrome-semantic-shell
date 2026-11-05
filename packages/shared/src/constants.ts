export const DEFAULT_SERVER_PORT = 12306;
export const HOST_NAME = 'com.chromesemanticshell.nativehost';

/** Internal executor names used only inside the headless extension runtime. */
export const TOOL_NAMES = {
  BROWSER: {
    EXEC: 'chrome_shell_exec',
    GET_WINDOWS_AND_TABS: 'shell_window',
    NAVIGATE: 'shell_navigate',
    SCREENSHOT: 'shell_screenshot',
    CLOSE_TABS: 'shell_close_tabs',
    SWITCH_TAB: 'shell_switch_tab',
    CLICK: 'shell_click',
    FILL: 'shell_fill',
    NETWORK_CAPTURE: 'shell_network_capture',
    NETWORK_CAPTURE_START: 'shell_network_capture_start',
    NETWORK_CAPTURE_STOP: 'shell_network_capture_stop',
    NETWORK_DEBUGGER_START: 'shell_network_debugger_start',
    NETWORK_DEBUGGER_STOP: 'shell_network_debugger_stop',
    KEYBOARD: 'shell_keyboard',
    INJECT_SCRIPT: 'shell_inject_script',
    JAVASCRIPT: 'shell_javascript',
    CONSOLE: 'shell_console',
    FILE_UPLOAD: 'shell_upload_file',
    READ_PAGE: 'shell_read_page',
    COMPUTER: 'shell_computer',
    HANDLE_DIALOG: 'shell_handle_dialog',
    HANDLE_DOWNLOAD: 'shell_handle_download',
    PAGE_DIFF: 'shell_page_diff',
  },
} as const;
