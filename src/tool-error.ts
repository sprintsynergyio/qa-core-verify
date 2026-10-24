/** A problem in the arguments, the config, or a spec file. The CLI exits 2. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}
