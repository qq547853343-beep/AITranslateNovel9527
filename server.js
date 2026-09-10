import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApplication } from './lib/application.js';

const baseDirectory = path.dirname(fileURLToPath(import.meta.url));

export async function startServer({
  port = Number(process.env.PORT || 6501),
  host = '127.0.0.1',
  dataDirectory = process.env.TRANSLATE_DATA_DIR || path.join(baseDirectory, 'data'),
  launcherInstanceId = process.env.LAUNCHER_INSTANCE_ID || '',
  launcherControlToken = process.env.LAUNCHER_CONTROL_TOKEN || ''
} = {}) {
  let shutdownRequested = false;
  let shutdown = async () => {};
  const runtime = await createApplication({
    baseDirectory,
    dataDirectory,
    launcherControl: {
      instanceId: launcherInstanceId,
      token: launcherControlToken,
      requestShutdown: () => setImmediate(() => void shutdown('launcher'))
    }
  });
  let server;
  try {
    server = await new Promise((resolve, reject) => {
      const listener = runtime.app.listen(port, host, () => resolve(listener));
      listener.once('error', reject);
    });
  } catch (error) {
    runtime.database.close();
    throw error;
  }

  shutdown = async (reason = 'signal') => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    console.log(`[service] graceful shutdown requested (${reason})`);
    const forceTimer = setTimeout(() => server.closeAllConnections?.(), 8000);
    forceTimer.unref?.();
    await new Promise((resolve) => server.close(resolve));
    clearTimeout(forceTimer);
    runtime.database.close();
  };

  const onSigterm = () => void shutdown('SIGTERM');
  const onSigint = () => void shutdown('SIGINT');
  process.once('SIGTERM', onSigterm);
  process.once('SIGINT', onSigint);
  server.once('close', () => {
    process.off('SIGTERM', onSigterm);
    process.off('SIGINT', onSigint);
  });
  console.log(`AITranslateNovel9527 ver0.3 running at http://${host}:${port}`);
  return { ...runtime, server, port, host, shutdown };
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  startServer().catch((error) => {
    console.error(`[service] startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
