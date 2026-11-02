// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
// Transport test peer only. This is not the application host.

import { NativeMessageDecoder, writeNativeMessage } from '../../host/dist/nativeMessaging.js';
import { validateToHost } from '../../shared/dist/validate.js';

const decoder = new NativeMessageDecoder(reason => process.stderr.write(reason + '\n'));
process.stdin.pipe(decoder);
try {
  for await (const value of decoder) {
    const parsed = validateToHost(value);
    if (!parsed.success) {
      process.stderr.write('Invalid protocol message\n');
      continue;
    }
    if (parsed.data.type === 'hello') {
      await writeNativeMessage(process.stdout, {
        type: 'ready', protocolVersion: 1, hostVersion: 'test-peer',
        sdkVersion: 'not-started', signedIn: false,
      });
    } else {
      await writeNativeMessage(process.stdout, {
        type: 'error', code: 'protocol_error', message: 'Transport test peer accepts hello only',
      });
    }
  }
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
}
