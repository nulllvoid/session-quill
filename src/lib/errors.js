export class TrackerError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'TrackerError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export function isTrackerError(err, code) {
  return err instanceof TrackerError && (code === undefined || err.code === code);
}
