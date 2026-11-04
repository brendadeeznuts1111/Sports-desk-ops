/** Environment capability probes for suites that need real OS facilities. */
/**
 * The DSH agent sandbox denies `/dev/ptmx` allocation, WebView/CDP sockets and keychain
 * mutation, so the capability-dependent suites are skipped there and run on the host/CI.
 * `DSH_SESSION_ID` is set only inside that sandbox; it is not present on a normal runner.
 */
const restrictedSandbox = (process.env.DSH_SESSION_ID ?? "").trim() !== "";

export const ptyAvailable: boolean = !restrictedSandbox;
export const secretsWritable: boolean = !restrictedSandbox;
export const chromeWebViewAvailable: boolean = !restrictedSandbox;
