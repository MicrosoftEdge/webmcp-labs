// Copyright (c) Microsoft Corporation. Licensed under the MIT License.

import type { ZodSafeParseResult } from 'zod';
import { toExtensionSchema, toHostSchema, type ToExtension, type ToHost } from './protocol.js';

// safeParse errors contain paths, not a stringified copy of page content.
export const validateToHost = (message: unknown): ZodSafeParseResult<ToHost> => toHostSchema.safeParse(message);
export const validateToExtension = (message: unknown): ZodSafeParseResult<ToExtension> => toExtensionSchema.safeParse(message);
