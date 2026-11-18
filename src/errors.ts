/** Error with a stable machine code and an actionable message. */
export class WatayError extends Error {
  code: string;
  constructor(message: string, code = 'WATAY_ERROR') {
    super(message);
    this.name = 'WatayError';
    this.code = code;
  }
}
