/** Bad input from the operator (flag, path, config file): the CLI exit-2 class, not a crash. */
export class UsageError extends Error {
  override readonly name: string = "UsageError";
}
