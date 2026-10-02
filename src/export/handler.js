// Export endpoints served by the worker: exact preview, then a local file write. Never uploads.
import path from 'node:path';
import { quillHome } from '../lib/paths.js';
import { previewExport, normalizeOptions } from './sanitize.js';
import { writeStaticHtml } from './static.js';
import { TrackerError } from '../lib/errors.js';

export function defaultExportPath(env, exportedAt) {
  return path.join(quillHome(env), 'exports', `session-quill-snapshot-${exportedAt.replace(/[:]/g, '-')}.html`);
}

export const exportHandler = {
  preview(worker, params) {
    return previewExport(worker.getSnapshot(), params);
  },
  run(worker, body) {
    const options = normalizeOptions({ ...body, exportedAt: worker.now() });
    const out = body && typeof body.out === 'string' && body.out.trim() ? body.out : defaultExportPath(worker.env, options.exportedAt);
    if (!/\.html?$/i.test(out)) throw new TrackerError('export-path-invalid', 'export path must end in .html', { status: 400 });
    const result = writeStaticHtml(worker.getSnapshot(), out, options);
    return { ...result, exported_at: options.exportedAt, fields: options.fields, projects: options.projects, uploaded: false };
  },
};
