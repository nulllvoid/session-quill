// Reconciliation runs as the "reconcile" job of the schedule framework (ADR 0007); this module keeps
// the extension entry point the worker and tests load.
export { createSchedulerExtension as createExtension } from '../schedule/extension.js';
