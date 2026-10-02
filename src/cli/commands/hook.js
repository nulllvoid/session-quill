import { runHook, readStdinJson, HOOK_EVENTS } from '../../hooks/adapter.js';

// `tracker hook <EventName>`: never throws out to the host; non-gate hooks always exit 0.
export async function run({ args, io, env }) {
  const [eventName] = args;
  if (!HOOK_EVENTS.includes(eventName)) {
    io.error(`Session Tracker: unsupported hook event ${eventName}`);
    return 0;
  }
  let input;
  try {
    const raw = await io.readStdin();
    input = raw ? JSON.parse(raw) : {};
  } catch (err) {
    io.error(`Session Tracker: malformed hook input (${err.message})`);
    return 0;
  }
  let result;
  try {
    result = runHook(eventName, input, { env });
  } catch (err) {
    io.error(`Session Tracker: hook failure (${err.message})`);
    return 0;
  }
  if (result.stdout) io.out(result.stdout);
  if (result.stderr) io.err(result.stderr);
  return result.exitCode ?? 0;
}

export { readStdinJson };
