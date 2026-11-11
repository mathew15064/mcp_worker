import { provisionPreviewDatabase } from '../src/deployment/previewProvisioning';

void provisionPreviewDatabase()
  .then((status) => {
    // Never print a database URL, credential, session secret or record contents.
    console.log(JSON.stringify(status));
  })
  .catch((error: unknown) => {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'VERCEL_PREVIEW_PROVISION_FAILED';
    console.error('[PREVIEW_PROVISION] ' + code);
    process.exitCode = 1;
  });
