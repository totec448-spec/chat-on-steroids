/** The public Windows Window2 vocabulary; native execution stays in main/computer. */
export const WINDOWS_COMPUTER_READ_METHODS = ['list_windows', 'get_window', 'list_apps', 'get_window_state'] as const;
export const WINDOWS_COMPUTER_INPUT_METHODS = ['launch_app', 'click', 'press_key', 'type_text', 'scroll', 'set_value', 'drag', 'perform_secondary_action', 'activate_window'] as const;
export const WINDOWS_COMPUTER_METHODS = [...WINDOWS_COMPUTER_READ_METHODS, ...WINDOWS_COMPUTER_INPUT_METHODS] as const;
/** These inputs consume the observation retained for the exact caller. */
export const WINDOWS_COMPUTER_STATE_INPUT_METHODS = ['click', 'scroll', 'set_value', 'drag', 'perform_secondary_action'] as const;
export type WindowsComputerMethod = typeof WINDOWS_COMPUTER_METHODS[number];
